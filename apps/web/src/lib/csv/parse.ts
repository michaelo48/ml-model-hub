import Papa from 'papaparse'

/** papaparse adapter for analyzeCsv. previewRows = 0 parses everything. Kept separate so infer.ts stays dependency-free. */
export function parseCsvText(text: string, previewRows: number): { data: string[][]; fatalError?: string } {
  const res = Papa.parse<string[]>(text, { header: false, skipEmptyLines: 'greedy', preview: previewRows })
  // UndetectableDelimiter is a warning (papaparse falls back to ','); real
  // structural failures are quote errors and other delimiter errors.
  const fatal = res.errors.find(
    (e) => e.type === 'Quotes' || (e.type === 'Delimiter' && e.code !== 'UndetectableDelimiter')
  )
  return { data: res.data, fatalError: fatal?.message }
}

/** Serialize header + rows back to CSV text (RFC 4180 quoting, LF newlines). */
export function unparseCsv(header: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>): string {
  return Papa.unparse({ fields: [...header], data: rows.map((r) => [...r]) }, { newline: '\n' }) + '\n'
}
