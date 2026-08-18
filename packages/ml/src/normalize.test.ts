import { describe, expect, it } from 'vitest'
import { applyStats, computeStats } from './normalize'
import { solve } from './linalg'

describe('computeStats / applyStats', () => {
  it('z-scores columns to mean 0 and std 1', () => {
    const X = [
      [1, 10],
      [2, 20],
      [3, 30],
      [4, 40],
    ]
    const stats = computeStats(X)
    expect(stats.mean).toEqual([2.5, 25])
    expect(stats.std[0]).toBeCloseTo(Math.sqrt(1.25), 12)
    expect(stats.std[1]).toBeCloseTo(Math.sqrt(125), 12)

    const Z = applyStats(X, stats)
    for (let j = 0; j < 2; j++) {
      const col = Z.map((r) => r[j]!)
      const mean = col.reduce((a, b) => a + b, 0) / col.length
      const variance = col.reduce((a, b) => a + (b - mean) ** 2, 0) / col.length
      expect(mean).toBeCloseTo(0, 12)
      expect(variance).toBeCloseTo(1, 12)
    }
  })

  it('maps a constant column to zeros instead of NaN', () => {
    const X = [[7], [7], [7]]
    const stats = computeStats(X)
    expect(stats.std).toEqual([1])
    expect(applyStats(X, stats)).toEqual([[0], [0], [0]])
  })

  it('rejects ragged and empty input', () => {
    expect(() => computeStats([])).toThrow()
    expect(() => computeStats([[1, 2], [3]])).toThrow()
  })
})

describe('solve', () => {
  it('solves a well-conditioned 3x3 system', () => {
    // 2x + y - z = 8; -3x - y + 2z = -11; -2x + y + 2z = -3  ->  x=2, y=3, z=-1
    const A = [
      [2, 1, -1],
      [-3, -1, 2],
      [-2, 1, 2],
    ]
    const x = solve(A, [8, -11, -3])
    expect(x[0]).toBeCloseTo(2, 10)
    expect(x[1]).toBeCloseTo(3, 10)
    expect(x[2]).toBeCloseTo(-1, 10)
  })

  it('pivots when the leading entry is zero', () => {
    const A = [
      [0, 1],
      [1, 0],
    ]
    expect(solve(A, [5, 7])).toEqual([7, 5])
  })

  it('throws on a singular matrix', () => {
    expect(() =>
      solve(
        [
          [1, 2],
          [2, 4],
        ],
        [1, 2]
      )
    ).toThrow()
  })
})
