'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import type { ActionResult } from '@/lib/result'
import type { Json } from '@/lib/supabase/database.types'
import { DATASETS_BUCKET, analyzeCsv, columnsSchema, type ColumnMeta } from '@/lib/csv/infer'
import { parseCsvText, unparseCsv } from '@/lib/csv/parse'
import {
  applyMissingFixes,
  buildMissingReport,
  missingFixesSchema,
  type MissingFixes,
  type MissingReport,
} from './missing'

/**
 * Storage layout: the untouched upload lives at <uid>/<id>.csv and is never
 * overwritten. Each edit writes a new immutable object <uid>/<id>.v<n>.csv and
 * repoints datasets.storage_path at it. Immutable keys sidestep CDN caching of
 * in-place overwrites; restore is just pointing back at the original.
 */
function originalPath(userId: string, datasetId: string): string {
  return `${userId}/${datasetId}.csv`
}

function nextVersionPath(userId: string, datasetId: string, current: string): string {
  const m = /\.v(\d+)\.csv$/.exec(current)
  const n = m ? Number(m[1]) + 1 : 1
  return `${userId}/${datasetId}.v${n}.csv`
}

type Supabase = Awaited<ReturnType<typeof createClient>>
type OwnedDataset = { id: string; storage_path: string; status: string; row_count: number | null; columns: Json | null }
type Loaded = { ok: true; supabase: Supabase; ds: OwnedDataset; userId: string } | { ok: false; error: string }

async function loadOwnedDataset(datasetId: string): Promise<Loaded> {
  if (!z.string().uuid().safeParse(datasetId).success) return { ok: false, error: 'Bad dataset id.' }
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }
  const { data: ds } = await supabase
    .from('datasets')
    .select('id, storage_path, status, row_count, columns')
    .eq('id', datasetId)
    .maybeSingle()
  if (!ds) return { ok: false, error: 'Dataset not found.' }
  if (ds.status !== 'ready') return { ok: false, error: 'Dataset is not ready.' }
  return { ok: true, supabase, ds, userId: user.id }
}

async function downloadRows(
  supabase: Supabase,
  path: string
): Promise<{ header: string[]; rows: string[][] } | { error: string }> {
  const { data: blob, error } = await supabase.storage.from(DATASETS_BUCKET).download(path)
  if (error || !blob) return { error: 'Could not read the file from storage.' }
  const parsed = parseCsvText(await blob.text(), 0) // 0 = no row cap
  if (parsed.fatalError) return { error: `CSV parse error: ${parsed.fatalError}` }
  const [header, ...rows] = parsed.data
  if (!header) return { error: 'File is empty.' }
  return { header, rows }
}

export type MissingReportResult = ActionResult<
  MissingReport & { columnTypes: ColumnMeta['type'][]; hasOriginal: boolean }
>

/** Rows with missing cells (optionally restricted to some columns), for the editor. */
export async function getMissingReport(datasetId: string, onlyColumns?: string[]): Promise<MissingReportResult> {
  const loaded = await loadOwnedDataset(datasetId)
  if (!loaded.ok) return { ok: false, error: loaded.error }
  const { supabase, ds, userId } = loaded

  const file = await downloadRows(supabase, ds.storage_path)
  if ('error' in file) return { ok: false, error: file.error }

  const meta = columnsSchema.safeParse(ds.columns)
  const columnTypes = file.header.map((h) => meta.success ? meta.data.find((c) => c.name === h)?.type ?? 'string' : 'string')

  const report = buildMissingReport(file.header, file.rows, onlyColumns)

  const hasOriginal = ds.storage_path !== originalPath(userId, ds.id)

  return { ok: true, data: { ...report, columnTypes, hasOriginal } }
}

export type ApplyFixesResult = ActionResult<{
  editsApplied: number
  fillsApplied: number
  rowsDropped: number
  rowCount: number
  remainingMissingRows: number
}>

/**
 * Apply cell edits, bulk fills and row drops; rewrite the CSV in storage
 * (backing up the original the first time); re-run validation and update
 * the dataset's metadata.
 */
