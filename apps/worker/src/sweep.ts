import { z } from 'zod'
import { DATASETS_BUCKET, MODELS_BUCKET, type Db } from './db'

/**
 * Orphaned-object sweep for the two storage buckets.
 *
 * Rows are the source of truth: an object nobody points at is litter. Orphans
 * arise from best-effort cleanup that lost its second step (deleteModel /
 * deleteDataset removed the row, then the storage call failed), from a worker
 * crash between artifact upload and row insert that was never retried, and
 * from the missing-values editor's upload-then-repoint sequence. None of them
 * are readable (every storage read policy is by folder and nothing references
 * the object), so this is housekeeping, not security.
 *
 * Two hazards, both handled by refusing to delete on doubt:
 *
 *   1. Racing a writer that uploads first and records the row second. Every
 *      such sequence in this codebase completes in seconds, so only objects
 *      older than `graceMs` are candidates; a fresh object is left alone even
 *      when no row claims it yet.
 *
 *   2. An incomplete live set. "Rows are the source of truth" only holds if we
 *      actually read every row. PostgREST caps any single response at
 *      `db-max-rows` (1000 on Supabase by default) and truncates silently, so
 *      the live set is read in pages and then checked against an exact count
 *      taken in the same pass. A mismatch aborts the sweep for that bucket
 *      before anything is removed. Failing closed here costs one skipped
 *      sweep; failing open deletes a user's trained model.
 *
 * What counts as live:
 *   - models bucket:   every `model_artifacts.storage_path`.
 *   - datasets bucket: every `datasets.storage_path`, plus the original upload
 *     `<user_id>/<dataset_id>.csv`, which the editor keeps for "restore
 *     original" after it has repointed the row at a `.v<n>.csv` version.
 */

export interface StoredObject {
  /** Full object key within the bucket. */
  path: string
  /** ISO timestamp from the storage listing; empty when the listing had none. */
  createdAt: string
}

/** Everything the sweep needs from the outside world, so it can be tested with fakes. */
export interface SweepDeps {
  listObjects(bucket: string): Promise<StoredObject[]>
  /** Must be complete or throw. Never return a partial set. */
  liveArtifactPaths(): Promise<Set<string>>
  /** Must be complete or throw. Never return a partial set. */
  liveDatasetPaths(): Promise<Set<string>>
  remove(bucket: string, paths: string[]): Promise<void>
}

export interface BucketSweep {
  /** Unreferenced objects older than the grace period, now removed. */
  removed: number
  /** Unreferenced objects younger than the grace period, left for next time. */
  skippedYoung: number
  /** Unreferenced objects whose listing carried no usable timestamp. Never removed. */
  skippedUnknownAge: number
}

export interface SweepResult {
  datasets: BucketSweep
  models: BucketSweep
}

export interface Classified {
  orphans: string[]
  young: number
  unknownAge: number
}

/** Sort unreferenced objects into removable, too young, and undatable. Pure. */
export function classifyObjects(objects: StoredObject[], live: ReadonlySet<string>, cutoffMs: number): Classified {
  const out: Classified = { orphans: [], young: 0, unknownAge: 0 }
  for (const o of objects) {
    if (live.has(o.path)) continue
    const created = Date.parse(o.createdAt)
    if (!Number.isFinite(created)) out.unknownAge++
    else if (created > cutoffMs) out.young++
    else out.orphans.push(o.path)
  }
  return out
}

/** Storage removes are batched; Supabase accepts many keys per call but keep requests bounded. */
const REMOVE_BATCH = 100

export async function sweepOrphans(deps: SweepDeps, nowMs: number, graceMs: number): Promise<SweepResult> {
  const cutoff = nowMs - graceMs

  const sweepBucket = async (bucket: string, live: () => Promise<Set<string>>): Promise<BucketSweep> => {
    // List first, then load the live set. A row inserted after the listing
    // refers to an object that is younger than the grace period anyway, and a
    // row deleted after the listing leaves an object that is a real orphan.
    const objects = await deps.listObjects(bucket)
    const liveSet = await live()
    const { orphans, young, unknownAge } = classifyObjects(objects, liveSet, cutoff)
    for (let i = 0; i < orphans.length; i += REMOVE_BATCH) {
      await deps.remove(bucket, orphans.slice(i, i + REMOVE_BATCH))
    }
    return { removed: orphans.length, skippedYoung: young, skippedUnknownAge: unknownAge }
  }

  const models = await sweepBucket(MODELS_BUCKET, deps.liveArtifactPaths)
  const datasets = await sweepBucket(DATASETS_BUCKET, deps.liveDatasetPaths)
  return { datasets, models }
}

