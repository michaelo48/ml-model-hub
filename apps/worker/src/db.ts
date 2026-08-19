import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { algorithmSchema, hyperparametersSchema, taskSchema } from '@modelforge/ml'

/**
 * Thin, zod-validated access layer over the tables the worker touches.
 *
 * The worker uses the secret key, so RLS does not apply; every query scopes
 * itself explicitly. Beyond that, every write that moves a job out of its
 * claimed/running state is fenced on `claimed_by = <this worker>` and returns
 * whether it matched. A worker that stalled past STALE_JOB_AFTER (GC pause,
 * frozen VM, slow network) may have had its job reaped and handed to another
 * worker; when it wakes up its writes must land on nothing rather than stomp
 * the new owner's row.
 */

export type Db = SupabaseClient

/**
 * supabase-js has no request timeout; a stalled connection would hold an
 * await (and with it a job) indefinitely. Every call gets an abort deadline so
 * a stall surfaces as an InfraError and takes the requeue path instead.
 */
export function createDb(url: string, secretKey: string, requestTimeoutMs = 30_000): Db {
  return createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(requestTimeoutMs) }),
    },
  })
}

export const DATASETS_BUCKET = 'datasets'
export const MODELS_BUCKET = 'models'

export const jobRowSchema = z.object({
  id: z.string().uuid(),
  model_id: z.string().uuid(),
  status: z.enum(['queued', 'claimed', 'running', 'succeeded', 'failed']),
  claimed_by: z.string().nullable(),
  attempt: z.number().int(),
  created_at: z.string(),
})
export type JobRow = z.infer<typeof jobRowSchema>

export const modelRowSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  dataset_id: z.string().uuid(),
  task: taskSchema,
  algorithm: algorithmSchema,
  target_column: z.string().min(1),
  feature_columns: z.array(z.string().min(1)).min(1),
  hyperparameters: hyperparametersSchema,
})
export type ModelRow = z.infer<typeof modelRowSchema>

export const datasetRowSchema = z.object({
  id: z.string().uuid(),
  storage_path: z.string().min(1),
  status: z.enum(['uploading', 'ready', 'invalid']),
})
export type DatasetRow = z.infer<typeof datasetRowSchema>

/** Thrown for DB/storage failures the worker should treat as retryable. */
export class InfraError extends Error {
  override readonly name = 'InfraError'
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
  }
}

/** The model row itself is unusable; the user must fix it. Not retryable. */
export class ModelConfigError extends Error {
  override readonly name = 'ModelConfigError'
}

