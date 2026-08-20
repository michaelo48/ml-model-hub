import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'

/**
 * Usage limits live in public.app_limits and are enforced by Postgres triggers
 * (see supabase/migrations/*_usage_limits.sql). The web app only reads them to
 * show usage; the database is the sole gate.
 */
export type LimitKey =
  | 'max_datasets_per_user'
  | 'dataset_uploads_per_hour'
  | 'dataset_edits_per_hour'
  | 'training_jobs_per_hour'

const LIMIT_KEYS: readonly LimitKey[] = [
  'max_datasets_per_user',
  'dataset_uploads_per_hour',
  'dataset_edits_per_hour',
  'training_jobs_per_hour',
]

/** SQLSTATE raised by the limit triggers (program_limit_exceeded). */
export const LIMIT_ERROR_CODE = '54000'

export interface DbError {
  code?: string
  message: string
  details?: string | null
  hint?: string | null
}

export function isLimitError(err: DbError | null | undefined): boolean {
  return err?.code === LIMIT_ERROR_CODE
}

/**
 * Message to show the user for a failed write. Limit errors carry a
 * human-readable message written by the trigger and are expected, so they are
 * returned as-is. Anything else is logged with `context` (so it is visible in
 * server logs) and replaced by `fallback` so internals are not surfaced.
 */
export function dbErrorMessage(err: DbError, context: string, fallback: string): string {
  if (isLimitError(err)) return err.message
  console.error(`[${context}] database error`, { code: err.code, message: err.message, details: err.details, hint: err.hint })
  return fallback
}

/** Reads every limit. Throws if the table is unreadable or a key is missing. */
export async function getLimits(supabase: SupabaseClient<Database>): Promise<Record<LimitKey, number>> {
  const { data, error } = await supabase.from('app_limits').select('key, value')
  if (error) throw new Error(`getLimits: ${error.message}`)
  const limits: Partial<Record<LimitKey, number>> = {}
  for (const row of data) {
    if ((LIMIT_KEYS as readonly string[]).includes(row.key)) limits[row.key as LimitKey] = row.value
  }
  const missing = LIMIT_KEYS.filter((k) => limits[k] === undefined)
  if (missing.length) throw new Error(`getLimits: app_limits is missing ${missing.join(', ')}`)
  return limits as Record<LimitKey, number>
}

/** How many datasets the signed-in user has (any status) and the cap. */
export async function getDatasetUsage(
  supabase: SupabaseClient<Database>
): Promise<{ used: number; max: number; remaining: number }> {
  const [{ count, error }, limits] = await Promise.all([
    supabase.from('datasets').select('id', { count: 'exact', head: true }),
    getLimits(supabase),
  ])
  if (error) throw new Error(`getDatasetUsage: ${error.message}`)
  const used = count ?? 0
  const max = limits.max_datasets_per_user
  return { used, max, remaining: Math.max(0, max - used) }
}
