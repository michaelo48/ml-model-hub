import { describe, expect, it } from 'vitest'
import { epochTicks, formatDuration, formatNumber, formatTick, logTicks, niceTicks, scaleLinear } from './scale'

describe('niceTicks', () => {
  it('encloses the domain with round steps', () => {
    expect(niceTicks(0.13, 0.87, 5)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1])
    expect(niceTicks(3, 47, 5)).toEqual([0, 10, 20, 30, 40, 50])
  })
  it('handles a degenerate domain', () => {
    const t = niceTicks(2, 2)
    expect(t[0]).toBeLessThan(2)
    expect(t[t.length - 1]).toBeGreaterThan(2)
    expect(niceTicks(0, 0)).toEqual([-1, -0.5, 0, 0.5, 1])
  })
  it('does not accumulate float drift', () => {
    expect(niceTicks(0, 0.3, 4)).toEqual([0, 0.1, 0.2, 0.3])
  })
  it('works with tiny losses', () => {
    const t = niceTicks(0.00012, 0.00098, 5)
    expect(t[0]).toBe(0)
    expect(t[t.length - 1]).toBeCloseTo(0.001)
  })
  it('returns nothing for non-finite input', () => {
    expect(niceTicks(NaN, 1)).toEqual([])
  })
})

describe('epochTicks', () => {
  it('always includes first and last epoch', () => {
    expect(epochTicks(1)).toEqual([1])
    expect(epochTicks(2)).toEqual([1, 2])
    expect(epochTicks(200)[0]).toBe(1)
    expect(epochTicks(200).at(-1)).toBe(200)
  })
  it('uses round interior steps', () => {
    expect(epochTicks(200)).toEqual([1, 50, 100, 150, 200])
    expect(epochTicks(50)).toEqual([1, 10, 20, 30, 40, 50])
  })
  it('drops interior ticks that crowd the ends', () => {
    // step 10 for max 47; 40 is too close to 47 so it is dropped.
    expect(epochTicks(47)).toEqual([1, 10, 20, 30, 47])
  })
})

describe('logTicks', () => {
  it('uses 1/2/5 multiples and pads one tick past the data on each side', () => {
    expect(logTicks(0.3, 40)).toEqual([0.2, 0.5, 1, 2, 5, 10, 20, 50])
    expect(logTicks(0.0123, 0.0456)).toEqual([0.01, 0.02, 0.05])
  })
  it('falls back to whole decades over wide ranges', () => {
    expect(logTicks(4.5e8, 6e10)).toEqual([1e8, 1e9, 1e10, 1e11])
    const t = logTicks(1e-6, 1e6)
    expect(t[0]).toBeCloseTo(1e-6)
    expect(t[t.length - 1]).toBe(1e6)
    expect(t.length).toBeLessThanOrEqual(8)
  })
  it('rejects non-positive input', () => {
    expect(logTicks(0, 10)).toEqual([])
    expect(logTicks(-1, 10)).toEqual([])
  })
})

describe('scaleLinear', () => {
  it('maps domain onto range, including inverted ranges', () => {
    const y = scaleLinear({ min: 0, max: 10 }, { min: 100, max: 0 })
    expect(y(0)).toBe(100)
    expect(y(10)).toBe(0)
    expect(y(5)).toBe(50)
  })
  it('centers when the domain is empty', () => {
    expect(scaleLinear({ min: 3, max: 3 }, { min: 0, max: 10 })(3)).toBe(5)
  })
})

describe('formatNumber', () => {
  it('keeps a few significant figures', () => {
    expect(formatNumber(1234.5678)).toBe('1234.6')
    expect(formatNumber(12.3456)).toBe('12.35')
    expect(formatNumber(1.23456)).toBe('1.235')
    expect(formatNumber(0.123456)).toBe('0.123')
    expect(formatNumber(0.5)).toBe('0.5')
    expect(formatNumber(2)).toBe('2')
    expect(formatNumber(0)).toBe('0')
  })
  it('switches to exponent form for extremes', () => {
    expect(formatNumber(0.000012345)).toBe('1.23e-5')
    expect(formatNumber(12345678)).toBe('1.23e+7')
    expect(formatNumber(1e-10)).toBe('1e-10')
  })
})

describe('formatTick', () => {
  it('uses the same decimals for every tick', () => {
    const ticks = [0, 0.25, 0.5, 0.75, 1]
    expect(ticks.map((t) => formatTick(t, ticks))).toEqual(['0.00', '0.25', '0.50', '0.75', '1.00'])
    const ints = [0, 10, 20]
    expect(ints.map((t) => formatTick(t, ints))).toEqual(['0', '10', '20'])
  })
  it('keeps neighbouring exponent-form ticks distinguishable', () => {
    const big = [9.106e10, 9.108e10, 9.11e10, 9.112e10]
    expect(big.map((t) => formatTick(t, big))).toEqual(['9.106e+10', '9.108e+10', '9.110e+10', '9.112e+10'])
    const tiny = [0, 0.0002, 0.0004, 0.0006]
    expect(tiny.map((t) => formatTick(t, tiny))).toEqual(['0', '2e-4', '4e-4', '6e-4'])
  })
})

describe('formatDuration', () => {
  it('picks a unit by magnitude', () => {
    expect(formatDuration(1_240)).toBe('1.2s')
    expect(formatDuration(12_400)).toBe('12s')
    expect(formatDuration(192_000)).toBe('3m 12s')
    expect(formatDuration(3_840_000)).toBe('1h 04m')
  })
})
