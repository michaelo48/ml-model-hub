import { claimJob, createDb, probe, reapStaleJobs } from './db'
import { loadEnv } from './env'
import { runJob, type RunningJob } from './job'
import { log } from './log'

/**
 * Worker entry point. Owns process lifecycle only.
 *
 * Loop: reap stale jobs now and then, try to claim a queued job, run it to
 * completion (job.ts), repeat. One job at a time per process: training is
 * CPU-bound and runs on a dedicated thread, so a second concurrent job would
 * only compete for the same core. Scale by running more instances; the claim
 * is atomic so they never collide.
 *
 * Shutdown (SIGINT/SIGTERM): stop claiming, ask the in-flight job to stop
 * after its current epoch (it releases itself back to the queue), wait up to
 * SHUTDOWN_GRACE_MS, then exit. If the process dies hard instead, the reaper
 * on any surviving worker requeues the job once its heartbeat goes stale.
 */
async function main(): Promise<void> {
  const env = loadEnv()
  const db = createDb(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, env.REQUEST_TIMEOUT_MS)

  let stopping = false
  let running: RunningJob | null = null
  let wake: (() => void) | null = null

  const stop = (signal: string): void => {
    if (stopping) return
    stopping = true
    log.info('shutdown requested', { signal, inFlightJob: running?.jobId ?? null })
    running?.stop()
    wake?.()
    setTimeout(() => {
      log.error('shutdown grace period elapsed; exiting with job still in flight', { jobId: running?.jobId })
      process.exit(1)
    }, env.SHUTDOWN_GRACE_MS).unref()
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))

  log.info('worker started', {
    workerId: env.WORKER_ID,
    pollIntervalMs: env.POLL_INTERVAL_MS,
    heartbeatIntervalMs: env.HEARTBEAT_INTERVAL_MS,
  })

  // Fail fast on misconfiguration: one cheap query at boot.
  const probeError = await probe(db)
  if (probeError) {
    log.error('cannot reach training_jobs; check SUPABASE_URL / SUPABASE_SECRET_KEY', { error: probeError })
    process.exitCode = 1
    return
  }

  let lastReap = 0
  while (!stopping) {
    const now = Date.now()
    if (now - lastReap >= env.REAP_INTERVAL_MS) {
      lastReap = now
      try {
        const n = await reapStaleJobs(db, env.STALE_JOB_AFTER, env.MAX_ATTEMPTS)
        if (n > 0) log.warn('reaped stale jobs', { count: n })
      } catch (err) {
        log.warn('reaper failed', { error: err instanceof Error ? err.message : String(err) })
      }
    }

    let claimed = null
    try {
      claimed = await claimJob(db, env.WORKER_ID)
    } catch (err) {
      log.warn('claim failed', { error: err instanceof Error ? err.message : String(err) })
    }

    if (claimed) {
      log.info('job claimed', { jobId: claimed.id, modelId: claimed.model_id, attempt: claimed.attempt })
      await runJob({ db, env }, claimed, (r) => {
        running = r
        // A signal may have arrived between claim and thread start.
        if (stopping) r.stop()
      })
      running = null
      continue // drain the queue without sleeping
    }

    await sleep(env.POLL_INTERVAL_MS, (w) => (wake = w))
    wake = null
  }

  log.info('worker stopped', { workerId: env.WORKER_ID })
}

/** Sleep that can be cut short by calling the function handed to `onWake`. */
function sleep(ms: number, onWake: (wake: () => void) => void): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    onWake(() => {
      clearTimeout(t)
      resolve()
    })
  })
}

main().catch((err: unknown) => {
  log.error('fatal', { error: err instanceof Error ? err.message : String(err) })
  process.exitCode = 1
})
