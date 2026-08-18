import { gram, gramVec, solve } from '../linalg'
import { applyStats, computeStats } from '../normalize'
import type { LinearModel, Matrix, Vector } from '../types'

export interface OlsOptions {
  /** L2 (ridge) penalty on the weights, not the bias. 0 = plain OLS. */
  l2?: number
}

/**
 * Ordinary least squares via the normal equations:
 *   (XᵀX + λI) w = Xᵀy
 * solved on z-scored features with an explicit bias column.
 * Closed-form, so there are no epochs and no loss curve; this is the
 * baseline the iterative optimizers are checked against.
 */
export function fitOls(X: Matrix, y: Vector, opts: OlsOptions = {}): LinearModel {
  const n = X.length
  if (n === 0) throw new Error('fitOls: no training rows')
  if (y.length !== n) throw new Error('fitOls: X and y row counts differ')
  const d = X[0]!.length
  if (d === 0) throw new Error('fitOls: no features')
  const l2 = opts.l2 ?? 0
  if (l2 < 0) throw new Error('fitOls: l2 must be >= 0')

  const stats = computeStats(X)
  const Xn = applyStats(X, stats)

  // A constant feature z-scores to an all-zero column, which is collinear
  // with the intercept and makes XᵀX singular. Its weight is unidentifiable,
  // so exclude it from the solve and report weight 0 for it.
  const active: number[] = []
  for (let j = 0; j < d; j++) {
    if (Xn.some((row) => row[j] !== 0)) active.push(j)
  }

  // Augment with a leading 1 for the intercept.
  const Xa = Xn.map((row) => [1, ...active.map((j) => row[j]!)])
  const G = gram(Xa)
  const v = gramVec(Xa, y)

  // Ridge penalty on weights only (skip index 0 = bias).
  for (let j = 1; j <= active.length; j++) G[j]![j]! += l2

  const theta = solve(G, v)
  const weights = new Array<number>(d).fill(0)
  active.forEach((j, k) => {
    weights[j] = theta[k + 1]!
  })

  return { bias: theta[0]!, weights, stats }
}

/** Predict for raw (un-normalized) feature rows using a fitted linear model. */
export function predictLinear(model: LinearModel, X: Matrix): Vector {
  const Xn = applyStats(X, model.stats)
  return Xn.map((row) => {
    let s = model.bias
    for (let j = 0; j < row.length; j++) s += model.weights[j]! * row[j]!
    return s
  })
}
