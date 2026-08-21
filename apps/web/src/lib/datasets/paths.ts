/**
 * Storage layout for the `datasets` bucket. The untouched upload lives at
 * `<uid>/<id>.csv` and is never overwritten. Each missing-values edit writes a
 * new immutable object `<uid>/<id>.v<n>.csv` and repoints
 * `datasets.storage_path` at it. Immutable keys sidestep CDN caching of
 * in-place overwrites; restore is just pointing back at the original.
 *
 * LOAD-BEARING CONTRACT. The worker's orphan sweep
 * (apps/worker/src/sweep.ts, `originalDatasetPath`) carries its own copy of
 * the original-upload key so it can keep that object alive after the row has
 * been repointed. Change the layout here without changing it there and the
 * sweep removes every original upload in the system after one grace period.
 * Change both together.
 */

export function originalDatasetPath(userId: string, datasetId: string): string {
  return `${userId}/${datasetId}.csv`
}

export function nextVersionPath(userId: string, datasetId: string, current: string): string {
  const m = /\.v(\d+)\.csv$/.exec(current)
  const n = m ? Number(m[1]) + 1 : 1
  return `${userId}/${datasetId}.v${n}.csv`
}
