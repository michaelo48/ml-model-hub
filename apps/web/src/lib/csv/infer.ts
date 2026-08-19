import { z } from 'zod'

/** Storage bucket for raw CSV uploads; objects live under '<user_id>/<dataset_id>.csv'. */
export const DATASETS_BUCKET = 'datasets'

/** Hard limits, enforced server-side (client uses them for early feedback). */
export const DATASET_LIMITS = {
  maxBytes: 25 * 1024 * 1024, // 25 MB, matches the storage bucket cap
  maxRows: 100_000,
  maxColumns: 500,
  previewRows: 50,
  sampleValues: 5,
} as const

export const columnTypeSchema = z.enum(['number', 'boolean', 'string'])
export type ColumnType = z.infer<typeof columnTypeSchema>

export const columnMetaSchema = z.object({
  name: z.string(),
  type: columnTypeSchema,
  /** Rows where the cell was empty. */
  missing: z.number().int().nonnegative(),
  /** A few distinct non-empty values, in order of first appearance. */
  sample: z.array(z.string()),
})
export type ColumnMeta = z.infer<typeof columnMetaSchema>
export const columnsSchema = z.array(columnMetaSchema)

const BOOL_TOKENS = new Set(['true', 'false', 'yes', 'no', 't', 'f', 'y', 'n', '0', '1'])

export function isMissing(cell: string | null | undefined): boolean {
  if (cell == null) return true
  const s = cell.trim()
  return s === '' || s.toLowerCase() === 'na' || s.toLowerCase() === 'nan' || s.toLowerCase() === 'null'
}

export function parseNumber(cell: string): number | null {
  const s = cell.trim()
  if (s === '') return null
  // Reject things Number() is too lenient about (e.g. '' -> 0, '0x10').
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/**
 * Infer a column type from its raw string cells.
 * number: every non-missing cell parses as a finite number.
 * boolean: every non-missing cell is a boolean-ish token AND the column is
 *          not all-numeric (so a 0/1 column stays numeric, which is what
 *          regression wants).
 * string: everything else.
 */
export function inferType(cells: ReadonlyArray<string | null | undefined>): ColumnType {
  let sawValue = false
  let allNumeric = true
  let allBool = true
  for (const c of cells) {
    if (isMissing(c)) continue
    sawValue = true
    const s = (c as string).trim()
    if (allNumeric && parseNumber(s) === null) allNumeric = false
    if (allBool && !BOOL_TOKENS.has(s.toLowerCase())) allBool = false
    if (!allNumeric && !allBool) return 'string'
  }
  if (!sawValue) return 'string'
  if (allNumeric) return 'number'
  if (allBool) return 'boolean'
  return 'string'
}

/**
 * Build column metadata from a header row and data rows (array-of-arrays,
 * as papaparse produces with header: false).
 */
export function inferColumns(header: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>): ColumnMeta[] {
  return header.map((rawName, j) => {
    const name = rawName.trim() || `column_${j + 1}`
    const cells = rows.map((r) => r[j])
    let missing = 0
    const sample: string[] = []
    const seen = new Set<string>()
    for (const c of cells) {
      if (isMissing(c)) {
        missing++
        continue
      }
      const s = (c as string).trim()
      if (sample.length < DATASET_LIMITS.sampleValues && !seen.has(s)) {
        seen.add(s)
        sample.push(s.length > 40 ? s.slice(0, 40) + '…' : s)
      }
    }
    return { name, type: inferType(cells), missing, sample }
  })
}

/** Structural validation of a parsed CSV. Returns an error message or null. */
export function validateShape(header: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>): string | null {
  if (header.length < 2) return 'CSV needs at least two columns (features and a target).'
  if (header.length > DATASET_LIMITS.maxColumns) return `CSV has ${header.length} columns; the limit is ${DATASET_LIMITS.maxColumns}.`
  if (rows.length === 0) return 'CSV has a header but no data rows.'
  if (rows.length > DATASET_LIMITS.maxRows) return `CSV has more than ${DATASET_LIMITS.maxRows.toLocaleString()} rows.`
  const names = header.map((h) => h.trim())
  if (names.some((n) => n === '')) return 'Every column needs a header name.'
  const dupes = names.filter((n, i) => names.indexOf(n) !== i)
  if (dupes.length) return `Duplicate column names: ${[...new Set(dupes)].join(', ')}.`
  const bad = rows.findIndex((r) => r.length !== header.length)
  if (bad !== -1) return `Row ${bad + 2} has ${rows[bad]!.length} cells; expected ${header.length}.`
  return null
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export type CsvAnalysis =
  | { ok: true; columns: ColumnMeta[]; rowCount: number }
  | { ok: false; error: string }

/**
 * Parse full CSV text and produce column metadata, enforcing every limit.
 * Pure: the server action feeds it the downloaded file and stores the result.
 */
export function analyzeCsv(
  text: string,
  parse: (text: string, previewRows: number) => { data: string[][]; fatalError?: string }
): CsvAnalysis {
  // maxRows + 2 (header + one over) lets us detect "too many rows" without
  // materialising the whole tail of a large file.
  const parsed = parse(text, DATASET_LIMITS.maxRows + 2)
  if (parsed.fatalError) return { ok: false, error: `CSV parse error: ${parsed.fatalError}` }
  const [header, ...rows] = parsed.data
  if (!header) return { ok: false, error: 'File is empty.' }
  const shapeError = validateShape(header, rows)
  if (shapeError) return { ok: false, error: shapeError }
  return { ok: true, columns: inferColumns(header, rows), rowCount: rows.length }
}