function fail(what: string, error: { message: string } | null): never {
  throw new InfraError(`${what}: ${error?.message ?? 'unknown error'}`, error)
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

/** Atomically claim the oldest queued job, or null if the queue is empty. */
export async function claimJob(db: Db, workerId: string): Promise<JobRow | null> {
  const { data, error } = await db.rpc('claim_training_job', { p_worker_id: workerId })
  if (error) fail('claim_training_job', error)
  const rows = z.array(jobRowSchema).parse(data ?? [])
  return rows[0] ?? null
}

export async function reapStaleJobs(db: Db, staleAfter: string, maxAttempts: number): Promise<number> {
  const { data, error } = await db.rpc('reap_stale_jobs', {
    p_stale_after: staleAfter,
    p_max_attempts: maxAttempts,
  })
  if (error) fail('reap_stale_jobs', error)
  return z.number().int().parse(data)
}

/** Cheapest possible liveness probe: one indexed row fetch, no count. */
export async function probe(db: Db): Promise<string | null> {
  const { error } = await db.from('training_jobs').select('id').limit(1)
  return error ? error.message : null
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function loadModel(db: Db, modelId: string): Promise<ModelRow | null> {
  const { data, error } = await db
    .from('models')
    .select('id, user_id, dataset_id, task, algorithm, target_column, feature_columns, hyperparameters')
    .eq('id', modelId)
    .maybeSingle()
  if (error) fail('load model', error)
  if (!data) return null
  const parsed = modelRowSchema.safeParse(data)
  if (!parsed.success) {
    throw new ModelConfigError(`Model configuration is invalid: ${parsed.error.issues[0]?.message ?? 'unknown'}`)
  }
  return parsed.data
}

export async function loadDataset(db: Db, datasetId: string): Promise<DatasetRow | null> {
  const { data, error } = await db.from('datasets').select('id, storage_path, status').eq('id', datasetId).maybeSingle()
  if (error) fail('load dataset', error)
  return data ? datasetRowSchema.parse(data) : null
}

/**
 * A short-lived signed URL for the dataset object. The training thread
 * streams the response body straight into the CSV parser, so the file is
 * never held in memory whole.
 */
export async function signDatasetUrl(db: Db, storagePath: string, ttlSeconds: number): Promise<string> {
  const { data, error } = await db.storage.from(DATASETS_BUCKET).createSignedUrl(storagePath, ttlSeconds)
  if (error || !data) fail(`sign ${storagePath}`, error)
  return data.signedUrl
}

// ---------------------------------------------------------------------------
// Job state. Every transition out of claimed/running is fenced on claimed_by.
// ---------------------------------------------------------------------------

/** claimed -> running. False if the claim was lost before we got here. */
export async function markJobRunning(db: Db, jobId: string, workerId: string): Promise<boolean> {
  const now = new Date().toISOString()
  const { data, error } = await db
    .from('training_jobs')
    .update({ status: 'running', started_at: now, heartbeat_at: now, error_message: null })
    .eq('id', jobId)
    .eq('claimed_by', workerId)
    .eq('status', 'claimed')
    .select('id')
  if (error) fail('mark job running', error)
  return (data?.length ?? 0) > 0
}

/** Bump heartbeat_at. False if this worker no longer owns the running job. */
export async function heartbeat(db: Db, jobId: string, workerId: string): Promise<boolean> {
  const { data, error } = await db
    .from('training_jobs')
    .update({ heartbeat_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('claimed_by', workerId)
    .eq('status', 'running')
    .select('id')
  if (error) fail('heartbeat', error)
  return (data?.length ?? 0) > 0
}

export async function markJobSucceeded(db: Db, jobId: string, workerId: string): Promise<boolean> {
  const { data, error } = await db
    .from('training_jobs')
    .update({ status: 'succeeded', finished_at: new Date().toISOString(), error_message: null })
    .eq('id', jobId)
    .eq('claimed_by', workerId)
    .in('status', ['claimed', 'running'])
    .select('id')
  if (error) fail('mark job succeeded', error)
  return (data?.length ?? 0) > 0
}

export async function markJobFailed(db: Db, jobId: string, workerId: string, message: string): Promise<boolean> {
  const { data, error } = await db
    .from('training_jobs')
    .update({ status: 'failed', finished_at: new Date().toISOString(), error_message: message })
    .eq('id', jobId)
    .eq('claimed_by', workerId)
    .in('status', ['claimed', 'running'])
    .select('id')
  if (error) fail('mark job failed', error)
  return (data?.length ?? 0) > 0
}

/**
 * Put a job back on the queue (graceful shutdown or a retryable infra error).
 * `attempt` is restored when the release is voluntary so a redeploy does not
 * burn one of the job's bounded retries.
 */
export async function requeueJob(
  db: Db,
  jobId: string,
  workerId: string,
  opts: { attempt?: number }
): Promise<boolean> {
  const { data, error } = await db
    .from('training_jobs')
    .update({
      status: 'queued',
      claimed_by: null,
      claimed_at: null,
      started_at: null,
      heartbeat_at: null,
      error_message: null,
      ...(opts.attempt !== undefined ? { attempt: opts.attempt } : {}),
    })
    .eq('id', jobId)
    .eq('claimed_by', workerId)
    .in('status', ['claimed', 'running'])
    .select('id')
  if (error) fail('requeue job', error)
  return (data?.length ?? 0) > 0
}

/**
 * models.status follows the job. Only called after a fenced job write
 * matched, so it cannot regress a model whose job moved to another worker.
 */
export async function setModelStatus(
  db: Db,
  modelId: string,
  status: 'queued' | 'training' | 'succeeded' | 'failed'
): Promise<void> {
  const { error } = await db.from('models').update({ status }).eq('id', modelId)
  if (error) fail(`set model status ${status}`, error)
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export async function deleteJobMetrics(db: Db, jobId: string): Promise<void> {
  const { error } = await db.from('training_metrics').delete().eq('job_id', jobId)
  if (error) fail('delete stale metrics', error)
}

export interface MetricRow {
  epoch: number
  loss: number
  elapsed_ms: number
}

/**
 * Idempotent insert keyed on (job_id, epoch). A late flush from a previous
 * owner of the job, or a retried batch, lands as a no-op instead of a unique
 * violation that would jam the sink.
 */
export async function insertMetrics(db: Db, jobId: string, rows: MetricRow[]): Promise<void> {
  if (rows.length === 0) return
  const { error } = await db
    .from('training_metrics')
    .upsert(
      rows.map((r) => ({ job_id: jobId, epoch: r.epoch, loss: r.loss, elapsed_ms: r.elapsed_ms })),
      { onConflict: 'job_id,epoch', ignoreDuplicates: true }
    )
  if (error) fail('insert metrics', error)
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

export async function nextArtifactVersion(db: Db, modelId: string): Promise<number> {
  const { data, error } = await db
    .from('model_artifacts')
    .select('version')
    .eq('model_id', modelId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) fail('read artifact versions', error)
  const current = z.object({ version: z.number().int() }).nullable().parse(data)
  return (current?.version ?? 0) + 1
}

/**
 * upsert: true on purpose. The path is deterministic per (model, version) and
 * a version only becomes real once its model_artifacts row exists, so an
 * orphaned object from a crash between upload and insert is simply overwritten
 * by the retry instead of blocking it forever.
 */
export async function uploadArtifact(db: Db, storagePath: string, json: string): Promise<void> {
  const { error } = await db.storage
    .from(MODELS_BUCKET)
    .upload(storagePath, new Blob([json], { type: 'application/json' }), {
      contentType: 'application/json',
      upsert: true,
    })
  if (error) fail(`upload artifact ${storagePath}`, error)
}

export async function removeArtifactObject(db: Db, storagePath: string): Promise<void> {
  await db.storage.from(MODELS_BUCKET).remove([storagePath])
}

export async function insertArtifactRow(
  db: Db,
  row: { model_id: string; job_id: string; version: number; storage_path: string; metrics: unknown }
): Promise<string> {
  const { data, error } = await db.from('model_artifacts').insert(row).select('id').single()
  if (error) fail('insert artifact row', error)
  return z.object({ id: z.string().uuid() }).parse(data).id
}

export async function deleteArtifactRow(db: Db, artifactId: string): Promise<void> {
  await db.from('model_artifacts').delete().eq('id', artifactId)
}
