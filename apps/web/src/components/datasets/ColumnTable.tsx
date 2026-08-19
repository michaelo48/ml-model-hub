import type { ColumnMeta } from '@/lib/csv/infer'

export function ColumnTable({ columns, rowCount }: { columns: ColumnMeta[]; rowCount?: number }) {
  if (columns.length === 0) return <p className="text-sm text-fg-muted">No columns.</p>
  return (
    <div className="overflow-x-auto rounded-sm border border-line">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-surface text-left text-xs text-fg-muted">
          <tr>
            <th className="border-b border-line px-3 py-1.5 font-medium">Column</th>
            <th className="border-b border-line px-3 py-1.5 font-medium">Type</th>
            <th className="border-b border-line px-3 py-1.5 text-right font-medium">Missing</th>
            <th className="border-b border-line px-3 py-1.5 font-medium">Sample values</th>
          </tr>
        </thead>
        <tbody>
          {columns.map((c) => (
            <tr key={c.name} className="border-b border-line last:border-0">
              <td className="whitespace-nowrap px-3 py-1.5 font-mono text-xs">{c.name}</td>
              <td className="px-3 py-1.5 font-mono text-xs text-fg-muted">{c.type}</td>
              <td className="px-3 py-1.5 text-right font-mono text-xs text-fg-muted">
                {c.missing}
                {rowCount ? <span className="text-fg-muted/70"> / {rowCount.toLocaleString()}</span> : null}
              </td>
              <td className="px-3 py-1.5 font-mono text-xs text-fg-muted">{c.sample.join(', ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
