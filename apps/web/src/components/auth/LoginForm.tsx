'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import { signIn, type AuthActionState } from '@/lib/auth/actions'
import { Field, FormMessage, SubmitButton } from '@/components/ui/form'

export function LoginForm({ next, initialError }: { next?: string; initialError?: string }) {
  const [state, action, pending] = useActionState<AuthActionState, FormData>(signIn, null)
  const fieldErrors = state && !state.ok ? state.fieldErrors ?? {} : {}

  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      {next ? <input type="hidden" name="next" value={next} /> : null}

      {state && !state.ok ? (
        <FormMessage tone="error">{state.error}</FormMessage>
      ) : initialError ? (
        <FormMessage tone="error">{initialError}</FormMessage>
      ) : null}

      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        required
        error={fieldErrors.email}
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        error={fieldErrors.password}
      />

      <SubmitButton pending={pending}>Sign in</SubmitButton>

      <p className="text-center text-sm text-fg-muted">
        No account yet?{' '}
        <Link href="/signup" className="text-fg underline underline-offset-2 hover:text-accent">
          Create one
        </Link>
      </p>
    </form>
  )
}
