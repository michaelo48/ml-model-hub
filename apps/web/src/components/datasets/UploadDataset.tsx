'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useDropzone, type FileRejection } from 'react-dropzone'
import Papa from 'papaparse'
import { createClient } from '@/lib/supabase/client'
import { createDataset, finalizeDataset } from '@/lib/datasets/actions'
import {
  DATASET_LIMITS,
  DATASETS_BUCKET,
  formatBytes,
  inferColumns,
  validateShape,
  type ColumnMeta,
} from '@/lib/csv/infer'
import { FormMessage, SubmitButton } from '@/components/ui/form'
import { ColumnTable } from './ColumnTable'

type Preview = {
  file: File
  header: string[]
  rows: string[][]
  columns: ColumnMeta[]
  truncated: boolean
  error: string | null
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'reserving' }
  | { kind: 'uploading' }
  | { kind: 'validating' }
  | { kind: 'error'; message: string }

const PHASE_LABEL: Record<Exclude<Phase['kind'], 'idle' | 'error'>, string> = {
  reserving: 'Preparing...',
  uploading: 'Uploading...',
  validating: 'Validating...',
}

export function UploadDataset() {
  const router = useRouter()
  const [preview, setPreview] = useState<Preview | null>(null)
  const [name, setName] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })

  const onDrop = useCallback((accepted: File[], rejected: FileRejection[]) => {
    setPhase({ kind: 'idle' })
    if (rejected.length) {
      const code = rejected[0]?.errors[0]?.code
      const message =
        code === 'file-too-large'
          ? `File exceeds ${formatBytes(DATASET_LIMITS.maxBytes)}.`
          : code === 'file-invalid-type'
            ? 'Only .csv files are accepted.'
            : 'That file could not be accepted.'
      setPreview(null)
      setPhase({ kind: 'error', message })
      return
    }
    const file = accepted[0]
    if (!file) return

    // Preview only the first N rows client-side; the server parses everything.
    Papa.parse<string[]>(file, {
      header: false,
      skipEmptyLines: 'greedy',
      preview: DATASET_LIMITS.previewRows + 1,
      complete: (res) => {
        const [header, ...rows] = res.data
        if (!header) {
          setPreview({ file, header: [], rows: [], columns: [], truncated: false, error: 'File is empty.' })
          return
        }
        // Row-count limits are checked server-side; only shape problems are surfaced early.
        const shapeError = validateShape(header, rows)
        const columns = shapeError ? [] : inferColumns(header, rows)
        setPreview({
          file,
          header,
          rows,
          columns,
          truncated: rows.length > DATASET_LIMITS.previewRows,
          error: shapeError,
        })
        setName((n) => n || file.name.replace(/\.csv$/i, ''))
      },
      error: (err) => {
        setPreview({ file, header: [], rows: [], columns: [], truncated: false, error: err.message })
      },
    })
  }, [])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    multiple: false,
    maxSize: DATASET_LIMITS.maxBytes,
    accept: { 'text/csv': ['.csv'], 'application/vnd.ms-excel': ['.csv'], 'text/plain': ['.csv'] },
  })

  const busy = phase.kind === 'reserving' || phase.kind === 'uploading' || phase.kind === 'validating'
  const canUpload = !!preview && !preview.error && name.trim().length > 0 && !busy

  async function upload() {
    if (!preview || preview.error) return
    setPhase({ kind: 'reserving' })
    const reserved = await createDataset({ name: name.trim(), sizeBytes: preview.file.size })
    if (!reserved.ok) {
      setPhase({ kind: 'error', message: reserved.error })
      return
    }

    setPhase({ kind: 'uploading' })
    const supabase = createClient()
    const { error: upErr } = await supabase.storage
      .from(DATASETS_BUCKET)
      .upload(reserved.data.storagePath, preview.file, { contentType: 'text/csv', upsert: false })
    if (upErr) {
      // Let the server mark the row invalid so it does not sit in 'uploading' forever.
      await finalizeDataset(reserved.data.id)
      setPhase({ kind: 'error', message: `Upload failed: ${upErr.message}` })
      return
    }

    setPhase({ kind: 'validating' })
    const fin = await finalizeDataset(reserved.data.id)
    if (!fin.ok) {
      setPhase({ kind: 'error', message: fin.error })
      return
    }
    if (fin.data.status === 'invalid') {
      setPhase({ kind: 'error', message: fin.data.error ?? 'The file failed validation.' })
      return
    }
    router.push(`/datasets/${reserved.data.id}`)
  }

  return (
    <div className="flex flex-col gap-6">
      <div
        {...getRootProps()}
        className={[
          'cursor-pointer rounded-sm border border-dashed px-6 py-10 text-center text-sm',
          isDragActive ? 'border-accent bg-accent/5 text-fg' : 'border-line bg-surface text-fg-muted hover:border-fg-muted',
        ].join(' ')}
      >
        <input {...getInputProps()} />
        {preview ? (
          <p>
            <span className="font-medium text-fg">{preview.file.name}</span>{' '}
            <span className="font-mono">({formatBytes(preview.file.size)})</span>. Drop another file to replace it.
          </p>
        ) : (
          <p>
            Drop a CSV here, or click to choose one. Up to {formatBytes(DATASET_LIMITS.maxBytes)} and{' '}
            {DATASET_LIMITS.maxRows.toLocaleString()} rows.
          </p>
        )}
      </div>

      {phase.kind === 'error' ? <FormMessage tone="error">{phase.message}</FormMessage> : null}
      {preview?.error ? <FormMessage tone="error">{preview.error}</FormMessage> : null}

      {preview && !preview.error ? (
        <>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="dataset-name" className="text-sm font-medium">
              Dataset name
            </label>
            <input
              id="dataset-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              disabled={busy}
              className="h-9 w-full max-w-md rounded-sm border border-line bg-surface px-3 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/25"
            />
          </div>

          <section>
            <h2 className="mb-2 text-sm font-medium">
              Columns <span className="font-normal text-fg-muted">(inferred from the first {DATASET_LIMITS.previewRows} rows)</span>
            </h2>
            <ColumnTable columns={preview.columns} />
          </section>

          <section>
            <h2 className="mb-2 text-sm font-medium">
              Preview{' '}
              <span className="font-normal text-fg-muted">
                (first {Math.min(preview.rows.length, DATASET_LIMITS.previewRows)} rows{preview.truncated ? ', truncated' : ''})
              </span>
            </h2>
            <div className="overflow-x-auto rounded-sm border border-line">
              <table className="w-full border-collapse font-mono text-xs">
                <thead className="bg-surface text-left">
                  <tr>
                    {preview.header.map((h, i) => (
                      <th key={i} className="whitespace-nowrap border-b border-line px-2 py-1.5 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, DATASET_LIMITS.previewRows).map((r, i) => (
                    <tr key={i} className="border-b border-line last:border-0">
                      {r.map((c, j) => (
                        <td key={j} className="whitespace-nowrap px-2 py-1 text-fg-muted">
                          {c}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="max-w-xs">
            <SubmitButton
              type="button"
              pending={busy}
              pendingLabel={busy ? PHASE_LABEL[phase.kind as keyof typeof PHASE_LABEL] : undefined}
              disabled={!canUpload}
              onClick={upload}
            >
              Upload dataset
            </SubmitButton>
          </div>
        </>
      ) : null}
    </div>
  )
}
