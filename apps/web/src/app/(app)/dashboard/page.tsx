import type { Metadata } from 'next'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { columnsSchema, formatBytes } from '@/lib/csv/infer'
import { PageHeader, StatusBadge } from '@/components/layout/AppShell'

export const metadata: Metadata = { title: 'Dashboard' }

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: datasets } = await supabase
    .from('datasets')
    .select('id, name, status, row_count, size_bytes, columns, created_at')
    .order('created_at', { ascending: false })

  const { data: models } = await supabase
    .from('models')
    .select('id, name, task, status, created_at, datasets(name)')
    .order('created_at', { ascending: false })

  return (
    <>
      <PageHeader
        title="Models"
        description="Train a model on one of your datasets, then serve it."
        action={
          <Link
            href="/models/new"
            className="rounded-sm bg-accent px-3 py-1.5 text-sm text-accent-fg hover:bg-accent-hover"
          >
            New model
          </Link>
        }
      />

      {!models || models.length === 0 ? (
        <div className="mb-10 rounded-sm border border-line bg-surface px-6 py-10 text-center text-sm text-fg-muted">
          No models yet.{' '}
          {datasets && datasets.some((d) => d.status === 'ready') ? (
            <Link href="/models/new" className="text-fg underline underline-offset-2 hover:text-accent">
              Build your first model
            </Link>
          ) : (
            <span>Upload a dataset first.</span>
          )}
        </div>
      ) : (
        <div className="mb-10 overflow-x-auto rounded-sm border border-line">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-surface text-left text-xs text-fg-muted">
              <tr>
                <th className="border-b border-line px-3 py-1.5 font-medium">Name</th>
                <th className="border-b border-line px-3 py-1.5 font-medium">Status</th>
                <th className="border-b border-line px-3 py-1.5 font-medium">Task</th>
                <th className="border-b border-line px-3 py-1.5 font-medium">Dataset</th>
                <th className="border-b border-line px-3 py-1.5 text-right font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.id} className="border-b border-line last:border-0 hover:bg-surface">
                  <td className="px-3 py-2">
                    <Link href={`/models/${m.id}`} className="font-medium text-fg hover:text-accent">
                      {m.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2"><StatusBadge status={m.status} /></td>
                  <td className="px-3 py-2 font-mono text-xs text-fg-muted">{m.task}</td>
                  <td className="px-3 py-2 text-xs text-fg-muted">{m.datasets?.name ?? '–'}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-fg-muted">{new Date(m.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight">Datasets</h2>
        <Link href="/datasets/new" className="rounded-sm border border-line px-3 py-1.5 text-sm text-fg hover:bg-surface">
          Upload dataset
        </Link>
      </div>

      {!datasets || datasets.length === 0 ? (
        <div className="rounded-sm border border-line bg-surface px-6 py-10 text-center text-sm text-fg-muted">
          No datasets yet.{' '}
          <Link href="/datasets/new" className="text-fg underline underline-offset-2 hover:text-accent">
            Upload your first CSV
          </Link>
          .
        </div>
      ) : (
        <div className="overflow-x-auto rounded-sm border border-line">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-surface text-left text-xs text-fg-muted">
              <tr>
                <th className="border-b border-line px-3 py-1.5 font-medium">Name</th>
                <th className="border-b border-line px-3 py-1.5 font-medium">Status</th>
                <th className="border-b border-line px-3 py-1.5 text-right font-medium">Rows</th>
                <th className="border-b border-line px-3 py-1.5 text-right font-medium">Columns</th>
                <th className="border-b border-line px-3 py-1.5 text-right font-medium">Size</th>
                <th className="border-b border-line px-3 py-1.5 text-right font-medium">Uploaded</th>
              </tr>
            </thead>
            <tbody>
              {datasets.map((d) => {
                const cols = columnsSchema.safeParse(d.columns)
                return (
                  <tr key={d.id} className="border-b border-line last:border-0 hover:bg-surface">
                    <td className="px-3 py-2">
                      <Link href={`/datasets/${d.id}`} className="font-medium text-fg hover:text-accent">
                        {d.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={d.status} />
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{d.row_count?.toLocaleString() ?? '–'}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{cols.success ? cols.data.length : '–'}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{d.size_bytes != null ? formatBytes(d.size_bytes) : '–'}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-fg-muted">
                      {new Date(d.created_at).toLocaleDateString()}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
