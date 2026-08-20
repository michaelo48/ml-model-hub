import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { AppShell } from '@/components/layout/AppShell'

/**
 * Authenticated shell. proxy.ts already redirects anonymous requests, but the
 * layout re-checks so a Server Component can never render without a user.
 */
export default async function AppLayout({ children }: LayoutProps<'/'>) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name')
    .eq('id', user.id)
    .maybeSingle()

  return <AppShell userLabel={profile?.display_name ?? user.email ?? 'Account'}>{children}</AppShell>
}
