import { describe, expect, it } from 'vitest'
import { fitOls, predictLinear } from './ols'
import { r2, rmse } from '../metrics'
import type { Matrix, Vector } from '../types'

const close = (a: number, b: number, tol = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(tol)

describe('fitOls', () => {
  it('recovers an exact 1-D line: y = 3x + 2', () => {
    const X: Matrix = [[0], [1], [2], [3], [4]]
    const y: Vector = X.map(([x]) => 3 * x! + 2)
    const m = fitOls(X, y)
    const pred = predictLinear(m, [[10], [-2.5]])
    close(pred[0]!, 32)
    close(pred[1]!, -5.5)
    close(rmse(y, predictLinear(m, X)), 0)
    close(r2(y, predictLinear(m, X)), 1)
  })

  it('recovers exact multivariate coefficients: y = 1.5a - 2b + 0.5c + 4', () => {
    const X: Matrix = [
      [1, 2, 3],
      [2, 0, 1],
      [0, 5, 2],
      [3, 3, 3],
      [4, 1, 0],
      [1, 1, 1],
      [6, 2, 5],
    ]
    const f = ([a, b, c]: number[]) => 1.5 * a! - 2 * b! + 0.5 * c! + 4
    const y = X.map(f)
    const m = fitOls(X, y)
    const probe: Matrix = [
      [7, 7, 7],
      [-1, 2, 0.5],
    ]
    const pred = predictLinear(m, probe)
    close(pred[0]!, f(probe[0]!))
    close(pred[1]!, f(probe[1]!))
  })

  it('matches the textbook slope/intercept formulas on noisy data', () => {
    // Anscombe's first dataset. Known fit: y = 0.5001x + 3.0001 (to 4 dp).
    const x = [10, 8, 13, 9, 11, 14, 6, 4, 12, 7, 5]
    const y = [8.04, 6.95, 7.58, 8.81, 8.33, 9.96, 7.24, 4.26, 10.84, 4.82, 5.68]
    const m = fitOls(
      x.map((v) => [v]),
      y
    )
    // Model is in normalized space; convert back to raw slope/intercept.
    const slope = m.weights[0]! / m.stats.std[0]!
    const intercept = m.bias - slope * m.stats.mean[0]!
    close(slope, 0.5001, 5e-4)
    close(intercept, 3.0001, 5e-4)
    close(r2(y, predictLinear(m, x.map((v) => [v]))), 0.6665, 5e-4)
  })

  it('handles a constant feature without producing NaN', () => {
    const X: Matrix = [
      [1, 5],
      [2, 5],
      [3, 5],
      [4, 5],
    ]
    const y = X.map(([a]) => 2 * a! + 1)
    const m = fitOls(X, y)
    const pred = predictLinear(m, [[5, 5]])
    expect(Number.isFinite(pred[0]!)).toBe(true)
    close(pred[0]!, 11)
  })

  it('ridge (l2 > 0) shrinks weights toward zero', () => {
    const X: Matrix = [[0], [1], [2], [3], [4], [5]]
    const y = X.map(([x]) => 3 * x! + 2)
    const plain = fitOls(X, y)
    const ridge = fitOls(X, y, { l2: 5 })
    expect(Math.abs(ridge.weights[0]!)).toBeLessThan(Math.abs(plain.weights[0]!))
    expect(ridge.weights[0]!).toBeGreaterThan(0)
  })

  it('rejects mismatched or empty inputs', () => {
    expect(() => fitOls([], [])).toThrow()
    expect(() => fitOls([[1]], [1, 2])).toThrow()
    expect(() => fitOls([[]], [1])).toThrow()
    expect(() => fitOls([[1], [2]], [1, 2], { l2: -1 })).toThrow()
  })

  it('predict rejects rows with the wrong feature count', () => {
    const m = fitOls([[1, 2], [2, 3], [3, 5]], [1, 2, 3])
    expect(() => predictLinear(m, [[1]])).toThrow()
  })
})
