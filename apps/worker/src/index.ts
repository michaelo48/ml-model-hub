import { createClient } from '@supabase/supabase-js'
import { loadEnv } from './env'
import { log } from './log'

/**
 * Worker entry point.
 *
 * Loop: poll training_jobs for a queued job, claim it atomically, train it
 * with @modelforge/ml while streaming per-epoch metrics, upload the artifact,
 * mark the job succeeded or failed. This file owns process lifecycle only;
 * claim/train/report logic lands in Phase 1 step 4 once the schema exists.
 */
async function main(): Promise<void> {
  const env = loadEnv()
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  let stopping = false
  const stop = (signal: string) => {
    if (stopping) return
    stopping = true
    log.info('shutdown requested', { signal })
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))

  log.info('worker started', {
    workerId: env.WORKER_ID,
    pollIntervalMs: env.POLL_INTERVAL_MS,
  })

  // Sanity check connectivity once at boot so misconfiguration fails fast.
  const { error } = await supabase.from('training_jobs').select('id', { head: true, count: 'exact' })
  if (error) {
    log.error('cannot reach training_jobs; check SUPABASE_URL / SUPABASE_SECRET_KEY', {
      error: error.message,
    })
    process.exitCode = 1
    return
  }

  while (!stopping) {
    // TODO(phase-1-step-4): claim a queued job with FOR UPDATE SKIP LOCKED,
    // train it, stream metrics, upload artifact, mark succeeded/failed.
    await sleep(env.POLL_INTERVAL_MS)
  }

  log.info('worker stopped', { workerId: env.WORKER_ID })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

main().catch((err: unknown) => {
  log.error('fatal', { error: err instanceof Error ? err.message : String(err) })
  process.exitCode = 1
})
