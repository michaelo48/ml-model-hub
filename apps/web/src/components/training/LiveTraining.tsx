'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'
import { formatDuration, formatNumber } from '@/lib/charts/scale'
import {
  acceptsPoint,
  decideRefetch,
  fetchAllMetrics,
  isTerminal,
  mergePoints,
  metricsWindow,
  normalizeBatch,
  type JobRow,
  type MetricPoint,
} from '@/lib/training/metrics'
import { Stat, StatusBadge } from '@/components/layout/AppShell'
import { LossChart } from './LossChart'

type MetricRow = {
  job_id: string
  epoch: number
  loss: number
  val_loss: number | null
  elapsed_ms: number | null
  created_at: string
}

/**
 * Reconciliation poll. Realtime is the fast path, not the source of truth:
 * under a sustained burst (the worker can write ~200 rows/s) a channel has
 * been observed to stop delivering, including the final job UPDATE, while
 * still reporting SUBSCRIBED. So while the job is not terminal the page also
 * re-reads the job row on a timer and catches up on any epochs it has not
 * seen. Cheap (one row, plus only epochs past the last known one); the
 * terminal transition then triggers the full merge that closes any gaps in
 * the middle. Faster while the channel is known to be down.
 */
const RECONCILE_LIVE_MS = 5000
const RECONCILE_DOWN_MS = 3000

/**
 * Owns the live state of one training job: the job row (status, timestamps,
 * error) and its metrics. Seeded from the server render, then kept current by
 * Supabase Realtime under RLS (the owner may read training_metrics and
 * training_jobs, see the phase1 migration). Safeguards that keep the curve
 * trustworthy:
 *   - metric rows are accepted only inside the current attempt's window
 *     (created_at >= claimed_at, see metricsWindow), so a requeue/reclaim
 *     can never stitch two attempts together however the worker's delete
 *     races our reads;
 *   - every (re)subscribe triggers a refetch, closing the gap between the
 *     server render and the socket opening, and covering reconnects;
 *   - while the channel is not subscribed, the component polls instead;
 *   - Realtime delivers one message per inserted row (the worker writes up to
 *     200 per flush), so rows are buffered and applied once per animation
 *     frame rather than one React render per row.
 */
