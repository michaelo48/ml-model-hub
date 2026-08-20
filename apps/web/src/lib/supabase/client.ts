import { createBrowserClient } from '@supabase/ssr'
import type { Database } from './database.types'

/** Browser client: publishable key + the user's session. All reads go through RLS. */
export const createClient = () =>
  createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
  )
