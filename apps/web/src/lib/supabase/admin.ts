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
export const createAdminClient = () =>
  createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  )
