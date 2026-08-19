import { describe, expect, it } from 'vitest'
import { applyMissingFixes, buildMissingReport, computeFillValue } from './missing'

const header = ['sqft', 'garage', 'city', 'price']
const rows = [
  ['1000', 'yes', 'Austin', '200'],
  ['', 'no', 'Dallas', '150'],
  ['1200', '', 'Austin', ''],
  ['NA', 'yes', '', '300'],
  ['1400', 'yes', 'Austin', '400'],
]
const types = ['number', 'boolean', 'string', 'number'] as const

describe('buildMissingReport', () => {
  it('counts missing per column and lists affected rows', () => {
    const r = buildMissingReport(header, rows)
    expect(r.missingByColumn).toEqual([2, 1, 1, 1])
    expect(r.rows.map((x) => x.index)).toEqual([1, 2, 3])
    expect(r.totalMissingRows).toBe(3)
    expect(r.capped).toBe(false)
  })
  it('restricts to requested columns', () => {
    const r = buildMissingReport(header, rows, ['price'])
    expect(r.rows.map((x) => x.index)).toEqual([2])
    expect(r.missingByColumn).toEqual([0, 0, 0, 1])
  })
})

describe('computeFillValue', () => {
  const col = ['1', '', '3', 'NA', '10']
  it('mean', () => expect(computeFillValue(col, 'mean')).toEqual({ ok: true, value: '4.66666666667' }))
  it('median', () => expect(computeFillValue(col, 'median')).toEqual({ ok: true, value: '3' }))
  it('mode', () => expect(computeFillValue(['a', 'b', 'a', ''], 'mode')).toEqual({ ok: true, value: 'a' }))
  it('value', () => expect(computeFillValue(col, 'value', ' 7 ')).toEqual({ ok: true, value: '7' }))
  it('mean on strings fails', () => expect(computeFillValue(['a', 'b'], 'mean').ok).toBe(false))
  it('value without a value fails', () => expect(computeFillValue(col, 'value', '').ok).toBe(false))
  it('all-missing fails', () => expect(computeFillValue(['', 'NA'], 'mode').ok).toBe(false))
})

describe('applyMissingFixes', () => {
  it('applies edits, then fills, then drops, in order', () => {
    const res = applyMissingFixes(
      header,
      rows,
      {
        edits: [{ row: 1, col: 'sqft', value: '1100' }],
        fills: [
          { col: 'sqft', strategy: 'mean' },
          { col: 'garage', strategy: 'mode' },
        ],
        dropRowsMissingIn: ['city', 'price'],
      },
      types
    )
    expect(res.editsApplied).toBe(1)
    expect(res.fillsApplied).toBe(2) // sqft row 3 (NA) + garage row 2
    expect(res.rowsDropped).toBe(2) // row 2 (price missing), row 3 (city missing)
    expect(res.rows).toHaveLength(3)
    expect(res.rows[1]).toEqual(['1100', 'no', 'Dallas', '150'])
    // mean of sqft after edit: (1000+1100+1200+1400)/4 = 1175, filled into the dropped row, so not visible; check no missing remains in sqft
    expect(res.rows.every((r) => r[0] !== '' && r[0] !== 'NA')).toBe(true)
  })

  it('rejects a non-numeric edit into a numeric column', () => {
    expect(() =>
      applyMissingFixes(header, rows, { edits: [{ row: 1, col: 'sqft', value: 'big' }], fills: [], dropRowsMissingIn: [] }, types)
    ).toThrow(/not a number/)
  })

  it('rejects unknown columns and out-of-range rows', () => {
    expect(() =>
      applyMissingFixes(header, rows, { edits: [{ row: 0, col: 'nope', value: '1' }], fills: [], dropRowsMissingIn: [] }, types)
    ).toThrow(/Unknown column/)
    expect(() =>
      applyMissingFixes(header, rows, { edits: [{ row: 99, col: 'sqft', value: '1' }], fills: [], dropRowsMissingIn: [] }, types)
    ).toThrow(/does not exist/)
  })

  it('does not mutate the input', () => {
    const before = JSON.stringify(rows)
    applyMissingFixes(header, rows, { edits: [], fills: [{ col: 'sqft', strategy: 'median' }], dropRowsMissingIn: ['city'] }, types)
    expect(JSON.stringify(rows)).toBe(before)
  })
})
