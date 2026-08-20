import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'

/** One epoch on the loss curve. Kept minimal so thousands of points stay cheap. */
export interface MetricPoint {
  epoch: number
  loss: number
  val_loss: number | null
  elapsed_ms: number | null
}

export type JobRow = Database['public']['Tables']['training_jobs']['Row']
export type JobStatus = Database['public']['Enums']['job_status']
type JobLike = Pick<JobRow, 'status' | 'claimed_at'>

/** PostgREST caps a single response at 1000 rows; epochs go up to 5000. */
const PAGE = 1000

/**
 * Which metric rows belong to the job's *current* attempt.
 *
 * The worker deletes a job's old metrics only after it has marked the job
 * running (and, on graceful shutdown, only after requeueing it), so any fetch
 * that races those writes can return rows from a previous attempt. The
 * reliable discriminator is time: claim_training_job stamps claimed_at with
 * the database clock and every metric row gets created_at from the same
 * clock, so rows at or after claimed_at are this attempt's. Requeue and the
 * reaper null claimed_at, so a queued job has no current attempt at all.
 *
 *   - 'none':  queued. Nothing is current; show an empty curve.
 *   - 'since': an attempt is (or was) in flight; rows >= claimed_at count.
 *   - 'all':   terminal with no claimed_at (reaped to failed). Whatever is
 *              left is the last thing that happened; show it.
 */
export type MetricsWindow = { kind: 'none' } | { kind: 'since'; since: string } | { kind: 'all' }

export function metricsWindow(job: JobLike): MetricsWindow {
  if (job.status === 'queued') return { kind: 'none' }
  if (job.claimed_at) return { kind: 'since', since: job.claimed_at }
  return isTerminal(job.status) ? { kind: 'all' } : { kind: 'none' }
}

/** Whether a metric row created at `createdAt` belongs to the job's current attempt. */
export function acceptsPoint(job: JobLike, createdAt: string): boolean {
  const w = metricsWindow(job)
  if (w.kind === 'none') return false
  if (w.kind === 'all') return true
  return Date.parse(createdAt) >= Date.parse(w.since)
}

/**
 * What the live view should do with its points when the job row changes.
 *
 *   - 'clear':   back to queued (shutdown requeue or reaper). The old attempt's
 *                rows are about to be deleted; drop them now rather than
 *                racing the delete with a fetch.
 *   - 'replace': a new attempt started (claimed_at changed). Anything held
 *                locally is from the old attempt; refetch inside the new
 *                window and replace wholesale.
 *   - 'merge':   same attempt, different status (claimed -> running,
 *                running -> succeeded). Refetch to catch rows the socket may
 *                have dropped and merge; both sides are within the same
 *                window so nothing stale can survive.
 *   - 'none':    heartbeat or other no-op update.
 */
export type RefetchDecision = 'clear' | 'replace' | 'merge' | 'none'

export function decideRefetch(prev: JobLike, next: JobLike): RefetchDecision {
  if (next.status === 'queued') return 'clear'
  if (next.claimed_at !== prev.claimed_at) return 'replace'
  if (next.status !== prev.status) return 'merge'
  return 'none'
}

/**
 * Load every metric row for a job's current attempt with epoch > afterEpoch
 * (default: all of them), in epoch order. Works with both the server and
 * browser clients (both run under RLS). Pages by epoch rather than offset so
 * rows inserted mid-fetch cannot shift the window. Note: up to 5 sequential round trips for a 5000-epoch job; if that
 * ever matters on the server render, replace with a get_job_metrics(job_id)
 * RPC or raise PostgREST max-rows.
 */
export async function fetchAllMetrics(
  supabase: SupabaseClient<Database>,
  jobId: string,
  window: MetricsWindow,
  afterEpoch = 0
): Promise<MetricPoint[]> {
  if (window.kind === 'none') return []
  const out: MetricPoint[] = []
  let after = afterEpoch
  for (;;) {
    let q = supabase
      .from('training_metrics')
      .select('epoch, loss, val_loss, elapsed_ms')
      .eq('job_id', jobId)
      .gt('epoch', after)
    if (window.kind === 'since') q = q.gte('created_at', window.since)
    const { data, error } = await q.order('epoch', { ascending: true }).limit(PAGE)
    if (error) throw new Error(error.message)
    if (!data || data.length === 0) break
    for (const row of data) {
      out.push(row)
      after = row.epoch
    }
    if (data.length < PAGE) break
  }
  return out
}

/**
 * Merge two epoch-sorted lists in one pass; `incoming` wins on equal epochs.
 * Used both for Realtime batches (incoming = this frame's rows) and for
 * refetches (incoming = what the database says). O(n + m), never mutates.
 */
export function mergePoints(base: MetricPoint[], incoming: MetricPoint[]): MetricPoint[] {
  if (incoming.length === 0) return base
  if (base.length === 0) return incoming
  const out: MetricPoint[] = []
  let i = 0
  let j = 0
  for (;;) {
    const a = base[i]
    const b = incoming[j]
    if (a === undefined && b === undefined) break
    if (b === undefined || (a !== undefined && a.epoch < b.epoch)) {
      out.push(a as MetricPoint)
      i++
    } else if (a === undefined || b.epoch < a.epoch) {
      out.push(b)
      j++
    } else {
      out.push(b)
      i++
      j++
    }
  }
  return out
}

/**
 * Sort a batch of arbitrary-order rows by epoch and drop duplicate epochs
 * (last one wins), so it can be handed to mergePoints.
 */
export function normalizeBatch(rows: MetricPoint[]): MetricPoint[] {
  if (rows.length <= 1) return rows
  const sorted = rows.slice().sort((a, b) => a.epoch - b.epoch)
  const out: MetricPoint[] = []
  for (const p of sorted) {
    const last = out[out.length - 1]
    if (last && last.epoch === p.epoch) out[out.length - 1] = p
    else out.push(p)
  }
  return out
}

/** Index of the recorded point whose epoch is nearest to `epoch` (binary search). */
export function nearestPointIndex(points: MetricPoint[], epoch: number): number {
  let lo = 0
  let hi = points.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((points[mid]?.epoch ?? Infinity) < epoch) lo = mid + 1
    else hi = mid
  }
  const here = points[lo]
  const before = points[lo - 1]
  if (here && before && Math.abs(before.epoch - epoch) < Math.abs(here.epoch - epoch)) return lo - 1
  return lo
}

/** Terminal job states: no more metrics or status changes will arrive. */
export function isTerminal(status: JobStatus): boolean {
  return status === 'succeeded' || status === 'failed'
}
