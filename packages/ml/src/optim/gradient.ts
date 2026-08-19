import type { Hyperparameters, Optimizer } from '../config/model'
import { DivergenceError } from '../errors'
import { applyStats, computeStats } from '../normalize'
import { createRng, shuffledIndices } from '../random'
import type { LinearModel, Matrix, Vector } from '../types'

/** Optimizers that iterate; `ols` is closed-form and lives in linear/ols.ts. */
export type GradientOptimizer = Exclude<Optimizer, 'ols'>

/**
 * How raw scores z = Xw + b map to predictions and which loss is reported.
 *   identity -> linear regression, loss = MSE
 *   sigmoid  -> logistic regression, loss = binary cross-entropy
 * Both share the gradient (1/m) X^T (h(z) - y), which is why one trainer
 * serves both algorithms.
 */
export type Link = 'identity' | 'sigmoid'

export interface EpochMetrics {
  /** 1-based epoch index. */
  epoch: number
  /** Data loss (MSE or log-loss) over the full training set after this epoch. */
  loss: number
}

export interface GradientTrainOptions extends Omit<Hyperparameters, 'optimizer'> {
  optimizer: GradientOptimizer
  /** Seed for the mini-batch shuffle. Same seed + config -> same curve. */
  seed?: number
  /**
   * Called after every epoch with the full-dataset loss. Return `false` to
   * stop early (e.g. worker shutdown); the model trained so far is returned.
   */
  onEpoch?: (metrics: EpochMetrics) => void | boolean
}

const ADAM_BETA1 = 0.9
const ADAM_BETA2 = 0.999
const ADAM_EPS = 1e-8

export function sigmoid(z: number): number {
  // Split to avoid overflow in exp for large |z|.
  return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z))
}

/**
 * Trains a linear model with an iterative optimizer on z-scored features.
 *
 * Objective minimized (per full pass over n rows):
 *   J = (1/n) sum_i l(h(x_i . w + b), y_i) + (l2 / 2n) ||w||^2
 * with l = 1/2 (yhat - y)^2 for identity, and -[y log yhat + (1-y) log(1-yhat)]
 * for sigmoid. The l2 scaling matches fitOls's ridge, so batch_gd with the same
 * l2 converges to the same weights as the closed form.
 *
 * The loss reported to onEpoch is NOT J: it is the plain data loss users
 * expect on a curve, i.e. MSE (= 2x the 1/2-squared term) for identity and
 * mean binary cross-entropy for sigmoid, without the l2 term.
 *
 *   batch_gd  one full-gradient step per epoch (batch_size ignored)
 *   sgd       shuffled mini-batches of batch_size, plain step
 *   adam      shuffled mini-batches of batch_size, Adam update
 *
 * Throws if the loss becomes non-finite (learning rate too high).
 */
export function trainGradient(X: Matrix, y: Vector, link: Link, opts: GradientTrainOptions): LinearModel {
  const n = X.length
  if (n === 0) throw new Error('trainGradient: no training rows')
  if (y.length !== n) throw new Error('trainGradient: X and y row counts differ')
  const d = X[0]!.length
  if (d === 0) throw new Error('trainGradient: no features')
  if (!(opts.learning_rate > 0)) throw new Error('trainGradient: learning_rate must be > 0')
  if (!Number.isInteger(opts.epochs) || opts.epochs < 1) throw new Error('trainGradient: epochs must be >= 1')
  if (!Number.isInteger(opts.batch_size) || opts.batch_size < 1) {
    throw new Error('trainGradient: batch_size must be >= 1')
  }
  if (opts.l2 < 0) throw new Error('trainGradient: l2 must be >= 0')
  if (link === 'sigmoid' && y.some((v) => v !== 0 && v !== 1)) {
    throw new Error('trainGradient: logistic targets must be 0 or 1')
  }

  const stats = computeStats(X)
  const Xn = applyStats(X, stats)
  const h = link === 'identity' ? (z: number) => z : sigmoid

  const w = new Float64Array(d)
  let b = 0
  const lr = opts.learning_rate
  const l2PerRow = opts.l2 / n
  const batchSize = opts.optimizer === 'batch_gd' ? n : Math.min(opts.batch_size, n)
  const rng = createRng(opts.seed ?? 0)

  // Adam state.
  const mW = new Float64Array(d)
  const vW = new Float64Array(d)
  let mB = 0
  let vB = 0
  let step = 0

  const gW = new Float64Array(d)

  for (let epoch = 1; epoch <= opts.epochs; epoch++) {
    const order = batchSize === n ? null : shuffledIndices(n, rng)

    for (let start = 0; start < n; start += batchSize) {
      const end = Math.min(start + batchSize, n)
      const m = end - start
      gW.fill(0)
      let gB = 0

      for (let k = start; k < end; k++) {
        const i = order ? order[k]! : k
        const row = Xn[i]!
        let z = b
        for (let j = 0; j < d; j++) z += w[j]! * row[j]!
        const r = h(z) - y[i]!
        for (let j = 0; j < d; j++) gW[j]! += r * row[j]!
        gB += r
      }
      for (let j = 0; j < d; j++) gW[j] = gW[j]! / m + l2PerRow * w[j]!
      gB /= m

      if (opts.optimizer === 'adam') {
        step++
        const c1 = 1 - ADAM_BETA1 ** step
        const c2 = 1 - ADAM_BETA2 ** step
        for (let j = 0; j < d; j++) {
          mW[j] = ADAM_BETA1 * mW[j]! + (1 - ADAM_BETA1) * gW[j]!
          vW[j] = ADAM_BETA2 * vW[j]! + (1 - ADAM_BETA2) * gW[j]! * gW[j]!
          w[j]! -= (lr * (mW[j]! / c1)) / (Math.sqrt(vW[j]! / c2) + ADAM_EPS)
        }
        mB = ADAM_BETA1 * mB + (1 - ADAM_BETA1) * gB
        vB = ADAM_BETA2 * vB + (1 - ADAM_BETA2) * gB * gB
        b -= (lr * (mB / c1)) / (Math.sqrt(vB / c2) + ADAM_EPS)
      } else {
        for (let j = 0; j < d; j++) w[j]! -= lr * gW[j]!
        b -= lr * gB
      }
    }

    const loss = dataLoss(Xn, y, w, b, link)
    if (!Number.isFinite(loss)) {
      throw new DivergenceError(epoch, lr)
    }
    if (opts.onEpoch?.({ epoch, loss }) === false) break
  }

  return { weights: Array.from(w), bias: b, stats }
}

/** Mean data loss (no regularization) of the current parameters on normalized X. */
function dataLoss(Xn: Matrix, y: Vector, w: Float64Array, b: number, link: Link): number {
  const n = Xn.length
  const d = w.length
  let s = 0
  for (let i = 0; i < n; i++) {
    const row = Xn[i]!
    let z = b
    for (let j = 0; j < d; j++) z += w[j]! * row[j]!
    if (link === 'identity') {
      const r = z - y[i]!
      s += r * r
    } else {
      // Numerically stable BCE on the logit: softplus(z) - y*z.
      const softplus = z > 0 ? z + Math.log1p(Math.exp(-z)) : Math.log1p(Math.exp(z))
      s += softplus - y[i]! * z
    }
  }
  return s / n
}
