import { describe, expect, it } from 'vitest'
import { DATASET_LIMITS, analyzeCsv, inferColumns, inferType, parseNumber, validateShape } from './infer'
import { parseCsvText } from './parse'

describe('parseNumber', () => {
  it('accepts ints, decimals, exponents, signs', () => {
    expect(parseNumber('42')).toBe(42)
    expect(parseNumber('-3.5')).toBe(-3.5)
    expect(parseNumber('.5')).toBe(0.5)
    expect(parseNumber('1e3')).toBe(1000)
    expect(parseNumber(' 7 ')).toBe(7)
  })
  it('rejects things Number() would accept', () => {
    expect(parseNumber('')).toBeNull()
    expect(parseNumber('0x10')).toBeNull()
    expect(parseNumber('1,000')).toBeNull()
    expect(parseNumber('Infinity')).toBeNull()
    expect(parseNumber('12abc')).toBeNull()
  })
})

describe('inferType', () => {
  it('numeric column', () => expect(inferType(['1', '2.5', '', '-3'])).toBe('number'))
  it('0/1 column stays numeric', () => expect(inferType(['0', '1', '1', '0'])).toBe('number'))
  it('boolean column', () => expect(inferType(['true', 'False', 'yes', 'NO'])).toBe('boolean'))
  it('string column', () => expect(inferType(['a', '1', 'true'])).toBe('string'))
  it('all-missing column is string', () => expect(inferType(['', 'NA', null])).toBe('string'))
})

describe('inferColumns', () => {
  it('produces name, type, missing count and up to 5 distinct samples', () => {
    const header = ['sqft', 'sold', ' city ']
    const rows = [
      ['1000', 'yes', 'Austin'],
      ['1200', 'no', 'Austin'],
      ['', 'yes', 'Dallas'],
      ['900', 'NA', 'Houston'],
      ['1500', 'no', 'Plano'],
      ['1600', 'yes', 'Waco'],
      ['1700', 'yes', 'Tyler'],
    ]
    const cols = inferColumns(header, rows)
    expect(cols.map((c) => c.name)).toEqual(['sqft', 'sold', 'city'])
    expect(cols.map((c) => c.type)).toEqual(['number', 'boolean', 'string'])
    expect(cols.map((c) => c.missing)).toEqual([1, 1, 0])
    expect(cols[2]!.sample).toEqual(['Austin', 'Dallas', 'Houston', 'Plano', 'Waco'])
  })
})

describe('validateShape', () => {
  it('rejects too few columns', () => expect(validateShape(['a'], [['1']])).toMatch(/at least two/))
  it('rejects no data rows', () => expect(validateShape(['a', 'b'], [])).toMatch(/no data rows/))
  it('rejects blank header', () => expect(validateShape(['a', ''], [['1', '2']])).toMatch(/header name/))
  it('rejects duplicate headers', () => expect(validateShape(['a', 'a'], [['1', '2']])).toMatch(/Duplicate/))
  it('rejects ragged rows with a 1-based line number', () =>
    expect(validateShape(['a', 'b'], [['1', '2'], ['3']])).toMatch(/Row 3 has 1 cells/))
  it('rejects too many rows', () => {
    const rows = Array.from({ length: DATASET_LIMITS.maxRows + 1 }, () => ['1', '2'])
    expect(validateShape(['a', 'b'], rows)).toMatch(/more than/)
  })
  it('accepts a clean table', () => expect(validateShape(['a', 'b'], [['1', '2']])).toBeNull())
})

describe('analyzeCsv with papaparse', () => {
  it('parses quoted fields, CRLF, and trailing newline', () => {
    const text = 'name,price,"note, with comma"\r\n"Smith, J",100,"x"\r\nLee,200.5,\r\n'
    const res = analyzeCsv(text, parseCsvText)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.rowCount).toBe(2)
    expect(res.columns.map((c) => c.type)).toEqual(['string', 'number', 'string'])
    expect(res.columns[2]!.missing).toBe(1)
  })
  it('flags empty text', () => {
    expect(analyzeCsv('', parseCsvText)).toEqual({ ok: false, error: 'File is empty.' })
  })
  it('flags rows over the limit without needing all rows parsed', () => {
    const lines = ['a,b']
    for (let i = 0; i < DATASET_LIMITS.maxRows + 5; i++) lines.push(`${i},${i}`)
    const res = analyzeCsv(lines.join('\n'), parseCsvText)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toMatch(/more than/)
  })
  it('accepts exactly maxRows rows', () => {
    const lines = ['a,b']
    for (let i = 0; i < DATASET_LIMITS.maxRows; i++) lines.push(`${i},${i}`)
    const res = analyzeCsv(lines.join('\n'), parseCsvText)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.rowCount).toBe(DATASET_LIMITS.maxRows)
  })
})
