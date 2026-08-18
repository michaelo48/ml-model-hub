import 'dotenv/config'
import { z } from 'zod'

const schema = z.object({
  SUPABASE_URL: z.string().url(),
  // Secret key: the worker is a trusted backend and bypasses RLS.
  SUPABASE_SECRET_KEY: z.string().min(1),
  WORKER_ID: z.string().min(1).default(`worker-${process.pid}`),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(3000),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(10000),
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
