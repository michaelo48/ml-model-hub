import type { Matrix, Task, Vector } from '@modelforge/ml'
import { CsvError, CsvParser } from './csv'

/**
 * Turn a dataset CSV into the numeric design matrix a model needs, fed
 * incrementally: bytes go in chunk by chunk (from a network stream or a
 * buffer), rows come out as numbers as soon as each line is complete, and
 * nothing but the final X and y is retained.
 *
 * Rules mirror the web app's column inference (apps/web/src/lib/csv/infer.ts):
 * numeric cells must match a strict number pattern, boolean-ish tokens map to
 * 0/1, and empty / NA / NaN / null cells count as missing. The model builder
 * already refused text or missing columns, so any violation here means the
 * file changed under us or inference disagreed; either way the user gets a
 * row-and-column-specific message rather than NaN weights.
 */

export interface DatasetSpec {
  task: Task
  target_column: string
  feature_columns: string[]
}

export interface TrainingData {
  X: Matrix
  y: Vector
  nRows: number
}

/** A data problem the user must fix. Not retryable. */
export class DataError extends Error {
  override readonly name = 'DataError'
}

const TRUE_TOKENS = new Set(['true', 't', 'yes', 'y', '1'])
const FALSE_TOKENS = new Set(['false', 'f', 'no', 'n', '0'])
const NUMBER_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/

export function isMissing(cell: string | undefined): boolean {
  if (cell == null) return true
  const s = cell.trim().toLowerCase()
  return s === '' || s === 'na' || s === 'nan' || s === 'null'
}

/** Parse a numeric or boolean cell; null if neither. */
export function parseCell(cell: string): number | null {
  const s = cell.trim()
  if (NUMBER_RE.test(s)) {
    const n = Number(s)
    return Number.isFinite(n) ? n : null
  }
  const l = s.toLowerCase()
  if (TRUE_TOKENS.has(l)) return 1
  if (FALSE_TOKENS.has(l)) return 0
  return null
}

/** Incremental CSV -> (X, y). push() bytes in any chunking, then finish(). */
export class DatasetLoader {
  private readonly X: Matrix = []
  private readonly y: Vector = []
  private readonly decoder = new TextDecoder('utf-8')
  private readonly parser: CsvParser
  private header: string[] | null = null
  private featureIdx: number[] = []
  private targetIdx = -1
  private width = 0

  constructor(private readonly spec: DatasetSpec) {
    this.parser = new CsvParser((row, index) => this.onRow(row, index))
  }

  push(chunk: Uint8Array): void {
    this.feed(this.decoder.decode(chunk, { stream: true }))
  }

  finish(): TrainingData {
    this.feed(this.decoder.decode())
    try {
      this.parser.end()
    } catch (err) {
      throw wrapCsvError(err)
    }
    if (this.header === null) throw new DataError('The dataset file is empty.')
    if (this.X.length === 0) throw new DataError('The dataset has a header but no data rows.')
    if (this.X.length < 2) throw new DataError('Training needs at least two rows.')
    return { X: this.X, y: this.y, nRows: this.X.length }
  }

  private feed(text: string): void {
    try {
      this.parser.push(text)
    } catch (err) {
      throw wrapCsvError(err)
    }
  }

  private onRow(row: string[], index: number): void {
    const { spec } = this
    if (this.header === null) {
      const header = row.map((h) => h.trim())
      this.header = header
      this.width = header.length
      this.targetIdx = header.indexOf(spec.target_column)
      if (this.targetIdx < 0) throw new DataError(`Target column "${spec.target_column}" is not in the dataset.`)
      this.featureIdx = spec.feature_columns.map((f) => {
        const j = header.indexOf(f)
        if (j < 0) throw new DataError(`Feature column "${f}" is not in the dataset.`)
        return j
      })
      return
    }
    // 1-based line number in the file, header included (see CsvParser).
    const line = index + 1
    if (row.length !== this.width) {
      throw new DataError(`Row ${line} has ${row.length} cells; expected ${this.width}.`)
    }
    const xs = new Array<number>(this.featureIdx.length)
    for (let k = 0; k < this.featureIdx.length; k++) {
      xs[k] = cellValue(row[this.featureIdx[k]!], spec.feature_columns[k]!, line)
    }
    const t = cellValue(row[this.targetIdx], spec.target_column, line)
    if (spec.task === 'binary_classification' && t !== 0 && t !== 1) {
      throw new DataError(
        `Row ${line}, column "${spec.target_column}": binary classification needs 0/1 or true/false targets, got "${row[this.targetIdx]}".`
      )
    }
    this.X.push(xs)
    this.y.push(t)
  }
}

/** Consume an async byte stream (e.g. a fetch response body) into training data. */
export async function loadTrainingDataFromStream(
  chunks: AsyncIterable<Uint8Array>,
  spec: DatasetSpec
): Promise<TrainingData> {
  const loader = new DatasetLoader(spec)
  for await (const chunk of chunks) loader.push(chunk)
  return loader.finish()
}

/** In-memory variant for tests and small inputs. */
export function loadTrainingData(bytes: Uint8Array, spec: DatasetSpec, chunkSize = 1 << 16): TrainingData {
  const loader = new DatasetLoader(spec)
  for (let off = 0; off < bytes.length; off += chunkSize) {
    loader.push(bytes.subarray(off, Math.min(off + chunkSize, bytes.length)))
  }
  return loader.finish()
}

function wrapCsvError(err: unknown): unknown {
  return err instanceof CsvError ? new DataError(`The CSV could not be parsed. ${err.message}`) : err
}

function cellValue(cell: string | undefined, column: string, line: number): number {
  if (isMissing(cell)) {
    throw new DataError(
      `Row ${line}, column "${column}" is missing a value. Fix missing values on the dataset page, then retrain.`
    )
  }
  const v = parseCell(cell as string)
  if (v === null) {
    throw new DataError(`Row ${line}, column "${column}": "${cell}" is not a number or true/false value.`)
  }
  return v
}
