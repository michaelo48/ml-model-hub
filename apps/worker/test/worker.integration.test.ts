/**
 * End-to-end worker test against a real Supabase project: dataset in storage
 * -> model -> queued job -> claim_training_job -> runJob -> metrics, artifact,
 * statuses. Also the failure modes that matter for a distributed queue: an
 * orphaned artifact object, a job reaped and reclaimed while we were running,
 * a late metrics flush from a previous owner, the reaper moving model status.
 *
 * Requires SUPABASE_URL and SUPABASE_SECRET_KEY (apps/worker/.env is loaded);
 * skips itself otherwise so `pnpm test` stays green offline. The training
 * thread runs from dist/ (built by the pretest hook).
 *
 * Run: pnpm test:integration
 */
import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseArtifact, predictWithArtifact } from '@modelforge/ml'
import { claimJob, createDb, reapStaleJobs, type Db, type JobRow } from '../src/db'
import { loadEnv, type Env } from '../src/env'
import { runJob } from '../src/job'

const URL_ = process.env.SUPABASE_URL
const SECRET = process.env.SUPABASE_SECRET_KEY
const enabled = Boolean(URL_ && SECRET)

const housing = readFileSync(fileURLToPath(new URL('../../../fixtures/housing.csv', import.meta.url)))
const OLS = { optimizer: 'ols', learning_rate: 0.01, epochs: 1, batch_size: 32, l2: 0 }

