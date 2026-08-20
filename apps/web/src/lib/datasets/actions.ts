'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import type { ActionResult } from '@/lib/result'
import type { Json } from '@/lib/supabase/database.types'
import { DATASET_LIMITS, DATASETS_BUCKET, analyzeCsv, type ColumnMeta } from '@/lib/csv/infer'
import { parseCsvText } from '@/lib/csv/parse'
import { dbErrorMessage } from '@/lib/limits'

const BUCKET = DATASETS_BUCKET

const createSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(120, 'Name is too long.'),
  sizeBytes: z
    .number()
    .int()
    .positive('File is empty.')
    .max(DATASET_LIMITS.maxBytes, `File exceeds ${DATASET_LIMITS.maxBytes / (1024 * 1024)} MB.`),
})

/**
 * Step 1 of upload. Reserves a datasets row in 'uploading' state and returns
 * the storage path the browser must upload to. The path is under the user's
 * folder, which is what the storage RLS policy checks.
 */
export async function createDataset(input: {
  name: string
  sizeBytes: number
}): Promise<ActionResult<{ id: string; storagePath: string }>> {
  const parsed = createSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' }
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }

  // The database trigger is the gate for the per-user cap and the hourly upload
  // rate; both reject with SQLSTATE 54000 and a message meant for the user.
  const id = crypto.randomUUID()
  const storagePath = `${user.id}/${id}.csv`

  const { error } = await supabase.from('datasets').insert({
    id,
    user_id: user.id,
    name: parsed.data.name,
    storage_path: storagePath,
    size_bytes: parsed.data.sizeBytes,
    status: 'uploading',
  })
  if (error) return { ok: false, error: dbErrorMessage(error, 'createDataset', 'Could not create the dataset. Try again.') }

  return { ok: true, data: { id, storagePath } }
}

/**
 * Step 2 of upload, after the browser has put the file in storage.
 * Downloads the object (through RLS, as the user), parses it, enforces the
 * limits, infers column metadata, and marks the row 'ready' or 'invalid'.
 * All limits are enforced here regardless of what the client showed.
 */
export async function finalizeDataset(
  datasetId: string
): Promise<ActionResult<{ status: 'ready' | 'invalid'; error?: string }>> {
  if (!z.string().uuid().safeParse(datasetId).success) return { ok: false, error: 'Bad dataset id.' }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }

  const { data: ds, error: dsErr } = await supabase
    .from('datasets')
    .select('id, storage_path, status')
    .eq('id', datasetId)
    .single()
  if (dsErr || !ds) return { ok: false, error: 'Dataset not found.' }
  if (ds.status !== 'uploading') return { ok: true, data: { status: ds.status === 'ready' ? 'ready' : 'invalid' } }

  // A file that failed validation is of no use: drop the row (so it does not
  // count against the dataset cap) and the object, and hand the reason back to
  // the upload form. Best effort: an orphaned object is harmless.
  const markInvalid = async (message: string) => {
    const { error: delErr } = await supabase.from('datasets').delete().eq('id', datasetId)
    if (delErr) console.error('[finalizeDataset] could not delete invalid dataset row', { datasetId, error: delErr.message })
    await supabase.storage.from(BUCKET).remove([ds.storage_path])
    revalidatePath('/dashboard')
    return { ok: true as const, data: { status: 'invalid' as const, error: message } }
  }

  const { data: blob, error: dlErr } = await supabase.storage.from(BUCKET).download(ds.storage_path)
  if (dlErr || !blob) return markInvalid('Uploaded file could not be read from storage.')

  if (blob.size > DATASET_LIMITS.maxBytes) {
    return markInvalid(`File is ${(blob.size / (1024 * 1024)).toFixed(1)} MB; the limit is 25 MB.`)
  }

  const analysis = analyzeCsv(await blob.text(), parseCsvText)
  if (!analysis.ok) return markInvalid(analysis.error)
  const columns: ColumnMeta[] = analysis.columns
  const rowCount = analysis.rowCount

  const { error: upErr } = await supabase
    .from('datasets')
    .update({
      status: 'ready',
      error: null,
      row_count: rowCount,
      size_bytes: blob.size,
      columns: columns as unknown as Json,
    })
    .eq('id', datasetId)
  if (upErr) return { ok: false, error: dbErrorMessage(upErr, 'finalizeDataset', 'Could not save the dataset. Try again.') }

  revalidatePath('/dashboard')
  revalidatePath(`/datasets/${datasetId}`)
  return { ok: true, data: { status: 'ready' } }
}

/** Removes the storage object and the row. Fails if a model still references it. */
export async function deleteDataset(datasetId: string): Promise<ActionResult<undefined>> {
  if (!z.string().uuid().safeParse(datasetId).success) return { ok: false, error: 'Bad dataset id.' }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }

  const { data: ds } = await supabase.from('datasets').select('storage_path').eq('id', datasetId).single()
  if (!ds) return { ok: false, error: 'Dataset not found.' }

  const { error } = await supabase.from('datasets').delete().eq('id', datasetId)
  if (error) {
    if (error.code === '23503') {
      return { ok: false, error: 'This dataset is used by a model. Delete the model first.' }
    }
    return { ok: false, error: error.message }
  }
  // Best effort: the row is gone either way; an orphaned object is harmless.
  // Remove the current version and the original upload (they differ once the
  // missing-values editor has written a <id>.v<n>.csv version).
  const original = `${user.id}/${datasetId}.csv`
  await supabase.storage
    .from(BUCKET)
    .remove(ds.storage_path === original ? [original] : [ds.storage_path, original])

  revalidatePath('/dashboard')
  return { ok: true, data: undefined }
}
