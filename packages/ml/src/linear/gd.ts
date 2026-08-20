import { trainGradient, type GradientTrainOptions } from '../optim/gradient'
import type { LinearModel, Matrix, Vector } from '../types'

/**
 * Linear regression by gradient descent (batch, mini-batch SGD or Adam).
 * Same model shape as fitOls; use predictLinear for inference.
 */
export function fitLinearGd(X: Matrix, y: Vector, opts: GradientTrainOptions): LinearModel {
  return trainGradient(X, y, 'identity', opts)
}
