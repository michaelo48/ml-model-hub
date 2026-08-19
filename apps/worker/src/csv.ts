/**
 * Incremental RFC 4180 CSV parser.
 *
 * Feed it text chunks of any size with push(); it emits complete rows as
 * string[] via the callback and keeps partial state between chunks. Handles
 * quoted fields, doubled quotes inside quotes, CR/LF/CRLF line endings and a
 * UTF-8 BOM. Blank lines are skipped, matching papaparse's skipEmptyLines on
 * the upload path, but they still advance the row index, so `index` is the
 * 0-based line number of the record in the file (header = 0) as long as no
 * quoted field contains a newline. Comma delimiter only: the web app rewrites
 * edited files with commas and validates the upload, so the worker sees one
 * dialect.
 */
export class CsvParser {
  private field = ''
  private row: string[] = []
  private inQuotes = false
  /** True right after a closing quote, to detect a stray character after it. */
  private afterQuote = false
  private pendingCR = false
  /** Set when a chunk ended on a quote inside a quoted field; resolved by the next char. */
  private quoteAtBoundary = false
  private first = true
  private rowIndex = 0

  constructor(private readonly onRow: (row: string[], index: number) => void) {}

  push(chunk: string): void {
    let i = 0
    if (this.first) {
      this.first = false
      if (chunk.charCodeAt(0) === 0xfeff) i = 1
    }
    for (; i < chunk.length; i++) {
      const ch = chunk[i]!
      if (this.pendingCR) {
        this.pendingCR = false
        if (ch === '\n') continue // CRLF: the CR already ended the row
      }
      if (this.inQuotes) {
        if (ch === '"') {
          // Either a closing quote or the first half of an escaped "".
          if (i + 1 < chunk.length) {
            if (chunk[i + 1] === '"') {
              this.field += '"'
              i++
            } else {
              this.inQuotes = false
              this.afterQuote = true
            }
          } else {
            // Chunk boundary right after a quote: decide on the next char.
            this.inQuotes = false
            this.afterQuote = true
            this.quoteAtBoundary = true
          }
        } else {
          this.field += ch
        }
        continue
      }
      if (this.quoteAtBoundary) {
        this.quoteAtBoundary = false
        if (ch === '"') {
          // It was an escaped quote split across chunks.
          this.field += '"'
          this.inQuotes = true
          this.afterQuote = false
          continue
        }
      }
      switch (ch) {
        case ',':
          this.endField()
          break
        case '\n':
          this.endField()
          this.endRow()
          break
        case '\r':
          this.endField()
          this.endRow()
          this.pendingCR = true
          break
        case '"':
          if (this.field === '' && !this.afterQuote) {
            this.inQuotes = true
          } else {
            throw new CsvError(`Row ${this.rowIndex + 1}: unexpected quote in unquoted field.`)
          }
          break
        default:
          if (this.afterQuote) {
            throw new CsvError(`Row ${this.rowIndex + 1}: text after a closing quote.`)
          }
          this.field += ch
      }
    }
  }

  /** Flush the final row (files often lack a trailing newline). */
  end(): void {
    if (this.inQuotes) throw new CsvError(`Row ${this.rowIndex + 1}: unterminated quoted field.`)
    this.quoteAtBoundary = false
    if (this.field !== '' || this.row.length > 0 || this.afterQuote) {
      this.endField()
      this.endRow()
    }
  }

  private endField(): void {
    this.row.push(this.field)
    this.field = ''
    this.afterQuote = false
  }

  private endRow(): void {
    const row = this.row
    this.row = []
    const index = this.rowIndex++
    // Skip blank lines (a single empty field and nothing else) but keep counting.
    if (row.length === 1 && row[0] === '') return
    this.onRow(row, index)
  }
}

export class CsvError extends Error {
  override readonly name = 'CsvError'
}

/** Parse a whole string at once; convenience for tests and small inputs. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  const p = new CsvParser((r) => rows.push(r))
  p.push(text)
  p.end()
  return rows
}

/**
 * Decode bytes as UTF-8 in chunks and feed the parser. `chunkSize` is exposed
 * so tests can force chunk boundaries in awkward places.
 */
export function parseCsvBytes(bytes: Uint8Array, onRow: (row: string[], index: number) => void, chunkSize = 1 << 16): void {
  const decoder = new TextDecoder('utf-8')
  const parser = new CsvParser(onRow)
  for (let off = 0; off < bytes.length; off += chunkSize) {
    parser.push(decoder.decode(bytes.subarray(off, Math.min(off + chunkSize, bytes.length)), { stream: true }))
  }
  parser.push(decoder.decode())
  parser.end()
}
