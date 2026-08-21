import { z } from 'zod'
import type { Matrix } from '@modelforge/ml'

/** Hard cap from CLAUDE.md 5.7: at most 100 rows per request. */
export const MAX_ROWS_PER_REQUEST = 100

/**
 * One feature value. Booleans are accepted because boolean CSV columns are
 * valid features (the worker trains them as 0/1); strings are not, because
 * silently coercing "12" invites silently coercing "12abc" to NaN.
 */
const featureValue = z.union([z.number().finite(), z.boolean()])

const row = z.record(z.string(), z.unknown())
const rows = z
  .array(row)
  .min(1, 'Send at least one row.')
  .max(MAX_ROWS_PER_REQUEST, `At most ${MAX_ROWS_PER_REQUEST} rows per request.`)

/** A bare array of feature objects, or `{ rows: [...] }` for clients that prefer an envelope. */
export const predictBodySchema = z
  .union([rows, z.object({ rows })])
  .transform((b) => (Array.isArray(b) ? b : b.rows))

export type PredictRows = z.infer<typeof predictBodySchema>

export type RowsToMatrixResult = { ok: true; X: Matrix } | { ok: false; message: string }

/**
 * Turn validated rows into a design matrix in the artifact's column order.
 * Every feature must be present in every row; extra keys are ignored so a
 * client can send whole records. The first problem is reported with its row
 * index and column so the caller can fix the payload rather than guess.
 */
export function rowsToMatrix(input: PredictRows, featureColumns: readonly string[]): RowsToMatrixResult {
  const X: Matrix = new Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const r = input[i]!
    const out = new Array<number>(featureColumns.length)
    for (let j = 0; j < featureColumns.length; j++) {
      const col = featureColumns[j]!
      if (!(col in r)) return { ok: false, message: `Row ${i}: missing feature "${col}".` }
      const parsed = featureValue.safeParse(r[col])
      if (!parsed.success) {
        return { ok: false, message: `Row ${i}: feature "${col}" must be a finite number or boolean.` }
      }
      out[j] = typeof parsed.data === 'boolean' ? (parsed.data ? 1 : 0) : parsed.data
    }
    X[i] = out
  }
  return { ok: true, X }
}
