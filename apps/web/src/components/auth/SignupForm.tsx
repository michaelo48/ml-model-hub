'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import { signUp, type AuthActionState } from '@/lib/auth/actions'
import { Field, FormMessage, SubmitButton } from '@/components/ui/form'

export function SignupForm() {
  const [state, action, pending] = useActionState<AuthActionState, FormData>(signUp, null)
  const fieldErrors = state && !state.ok ? state.fieldErrors ?? {} : {}

  if (state?.ok && state.data.message) {
    return (
      <div className="flex flex-col gap-4">
        <FormMessage tone="success">{state.data.message}</FormMessage>
        <Link
          href="/login"
          className="text-center text-sm text-fg underline underline-offset-2 hover:text-accent"
        >
          Go to sign in
        </Link>
      </div>
    )
  }

  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      {state && !state.ok ? <FormMessage tone="error">{state.error}</FormMessage> : null}

      <Field
        label="Name"
        name="displayName"
        type="text"
        autoComplete="name"
        required
        error={fieldErrors.displayName}
      />
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
        autoComplete="new-password"
        required
        minLength={8}
        hint="At least 8 characters."
        error={fieldErrors.password}
      />

      <SubmitButton pending={pending}>Create account</SubmitButton>

      <p className="text-center text-sm text-fg-muted">
        Already have an account?{' '}
        <Link href="/login" className="text-fg underline underline-offset-2 hover:text-accent">
          Sign in
        </Link>
      </p>
    </form>
  )
}