export function LiveTraining({
  initialJob,
  initialPoints,
  totalEpochs,
  modelId,
}: {
  initialJob: JobRow
  initialPoints: MetricPoint[]
  totalEpochs: number | null
  modelId: string
}) {
  const [job, setJob] = useState(initialJob)
  const [points, setPoints] = useState(initialPoints)
  // 'connecting' hides the reconnect marker during the initial handshake.
  const [conn, setConn] = useState<'connecting' | 'live' | 'down'>('connecting')
  // Latest job row for event handlers, without re-creating the subscription.
  // Written synchronously in the Realtime handler too, so a metric event that
  // follows a claim in the same tick is judged against the new claimed_at.
  const jobRef = useRef(job)
  useEffect(() => {
    jobRef.current = job
  }, [job])
  // The job as it was at render time; the subscription effect keys on the id
  // only, so a parent re-render cannot tear the channel down.
  const initialRef = useRef(initialJob)

  const terminal = isTerminal(job.status)

  // Realtime subscription. Skipped entirely for jobs that were already
  // finished at render time: nothing will change.
  useEffect(() => {
    const jobId = initialRef.current.id
    if (isTerminal(initialRef.current.status)) return
    const supabase = createClient()
    let cancelled = false

    // rAF batching for metric inserts (see the component comment).
    let pending: MetricPoint[] = []
    let frame: number | null = null
    const flush = () => {
      frame = null
      if (pending.length === 0) return
      const batch = normalizeBatch(pending)
      pending = []
      setPoints((prev) => mergePoints(prev, batch))
    }
    const enqueue = (p: MetricPoint) => {
      pending.push(p)
      if (frame == null) frame = requestAnimationFrame(flush)
    }

    async function refetch(mode: 'replace' | 'merge') {
      try {
        const jobRes = await supabase.from('training_jobs').select('*').eq('id', jobId).maybeSingle()
        if (cancelled) return
        const current = jobRes.data ?? jobRef.current
        const metrics = await fetchAllMetrics(supabase, jobId, metricsWindow(current))
        if (cancelled) return
        if (mode === 'replace') {
          pending = []
          setPoints(metrics)
        } else {
          setPoints((prev) => mergePoints(prev, metrics))
        }
        if (jobRes.data) {
          jobRef.current = jobRes.data
          setJob(jobRes.data)
        }
      } catch {
        // Transient; the next tick or event will try again.
      }
    }

    let channel: RealtimeChannel | null = null
    void (async () => {
      // Attach the user's JWT to the channel BEFORE subscribing. Without this,
      // realtime-js sends the join while the token is still being read from
      // the cookie store; the token then arrives mid-join and is never pushed
      // to the channel, so Realtime evaluates RLS as anon and silently
      // delivers nothing (the channel still reports SUBSCRIBED). Verified
      // against @supabase/realtime-js 2.112.
      let authed = true
      try {
        await supabase.realtime.setAuth()
      } catch {
        authed = false
      }
      if (cancelled) return
      // No token means the channel will evaluate as anon and stay silent:
      // say so, and let the polling fallback be the visible source of truth.
      if (!authed) setConn('down')
      channel = supabase
        .channel(`job:${jobId}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'training_metrics', filter: `job_id=eq.${jobId}` },
          (payload: RealtimePostgresChangesPayload<MetricRow>) => {
            const row = payload.new
            if (!('epoch' in row)) return
            if (!acceptsPoint(jobRef.current, row.created_at)) return
            enqueue({ epoch: row.epoch, loss: row.loss, val_loss: row.val_loss, elapsed_ms: row.elapsed_ms })
          }
        )
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'training_jobs', filter: `id=eq.${jobId}` },
          (payload: RealtimePostgresChangesPayload<JobRow>) => {
            const next = payload.new
            if (!('id' in next)) return
            const decision = decideRefetch(jobRef.current, next)
            jobRef.current = next
            setJob(next)
            switch (decision) {
              case 'clear':
                pending = []
                setPoints([])
                break
              case 'replace':
                void refetch('replace')
                break
              case 'merge':
                void refetch('merge')
                break
              case 'none':
                break
            }
          }
        )
        .subscribe((status) => {
          if (cancelled) return
          if (status === 'SUBSCRIBED') {
            setConn('live')
            void refetch('merge')
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            // A failed handshake is a dead channel, first attempt or not.
            setConn('down')
          } else {
            // CLOSED: ambiguous during the handshake (StrictMode double mount),
            // a real drop afterwards.
            setConn((c) => (c === 'connecting' ? c : 'down'))
          }
        })
    })()

    return () => {
      cancelled = true
      if (frame != null) cancelAnimationFrame(frame)
      if (channel) void supabase.removeChannel(channel)
    }
  }, [initialJob.id])

  // Reconciliation poll (see RECONCILE_*). Runs whenever the job is not
  // terminal; cadence depends on whether the channel is believed healthy.
  const lastEpochRef = useRef(0)
  useEffect(() => {
    lastEpochRef.current = points.length > 0 ? points[points.length - 1]!.epoch : 0
  }, [points])
  useEffect(() => {
    if (terminal) return
    const supabase = createClient()
    const jobId = job.id
    let busy = false
    const tick = async () => {
      if (busy) return
      busy = true
      try {
        const jobRes = await supabase.from('training_jobs').select('*').eq('id', jobId).maybeSingle()
        if (!jobRes.data) return
        const decision = decideRefetch(jobRef.current, jobRes.data)
        const current = jobRes.data
        jobRef.current = current
        setJob(current)
        if (decision === 'clear') {
          setPoints([])
          return
        }
        // Full window on an attempt/status change, incremental otherwise.
        const after = decision === 'none' ? lastEpochRef.current : 0
        const metrics = await fetchAllMetrics(supabase, jobId, metricsWindow(current), after)
        if (decision === 'replace') setPoints(metrics)
        else if (metrics.length > 0) setPoints((prev) => mergePoints(prev, metrics))
      } catch {
        // Transient; try again next tick.
      } finally {
        busy = false
      }
    }
    const id = setInterval(() => void tick(), conn === 'live' ? RECONCILE_LIVE_MS : RECONCILE_DOWN_MS)
    return () => clearInterval(id)
  }, [conn, terminal, job.id])

  const now = useNow(!terminal)

  const last = points[points.length - 1]
  const best = useMemo(() => {
    let b = Infinity
    for (const p of points) if (p.loss < b) b = p.loss
    return b === Infinity ? null : b
  }, [points])

  const elapsedMs = elapsed(job, now)
  const live = !terminal
  const hasVal = points.some((p) => p.val_loss != null)

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <StatusBadge status={job.status} />
        <span className="text-fg-muted">{narrative(job, last, totalEpochs)}</span>
        {job.claimed_by ? <span className="font-mono text-xs text-fg-muted">worker {job.claimed_by}</span> : null}
        {job.attempt > 1 ? <span className="font-mono text-xs text-fg-muted">attempt {job.attempt}</span> : null}
        {live && conn === 'down' ? <span className="font-mono text-xs text-warning">reconnecting</span> : null}
      </div>

      {job.status === 'failed' && job.error_message ? (
        <p role="alert" className="mb-4 rounded-sm border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger">
          {job.error_message}
        </p>
      ) : null}

      {job.status === 'succeeded' ? (
        <p className="mb-4 text-sm">
          <Link href={`/models/${modelId}`} className="text-accent hover:text-accent-hover">
            View the trained model and its artifact
          </Link>
        </p>
      ) : null}

      <dl className="mb-4 grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-5">
        <Stat label="Epoch">
          {last ? (
            <>
              {last.epoch.toLocaleString()}
              {totalEpochs ? <span className="text-fg-muted"> / {totalEpochs.toLocaleString()}</span> : null}
            </>
          ) : (
            <Dash />
          )}
        </Stat>
        <Stat label="Train loss">{last ? formatNumber(last.loss) : <Dash />}</Stat>
        {hasVal ? (
          <Stat label="Val loss">{last?.val_loss != null ? formatNumber(last.val_loss) : <Dash />}</Stat>
        ) : null}
        <Stat label="Best loss">{best != null ? formatNumber(best) : <Dash />}</Stat>
        <Stat label="Elapsed">{elapsedMs != null ? formatDuration(elapsedMs) : <Dash />}</Stat>
      </dl>

      <div className="rounded-sm border border-line bg-surface px-3 pt-3 pb-1">
        <LossChart points={points} totalEpochs={totalEpochs} live={live} />
      </div>
    </>
  )
}

/**
 * Wall clock that ticks once a second while `active`, null otherwise and
 * during server rendering (so the elapsed readout never causes a hydration
 * mismatch).
 */
function useNow(active: boolean): number | null {
  return useSyncExternalStore(
    (onChange) => {
      if (!active) return () => {}
      const id = setInterval(onChange, 1000)
      return () => clearInterval(id)
    },
    () => (active ? Math.floor(Date.now() / 1000) * 1000 : null),
    () => null
  )
}

function narrative(job: JobRow, last: MetricPoint | undefined, totalEpochs: number | null): string {
  switch (job.status) {
    case 'queued':
      return 'Waiting for a worker to pick this job up.'
    case 'claimed':
      return 'A worker claimed the job and is loading the dataset.'
    case 'running':
      if (!last) return 'Training started.'
      return totalEpochs && totalEpochs > 1 ? `Training, epoch ${last.epoch} of ${totalEpochs}.` : 'Training.'
    case 'succeeded':
      return 'Training finished and the artifact was saved.'
    case 'failed':
      return 'Training failed.'
  }
}

function elapsed(job: JobRow, now: number | null): number | null {
  if (!job.started_at) return null
  const start = new Date(job.started_at).getTime()
  if (job.finished_at) return new Date(job.finished_at).getTime() - start
  if (now == null) return null
  return Math.max(0, now - start)
}

function Dash() {
  return <span className="text-fg-muted">-</span>
}
