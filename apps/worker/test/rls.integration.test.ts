/**
 * RLS / job-queue integration test. Runs against a real Supabase project.
 *
 * Requires in the environment (apps/worker/.env is loaded):
 *   SUPABASE_URL, SUPABASE_SECRET_KEY, SUPABASE_PUBLISHABLE_KEY
 * Skips itself if any are missing so `pnpm test` stays green offline.
 *
 * Creates two throwaway users, exercises every policy in
 * docs/rls-testing.md, and deletes the users (rows cascade) in afterAll.
 *
 * Run: pnpm test:rls
 */
import 'dotenv/config'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const URL_ = process.env.SUPABASE_URL
const SECRET = process.env.SUPABASE_SECRET_KEY
const PUB = process.env.SUPABASE_PUBLISHABLE_KEY
const enabled = Boolean(URL_ && SECRET && PUB)

const PASSWORD = 'rls-test-Passw0rd!'

interface TestUser {
  id: string
  client: SupabaseClient
}

const admin = enabled
  ? createClient(URL_!, SECRET!, { auth: { persistSession: false, autoRefreshToken: false } })
  : null

async function makeUser(tag: string): Promise<TestUser> {
  const email = `rls-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`
  const { data, error } = await admin!.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  })
  if (error || !data.user) throw error ?? new Error('createUser returned no user')

  const login = createClient(URL_!, PUB!, { auth: { persistSession: false } })
  const { data: session, error: sErr } = await login.auth.signInWithPassword({ email, password: PASSWORD })
  if (sErr || !session.session) throw sErr ?? new Error('no session')

  const client = createClient(URL_!, PUB!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${session.session.access_token}` } },
  })
  return { id: data.user.id, client }
}

describe.skipIf(!enabled)('RLS and job queue', () => {
  let A: TestUser
  let B: TestUser
  let datasetId: string
  let modelId: string
  let jobId: string
  let jobId2: string
  /**
   * Test jobs are backdated *as admin* so they are the oldest queued rows in
   * the project and claim_training_job hands them out first. Assertions are
   * then about our rows, never about global queue counts, so leftovers from
   * other users or runs cannot change the outcome. A user cannot do this
   * themselves; that is asserted below.
   */
  const BACKDATED = '2000-01-01T00:00:00Z'
  const BACKDATED_2 = '2000-01-01T00:00:01Z'

  beforeAll(async () => {
    ;[A, B] = await Promise.all([makeUser('a'), makeUser('b')])
  })

  afterAll(async () => {
    if (!admin) return
    // Loud cleanup: a leaked fixture user leaves claimed jobs and datasets in
    // the shared project and poisons later runs, so any failure here fails
    // the suite instead of being swallowed.
    const problems: string[] = []
    for (const u of [A, B]) {
      if (!u) continue
      const del = await admin.auth.admin.deleteUser(u.id)
      if (del.error) problems.push(`deleteUser ${u.id}: ${del.error.message}`)
      const objs = await admin.storage.from('datasets').list(u.id)
      const names = (objs.data ?? []).map((o) => `${u.id}/${o.name}`)
      if (names.length) {
        const rm = await admin.storage.from('datasets').remove(names)
        if (rm.error) problems.push(`remove storage ${u.id}: ${rm.error.message}`)
      }
      const rl = await admin.from('rate_limit_events').delete().eq('user_id', u.id)
      if (rl.error) problems.push(`rate_limit_events ${u.id}: ${rl.error.message}`)
    }
    if (problems.length) throw new Error(`RLS test cleanup failed: ${problems.join('; ')}`)
  })

  // ---- datasets / models -------------------------------------------------

  it('A can insert own dataset and model', async () => {
    const ds = await A.client
      .from('datasets')
      .insert({ user_id: A.id, name: 'housing', storage_path: `${A.id}/x.csv`, status: 'ready' })
      .select()
      .single()
    expect(ds.error).toBeNull()
    datasetId = ds.data!.id

    const m = await A.client
      .from('models')
      .insert({
        user_id: A.id,
        dataset_id: datasetId,
        name: 'm1',
        task: 'regression',
        algorithm: 'linear_regression',
        target_column: 'price',
        feature_columns: ['sqft'],
      })
      .select()
      .single()
    expect(m.error).toBeNull()
    modelId = m.data!.id
  })

  it("B cannot create a model on A's dataset", async () => {
    const { error } = await B.client.from('models').insert({
      user_id: B.id,
      dataset_id: datasetId,
      name: 'steal',
      task: 'regression',
      algorithm: 'linear_regression',
      target_column: 'price',
      feature_columns: ['sqft'],
    })
    expect(error).not.toBeNull()
  })

  it("B sees none of A's datasets or models", async () => {
    const ds = await B.client.from('datasets').select('id')
    const ms = await B.client.from('models').select('id')
    expect(ds.data).toEqual([])
    expect(ms.data).toEqual([])
  })

  // ---- training_jobs -----------------------------------------------------

  it('A can enqueue a job for own model; B cannot', async () => {
    const ok = await A.client.from('training_jobs').insert({ model_id: modelId }).select().single()
    expect(ok.error).toBeNull()
    jobId = ok.data!.id
    const ok2 = await A.client.from('training_jobs').insert({ model_id: modelId }).select().single()
    expect(ok2.error).toBeNull()
    jobId2 = ok2.data!.id
    // Admin (secret key, auth.uid() is null) may set created_at; the worker
    // never does, this is purely to make the test's rows the oldest queued.
    const bd1 = await admin!.from('training_jobs').update({ created_at: BACKDATED }).eq('id', jobId)
    const bd2 = await admin!.from('training_jobs').update({ created_at: BACKDATED_2 }).eq('id', jobId2)
    expect(bd1.error).toBeNull()
    expect(bd2.error).toBeNull()

    const bad = await B.client.from('training_jobs').insert({ model_id: modelId })
    expect(bad.error).not.toBeNull()
  })

  it('A cannot jump the queue or pick an attempt count: server sets created_at and attempt', async () => {
    const before = Date.now()
    const { data, error } = await A.client
      .from('training_jobs')
      .insert({
        model_id: modelId,
        created_at: '1970-01-01T00:00:00Z',
        attempt: 5,
        claimed_at: '1970-01-01T00:00:00Z',
        started_at: '1970-01-01T00:00:00Z',
        heartbeat_at: '1970-01-01T00:00:00Z',
        finished_at: '1970-01-01T00:00:00Z',
        error_message: 'nope',
      } as never)
      .select()
      .single()
    // The insert is accepted, but the stored row is a clean, freshly
    // timestamped, attempt-0 queued job: the sanitize trigger overrides
    // client values for authenticated sessions. (status and claimed_by are
    // rejected outright by the policy; see the next test.)
    expect(error).toBeNull()
    expect(data).toMatchObject({
      status: 'queued',
      attempt: 0,
      claimed_by: null,
      claimed_at: null,
      started_at: null,
      heartbeat_at: null,
      finished_at: null,
      error_message: null,
    })
    expect(new Date(data!.created_at).getTime()).toBeGreaterThanOrEqual(before - 5_000)
    await admin!.from('training_jobs').delete().eq('id', data!.id)
  })

  it('A cannot enqueue with a non-queued status or a claimed_by', async () => {
    const s = await A.client.from('training_jobs').insert({ model_id: modelId, status: 'running' })
    expect(s.error).not.toBeNull()
    const c = await A.client.from('training_jobs').insert({ model_id: modelId, claimed_by: 'me' })
    expect(c.error).not.toBeNull()
  })

  it('A cannot update job status (worker only)', async () => {
    await A.client.from('training_jobs').update({ status: 'succeeded' }).eq('id', jobId)
    const { data } = await admin!.from('training_jobs').select('status').eq('id', jobId).single()
    expect(data!.status).toBe('queued')
  })

  it('browser sessions cannot call worker functions', async () => {
    const claim = await A.client.rpc('claim_training_job', { p_worker_id: 'browser' })
    expect(claim.error?.message).toMatch(/permission denied/i)
    const reap = await A.client.rpc('reap_stale_jobs')
    expect(reap.error?.message).toMatch(/permission denied/i)
  })

  it('two concurrent claims hand out two distinct jobs, each exactly once', async () => {
    const [c1, c2] = await Promise.all([
      admin!.rpc('claim_training_job', { p_worker_id: 'w1' }),
      admin!.rpc('claim_training_job', { p_worker_id: 'w2' }),
    ])
    expect(c1.error).toBeNull()
    expect(c2.error).toBeNull()
    // Our two backdated jobs are the oldest in the queue, so they are what the
    // two calls receive: one each, never the same row twice (SKIP LOCKED).
    const got = [c1.data, c2.data].map((d) => (Array.isArray(d) && d.length === 1 ? d[0] : null))
    expect(got.every(Boolean)).toBe(true)
    expect(new Set(got.map((j) => j!.id))).toEqual(new Set([jobId, jobId2]))
    for (const j of got) {
      expect(j!.status).toBe('claimed')
      expect(j!.claimed_by).toMatch(/^w[12]$/)
      expect(j!.attempt).toBe(1)
    }
    const rows = await admin!.from('training_jobs').select('id, claimed_by').in('id', [jobId, jobId2])
    expect(rows.data?.map((r) => r.claimed_by).sort()).toEqual(['w1', 'w2'])
  })

  // ---- training_metrics --------------------------------------------------

  it('worker inserts metrics; A reads them, B cannot, A cannot insert', async () => {
    const ins = await admin!.from('training_metrics').insert([
      { job_id: jobId, epoch: 1, loss: 0.9 },
      { job_id: jobId, epoch: 2, loss: 0.5 },
    ])
    expect(ins.error).toBeNull()

    const a = await A.client.from('training_metrics').select('epoch').eq('job_id', jobId)
    expect(a.data).toHaveLength(2)
    const b = await B.client.from('training_metrics').select('epoch').eq('job_id', jobId)
    expect(b.data).toEqual([])
    const bad = await A.client.from('training_metrics').insert({ job_id: jobId, epoch: 3, loss: 0.1 })
    expect(bad.error).not.toBeNull()
  })

  // ---- reaper ------------------------------------------------------------

  it('reaper requeues a stale job, then fails it past max attempts', async () => {
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    await admin!.from('training_jobs').update({ heartbeat_at: stale }).eq('id', jobId)
    const r1 = await admin!.rpc('reap_stale_jobs', { p_stale_after: '5 minutes', p_max_attempts: 3 })
    expect(r1.error).toBeNull()
    expect(r1.data).toBeGreaterThanOrEqual(1) // ours, plus whatever else in the project was stale
    const after1 = await admin!.from('training_jobs').select('status,claimed_by,attempt').eq('id', jobId).single()
    expect(after1.data).toMatchObject({ status: 'queued', claimed_by: null, attempt: 1 })

    await admin!.from('training_jobs').update({ status: 'running', attempt: 3, heartbeat_at: stale }).eq('id', jobId)
    await admin!.rpc('reap_stale_jobs')
    const after2 = await admin!.from('training_jobs').select('status,error_message').eq('id', jobId).single()
    expect(after2.data!.status).toBe('failed')
    expect(after2.data!.error_message).toBeTruthy()
  })

  // ---- api_keys / artifacts / predictions_log ----------------------------

  it('api keys: A can create for own model, B cannot', async () => {
    const ok = await A.client
      .from('api_keys')
      .insert({ user_id: A.id, model_id: modelId, key_prefix: 'mf_abcd1', key_hash: 'h'.repeat(64) })
    expect(ok.error).toBeNull()
    const bad = await B.client
      .from('api_keys')
      .insert({ user_id: B.id, model_id: modelId, key_prefix: 'mf_zzzz9', key_hash: 'z'.repeat(64) })
    expect(bad.error).not.toBeNull()
  })

  it('artifacts and predictions_log are visible to owner only', async () => {
    await admin!.from('model_artifacts').insert({
      model_id: modelId,
      job_id: jobId,
      version: 1,
      storage_path: `${A.id}/${modelId}/v1.json`,
      metrics: { rmse: 1 },
    })
    await admin!.from('predictions_log').insert({ model_id: modelId, latency_ms: 5, input_row_count: 1, status_code: 200 })

    expect((await A.client.from('model_artifacts').select('version')).data).toHaveLength(1)
    expect((await B.client.from('model_artifacts').select('version')).data).toEqual([])
    expect((await A.client.from('predictions_log').select('id')).data).toHaveLength(1)
    expect((await B.client.from('predictions_log').select('id')).data).toEqual([])
  })

  // ---- storage -----------------------------------------------------------

  it('storage: only the next expected object of an owned dataset is writable; models bucket read-only', async () => {
    const csv = new Blob(['a,b\n1,2\n'], { type: 'text/csv' })

    // Precondition: A must be under the dataset cap to reserve one more row.
    const { data: lim } = await admin!.from('app_limits').select('value').eq('key', 'max_datasets_per_user').single()
    const { count } = await admin!.from('datasets').select('id', { count: 'exact', head: true }).eq('user_id', A.id)
    expect(count!, 'test setup: A must be below max_datasets_per_user').toBeLessThan(lim!.value)

    // No dataset row -> denied, even inside A's own folder.
    const orphan = await A.client.storage.from('datasets').upload(`${A.id}/orphan.csv`, csv)
    expect(orphan.error).not.toBeNull()

    // Reserve a row the way createDataset does, then exactly that path is allowed.
    const id = crypto.randomUUID()
    const reserve = await A.client
      .from('datasets')
      .insert({ id, user_id: A.id, name: 'upload', storage_path: `${A.id}/${id}.csv`, status: 'uploading' })
    expect(reserve.error).toBeNull()
    // While uploading, edited versions are not yet allowed.
    const early = await A.client.storage.from('datasets').upload(`${A.id}/${id}.v1.csv`, csv)
    expect(early.error).not.toBeNull()
    const up = await A.client.storage.from('datasets').upload(`${A.id}/${id}.csv`, csv)
    expect(up.error).toBeNull()

    // Once ready: the original path is locked, only version k+1 is writable.
    await A.client.from('datasets').update({ status: 'ready' }).eq('id', id)
    await admin!.storage.from('datasets').remove([`${A.id}/${id}.csv`])
    const again = await A.client.storage.from('datasets').upload(`${A.id}/${id}.csv`, csv)
    expect(again.error).not.toBeNull()
    for (const bad of [`${id}.v2.csv`, `${id}.v999.csv`, `${id}.vfoo.csv`, `${id}.v1.csv.bak`, `${id}.v1/x.csv`]) {
      const r = await A.client.storage.from('datasets').upload(`${A.id}/${bad}`, csv)
      expect(r.error, bad).not.toBeNull()
    }
    const v1 = await A.client.storage.from('datasets').upload(`${A.id}/${id}.v1.csv`, csv)
    expect(v1.error).toBeNull()
    // v1 is not current in storage_path yet, so v2 is still not allowed...
    const v2early = await A.client.storage.from('datasets').upload(`${A.id}/${id}.v2.csv`, csv)
    expect(v2early.error).not.toBeNull()
    // ...until the row points at v1 (this update is also what the edit rate limit counts).
    const point = await A.client.from('datasets').update({ storage_path: `${A.id}/${id}.v1.csv` }).eq('id', id)
    expect(point.error).toBeNull()
    const v2 = await A.client.storage.from('datasets').upload(`${A.id}/${id}.v2.csv`, csv)
    expect(v2.error).toBeNull()

    const evil = await B.client.storage.from('datasets').upload(`${A.id}/${id}.v3.csv`, csv)
    expect(evil.error).not.toBeNull()

    const list = await B.client.storage.from('datasets').list(A.id)
    expect(list.data ?? []).toEqual([])

    // UPDATE policy WITH CHECK: A cannot move an object into B's folder.
    const move = await A.client.storage.from('datasets').move(`${A.id}/${id}.v1.csv`, `${B.id}/${id}.v1.csv`)
    expect(move.error).not.toBeNull()
    const stillThere = await admin!.storage.from('datasets').list(A.id)
    expect(stillThere.data?.some((o) => o.name === `${id}.v1.csv`)).toBe(true)

    const art = await A.client.storage.from('models').upload(`${A.id}/x.json`, new Blob(['{}']))
    expect(art.error).not.toBeNull()

    await A.client.from('datasets').delete().eq('id', id)
  })

  // ---- usage limits --------------------------------------------------------

  it('limits: app_limits is readable, rate_limit_events is not', async () => {
    const limits = await A.client.from('app_limits').select('key, value')
    expect(limits.error).toBeNull()
    expect(limits.data?.some((l) => l.key === 'max_datasets_per_user')).toBe(true)

    const events = await A.client.from('rate_limit_events').select('id')
    expect(events.data ?? []).toEqual([])
    const insert = await A.client.from('rate_limit_events').insert({ user_id: A.id, action: 'x' })
    expect(insert.error).not.toBeNull()
  })

  it('limits: dataset cap per user, and deleting does not reset the hourly upload window', async () => {
    const { data: lim } = await admin!.from('app_limits').select('key, value')
    const maxDatasets = lim!.find((l) => l.key === 'max_datasets_per_user')!.value
    const perHour = lim!.find((l) => l.key === 'dataset_uploads_per_hour')!.value
    // The scenario below needs headroom in the hourly window to hit the cap first.
    expect(perHour, 'test assumes dataset_uploads_per_hour > max_datasets_per_user').toBeGreaterThan(maxDatasets)

    // Preconditions: B has no datasets and no upload events yet.
    const { count: bCount } = await admin!.from('datasets').select('id', { count: 'exact', head: true }).eq('user_id', B.id)
    expect(bCount, 'test setup: B must own no datasets').toBe(0)
    const { count: bEvents } = await admin!
      .from('rate_limit_events')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', B.id)
    expect(bEvents, 'test setup: B must have no rate-limit events').toBe(0)

    const mk = () =>
      B.client
        .from('datasets')
        .insert({ user_id: B.id, name: 'd', storage_path: `${B.id}/${crypto.randomUUID()}.csv`, status: 'ready' })
        .select('id')
        .single()

    const ids: string[] = []
    for (let i = 0; i < maxDatasets; i++) {
      const r = await mk()
      expect(r.error).toBeNull()
      ids.push(r.data!.id)
    }
    const overCap = await mk()
    expect(overCap.error?.code).toBe('54000')
    expect(overCap.error?.message).toBe(
      `Dataset limit reached: you can keep at most ${maxDatasets} dataset${maxDatasets === 1 ? '' : 's'}. Delete one to upload another.`
    )

    // Free a slot, then churn create+delete until the hourly window is exhausted.
    await B.client.from('datasets').delete().eq('id', ids[0]!)
    let created = maxDatasets
    while (created < perHour) {
      const r = await mk()
      expect(r.error).toBeNull()
      await B.client.from('datasets').delete().eq('id', r.data!.id)
      created++
    }
    const throttled = await mk()
    expect(throttled.error?.code).toBe('54000')
    expect(throttled.error?.message).toBe(
      `Rate limit reached: at most ${perHour} dataset uploads per hour. Try again later.`
    )

    // The worker (secret key) is exempt from user limits.
    const worker = await admin!
      .from('datasets')
      .insert({ user_id: B.id, name: 'seed', storage_path: `${B.id}/${crypto.randomUUID()}.csv`, status: 'ready' })
    expect(worker.error).toBeNull()
  })
})
