import { z } from 'zod'
import { isMissing, parseNumber } from '@/lib/csv/infer'

/** Max rows shown in the manual editor. Beyond this, bulk fills still work. */
export const MISSING_EDITOR_ROW_CAP = 500

export const fillStrategySchema = z.enum(['mean', 'median', 'mode', 'value'])
export type FillStrategy = z.infer<typeof fillStrategySchema>

export const missingFixesSchema = z.object({
  /** Individual cell edits: 0-based data row index (excludes header). */
  edits: z
    .array(z.object({ row: z.number().int().nonnegative(), col: z.string().min(1), value: z.string().max(1000) }))
    .max(5000),
  /** Per-column bulk fills, applied after edits to cells still missing. */
  fills: z
    .array(
      z.object({
        col: z.string().min(1),
        strategy: fillStrategySchema,
        value: z.string().max(1000).optional(),
      })
    )
    .max(500),
  /** After edits and fills, drop any row still missing a value in these columns. */
  dropRowsMissingIn: z.array(z.string().min(1)).max(500),
})
export type MissingFixes = z.infer<typeof missingFixesSchema>

export interface MissingRow {
  index: number
  cells: string[]
}

export interface MissingReport {
  header: string[]
  /** Per column: number of missing cells. */
  missingByColumn: number[]
  /** Rows (capped) that have at least one missing cell in `columns` (or any column). */
  rows: MissingRow[]
  totalMissingRows: number
  capped: boolean
}

export function buildMissingReport(
  header: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
  onlyColumns?: ReadonlyArray<string>
): MissingReport {
  const colIdx = onlyColumns?.length
    ? onlyColumns.map((c) => header.indexOf(c)).filter((i) => i >= 0)
    : header.map((_, i) => i)
  const missingByColumn = header.map(() => 0)
  const out: MissingRow[] = []
  let total = 0
  rows.forEach((r, i) => {
    let hit = false
    for (const j of colIdx) {
      if (isMissing(r[j])) {
        missingByColumn[j]!++
        hit = true
      }
    }
    if (hit) {
      total++
      if (out.length < MISSING_EDITOR_ROW_CAP) out.push({ index: i, cells: [...r] })
    }
  })
  return {
    header: [...header],
    missingByColumn,
    rows: out,
    totalMissingRows: total,
    capped: total > out.length,
  }
}

/** Compute the fill value for one column, or an error message. */
export function computeFillValue(
  cells: ReadonlyArray<string>,
  strategy: FillStrategy,
  value?: string
): { ok: true; value: string } | { ok: false; error: string } {
  if (strategy === 'value') {
    if (value == null || isMissing(value)) return { ok: false, error: 'Provide a value to fill with.' }
    return { ok: true, value: value.trim() }
  }
  const present = cells.filter((c) => !isMissing(c)).map((c) => c.trim())
  if (present.length === 0) return { ok: false, error: 'Column has no values to compute a fill from.' }

  if (strategy === 'mode') {
    const counts = new Map<string, number>()
    for (const c of present) counts.set(c, (counts.get(c) ?? 0) + 1)
    let best = present[0]!
    let bestN = 0
    for (const [k, n] of counts) {
      if (n > bestN) {
        best = k
        bestN = n
      }
    }
    return { ok: true, value: best }
  }

  const nums = present.map(parseNumber)
  if (nums.some((n) => n === null)) {
    return { ok: false, error: `${strategy} needs a numeric column.` }
  }
  const xs = (nums as number[]).slice().sort((a, b) => a - b)
  if (strategy === 'mean') {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length
    return { ok: true, value: trimNumber(m) }
  }
  const mid = Math.floor(xs.length / 2)
  const med = xs.length % 2 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2
  return { ok: true, value: trimNumber(med) }
}

function trimNumber(n: number): string {
  // Avoid 1.2000000000000002 style artefacts while keeping precision.
  return String(Number(n.toPrecision(12)))
}

export interface ApplyResult {
  rows: string[][]
  editsApplied: number
  fillsApplied: number
  rowsDropped: number
}

/**
 * Apply fixes in order: edits -> fills -> drops. Pure. Throws on invalid
 * input (unknown column, edit out of range, non-numeric edit into a numeric
 * column) so the caller can report it without partial writes.
 */
export function applyMissingFixes(
  header: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
  fixes: MissingFixes,
  columnTypes: ReadonlyArray<'number' | 'boolean' | 'string'>
): ApplyResult {
  const idxOf = (col: string): number => {
    const j = header.indexOf(col)
    if (j < 0) throw new Error(`Unknown column "${col}".`)
    return j
  }
  const out: string[][] = rows.map((r) => [...r])

  let editsApplied = 0
  for (const e of fixes.edits) {
    const j = idxOf(e.col)
    const r = out[e.row]
    if (!r) throw new Error(`Row ${e.row + 2} does not exist (the file may have changed).`)
    const v = e.value.trim()
    if (v === '') continue // leaving it blank is not an edit
    if (columnTypes[j] === 'number' && parseNumber(v) === null) {
      throw new Error(`Row ${e.row + 2}, column "${e.col}": "${v}" is not a number.`)
    }
    r[j] = v
    editsApplied++
  }

  let fillsApplied = 0
  for (const f of fixes.fills) {
    const j = idxOf(f.col)
    const fill = computeFillValue(
      out.map((r) => r[j] ?? ''),
      f.strategy,
      f.value
    )
    if (!fill.ok) throw new Error(`Column "${f.col}": ${fill.error}`)
    if (columnTypes[j] === 'number' && parseNumber(fill.value) === null) {
      throw new Error(`Column "${f.col}": fill value "${fill.value}" is not a number.`)
    }
    for (const r of out) {
      if (isMissing(r[j])) {
        r[j] = fill.value
        fillsApplied++
      }
    }
  }

  let rowsDropped = 0
  let kept = out
  if (fixes.dropRowsMissingIn.length) {
    const cols = fixes.dropRowsMissingIn.map(idxOf)
    kept = out.filter((r) => {
      const drop = cols.some((j) => isMissing(r[j]))
      if (drop) rowsDropped++
      return !drop
    })
  }

  return { rows: kept, editsApplied, fillsApplied, rowsDropped }
}
