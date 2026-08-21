'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import type { ActionResult } from '@/lib/result'
import { dbErrorMessage } from '@/lib/limits'
import { generateApiKey } from './keys'

const nameSchema = z.string().trim().max(60, 'Name must be 60 characters or fewer.').optional()

/**
 * Generate an API key for one of the user's models. Runs under the session,
 * so the api_keys insert policy (own row, own model) is the authorization.
 * The plaintext is returned exactly once and never stored.
 */
export async function createApiKey(
  modelId: string,
  name?: string
): Promise<ActionResult<{ id: string; plaintext: string; prefix: string }>> {
  if (!z.uuid().safeParse(modelId).success) return { ok: false, error: 'Bad model id.' }
  const parsedName = nameSchema.safeParse(name)
  if (!parsedName.success) {
    return { ok: false, error: 'Check the highlighted fields.', fieldErrors: { name: parsedName.error.issues[0]!.message } }
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }

  const key = generateApiKey()
  const { data, error } = await supabase
    .from('api_keys')
    .insert({
      user_id: user.id,
      model_id: modelId,
      name: parsedName.data || null,
      key_prefix: key.prefix,
      key_hash: key.hash,
    })
    .select('id')
    .single()
  const failed = 'Could not create the API key.'
  if (error) return { ok: false, error: dbErrorMessage(error, 'createApiKey', failed) }
  if (!data) return { ok: false, error: failed }

  revalidatePath(`/models/${modelId}`)
  return { ok: true, data: { id: data.id, plaintext: key.plaintext, prefix: key.prefix } }
}

/**
 * Revoke a key. Soft delete: the row stays so predictions_log keeps its
 * api_key_id and the usage dashboard can still attribute past traffic.
 * Idempotent; revoking twice is a no-op.
 */
export async function revokeApiKey(keyId: string): Promise<ActionResult<undefined>> {
  if (!z.uuid().safeParse(keyId).success) return { ok: false, error: 'Bad key id.' }
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }

  const { data, error } = await supabase
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', keyId)
    .is('revoked_at', null)
    .select('model_id')
    .maybeSingle()
  if (error) return { ok: false, error: dbErrorMessage(error, 'revokeApiKey', 'Could not revoke the key.') }
  if (data) revalidatePath(`/models/${data.model_id}`)
  return { ok: true, data: undefined }
}