export async function applyMissingFixesAction(datasetId: string, input: MissingFixes): Promise<ApplyFixesResult> {
  const parsedInput = missingFixesSchema.safeParse(input)
  if (!parsedInput.success) return { ok: false, error: 'Invalid fixes payload.' }
  const fixes = parsedInput.data
  if (!fixes.edits.length && !fixes.fills.length && !fixes.dropRowsMissingIn.length) {
    return { ok: false, error: 'Nothing to apply.' }
  }

  const loaded = await loadOwnedDataset(datasetId)
  if (!loaded.ok) return { ok: false, error: loaded.error }
  const { supabase, ds, userId } = loaded

  const file = await downloadRows(supabase, ds.storage_path)
  if ('error' in file) return { ok: false, error: file.error }
  if (ds.row_count != null && file.rows.length !== ds.row_count) {
    return { ok: false, error: 'The file changed since this page loaded. Reload and try again.' }
  }

  const meta = columnsSchema.safeParse(ds.columns)
  const columnTypes = file.header.map((h) => meta.success ? meta.data.find((c) => c.name === h)?.type ?? 'string' : 'string')

  let applied
  try {
    applied = applyMissingFixes(file.header, file.rows, fixes, columnTypes)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not apply fixes.' }
  }
  if (applied.rows.length === 0) return { ok: false, error: 'That would remove every row.' }

  const newText = unparseCsv(file.header, applied.rows)
  const analysis = analyzeCsv(newText, parseCsvText)
  if (!analysis.ok) return { ok: false, error: `Result would be invalid: ${analysis.error}` }

  const newPath = nextVersionPath(userId, ds.id, ds.storage_path)
  const blob = new Blob([newText], { type: 'text/csv' })
  const { error: upErr } = await supabase.storage
    .from(DATASETS_BUCKET)
    .upload(newPath, blob, { contentType: 'text/csv', upsert: false })
  if (upErr) return { ok: false, error: `Could not save the file: ${upErr.message}` }

  const { error: dbErr } = await supabase
    .from('datasets')
    .update({
      storage_path: newPath,
      row_count: analysis.rowCount,
      size_bytes: blob.size,
      columns: analysis.columns as unknown as Json,
    })
    .eq('id', ds.id)
  if (dbErr) {
    await supabase.storage.from(DATASETS_BUCKET).remove([newPath])
    return { ok: false, error: dbErr.message }
  }
  // Keep only the original and the current version.
  if (ds.storage_path !== originalPath(userId, ds.id)) {
    await supabase.storage.from(DATASETS_BUCKET).remove([ds.storage_path])
  }

  revalidatePath(`/datasets/${ds.id}`)
  revalidatePath('/dashboard')

  const remaining = buildMissingReport(file.header, applied.rows).totalMissingRows
  return {
    ok: true,
    data: {
      editsApplied: applied.editsApplied,
      fillsApplied: applied.fillsApplied,
      rowsDropped: applied.rowsDropped,
      rowCount: analysis.rowCount,
      remainingMissingRows: remaining,
    },
  }
}

/** Put the untouched upload back and re-validate. */
export async function restoreOriginalDataset(datasetId: string): Promise<ActionResult<{ rowCount: number }>> {
  const loaded = await loadOwnedDataset(datasetId)
  if (!loaded.ok) return { ok: false, error: loaded.error }
  const { supabase, ds, userId } = loaded

  const orig = originalPath(userId, ds.id)
  if (ds.storage_path === orig) return { ok: false, error: 'This dataset has not been edited.' }
  const { data: blob, error } = await supabase.storage.from(DATASETS_BUCKET).download(orig)
  if (error || !blob) return { ok: false, error: 'The original upload could not be read.' }

  const analysis = analyzeCsv(await blob.text(), parseCsvText)
  if (!analysis.ok) return { ok: false, error: `Original is invalid: ${analysis.error}` }

  const edited = ds.storage_path
  const { error: dbErr } = await supabase
    .from('datasets')
    .update({ storage_path: orig, row_count: analysis.rowCount, size_bytes: blob.size, columns: analysis.columns as unknown as Json })
    .eq('id', ds.id)
  if (dbErr) return { ok: false, error: dbErr.message }
  await supabase.storage.from(DATASETS_BUCKET).remove([edited])

  revalidatePath(`/datasets/${ds.id}`)
  revalidatePath('/dashboard')
  return { ok: true, data: { rowCount: analysis.rowCount } }
}
