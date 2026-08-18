import type { Metadata } from 'next'
import { LoginForm } from '@/components/auth/LoginForm'
import { GitHubButton, OrDivider } from '@/components/auth/GitHubButton'

export const metadata: Metadata = { title: 'Sign in' }

const ERROR_MESSAGES: Record<string, string> = {
  confirmation: 'That confirmation link is invalid or has expired. Try signing in, or sign up again.',
  oauth: 'GitHub sign-in did not complete. Please try again.',
}

export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  const params = await searchParams
  const next = typeof params.next === 'string' ? params.next : undefined
  const errorKey = typeof params.error === 'string' ? params.error : undefined
  const initialError = errorKey ? ERROR_MESSAGES[errorKey] : undefined

  return (
    <>
      <h1 className="mb-1 text-xl font-semibold tracking-tight text-fg">Sign in</h1>
      <p className="mb-6 text-sm text-fg-muted">Welcome back. Enter your details to continue.</p>
      <div className="flex flex-col gap-4">
        <GitHubButton next={next} label="Continue with GitHub" />
        <OrDivider />
        <LoginForm next={next} initialError={initialError} />
      </div>
    </>
  )
}
