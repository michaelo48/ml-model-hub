'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { isMissing } from '@/lib/csv/infer'
import type { ColumnType } from '@/lib/csv/infer'
import { applyMissingFixesAction, restoreOriginalDataset } from '@/lib/datasets/missing-actions'
import type { FillStrategy, MissingReport } from '@/lib/datasets/missing'
import { Empty } from '@/components/layout/AppShell'
import { FormMessage, SubmitButton } from '@/components/ui/form'

type ColumnFill = { strategy: FillStrategy | 'none' | 'drop'; value: string }

export function MissingEditor({
  datasetId,
  report,
  columnTypes,
  hasOriginal,
}: {
  datasetId: string
  report: MissingReport
  columnTypes: ColumnType[]
  hasOriginal: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null)
  // edits[rowIndex][colIndex] = typed value
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [fills, setFills] = useState<Record<number, ColumnFill>>({})

  const affectedCols = useMemo(
    () => report.header.map((_, j) => j).filter((j) => report.missingByColumn[j]! > 0),
    [report]
  )

  const editCount = Object.values(edits).filter((v) => v.trim() !== '').length
  const fillCount = Object.values(fills).filter((f) => f.strategy !== 'none').length
  const canApply = (editCount > 0 || fillCount > 0) && !pending

  function setFill(j: number, patch: Partial<ColumnFill>) {
    setFills((prev) => ({ ...prev, [j]: { strategy: 'none', value: '', ...prev[j], ...patch } }))
  }

  function apply() {
    setMessage(null)
    const payload = {
      edits: Object.entries(edits)
        .filter(([, v]) => v.trim() !== '')
        .map(([k, value]) => {
          const [r, c] = k.split(':').map(Number)
          return { row: r!, col: report.header[c!]!, value }
        }),
      fills: Object.entries(fills)
        .filter(([, f]) => f.strategy !== 'none' && f.strategy !== 'drop')
        .map(([j, f]) => ({
          col: report.header[Number(j)]!,
          strategy: f.strategy as FillStrategy,
          value: f.strategy === 'value' ? f.value : undefined,
        })),
      dropRowsMissingIn: Object.entries(fills)
        .filter(([, f]) => f.strategy === 'drop')
        .map(([j]) => report.header[Number(j)]!),
    }
    start(async () => {
      const res = await applyMissingFixesAction(datasetId, payload)
      if (!res.ok) {
        setMessage({ tone: 'error', text: res.error })
        return
      }
      const d = res.data
      setMessage({
        tone: 'success',
        text: `Applied ${d.editsApplied} edit${d.editsApplied === 1 ? '' : 's'}, ${d.fillsApplied} fill${d.fillsApplied === 1 ? '' : 's'}, dropped ${d.rowsDropped} row${d.rowsDropped === 1 ? '' : 's'}. ${d.rowCount.toLocaleString()} rows now; ${d.remainingMissingRows.toLocaleString()} still have missing values.`,
      })
      setEdits({})
      setFills({})
      router.refresh()
    })
  }

  function restore() {
    if (!window.confirm('Restore the original upload? All edits and fills will be discarded.')) return
    setMessage(null)
    start(async () => {
      const res = await restoreOriginalDataset(datasetId)
      if (!res.ok) {
        setMessage({ tone: 'error', text: res.error })
        return
      }
      setMessage({ tone: 'success', text: `Original restored (${res.data.rowCount.toLocaleString()} rows).` })
      setEdits({})
      setFills({})
      router.refresh()
    })
  }

  if (report.totalMissingRows === 0) {
    return (
      <div className="flex flex-col gap-4">
        <Empty>No missing values. This dataset is ready to train on.</Empty>
        {hasOriginal ? <RestoreRow onRestore={restore} pending={pending} /> : null}
        {message ? <FormMessage tone={message.tone}>{message.text}</FormMessage> : null}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {message ? <FormMessage tone={message.tone}>{message.text}</FormMessage> : null}

      <section>
        <h2 className="mb-2 text-sm font-medium">
          Bulk fill{' '}
          <span className="font-normal text-fg-muted">
            (applied after your cell edits, to whatever is still empty)
          </span>
        </h2>
        <div className="overflow-x-auto rounded-sm border border-line">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-surface text-left text-xs text-fg-muted">
              <tr>
                <th className="border-b border-line px-3 py-1.5 font-medium">Column</th>
                <th className="border-b border-line px-3 py-1.5 font-medium">Type</th>
                <th className="border-b border-line px-3 py-1.5 text-right font-medium">Missing</th>
                <th className="border-b border-line px-3 py-1.5 font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {affectedCols.map((j) => {
                const t = columnTypes[j] ?? 'string'
                const f = fills[j] ?? { strategy: 'none', value: '' }
                return (
                  <tr key={j} className="border-b border-line last:border-0">
                    <td className="px-3 py-1.5 font-mono text-xs">{report.header[j]}</td>
                    <td className="px-3 py-1.5 font-mono text-xs text-fg-muted">{t}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs">{report.missingByColumn[j]}</td>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-2">
                        <select
                          value={f.strategy}
                          disabled={pending}
                          onChange={(e) => setFill(j, { strategy: e.target.value as ColumnFill['strategy'] })}
                          className="h-8 rounded-sm border border-line bg-surface px-2 text-xs"
                        >
                          <option value="none">Leave as is</option>
                          {t === 'number' ? <option value="mean">Fill with mean</option> : null}
                          {t === 'number' ? <option value="median">Fill with median</option> : null}
                          <option value="mode">Fill with most common</option>
                          <option value="value">Fill with a value</option>
                          <option value="drop">Drop rows missing this</option>
                        </select>
                        {f.strategy === 'value' ? (
                          <input
                            value={f.value}
                            disabled={pending}
                            onChange={(e) => setFill(j, { value: e.target.value })}
                            placeholder={t === 'number' ? '0' : 'value'}
                            className="h-8 w-32 rounded-sm border border-line bg-surface px-2 font-mono text-xs"
                          />
                        ) : null}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium">
          Rows with missing values{' '}
          <span className="font-normal text-fg-muted">
            ({report.totalMissingRows.toLocaleString()} total
            {report.capped ? `, showing the first ${report.rows.length}` : ''}). Type into an empty cell to fill it.
          </span>
        </h2>
        <div className="max-h-[32rem] overflow-auto rounded-sm border border-line">
          <table className="w-full border-collapse font-mono text-xs">
            <thead className="sticky top-0 bg-surface text-left">
              <tr>
                <th className="border-b border-line px-2 py-1.5 font-medium text-fg-muted">#</th>
                {report.header.map((h, j) => (
                  <th key={j} className="whitespace-nowrap border-b border-line px-2 py-1.5 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.rows.map((r) => (
                <tr key={r.index} className="border-b border-line last:border-0">
                  <td className="px-2 py-1 text-fg-muted">{r.index + 2}</td>
                  {r.cells.map((c, j) => {
                    const key = `${r.index}:${j}`
                    if (!isMissing(c)) {
                      return (
                        <td key={j} className="whitespace-nowrap px-2 py-1 text-fg-muted">
                          {c}
                        </td>
                      )
                    }
                    return (
                      <td key={j} className="px-1 py-0.5">
                        <input
                          value={edits[key] ?? ''}
                          disabled={pending}
                          onChange={(e) => setEdits((prev) => ({ ...prev, [key]: e.target.value }))}
                          placeholder="empty"
                          aria-label={`Row ${r.index + 2}, ${report.header[j]}`}
                          inputMode={columnTypes[j] === 'number' ? 'decimal' : 'text'}
                          className="h-7 w-24 rounded-sm border border-warning/60 bg-warning/5 px-1.5 font-mono text-xs outline-none placeholder:text-fg-muted/60 focus:border-accent focus:ring-2 focus:ring-accent/25"
                        />
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-4">
        <div className="w-48">
          <SubmitButton type="button" pending={pending} pendingLabel="Applying..." disabled={!canApply} onClick={apply}>
            Apply {editCount > 0 ? `${editCount} edit${editCount === 1 ? '' : 's'}` : ''}
            {editCount > 0 && fillCount > 0 ? ' + ' : ''}
            {fillCount > 0 ? `${fillCount} bulk action${fillCount === 1 ? '' : 's'}` : ''}
            {editCount === 0 && fillCount === 0 ? 'changes' : ''}
          </SubmitButton>
        </div>
        {hasOriginal ? <RestoreRow onRestore={restore} pending={pending} /> : null}
      </div>
    </div>
  )
}

function RestoreRow({ onRestore, pending }: { onRestore: () => void; pending: boolean }) {
  return (
    <button
      type="button"
      onClick={onRestore}
      disabled={pending}
      className="text-sm text-fg-muted underline underline-offset-2 hover:text-danger disabled:opacity-60"
    >
      Restore original upload
    </button>
  )
}