/**
 * Original upload key for a dataset, kept alongside any edited version.
 *
 * LOAD-BEARING CONTRACT. This mirrors `originalDatasetPath` in
 * apps/web/src/lib/datasets/paths.ts, which is where the web app writes the
 * object. If the web side changes its layout and this copy does not, the
 * sweep will treat every original upload as an orphan and remove it after one
 * grace period. Change both together.
 */
export function originalDatasetPath(userId: string, datasetId: string): string {
  return `${userId}/${datasetId}.csv`
}

const LIST_PAGE = 1000
/**
 * Listing depth, counting the bucket root as 1. Objects live at depth 2
 * (`<user>/<dataset>.csv`) or depth 3 (`<user>/<model>/<artifact>.json`), so
 * folders are only ever found at depths 1 and 2. A folder at depth 3 is not
 * something this codebase writes; it is not descended into, which means its
 * contents are never deleted.
 */
const MAX_DEPTH = 3

/** Rows are read in pages of this many. Kept below db-max-rows so a page is never truncated. */
const ROW_PAGE = 1000

const artifactRow = z.object({ storage_path: z.string().min(1) })
const datasetRow = z.object({ id: z.string().uuid(), user_id: z.string().uuid(), storage_path: z.string().min(1) })

/**
 * Read every row of `table`, validated, and prove it was every row.
 *
 * The count is taken first so a row inserted mid-read shows up as a surplus
 * rather than a shortfall; surplus rows are fine (their objects are young).
 * A shortfall means a page was truncated, a row was deleted mid-read (which
 * only ever leaves a real orphan for next time), or PostgREST misbehaved.
 * None of those can be told apart from here, so all of them abort.
 */
async function readAllRows<T>(db: Db, table: string, columns: string, schema: z.ZodType<T>): Promise<T[]> {
  const { count, error: countErr } = await db.from(table).select('*', { count: 'exact', head: true })
  if (countErr) throw new Error(`count ${table}: ${countErr.message}`)
  if (count === null) throw new Error(`count ${table}: no count returned`)

  const rows: T[] = []
  for (let from = 0; ; from += ROW_PAGE) {
    const { data, error } = await db.from(table).select(columns).order('id').range(from, from + ROW_PAGE - 1)
    if (error) throw new Error(`read ${table}: ${error.message}`)
    const page = z.array(schema).parse(data ?? [])
    rows.push(...page)
    if (page.length < ROW_PAGE) break
  }

  if (rows.length < count) {
    throw new Error(`read ${table}: expected ${count} rows, got ${rows.length}; refusing to sweep on a partial live set`)
  }
  return rows
}

/** Real implementation over supabase-js. */
export function createSweepDeps(db: Db): SweepDeps {
  return {
    async listObjects(bucket) {
      const out: StoredObject[] = []
      const walk = async (prefix: string, depth: number): Promise<void> => {
        if (depth > MAX_DEPTH) return
        for (let offset = 0; ; offset += LIST_PAGE) {
          const { data, error } = await db.storage.from(bucket).list(prefix, { limit: LIST_PAGE, offset })
          if (error) throw new Error(`list ${bucket}/${prefix}: ${error.message}`)
          if (!data) break
          for (const entry of data) {
            const path = prefix ? `${prefix}/${entry.name}` : entry.name
            // Supabase returns folders as entries with a null id and no timestamps.
            if (entry.id === null || entry.id === undefined) await walk(path, depth + 1)
            else out.push({ path, createdAt: entry.created_at ?? '' })
          }
          if (data.length < LIST_PAGE) break
        }
      }
      await walk('', 1)
      return out
    },

    async liveArtifactPaths() {
      const rows = await readAllRows(db, 'model_artifacts', 'storage_path', artifactRow)
      return new Set(rows.map((r) => r.storage_path))
    },

    async liveDatasetPaths() {
      const rows = await readAllRows(db, 'datasets', 'id, user_id, storage_path', datasetRow)
      const live = new Set<string>()
      for (const r of rows) {
        live.add(r.storage_path)
        live.add(originalDatasetPath(r.user_id, r.id))
      }
      return live
    },

    async remove(bucket, paths) {
      const { error } = await db.storage.from(bucket).remove(paths)
      if (error) throw new Error(`remove from ${bucket}: ${error.message}`)
    },
  }
}
