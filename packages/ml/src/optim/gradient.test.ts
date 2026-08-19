import { describe, expect, it } from 'vitest'
import { fitLinearGd } from '../linear/gd'
import { fitOls, predictLinear } from '../linear/ols'
import { mse } from '../metrics'
import { createRng } from '../random'
import type { Matrix, Vector } from '../types'
import { trainGradient, type EpochMetrics, type GradientTrainOptions } from './gradient'

const close = (a: number, b: number, tol: number) => expect(Math.abs(a - b)).toBeLessThan(tol)

/** Deterministic noisy multivariate regression fixture. */
function makeRegression(n = 200, seed = 7): { X: Matrix; y: Vector } {
  const rng = createRng(seed)
  const X: Matrix = []
  const y: Vector = []
  for (let i = 0; i < n; i++) {
    const a = rng() * 10
    const b = rng() * 100 - 50
    const c = rng()
    X.push([a, b, c])
    y.push(1.5 * a - 0.2 * b + 8 * c + 4 + (rng() - 0.5) * 0.5)
  }
  return { X, y }
}

const base: GradientTrainOptions = {
  optimizer: 'batch_gd',
  learning_rate: 0.1,
  epochs: 500,
  batch_size: 32,
  l2: 0,
}

describe('trainGradient / fitLinearGd', () => {
  it('batch_gd converges to the OLS solution', () => {
    const { X, y } = makeRegression()
    const ols = fitOls(X, y)
    const gd = fitLinearGd(X, y, { ...base, epochs: 2000 })
    gd.weights.forEach((w, j) => close(w, ols.weights[j]!, 1e-6))
    close(gd.bias, ols.bias, 1e-6)
  })

  it('batch_gd with l2 converges to the ridge (OLS + l2) solution', () => {
    const { X, y } = makeRegression()
    const ols = fitOls(X, y, { l2: 25 })
    const gd = fitLinearGd(X, y, { ...base, epochs: 2000, l2: 25 })
    gd.weights.forEach((w, j) => close(w, ols.weights[j]!, 1e-6))
    close(gd.bias, ols.bias, 1e-6)
  })

  it('sgd reaches near-OLS loss with mini-batches', () => {
    const { X, y } = makeRegression()
    const olsLoss = mse(y, predictLinear(fitOls(X, y), X))
    const m = fitLinearGd(X, y, { ...base, optimizer: 'sgd', learning_rate: 0.01, epochs: 300, batch_size: 16 })
    const loss = mse(y, predictLinear(m, X))
    expect(loss).toBeLessThan(olsLoss * 1.05 + 1e-3)
  })

  it('adam reaches near-OLS loss with mini-batches', () => {
    const { X, y } = makeRegression()
    const olsLoss = mse(y, predictLinear(fitOls(X, y), X))
    const m = fitLinearGd(X, y, { ...base, optimizer: 'adam', learning_rate: 0.05, epochs: 300, batch_size: 16 })
    const loss = mse(y, predictLinear(m, X))
    expect(loss).toBeLessThan(olsLoss * 1.05 + 1e-3)
  })

  it('reports one metric per epoch, loss non-increasing for batch_gd, matching final MSE', () => {
    const { X, y } = makeRegression()
    const curve: EpochMetrics[] = []
    const m = fitLinearGd(X, y, { ...base, epochs: 50, onEpoch: (e) => void curve.push(e) })
    expect(curve.map((c) => c.epoch)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
    for (let i = 1; i < curve.length; i++) expect(curve[i]!.loss).toBeLessThanOrEqual(curve[i - 1]!.loss + 1e-12)
    close(curve.at(-1)!.loss, mse(y, predictLinear(m, X)), 1e-9)
  })

  it('is deterministic for the same seed and differs across seeds (sgd)', () => {
    const { X, y } = makeRegression()
    const opts: GradientTrainOptions = { ...base, optimizer: 'sgd', epochs: 5, batch_size: 8, learning_rate: 0.01 }
    const a = fitLinearGd(X, y, { ...opts, seed: 1 })
    const b = fitLinearGd(X, y, { ...opts, seed: 1 })
    const c = fitLinearGd(X, y, { ...opts, seed: 2 })
    expect(a.weights).toEqual(b.weights)
    expect(a.bias).toBe(b.bias)
    expect(a.weights).not.toEqual(c.weights)
  })

  it('stops early when onEpoch returns false', () => {
    const { X, y } = makeRegression()
    let calls = 0
    fitLinearGd(X, y, { ...base, epochs: 100, onEpoch: () => ++calls < 10 })
    expect(calls).toBe(10)
  })

  it('throws a clear error when the learning rate diverges', () => {
    const { X, y } = makeRegression()
    expect(() => fitLinearGd(X, y, { ...base, learning_rate: 20, epochs: 500 })).toThrow(/diverged/)
  })

  it('handles a constant feature (weight stays 0, no NaN)', () => {
    const X: Matrix = [
      [1, 5],
      [2, 5],
      [3, 5],
      [4, 5],
    ]
    const y = X.map(([a]) => 2 * a! + 1)
    const m = fitLinearGd(X, y, { ...base, epochs: 1000 })
    expect(m.weights[1]).toBe(0)
    close(predictLinear(m, [[5, 5]])[0]!, 11, 1e-6)
  })

  it('rejects invalid inputs', () => {
    expect(() => trainGradient([], [], 'identity', base)).toThrow()
    expect(() => trainGradient([[1]], [1, 2], 'identity', base)).toThrow()
    expect(() => trainGradient([[]], [1], 'identity', base)).toThrow()
    expect(() => trainGradient([[1], [2]], [1, 2], 'identity', { ...base, learning_rate: 0 })).toThrow()
    expect(() => trainGradient([[1], [2]], [1, 2], 'identity', { ...base, epochs: 0 })).toThrow()
    expect(() => trainGradient([[1], [2]], [1, 2], 'identity', { ...base, batch_size: 0 })).toThrow()
    expect(() => trainGradient([[1], [2]], [1, 2], 'identity', { ...base, l2: -1 })).toThrow()
    expect(() => trainGradient([[1], [2]], [0, 2], 'sigmoid', base)).toThrow(/0 or 1/)
  })
})
