import type { FeatureStats, Matrix } from './types'

/**
 * Column-wise mean and population standard deviation.
 * A constant column gets std = 1 so it normalizes to 0 instead of NaN.
 */
export function computeStats(X: Matrix): FeatureStats {
  const n = X.length
  if (n === 0) throw new Error('computeStats: X has no rows')
  const d = X[0]!.length
  const mean = new Array<number>(d).fill(0)
  const std = new Array<number>(d).fill(0)

  for (const row of X) {
    if (row.length !== d) throw new Error('computeStats: ragged matrix')
    for (let j = 0; j < d; j++) mean[j]! += row[j]!
  }
  for (let j = 0; j < d; j++) mean[j]! /= n

  for (const row of X) {
    for (let j = 0; j < d; j++) {
      const diff = row[j]! - mean[j]!
      std[j]! += diff * diff
    }
  }
  for (let j = 0; j < d; j++) {
    const s = Math.sqrt(std[j]! / n)
    std[j] = s === 0 ? 1 : s
  }

  return { mean, std }
}

/** Returns a new matrix with each column z-scored using `stats`. */
export function applyStats(X: Matrix, stats: FeatureStats): Matrix {
  const d = stats.mean.length
  return X.map((row) => {
    if (row.length !== d) {
      throw new Error(`applyStats: expected ${d} features, got ${row.length}`)
    }
    return row.map((v, j) => (v - stats.mean[j]!) / stats.std[j]!)
  })
}
