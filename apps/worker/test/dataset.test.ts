import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadTrainingData, parseCell } from '../src/dataset'

const enc = (s: string) => new TextEncoder().encode(s)
const housing = readFileSync(fileURLToPath(new URL('../../../fixtures/housing.csv', import.meta.url)))

describe('loadTrainingData', () => {
  it('loads the housing fixture with a boolean feature mapped to 0/1', () => {
    const d = loadTrainingData(new Uint8Array(housing), {
      task: 'regression',
      target_column: 'price',
      feature_columns: ['sqft', 'garage'],
    })
    expect(d.nRows).toBeGreaterThan(10)
    expect(d.X[0]).toEqual([2330, 1])
    expect(d.y[0]).toBe(320945)
    expect(d.X.every((r) => r[1] === 0 || r[1] === 1)).toBe(true)
  })

  it('respects feature order from the spec, not the file', () => {
    const d = loadTrainingData(enc('a,b,c\n1,2,3\n4,5,6\n'), {
      task: 'regression',
      target_column: 'a',
      feature_columns: ['c', 'b'],
    })
    expect(d.X).toEqual([
      [3, 2],
      [6, 5],
    ])
    expect(d.y).toEqual([1, 4])
  })

  it('accepts boolean and 0/1 targets for classification and rejects others', () => {
    const ok = loadTrainingData(enc('x,y\n1,yes\n2,no\n3,1\n'), {
      task: 'binary_classification',
      target_column: 'y',
      feature_columns: ['x'],
    })
    expect(ok.y).toEqual([1, 0, 1])
    expect(() =>
      loadTrainingData(enc('x,y\n1,2\n2,0\n'), {
        task: 'binary_classification',
        target_column: 'y',
        feature_columns: ['x'],
      })
    ).toThrow(/Row 2, column "y".*0\/1/)
  })

  it('reports missing and non-numeric cells with row and column', () => {
    const spec = { task: 'regression' as const, target_column: 'y', feature_columns: ['x'] }
    expect(() => loadTrainingData(enc('x,y\n1,2\n,3\n'), spec)).toThrow(/Row 3, column "x" is missing/)
    expect(() => loadTrainingData(enc('x,y\n1,2\nabc,3\n'), spec)).toThrow(/Row 3, column "x": "abc" is not a number/)
    expect(() => loadTrainingData(enc('x,y\n1,2\n1,2,3\n'), spec)).toThrow(/Row 3 has 3 cells; expected 2/)
  })

  it('reports unknown columns and empty files', () => {
    const reg = (target: string, features: string[]) => ({
      task: 'regression' as const,
      target_column: target,
      feature_columns: features,
    })
    expect(() => loadTrainingData(enc('x,y\n1,2\n'), reg('z', ['x']))).toThrow(/Target column "z"/)
    expect(() => loadTrainingData(enc('x,y\n1,2\n'), reg('y', ['q']))).toThrow(/Feature column "q"/)
    expect(() => loadTrainingData(enc(''), reg('y', ['x']))).toThrow(/empty/)
    expect(() => loadTrainingData(enc('x,y\n'), reg('y', ['x']))).toThrow(/no data rows/)
  })

  it('parseCell', () => {
    expect(parseCell(' 1.5e3 ')).toBe(1500)
    expect(parseCell('TRUE')).toBe(1)
    expect(parseCell('n')).toBe(0)
    expect(parseCell('0x10')).toBeNull()
    expect(parseCell('maybe')).toBeNull()
  })
})
