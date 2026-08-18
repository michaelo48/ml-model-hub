import Link from 'next/link'

export default function AuthLayout({ children }: LayoutProps<'/'>) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-bg px-4 py-12">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 block font-mono text-sm font-medium tracking-tight text-fg">
          ModelForge
        </Link>
        <div className="rounded-sm border border-line bg-surface p-6">{children}</div>
      </div>
    </main>
  )
}
