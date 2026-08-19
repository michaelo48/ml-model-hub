import { describe, expect, it } from 'vitest'
import { accuracy, logLoss } from '../metrics'
import { sigmoid } from '../optim/gradient'
import { createRng } from '../random'
import type { Matrix, Vector } from '../types'
import { fitLogistic, predictClass, predictProba } from './logistic'
import type { GradientTrainOptions } from '../optim/gradient'

const base: GradientTrainOptions = {
  optimizer: 'batch_gd',
  learning_rate: 0.5,
  epochs: 500,
  batch_size: 32,
  l2: 0,
}

/** Two 2-D Gaussian-ish blobs; labels from a known logit with mild noise. */
function makeBlobs(n = 300, seed = 3): { X: Matrix; y: Vector } {
  const rng = createRng(seed)
  const X: Matrix = []
  const y: Vector = []
  for (let i = 0; i < n; i++) {
    const a = rng() * 6 - 3
    const b = rng() * 6 - 3
    const p = sigmoid(2 * a - 1.5 * b + 0.5)
    X.push([a, b])
    y.push(rng() < p ? 1 : 0)
  }
  return { X, y }
}

describe('sigmoid', () => {
  it('is bounded and symmetric', () => {
    expect(sigmoid(0)).toBe(0.5)
    expect(sigmoid(1000)).toBe(1)
    expect(sigmoid(-1000)).toBe(0)
    expect(sigmoid(2) + sigmoid(-2)).toBeCloseTo(1, 12)
  })
})

describe('fitLogistic', () => {
  it('separates a linearly separable 1-D problem', () => {
    const X: Matrix = [[-3], [-2], [-1], [1], [2], [3]]
    const y: Vector = [0, 0, 0, 1, 1, 1]
    const m = fitLogistic(X, y, { ...base, epochs: 300 })
    expect(predictClass(m, X)).toEqual(y)
    expect(m.weights[0]).toBeGreaterThan(0)
    const p = predictProba(m, [[-10], [10]])
    expect(p[0]).toBeLessThan(0.01)
    expect(p[1]).toBeGreaterThan(0.99)
  })

  it('learns the sign structure and beats the majority baseline on noisy blobs', () => {
    const { X, y } = makeBlobs()
    const majority = Math.max(y.filter((v) => v === 1).length, y.filter((v) => v === 0).length) / y.length
    for (const optimizer of ['batch_gd', 'sgd', 'adam'] as const) {
      const lr = optimizer === 'batch_gd' ? 0.5 : 0.05
      const m = fitLogistic(X, y, { ...base, optimizer, learning_rate: lr, epochs: 200, batch_size: 16 })
      // True logit is 2a - 1.5b + 0.5 -> positive weight on a, negative on b.
      expect(m.weights[0]).toBeGreaterThan(0)
      expect(m.weights[1]).toBeLessThan(0)
      const acc = accuracy(y, predictClass(m, X))
      expect(acc).toBeGreaterThan(majority + 0.15)
      expect(logLoss(y, predictProba(m, X))).toBeLessThan(Math.log(2))
    }
  })

  it('reported per-epoch loss equals logLoss of the final probabilities and decreases', () => {
    const { X, y } = makeBlobs()
    const losses: number[] = []
    const m = fitLogistic(X, y, { ...base, epochs: 40, onEpoch: (e) => void losses.push(e.loss) })
    for (let i = 1; i < losses.length; i++) expect(losses[i]!).toBeLessThanOrEqual(losses[i - 1]! + 1e-12)
    expect(Math.abs(losses.at(-1)! - logLoss(y, predictProba(m, X)))).toBeLessThan(1e-9)
  })

  it('l2 shrinks the weights on separable data instead of letting them blow up', () => {
    const X: Matrix = [[-3], [-2], [-1], [1], [2], [3]]
    const y: Vector = [0, 0, 0, 1, 1, 1]
    const free = fitLogistic(X, y, { ...base, epochs: 2000 })
    const reg = fitLogistic(X, y, { ...base, epochs: 2000, l2: 10 })
    expect(Math.abs(reg.weights[0]!)).toBeLessThan(Math.abs(free.weights[0]!))
    expect(predictClass(reg, X)).toEqual(y)
  })

  it('predictClass honours the threshold', () => {
    const X: Matrix = [[-3], [-2], [-1], [1], [2], [3]]
    const y: Vector = [0, 0, 0, 1, 1, 1]
    const m = fitLogistic(X, y, { ...base, epochs: 300 })
    expect(predictClass(m, [[0]], 0.0)).toEqual([1])
    expect(predictClass(m, [[0]], 1.0)).toEqual([0])
  })

  it('rejects non-binary targets', () => {
    expect(() => fitLogistic([[1], [2]], [0, 2], base)).toThrow(/0 or 1/)
  })
})

describe('classification metrics', () => {
  it('logLoss is 0 for perfect confident predictions and clips extremes', () => {
    expect(logLoss([1, 0], [1, 0])).toBeCloseTo(0, 10)
    expect(Number.isFinite(logLoss([1, 0], [0, 1]))).toBe(true)
    expect(logLoss([1, 0], [0.5, 0.5])).toBeCloseTo(Math.log(2), 12)
  })
  it('accuracy counts exact matches', () => {
    expect(accuracy([1, 0, 1, 1], [1, 0, 0, 1])).toBe(0.75)
    expect(() => accuracy([1], [1, 0])).toThrow()
  })
})
