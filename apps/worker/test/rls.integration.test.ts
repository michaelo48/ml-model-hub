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

  beforeAll(async () => {
    ;[A, B] = await Promise.all([makeUser('a'), makeUser('b')])
  })

  afterAll(async () => {
    if (!admin) return
    await admin.storage.from('datasets').remove([`${A?.id}/test.csv`]).catch(() => undefined)
    if (A) await admin.auth.admin.deleteUser(A.id)
    if (B) await admin.auth.admin.deleteUser(B.id)
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

    const bad = await B.client.from('training_jobs').insert({ model_id: modelId })
    expect(bad.error).not.toBeNull()
  })

  it('A cannot enqueue with a non-queued status', async () => {
    const { error } = await A.client.from('training_jobs').insert({ model_id: modelId, status: 'running' })
    expect(error).not.toBeNull()
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

  it('exactly one of two concurrent workers claims the job', async () => {
    const [c1, c2] = await Promise.all([
      admin!.rpc('claim_training_job', { p_worker_id: 'w1' }),
      admin!.rpc('claim_training_job', { p_worker_id: 'w2' }),
    ])
    expect(c1.error).toBeNull()
    expect(c2.error).toBeNull()
    const winners = [c1.data, c2.data].filter((d) => Array.isArray(d) && d.length === 1)
    expect(winners).toHaveLength(1)
    const claimed = winners[0]![0]
    expect(claimed.status).toBe('claimed')
    expect(claimed.claimed_by).toMatch(/^w[12]$/)
    expect(claimed.attempt).toBe(1)
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
    expect(r1.data).toBe(1)
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

  it('storage: own-folder writes only in datasets; models bucket read-only', async () => {
    const csv = new Blob(['a,b\n1,2\n'], { type: 'text/csv' })
    const up = await A.client.storage.from('datasets').upload(`${A.id}/test.csv`, csv)
    expect(up.error).toBeNull()

    const evil = await B.client.storage.from('datasets').upload(`${A.id}/evil.csv`, csv)
    expect(evil.error).not.toBeNull()

    const list = await B.client.storage.from('datasets').list(A.id)
    expect(list.data ?? []).toEqual([])

    // UPDATE policy WITH CHECK: A cannot move an object into B's folder.
    const move = await A.client.storage.from('datasets').move(`${A.id}/test.csv`, `${B.id}/test.csv`)
    expect(move.error).not.toBeNull()
    const stillThere = await admin!.storage.from('datasets').list(A.id)
    expect(stillThere.data?.some((o) => o.name === 'test.csv')).toBe(true)

    const art = await A.client.storage.from('models').upload(`${A.id}/x.json`, new Blob(['{}']))
    expect(art.error).not.toBeNull()
  })
})
