import type { Metadata } from 'next'
import { SignupForm } from '@/components/auth/SignupForm'
import { GitHubButton, OrDivider } from '@/components/auth/GitHubButton'

export const metadata: Metadata = { title: 'Create account' }

export default function SignupPage() {
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold tracking-tight text-fg">Create an account</h1>
      <p className="mb-6 text-sm text-fg-muted">
        Upload datasets, train models, and serve predictions.
      </p>
      <div className="flex flex-col gap-4">
        <GitHubButton label="Continue with GitHub" />
        <OrDivider />
        <SignupForm />
      </div>
    </>
  )
}
