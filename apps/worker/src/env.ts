import 'dotenv/config'
import { z } from 'zod'

/** `STALE_JOB_AFTER` accepts a Postgres-style interval of the form "<n> seconds|minutes|hours". */
const STALE_RE = /^(\d+)\s+(seconds?|minutes?|hours?)$/
const UNIT_MS: Record<string, number> = { second: 1000, minute: 60_000, hour: 3_600_000 }

export function staleAfterMs(value: string): number | null {
  const m = STALE_RE.exec(value.trim())
  if (!m) return null
  const unit = m[2]!.replace(/s$/, '')
  return Number(m[1]) * UNIT_MS[unit]!
}

const schema = z
  .object({
    SUPABASE_URL: z.string().url(),
    // Secret key: the worker is a trusted backend and bypasses RLS.
    SUPABASE_SECRET_KEY: z.string().min(1),
    WORKER_ID: z.string().min(1).default(`worker-${process.pid}`),
    POLL_INTERVAL_MS: z.coerce.number().int().positive().default(3000),
    HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(10000),
    /** Buffered epoch metrics are inserted at most this often. */
    METRICS_FLUSH_MS: z.coerce.number().int().positive().default(250),
    /** How often to run the stale-job reaper. */
    REAP_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
    /** A claimed/running job with no heartbeat for this long is reaped. "<n> seconds|minutes|hours". */
    STALE_JOB_AFTER: z
      .string()
      .trim()
      .default('5 minutes')
      .refine((v) => staleAfterMs(v) !== null, 'must look like "5 minutes", "90 seconds" or "1 hour"'),
    /** Attempts (claims) before a job is failed for good. Shared with reap_stale_jobs. */
    MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
    /** How long to wait for an in-flight job to release on SIGTERM before exiting anyway. */
    SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().default(25000),
    /** Lifetime of the signed dataset URL handed to the training thread. */
    DATASET_URL_TTL_SECONDS: z.coerce.number().int().positive().default(600),
    /** Abort deadline for every Supabase request (DB and storage). */
    REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
    /** How often to sweep the storage buckets for objects no row points at. 0 disables. */
    SWEEP_INTERVAL_MS: z.coerce.number().int().nonnegative().default(6 * 3_600_000),
    /** An unreferenced object younger than this is left alone: its row may still be on the way. */
    SWEEP_GRACE_MS: z.coerce.number().int().positive().default(3_600_000),
  })
  .superRefine((env, ctx) => {
    // A worker must be able to miss a couple of heartbeats (GC pause, slow
    // network) without being declared dead and having its job handed away.
    const stale = staleAfterMs(env.STALE_JOB_AFTER)
    if (stale !== null && env.HEARTBEAT_INTERVAL_MS * 3 > stale) {
      ctx.addIssue({
        code: 'custom',
        path: ['HEARTBEAT_INTERVAL_MS'],
        message: `must be at most a third of STALE_JOB_AFTER (${env.STALE_JOB_AFTER} = ${stale} ms)`,
      })
    }
  })

export type Env = z.infer<typeof schema>

export function loadEnv(): Env {
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid worker environment: ${issues}`)
  }
  return parsed.data
}
