import Link from 'next/link'
import type { ReactNode } from 'react'
import { signOut } from '@/lib/auth/actions'

export function AppShell({ userLabel, children }: { userLabel: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-bg text-fg">
      <header className="border-b border-line">
        <div className="mx-auto flex h-12 w-full max-w-6xl items-center justify-between px-6">
          <nav className="flex items-center gap-6 text-sm">
            <Link href="/dashboard" className="font-mono font-medium tracking-tight text-fg">
              ModelForge
            </Link>
            <Link href="/dashboard" className="text-fg-muted hover:text-fg">
              Dashboard
            </Link>
          </nav>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-fg-muted">{userLabel}</span>
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
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
    </div>
  )
}

export function PageHeader({
  title,
  description,
  action,
}: {
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-fg-muted">{description}</p> : null}
      </div>
      {action}
    </div>
  )
}

export function StatusBadge({ status }: { status: string }) {
  const tone: Record<string, string> = {
    ready: 'text-success border-success/40',
    succeeded: 'text-success border-success/40',
    uploading: 'text-warning border-warning/40',
    queued: 'text-warning border-warning/40',
    claimed: 'text-warning border-warning/40',
    training: 'text-warning border-warning/40',
    running: 'text-warning border-warning/40',
    invalid: 'text-danger border-danger/40',
    failed: 'text-danger border-danger/40',
    draft: 'text-fg-muted border-line',
  }
  return (
    <span className={`inline-block rounded-sm border px-1.5 py-0.5 font-mono text-xs ${tone[status] ?? 'text-fg-muted border-line'}`}>
      {status}
    </span>
  )
}

/**
 * One labelled value in a `<dl>` row. Monospace and tabular by default, so a
 * row of figures stays column-aligned as values change (training page) or
 * differ in magnitude (model metrics), and so column names and ids read as
 * the literals they are. `prose` opts out for values that are neither: a
 * status badge, a link, a human-readable optimizer name.
 */
export function Stat({ label, prose, children }: { label: string; prose?: boolean; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className={prose ? 'mt-0.5' : 'mt-0.5 font-mono text-sm tabular-nums'}>{children}</dd>
    </div>
  )
}

/**
 * The panel shown where a table or metric block would be once there is data.
 * Same border and surface as the table it replaces, so the page does not
 * change shape when the first row arrives.
 */
export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-sm border border-line bg-surface px-4 py-6 text-center text-sm text-fg-muted">{children}</p>
  )
}
