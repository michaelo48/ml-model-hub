'use server'

import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import type { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import type { ActionResult } from '@/lib/result'
import { loginSchema, signupSchema } from './schemas'

export type AuthActionState = ActionResult<{ message?: string }> | null

function fieldErrorsFrom(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? 'form')
    if (!(key in out)) out[key] = issue.message
  }
  return out
}

/** Only allow same-origin relative paths as post-login destinations. */
function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return '/dashboard'
  return next
}

export async function signIn(
  _prev: AuthActionState,
  formData: FormData
): Promise<AuthActionState> {
  const parsed = loginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    next: formData.get('next') || undefined,
  })
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error),
    }
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  })

  if (error) {
    // Deliberately vague: do not reveal whether the email exists.
    return { ok: false, error: 'Incorrect email or password.' }
  }

  redirect(safeNext(parsed.data.next))
}

export async function signUp(
  _prev: AuthActionState,
  formData: FormData
): Promise<AuthActionState> {
  const parsed = signupSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    displayName: formData.get('displayName'),
  })
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Check the highlighted fields.',
      fieldErrors: fieldErrorsFrom(parsed.error),
    }
  }

  const origin =
    (await headers()).get('origin') ?? process.env.NEXT_PUBLIC_SITE_URL ?? ''
  const supabase = await createClient()
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      emailRedirectTo: `${origin}/auth/callback`,
      // Read by the handle_new_user trigger to populate profiles.display_name.
      data: { display_name: parsed.data.displayName },
    },
  })

  if (error) {
    return { ok: false, error: error.message }
  }

  // When email confirmation is enabled, Supabase returns a user but no session.
  if (!data.session) {
    return {
      ok: true,
      data: { message: 'Check your inbox for a confirmation link, then sign in.' },
    }
  }

  redirect('/dashboard')
}

/**
 * Starts the GitHub OAuth flow. Supabase returns a provider URL; we redirect
 * there, and GitHub sends the user back to /auth/callback with a code.
 */
export async function signInWithGitHub(formData: FormData): Promise<void> {
  const next = safeNext(String(formData.get('next') ?? '') || undefined)
  const origin =
    (await headers()).get('origin') ?? process.env.NEXT_PUBLIC_SITE_URL ?? ''
  const supabase = await createClient()
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'github',
    options: {
      redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  })

  if (error || !data.url) {
    redirect('/login?error=oauth')
  }

  redirect(data.url)
}

export async function signOut(): Promise<void> {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect('/login')
}
