import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { parseArtifact, type Artifact } from '@modelforge/ml'
import type { Database } from '@/lib/supabase/database.types'
import { LruCache } from './cache'

export const MODELS_BUCKET = 'models'

export interface ServingArtifact {
  version: number
  artifact: Artifact
}

/**
 * Parsed artifacts by model id, kept across requests on this instance. The
 * cache is consulted only after the cheap `model_artifacts` lookup below has
 * said which version is serving, so a retrain is picked up on the very next
 * request and the download is skipped only when the version is unchanged.
 */
const cache = new LruCache<string, ServingArtifact>(64)

export type LoadArtifactResult =
  | { ok: true; serving: ServingArtifact }
  | { ok: false; reason: 'no_artifact' | 'unreadable' }

/**
 * Load the artifact the endpoint serves for a model: the highest version,
 * which is also the one the model page badges as "serving". Any other choice
 * here makes that badge a lie, so keep the two in step.
 */
export async function loadServingArtifact(
  db: SupabaseClient<Database>,
  modelId: string
): Promise<LoadArtifactResult> {
  const { data: row, error } = await db
    .from('model_artifacts')
    .select('version, storage_path')
    .eq('model_id', modelId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    console.error('[predict] model_artifacts lookup failed', { modelId, message: error.message })
    return { ok: false, reason: 'unreadable' }
  }
  if (!row) return { ok: false, reason: 'no_artifact' }

  const cached = cache.get(modelId)
  if (cached && cached.version === row.version) return { ok: true, serving: cached }

  const { data: blob, error: dlErr } = await db.storage.from(MODELS_BUCKET).download(row.storage_path)
  if (dlErr || !blob) {
    console.error('[predict] artifact download failed', { modelId, path: row.storage_path, message: dlErr?.message })
    return { ok: false, reason: 'unreadable' }
  }
  let artifact: Artifact
  try {
    artifact = parseArtifact(JSON.parse(await blob.text()))
  } catch (e) {
    console.error('[predict] artifact unparseable', { modelId, path: row.storage_path, message: String(e) })
    return { ok: false, reason: 'unreadable' }
  }
  const serving = { version: row.version, artifact }
  cache.set(modelId, serving)
  return { ok: true, serving }
}
