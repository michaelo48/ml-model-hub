import type { Algorithm, Hyperparameters } from './config/model'
import { fitLinearGd } from './linear/gd'
import { fitOls, predictLinear } from './linear/ols'
import { fitLogistic } from './logistic/logistic'
import { mse } from './metrics'
import type { EpochMetrics } from './optim/gradient'
import type { LinearModel, Matrix, Vector } from './types'

export interface FitOptions {
  seed?: number
  onEpoch?: (metrics: EpochMetrics) => void | boolean
}

/**
 * Single entry point the worker calls: dispatches on algorithm + optimizer.
 * OLS has no epochs; it reports one synthetic epoch so callers always get at
 * least one loss-curve point.
 */
export function fitModel(
  algorithm: Algorithm,
  hp: Hyperparameters,
  X: Matrix,
  y: Vector,
  opts: FitOptions = {}
): LinearModel {
  if (hp.optimizer === 'ols') {
    if (algorithm !== 'linear_regression') {
      throw new Error('fitModel: ols is only available for linear_regression')
    }
    const model = fitOls(X, y, { l2: hp.l2 })
    opts.onEpoch?.({ epoch: 1, loss: mse(y, predictLinear(model, X)) })
    return model
  }
  const gdOpts = { ...hp, optimizer: hp.optimizer, seed: opts.seed, onEpoch: opts.onEpoch }
  return algorithm === 'linear_regression' ? fitLinearGd(X, y, gdOpts) : fitLogistic(X, y, gdOpts)
}
