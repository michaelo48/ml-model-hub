import { describe, expect, it } from 'vitest'
import { DEFAULT_HYPERPARAMETERS, OPTIMIZERS } from './config/model'
import { predictLinear } from './linear/ols'
import { predictClass } from './logistic/logistic'
import { fitModel } from './train'
import type { EpochMetrics } from './optim/gradient'
import type { Matrix, Vector } from './types'

const X: Matrix = [[0], [1], [2], [3], [4], [5], [6], [7]]
const yReg: Vector = X.map(([x]) => 3 * x! + 2)
const yCls: Vector = X.map(([x]) => (x! >= 4 ? 1 : 0))

describe('fitModel', () => {
  it('runs every optimizer for linear_regression with default hyperparameters', () => {
    for (const optimizer of OPTIMIZERS) {
      const curve: EpochMetrics[] = []
      const hp = { ...DEFAULT_HYPERPARAMETERS[optimizer], epochs: optimizer === 'ols' ? 1 : 3000 }
      const m = fitModel('linear_regression', hp, X, yReg, { onEpoch: (e) => void curve.push(e) })
      expect(curve.length).toBe(hp.epochs)
      expect(curve[0]!.epoch).toBe(1)
      const pred = predictLinear(m, [[10]])[0]!
      // Full-batch methods and OLS hit the exact line. Constant-lr Adam never
      // settles closer than ~lr (0.01) in normalized space, so allow that.
      expect(Math.abs(pred - 32), optimizer).toBeLessThan(optimizer === 'adam' ? 0.05 : 1e-9)
    }
  })

  it('forwards seed to the mini-batch shuffle', () => {
    const hp = { ...DEFAULT_HYPERPARAMETERS.sgd, epochs: 3, batch_size: 2 }
    const a = fitModel('linear_regression', hp, X, yReg, { seed: 1 })
    const b = fitModel('linear_regression', hp, X, yReg, { seed: 1 })
    const c = fitModel('linear_regression', hp, X, yReg, { seed: 2 })
    expect(a.weights).toEqual(b.weights)
    expect(a.weights).not.toEqual(c.weights)
  })

  it('OLS via fitModel reports exactly one epoch with the training MSE', () => {
    const curve: EpochMetrics[] = []
    fitModel('linear_regression', DEFAULT_HYPERPARAMETERS.ols, X, yReg, { onEpoch: (e) => void curve.push(e) })
    expect(curve).toHaveLength(1)
    expect(curve[0]!.loss).toBeLessThan(1e-18)
  })

  it('runs gradient optimizers for logistic_regression', () => {
    for (const optimizer of ['batch_gd', 'sgd', 'adam'] as const) {
      const hp = { ...DEFAULT_HYPERPARAMETERS[optimizer], epochs: 300, learning_rate: 0.1 }
      const m = fitModel('logistic_regression', hp, X, yCls, { seed: 1 })
      expect(predictClass(m, X)).toEqual(yCls)
    }
  })

  it('rejects ols for logistic_regression', () => {
    expect(() => fitModel('logistic_regression', DEFAULT_HYPERPARAMETERS.ols, X, yCls)).toThrow(/ols/)
  })
})
