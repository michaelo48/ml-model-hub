import 'server-only'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

/**
 * Secret-key client. BYPASSES RLS. Server-only by construction (the
 * 'server-only' import makes any client bundle that pulls this in fail to build).
 *
 * Use it only where the caller is not a browser session: the inference route
 * (authenticated by API key), and server code that must write rows the user
 * is not allowed to write directly. Always scope queries explicitly.
 */
export const createAdminClient = () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY
  // Fail with the variable's name rather than a cryptic supabase-js error on
  // the first request that needs it.
  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set')
  if (!key) throw new Error('SUPABASE_SECRET_KEY is not set')
  return createSupabaseClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}
