import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { signOut } from '@/lib/auth/actions'

export default async function DashboardPage() {
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

  const name = profile?.display_name ?? user.email

  return (
    <main className="min-h-screen bg-bg text-fg">
      <header className="border-b border-line">
        <div className="mx-auto flex h-12 max-w-5xl items-center justify-between px-6">
          <span className="font-mono text-sm font-medium tracking-tight">ModelForge</span>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-fg-muted">{name}</span>
            <form action={signOut}>
              <button
                type="submit"
                className="rounded-sm border border-line px-2.5 py-1 text-fg hover:bg-surface"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-6 py-8">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-2 text-sm text-fg-muted">
          Datasets, training jobs, and models will appear here.
        </p>
      </div>
    </main>
  )
}
