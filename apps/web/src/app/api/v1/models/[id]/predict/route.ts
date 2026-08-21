import { after, type NextRequest } from 'next/server'
import { z } from 'zod'
import { predictWithArtifact } from '@modelforge/ml'
import { createAdminClient } from '@/lib/supabase/admin'
import { bearerToken, hashApiKey } from '@/lib/api-keys/keys'
import { loadServingArtifact } from '@/lib/inference/artifacts'
import { predictBodySchema, rowsToMatrix } from '@/lib/inference/request'

// node:crypto for the key hash, and the artifact cache lives in process memory.
export const runtime = 'nodejs'

/** How often api_keys.last_used_at is refreshed per key, at most. */
const LAST_USED_GRANULARITY_MS = 60_000

/**
 * POST /api/v1/models/:id/predict
 *
 * The inference endpoint. Callers are external programs, so auth is a
 * per-model API key (`Authorization: Bearer mf_...`), not a session. The
 * route runs with the secret key and BYPASSES RLS; every query below is
 * scoped explicitly by the model id from the URL, and the key must belong to
 * that same model. A key for model A never serves model B.
 *
 * Request:  a JSON array of feature objects (or `{ rows: [...] }`), at most
 *           100 rows, every feature column present as a finite number or
 *           boolean. Extra keys are ignored.
 * Response: `{ model_id, version, task, predictions }`. Regression returns
 *           numbers; binary classification returns `{ probability, label }`.
 * Errors:   `{ error: { code, message } }` with 400 / 401 / 404 / 503.
 *
 * Once a key has authenticated, every outcome is recorded in predictions_log
 * (no bodies) for the usage dashboard. Unauthenticated calls are not logged,
 * so a stranger guessing keys cannot fill the owner's dashboard.
 */
export async function POST(req: NextRequest, ctx: RouteContext<'/api/v1/models/[id]/predict'>) {
  const startedAt = Date.now()
  const { id: modelId } = await ctx.params
  if (!z.uuid().safeParse(modelId).success) return fail(404, 'not_found', 'Model not found.')

  const token = bearerToken(req.headers.get('authorization'))
  if (!token) return fail(401, 'unauthorized', 'Send the API key as "Authorization: Bearer <key>".')

  const db = createAdminClient()
  const { data: key, error: keyErr } = await db
    .from('api_keys')
    .select('id, revoked_at')
    .eq('key_hash', hashApiKey(token))
    .eq('model_id', modelId)
    .maybeSingle()
  if (keyErr) {
    console.error('[predict] api_keys lookup failed', { modelId, message: keyErr.message })
    return fail(503, 'unavailable', 'Try again shortly.')
  }
  // Same answer for "no such key" and "wrong model" so a key cannot be used to
  // probe which model ids exist.
  if (!key) return fail(401, 'unauthorized', 'Invalid API key.')
  if (key.revoked_at) return fail(401, 'unauthorized', 'This API key has been revoked.')

  // From here on the caller is the key holder and every outcome is logged,
  // after the response is sent so logging never adds to latency. The log row
  // is one append-only insert per request (no contention). last_used_at is a
  // display field, so it is refreshed at most once a minute per key: a burst
  // from one key must not queue row-lock updates on the same api_keys row.
  const log = (status: number, rows: number) =>
    after(async () => {
      const now = new Date()
      const latency_ms = Math.max(0, now.getTime() - startedAt)
      const staleBefore = new Date(now.getTime() - LAST_USED_GRANULARITY_MS).toISOString()
      const [{ error: logErr }, { error: touchErr }] = await Promise.all([
        db.from('predictions_log').insert({
          model_id: modelId,
          api_key_id: key.id,
          latency_ms,
          input_row_count: rows,
          status_code: status,
        }),
        db
          .from('api_keys')
          .update({ last_used_at: now.toISOString() })
          .eq('id', key.id)
          .or(`last_used_at.is.null,last_used_at.lt.${staleBefore}`),
      ])
      if (logErr) console.error('[predict] predictions_log insert failed', { modelId, message: logErr.message })
      if (touchErr) console.error('[predict] last_used_at update failed', { modelId, message: touchErr.message })
    })
  const failLogged = (status: number, code: string, message: string, rows = 0) => {
    log(status, rows)
    return fail(status, code, message)
  }

  let json: unknown
  try {
    json = await req.json()
  } catch {
    return failLogged(400, 'bad_request', 'Body must be JSON.')
  }
  const body = predictBodySchema.safeParse(json)
  if (!body.success) return failLogged(400, 'bad_request', bodyErrorMessage(body.error))
  const rows = body.data

  const loaded = await loadServingArtifact(db, modelId)
  if (!loaded.ok) {
    return loaded.reason === 'no_artifact'
      ? failLogged(404, 'no_trained_version', 'This model has no trained version yet.', rows.length)
      : failLogged(503, 'unavailable', 'The trained model could not be loaded. Try again shortly.', rows.length)
  }
  const { artifact, version } = loaded.serving

  const matrix = rowsToMatrix(rows, artifact.feature_columns)
  if (!matrix.ok) return failLogged(400, 'bad_request', matrix.message, rows.length)

  const raw = predictWithArtifact(artifact, matrix.X)
  const predictions =
    artifact.task === 'binary_classification'
      ? raw.map((p) => ({ probability: p, label: p >= 0.5 ? 1 : 0 }))
      : raw

  log(200, rows.length)
  return Response.json(
    { model_id: modelId, version, task: artifact.task, predictions },
    { headers: { 'cache-control': 'no-store' } }
  )
}

/**
 * The schema is a union (array | { rows }), so anything that is neither
 * produces Zod's generic "Invalid input" at the root. Only the row-bound
 * messages (min/max) are written for callers; say what the shape should be
 * for everything else.
 */
function bodyErrorMessage(error: z.ZodError): string {
  const bound = error.issues.find((i) => i.code === 'too_small' || i.code === 'too_big')
  return bound?.message ?? 'Body must be a JSON array of feature objects, or { "rows": [...] }.'
}

function fail(status: number, code: string, message: string): Response {
  const headers: Record<string, string> = { 'cache-control': 'no-store' }
  if (status === 401) headers['www-authenticate'] = 'Bearer'
  return Response.json({ error: { code, message } }, { status, headers })
}
