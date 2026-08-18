import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'

export default async function Home() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  return (
    <main className="flex min-h-screen flex-col bg-bg text-fg">
      <header className="border-b border-line">
        <div className="mx-auto flex h-12 max-w-5xl items-center justify-between px-6">
          <span className="font-mono text-sm font-medium tracking-tight">ModelForge</span>
          <nav className="flex items-center gap-4 text-sm">
            {user ? (
              <Link href="/dashboard" className="text-fg hover:text-accent">
                Dashboard
              </Link>
            ) : (
              <>
                <Link href="/login" className="text-fg-muted hover:text-fg">
                  Sign in
                </Link>
                <Link
                  href="/signup"
                  className="rounded-sm bg-accent px-3 py-1.5 text-accent-fg hover:bg-accent-hover"
                >
                  Create account
                </Link>
              </>
            )}
          </nav>
        </div>
      </header>

      <section className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center px-6 py-24">
        <h1 className="max-w-2xl text-4xl font-semibold leading-tight tracking-tight">
          Train small models on tabular data and serve them over HTTP.
        </h1>
        <p className="mt-4 max-w-xl text-base text-fg-muted">
          Upload a CSV, pick an algorithm and optimizer, watch the loss curve update live, then
          call your model with an API key.
        </p>
        <div className="mt-8 flex gap-3 text-sm">
          <Link
            href={user ? '/dashboard' : '/signup'}
            className="rounded-sm bg-accent px-4 py-2 text-accent-fg hover:bg-accent-hover"
          >
            {user ? 'Open dashboard' : 'Get started'}
          </Link>
          {!user ? (
            <Link
              href="/login"
              className="rounded-sm border border-line px-4 py-2 text-fg hover:bg-surface"
            >
              Sign in
            </Link>
          ) : null}
        </div>
      </section>
    </main>
  )
}
