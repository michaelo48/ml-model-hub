'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { modelDefinitionSchema, type ModelDefinition } from '@modelforge/ml'
import { createClient } from '@/lib/supabase/server'
import type { ActionResult } from '@/lib/result'
import type { Json } from '@/lib/supabase/database.types'
import { columnsSchema } from '@/lib/csv/infer'

function fieldErrorsFrom(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? 'form')
    if (!(key in out)) out[key] = issue.message
  }
  return out
}

/**
 * Create a model in 'draft'. Validates the definition against the dataset's
 * actual columns: target and features must exist, be numeric or boolean, and
 * have no missing values (v1 trains on complete rows only; the missing-values
 * editor exists to get there).
 */
export async function createModel(input: ModelDefinition): Promise<ActionResult<{ id: string }>> {
  const parsed = modelDefinitionSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: 'Check the highlighted fields.', fieldErrors: fieldErrorsFrom(parsed.error) }
  }
  const def = parsed.data

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }

  const { data: ds } = await supabase
    .from('datasets')
    .select('id, status, columns')
    .eq('id', def.dataset_id)
    .maybeSingle()
  if (!ds) return { ok: false, error: 'Dataset not found.' }
  if (ds.status !== 'ready') return { ok: false, error: 'Dataset is not ready.' }
  const cols = columnsSchema.safeParse(ds.columns)
  if (!cols.success) return { ok: false, error: 'Dataset has no column metadata.' }
  const byName = new Map(cols.data.map((c) => [c.name, c]))

  const fieldErrors: Record<string, string> = {}
  const target = byName.get(def.target_column)
  if (!target) fieldErrors.target_column = 'Target column is not in this dataset.'
  else if (target.type === 'string') fieldErrors.target_column = 'Target must be numeric or boolean.'
  else if (def.task === 'regression' && target.type !== 'number') fieldErrors.target_column = 'Regression needs a numeric target.'
  else if (target.missing > 0) fieldErrors.target_column = `Target has ${target.missing} missing values. Fix them first.`

  for (const f of def.feature_columns) {
    const c = byName.get(f)
    if (!c) {
      fieldErrors.feature_columns = `Feature "${f}" is not in this dataset.`
      break
    }
    if (c.type === 'string') {
      fieldErrors.feature_columns = `Feature "${f}" is text; only numeric or boolean columns can be features.`
      break
    }
    if (c.missing > 0) {
      fieldErrors.feature_columns = `Feature "${f}" has ${c.missing} missing values. Fix them first.`
      break
    }
  }
  if (Object.keys(fieldErrors).length) return { ok: false, error: 'Check the highlighted fields.', fieldErrors }

  const { data, error } = await supabase
    .from('models')
    .insert({
      user_id: user.id,
      dataset_id: def.dataset_id,
      name: def.name,
      task: def.task,
      algorithm: def.algorithm,
      target_column: def.target_column,
      feature_columns: def.feature_columns,
      hyperparameters: def.hyperparameters as unknown as Json,
      status: 'draft',
    })
    .select('id')
    .single()
  if (error || !data) return { ok: false, error: error?.message ?? 'Could not create model.' }

  revalidatePath('/dashboard')
  return { ok: true, data: { id: data.id } }
}

/**
 * Enqueue a training job for a model. Allowed from draft, failed or succeeded
 * (retrain); refused while a job is already queued or running.
 */
export async function enqueueTraining(modelId: string): Promise<ActionResult<{ jobId: string }>> {
  if (!z.string().uuid().safeParse(modelId).success) return { ok: false, error: 'Bad model id.' }
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }

  const { data: model } = await supabase.from('models').select('id, status').eq('id', modelId).maybeSingle()
  if (!model) return { ok: false, error: 'Model not found.' }
  if (model.status === 'queued' || model.status === 'training') {
    return { ok: false, error: 'A training job is already in progress for this model.' }
  }

  const { data: job, error } = await supabase
    .from('training_jobs')
    .insert({ model_id: modelId })
    .select('id')
    .single()
  if (error || !job) return { ok: false, error: error?.message ?? 'Could not enqueue job.' }

  await supabase.from('models').update({ status: 'queued' }).eq('id', modelId)

  revalidatePath(`/models/${modelId}`)
  revalidatePath('/dashboard')
  return { ok: true, data: { jobId: job.id } }
}

export async function deleteModel(modelId: string): Promise<ActionResult<undefined>> {
  if (!z.string().uuid().safeParse(modelId).success) return { ok: false, error: 'Bad model id.' }
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }

  const { data: model } = await supabase.from('models').select('id, status').eq('id', modelId).maybeSingle()
  if (!model) return { ok: false, error: 'Model not found.' }
  if (model.status === 'queued' || model.status === 'training') {
    return { ok: false, error: 'Wait for the current training job to finish before deleting.' }
  }

  const { error } = await supabase.from('models').delete().eq('id', modelId)
  if (error) return { ok: false, error: error.message }

  revalidatePath('/dashboard')
  return { ok: true, data: undefined }
}