describe.skipIf(!enabled)('worker end to end', () => {
  let db: Db
  let userId: string
  let env: Env

  async function makeDataset(name: string, csv: Uint8Array | Buffer, status = 'ready'): Promise<string> {
    const { data, error } = await db
      .from('datasets')
      .insert({ user_id: userId, name, storage_path: `${userId}/pending-${name}.csv`, status })
      .select('id')
      .single()
    if (error) throw error
    const path = `${userId}/${data.id}.csv`
    // Fixture upload to a remote project: retry a stalled/timed-out attempt
    // so a network hiccup in setup does not read as a worker failure.
    let lastErr: unknown = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const up = await db.storage.from('datasets').upload(path, new Blob([csv]), { contentType: 'text/csv', upsert: true })
        if (!up.error) {
          lastErr = null
          break
        }
        lastErr = up.error
      } catch (err) {
        lastErr = err
      }
    }
    if (lastErr) throw lastErr
    const upd = await db.from('datasets').update({ storage_path: path }).eq('id', data.id)
    if (upd.error) throw upd.error
    return data.id
  }

  async function makeModel(model: Record<string, unknown>): Promise<string> {
    const m = await db
      .from('models')
      .insert({ user_id: userId, status: 'queued', ...model })
      .select('id')
      .single()
    if (m.error) throw m.error
    return m.data.id
  }

  /**
   * Test jobs are backdated (a unique, increasing timestamp in the year 2000)
   * so each is the oldest queued row in the project when it is enqueued and
   * claim_training_job hands it out first. No other user's job is ever
   * claimed or touched by this suite. This client is the secret key, so the
   * sanitize-insert trigger leaves created_at alone; a user's session could
   * not do this (see rls.integration.test.ts).
   */
  let backdate = Date.UTC(2000, 0, 1)
  async function enqueue(modelId: string): Promise<string> {
    const created_at = new Date((backdate += 1000)).toISOString()
    const j = await db.from('training_jobs').insert({ model_id: modelId, created_at }).select('id').single()
    if (j.error) throw j.error
    return j.data.id
  }

  /**
   * Claim through the real RPC. Our job is the oldest queued row (see
   * enqueue), so it is what comes back. If an earlier test in this run was
   * aborted and left one of *our own* jobs queued, that job is older still;
   * it is claimed and simply kept (it belongs to this fixture user and is
   * deleted with them), and we claim again. Anything not ours is an error.
   */
  async function claimOurs(jobId: string, workerId = env.WORKER_ID): Promise<JobRow> {
    for (let i = 0; i < 20; i++) {
      const job = await claimJob(db, workerId)
      if (!job) throw new Error(`claim_training_job returned nothing; expected job ${jobId}`)
      if (job.id === jobId) return job
      const owner = await db.from('models').select('user_id').eq('id', job.model_id).maybeSingle()
      if (owner.data?.user_id !== userId) {
        throw new Error(
          `claim_training_job returned ${job.id} (created ${job.created_at}) owned by someone else, ahead of our ` +
            `backdated ${jobId}; another queued row in the project is older than year 2000, which this suite does not handle`
        )
      }
      // Ours, left over from an aborted earlier test: hold it and keep going.
    }
    throw new Error(`could not claim job ${jobId}`)
  }

  async function claimAndRun(jobId: string, onStart?: Parameters<typeof runJob>[2]): Promise<void> {
    const job = await claimOurs(jobId)
    await runJob({ db, env }, job, onStart)
  }

  const jobState = async (jobId: string) =>
    (await db.from('training_jobs').select('status, claimed_by, attempt, heartbeat_at, error_message').eq('id', jobId).single())
      .data!
  const modelStatus = async (modelId: string) =>
    (await db.from('models').select('status').eq('id', modelId).single()).data!.status as string

  beforeAll(async () => {
    db = createDb(URL_!, SECRET!)
    env = { ...loadEnv(), WORKER_ID: `test-worker-${process.pid}`, HEARTBEAT_INTERVAL_MS: 400, METRICS_FLUSH_MS: 50 }
    const { data, error } = await db.auth.admin.createUser({
      email: `worker-e2e-${Date.now()}@example.com`,
      password: 'worker-e2e-Passw0rd!',
      email_confirm: true,
    })
    if (error || !data.user) throw error ?? new Error('no user')
    userId = data.user.id
  })

  afterAll(async () => {
    if (!db || !userId) return
    // Loud cleanup: a leaked fixture user leaves claimed/queued jobs in the
    // shared project and poisons later runs, so failures here fail the suite.
    const problems: string[] = []
    const del = await db.auth.admin.deleteUser(userId)
    if (del.error) problems.push(`deleteUser: ${del.error.message}`)
    for (const bucket of ['datasets', 'models']) {
      const top = await db.storage.from(bucket).list(userId)
      if (top.error) problems.push(`list ${bucket}: ${top.error.message}`)
      for (const entry of top.data ?? []) {
        const nested = await db.storage.from(bucket).list(`${userId}/${entry.name}`)
        const names = (nested.data ?? []).length
          ? (nested.data ?? []).map((o) => `${userId}/${entry.name}/${o.name}`)
          : [`${userId}/${entry.name}`]
        const rm = await db.storage.from(bucket).remove(names)
        if (rm.error) problems.push(`remove ${bucket}: ${rm.error.message}`)
      }
    }
    const rl = await db.from('rate_limit_events').delete().eq('user_id', userId)
    if (rl.error) problems.push(`rate_limit_events: ${rl.error.message}`)
    if (problems.length) throw new Error(`worker test cleanup failed: ${problems.join('; ')}`)
  })

  it('trains a regression model with OLS, publishes v1, then v2 on retrain', async () => {
    const datasetId = await makeDataset('housing', housing)
    const modelId = await makeModel({
      dataset_id: datasetId,
      name: 'ols',
      task: 'regression',
      algorithm: 'linear_regression',
      target_column: 'price',
      feature_columns: ['sqft', 'bedrooms', 'garage'],
      hyperparameters: OLS,
    })
    const jobId = await enqueue(modelId)
    await claimAndRun(jobId)

    expect(await jobState(jobId)).toMatchObject({ status: 'succeeded', error_message: null, attempt: 1 })
    expect(await modelStatus(modelId)).toBe('succeeded')

    const metrics = await db.from('training_metrics').select('epoch, loss').eq('job_id', jobId)
    expect(metrics.data).toHaveLength(1)

    const art = await db.from('model_artifacts').select('*').eq('model_id', modelId).single()
    expect(art.data?.version).toBe(1)
    expect(art.data?.job_id).toBe(jobId)
    expect(art.data?.metrics?.r2).toBeGreaterThan(0.5)

    const file = await db.storage.from('models').download(art.data!.storage_path)
    expect(file.error).toBeNull()
    const artifact = parseArtifact(JSON.parse(await file.data!.text()))
    expect(artifact.feature_columns).toEqual(['sqft', 'bedrooms', 'garage'])
    const [p] = predictWithArtifact(artifact, [[2330, 3, 1]])
    expect(Math.abs(p! - 320945) / 320945).toBeLessThan(0.25)

    await claimAndRun(await enqueue(modelId))
    const versions = await db.from('model_artifacts').select('version').eq('model_id', modelId).order('version')
    expect(versions.data?.map((v) => v.version)).toEqual([1, 2])
  })

  it('overwrites an orphaned artifact object left by a crash between upload and row insert', async () => {
    const datasetId = await makeDataset('housing-orphan', housing)
    const modelId = await makeModel({
      dataset_id: datasetId,
      name: 'orphan',
      task: 'regression',
      algorithm: 'linear_regression',
      target_column: 'price',
      feature_columns: ['sqft'],
      hyperparameters: OLS,
    })
    // Simulate the crash: the object for v1 exists, the row does not.
    const orphanPath = `${userId}/${modelId}/v1.json`
    const up = await db.storage.from('models').upload(orphanPath, new Blob(['{"orphan":true}']), { upsert: false })
    expect(up.error).toBeNull()

    const jobId = await enqueue(modelId)
    await claimAndRun(jobId)
    expect((await jobState(jobId)).status).toBe('succeeded')
    const art = await db.from('model_artifacts').select('version, storage_path').eq('model_id', modelId).single()
    expect(art.data).toEqual({ version: 1, storage_path: orphanPath })
    const file = await db.storage.from('models').download(orphanPath)
    expect(JSON.parse(await file.data!.text()).format).toBe('modelforge.linear.v1')
  })

  it('streams one metric row per epoch for an iterative optimizer', async () => {
    const datasetId = await makeDataset('housing-adam', housing)
    const modelId = await makeModel({
      dataset_id: datasetId,
      name: 'adam',
      task: 'regression',
      algorithm: 'linear_regression',
      target_column: 'price',
      feature_columns: ['sqft', 'bathrooms'],
      hyperparameters: { optimizer: 'adam', learning_rate: 0.05, epochs: 40, batch_size: 16, l2: 0 },
    })
    const jobId = await enqueue(modelId)
    await claimAndRun(jobId)
    const metrics = await db
      .from('training_metrics')
      .select('epoch, loss, elapsed_ms')
      .eq('job_id', jobId)
      .order('epoch')
    expect(metrics.data?.map((m) => m.epoch)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1))
    expect(metrics.data![39]!.loss).toBeLessThan(metrics.data![0]!.loss)
    expect(metrics.data!.every((m) => typeof m.elapsed_ms === 'number')).toBe(true)
  })

  it('trains logistic regression on a boolean target', async () => {
    const datasetId = await makeDataset('housing-logit', housing)
    const modelId = await makeModel({
      dataset_id: datasetId,
      name: 'logit',
      task: 'binary_classification',
      algorithm: 'logistic_regression',
      target_column: 'garage',
      feature_columns: ['sqft', 'price'],
      hyperparameters: { optimizer: 'sgd', learning_rate: 0.05, epochs: 30, batch_size: 8, l2: 0 },
    })
    await claimAndRun(await enqueue(modelId))
    const art = await db.from('model_artifacts').select('metrics').eq('model_id', modelId).single()
    expect(art.data?.metrics?.accuracy).toBeGreaterThanOrEqual(0)
    expect(art.data?.metrics?.accuracy).toBeLessThanOrEqual(1)
    expect(art.data?.metrics?.train_loss).toBeGreaterThan(0)
    expect(art.data?.metrics?.epochs_run).toBe(30)
  })

  it('fails clearly on a text feature and on a diverging run', async () => {
    const csv = new TextEncoder().encode('x,label,y\n1,a,2\n2,b,4\n3,,6\n')
    const datasetId = await makeDataset('bad', csv)

    const textModel = await makeModel({
      dataset_id: datasetId,
      name: 'text-feature',
      task: 'regression',
      algorithm: 'linear_regression',
      target_column: 'y',
      feature_columns: ['label'],
      hyperparameters: OLS,
    })
    const textJob = await enqueue(textModel)
    await claimAndRun(textJob)
    expect(await jobState(textJob)).toMatchObject({
      status: 'failed',
      error_message: 'Row 2, column "label": "a" is not a number or true/false value.',
    })
    expect(await modelStatus(textModel)).toBe('failed')
    expect((await db.from('model_artifacts').select('id').eq('model_id', textModel)).data).toEqual([])

    const divergeModel = await makeModel({
      dataset_id: datasetId,
      name: 'diverge',
      task: 'regression',
      algorithm: 'linear_regression',
      target_column: 'y',
      feature_columns: ['x'],
      hyperparameters: { optimizer: 'batch_gd', learning_rate: 10, epochs: 200, batch_size: 32, l2: 0 },
    })
    const divergeJob = await enqueue(divergeModel)
    await claimAndRun(divergeJob)
    const s = await jobState(divergeJob)
    expect(s.status).toBe('failed')
    expect(s.error_message).toMatch(/diverged/)
  })

  it('releases a job back to the queue when stopped mid-training, attempt restored', async () => {
    const lines = ['x1,x2,y']
    let seed = 7
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
    // 8k rows x one-row batches: ~1 ms per epoch, so 5000 epochs take seconds
    // and a stop after 1.5 s lands mid-training, with a ~250 KB fixture.
    for (let i = 0; i < 8_000; i++) {
      const a = rnd() * 10
      const b = rnd() * 10
      lines.push(`${a.toFixed(3)},${b.toFixed(3)},${(3 * a - 2 * b + 1 + rnd()).toFixed(3)}`)
    }
    const datasetId = await makeDataset('big', new TextEncoder().encode(lines.join('\n') + '\n'))
    const modelId = await makeModel({
      dataset_id: datasetId,
      name: 'interrupted',
      task: 'regression',
      algorithm: 'linear_regression',
      target_column: 'y',
      feature_columns: ['x1', 'x2'],
      hyperparameters: { optimizer: 'sgd', learning_rate: 0.001, epochs: 5000, batch_size: 1, l2: 0 },
    })
    const jobId = await enqueue(modelId)
    const t0 = Date.now()
    await claimAndRun(jobId, (r) => setTimeout(() => r.stop(), 1500))
    expect(Date.now() - t0).toBeLessThan(20_000)

    // claim_training_job set attempt to 1; the voluntary release puts it back to 0.
    expect(await jobState(jobId)).toMatchObject({ status: 'queued', claimed_by: null, attempt: 0, heartbeat_at: null })
    expect(await modelStatus(modelId)).toBe('queued')
    expect((await db.from('training_metrics').select('id').eq('job_id', jobId)).data).toEqual([])
    expect((await db.from('model_artifacts').select('id').eq('model_id', modelId)).data).toEqual([])

    // The same job is claimable again and completes normally. Switch the
    // model to OLS first so the rerun finishes in one epoch and the suite
    // leaves no queued job behind for later tests to claim.
    await db.from('models').update({ hyperparameters: OLS }).eq('id', modelId)
    await claimAndRun(jobId)
    expect(await jobState(jobId)).toMatchObject({ status: 'succeeded', attempt: 1 })
    expect(await modelStatus(modelId)).toBe('succeeded')
  })

  it('touches nothing once the job has been reaped and reclaimed by another worker', async () => {
    const datasetId = await makeDataset('housing-stolen', housing)
    const modelId = await makeModel({
      dataset_id: datasetId,
      name: 'stolen',
      task: 'regression',
      algorithm: 'linear_regression',
      target_column: 'price',
      feature_columns: ['sqft'],
      hyperparameters: { optimizer: 'sgd', learning_rate: 0.01, epochs: 3000, batch_size: 1, l2: 0 },
    })
    const jobId = await enqueue(modelId)

    // While we are training, simulate: our heartbeat went stale, the reaper
    // requeued the job, and worker B claimed it and is now running it.
    let stolen: Promise<void> | null = null
    await claimAndRun(jobId, () => {
      stolen = (async () => {
        await new Promise((r) => setTimeout(r, 200))
        const { error } = await db
          .from('training_jobs')
          .update({ claimed_by: 'worker-B', status: 'running', attempt: 2 })
          .eq('id', jobId)
        if (error) throw error
        await db.from('models').update({ status: 'training' }).eq('id', modelId)
      })()
    })
    await stolen!

    // Our worker must not have finalized anything: no succeeded/failed, no
    // artifact, and B's ownership intact.
    expect(await jobState(jobId)).toMatchObject({ status: 'running', claimed_by: 'worker-B', attempt: 2 })
    expect(await modelStatus(modelId)).toBe('training')
    expect((await db.from('model_artifacts').select('id').eq('model_id', modelId)).data).toEqual([])
    expect((await db.storage.from('models').list(`${userId}/${modelId}`)).data ?? []).toEqual([])

    // And a late metrics flush from us cannot jam B: B's upserts on the same
    // epochs succeed. Simulate B inserting epochs that overlap ours.
    const { error: bErr } = await db
      .from('training_metrics')
      .upsert(
        [1, 2, 3].map((epoch) => ({ job_id: jobId, epoch, loss: 0.5, elapsed_ms: 1 })),
        { onConflict: 'job_id,epoch', ignoreDuplicates: true }
      )
    expect(bErr).toBeNull()
  })

  it('reaper moves models.status along with the job', async () => {
    const datasetId = await makeDataset('housing-reap', housing)
    const modelId = await makeModel({
      dataset_id: datasetId,
      name: 'reaped',
      task: 'regression',
      algorithm: 'linear_regression',
      target_column: 'price',
      feature_columns: ['sqft'],
      hyperparameters: OLS,
    })
    const jobId = await enqueue(modelId)
    const job = await claimOurs(jobId, 'dead-worker')
    await db.from('models').update({ status: 'training' }).eq('id', modelId)
    const stale = new Date(Date.now() - 10 * 60_000).toISOString()

    // attempt 1 of 3 -> requeued, model back to queued
    await db.from('training_jobs').update({ status: 'running', heartbeat_at: stale }).eq('id', job.id)
    expect(await reapStaleJobs(db, '5 minutes', 3)).toBeGreaterThanOrEqual(1)
    expect(await jobState(jobId)).toMatchObject({ status: 'queued', claimed_by: null, attempt: 1 })
    expect(await modelStatus(modelId)).toBe('queued')

    // attempt 3 of 3 -> failed, model failed
    await db
      .from('training_jobs')
      .update({ status: 'running', claimed_by: 'dead-worker', heartbeat_at: stale, attempt: 3 })
      .eq('id', jobId)
    await db.from('models').update({ status: 'training' }).eq('id', modelId)
    expect(await reapStaleJobs(db, '5 minutes', 3)).toBeGreaterThanOrEqual(1)
    const s = await jobState(jobId)
    expect(s.status).toBe('failed')
    expect(s.error_message).toMatch(/stopped responding/)
    expect(await modelStatus(modelId)).toBe('failed')
  })

  it('fails a job whose dataset is not ready', async () => {
    const datasetId = await makeDataset('not-ready', housing, 'invalid')
    const modelId = await makeModel({
      dataset_id: datasetId,
      name: 'nr',
      task: 'regression',
      algorithm: 'linear_regression',
      target_column: 'price',
      feature_columns: ['sqft'],
      hyperparameters: OLS,
    })
    const jobId = await enqueue(modelId)
    await claimAndRun(jobId)
    const s = await jobState(jobId)
    expect(s.status).toBe('failed')
    expect(s.error_message).toMatch(/not ready/)
  })
})
