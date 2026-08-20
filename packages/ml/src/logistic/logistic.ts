import { predictLinear } from '../linear/ols'
import { sigmoid, trainGradient, type GradientTrainOptions } from '../optim/gradient'
import type { LinearModel, Matrix, Vector } from '../types'

/**
 * Binary logistic regression by gradient descent. Targets must be 0/1.
 * The returned model has the same shape as a linear model (weights in
 * normalized space + bias + stats); only the link differs at predict time.
 */
export function fitLogistic(X: Matrix, y: Vector, opts: GradientTrainOptions): LinearModel {
  return trainGradient(X, y, 'sigmoid', opts)
}

/** P(y = 1 | x) for raw feature rows. */
export function predictProba(model: LinearModel, X: Matrix): Vector {
  return predictLinear(model, X).map(sigmoid)
}

/** Hard 0/1 labels at the given probability threshold. */
export function predictClass(model: LinearModel, X: Matrix, threshold = 0.5): Vector {
  return predictProba(model, X).map((p) => (p >= threshold ? 1 : 0))
}
