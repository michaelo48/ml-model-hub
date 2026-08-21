import { describe, expect, it } from 'vitest'
import { MAX_ROWS_PER_REQUEST, predictBodySchema, rowsToMatrix } from './request'

describe('predict request', () => {
  it('accepts a bare array or a rows envelope', () => {
    expect(predictBodySchema.parse([{ a: 1 }])).toEqual([{ a: 1 }])
    expect(predictBodySchema.parse({ rows: [{ a: 1 }] })).toEqual([{ a: 1 }])
  })

  it('enforces the row bounds with issue codes the route can map to messages', () => {
    const empty = predictBodySchema.safeParse([])
    expect(empty.success).toBe(false)
    if (!empty.success) expect(empty.error.issues.some((i) => i.code === 'too_small')).toBe(true)
    const tooMany = predictBodySchema.safeParse(Array.from({ length: MAX_ROWS_PER_REQUEST + 1 }, () => ({})))
    expect(tooMany.success).toBe(false)
    if (!tooMany.success) expect(tooMany.error.issues.some((i) => i.code === 'too_big')).toBe(true)
    expect(predictBodySchema.safeParse({ a: 1 }).success).toBe(false)
    expect(predictBodySchema.safeParse('x').success).toBe(false)
    expect(predictBodySchema.safeParse({ rows: 'x' }).success).toBe(false)
  })

  it('builds the matrix in artifact column order, coercing booleans and ignoring extras', () => {
    const res = rowsToMatrix([{ b: true, a: 2, extra: 'x' }, { a: 0, b: false }], ['a', 'b'])
    expect(res).toEqual({ ok: true, X: [[2, 1], [0, 0]] })
  })

  it('reports the first bad cell by row and column', () => {
    expect(rowsToMatrix([{ a: 1, b: 2 }, { a: 1 }], ['a', 'b'])).toEqual({
      ok: false,
      message: 'Row 1: missing feature "b".',
    })
    expect(rowsToMatrix([{ a: '1', b: 2 }], ['a', 'b'])).toEqual({
      ok: false,
      message: 'Row 0: feature "a" must be a finite number or boolean.',
    })
    expect(rowsToMatrix([{ a: Number.NaN, b: 2 }], ['a', 'b']).ok).toBe(false)
    expect(rowsToMatrix([{ a: null, b: 2 }], ['a', 'b']).ok).toBe(false)
  })
})
