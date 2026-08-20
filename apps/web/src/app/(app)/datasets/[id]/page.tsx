import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { columnsSchema, formatBytes } from '@/lib/csv/infer'
import { PageHeader, StatusBadge } from '@/components/layout/AppShell'
import { ColumnTable } from '@/components/datasets/ColumnTable'
import { DeleteDatasetButton } from '@/components/datasets/DeleteDatasetButton'

export const metadata: Metadata = { title: 'Dataset' }

export default async function DatasetPage({ params }: PageProps<'/datasets/[id]'>) {
  const { id } = await params
  const supabase = await createClient()
  const { data: ds } = await supabase.from('datasets').select('*').eq('id', id).maybeSingle()
  if (!ds) notFound()

  const columns = columnsSchema.safeParse(ds.columns)
  const cols = columns.success ? columns.data : []
  const totalMissing = cols.reduce((n, c) => n + c.missing, 0)
  const colsWithMissing = cols.filter((c) => c.missing > 0).length

  return (
    <>
      <PageHeader
        title={ds.name}
        description={`Uploaded ${new Date(ds.created_at).toLocaleString()}`}
        action={
          <div className="flex items-start gap-2">
            {ds.status === 'ready' ? (
              <Link
                href={`/models/new?dataset=${ds.id}`}
                className="h-8 rounded-sm bg-accent px-3 text-sm leading-8 text-accent-fg hover:bg-accent-hover"
              >
                Build model
              </Link>
            ) : null}
            <DeleteDatasetButton datasetId={ds.id} name={ds.name} />
          </div>
        }
      />

      <dl className="mb-6 grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-fg-muted">Status</dt>
          <dd className="mt-0.5">
            <StatusBadge status={ds.status} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-fg-muted">Rows</dt>
          <dd className="mt-0.5 font-mono">{ds.row_count?.toLocaleString() ?? '–'}</dd>
        </div>
        <div>
          <dt className="text-xs text-fg-muted">Columns</dt>
          <dd className="mt-0.5 font-mono">{cols.length || '–'}</dd>
        </div>
        <div>
          <dt className="text-xs text-fg-muted">Size</dt>
          <dd className="mt-0.5 font-mono">{ds.size_bytes != null ? formatBytes(ds.size_bytes) : '–'}</dd>
        </div>
      </dl>

      {ds.status === 'invalid' ? (
        <p role="alert" className="mb-6 rounded-sm border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger">
          {ds.error ?? 'This file failed validation.'}
        </p>
      ) : null}

      {ds.status === 'uploading' ? (
        <p className="mb-6 text-sm text-fg-muted">
          Upload did not finish. Delete this dataset and try again.
        </p>
      ) : null}

      {cols.length > 0 ? (
        <section>
          <div className="mb-2 flex items-center justify-between gap-4">
            <h2 className="text-sm font-medium">Columns</h2>
            {ds.status === 'ready' ? (
              totalMissing > 0 ? (
                <Link
                  href={`/datasets/${ds.id}/missing`}
                  className="rounded-sm border border-warning/50 px-2.5 py-1 text-xs text-warning hover:bg-warning/5"
                >
                  {totalMissing.toLocaleString()} missing value{totalMissing === 1 ? '' : 's'} in{' '}
                  {colsWithMissing} column{colsWithMissing === 1 ? '' : 's'}. Fix them
                </Link>
              ) : (
                <Link href={`/datasets/${ds.id}/missing`} className="text-xs text-fg-muted hover:text-fg">
                  No missing values
                </Link>
              )
            ) : null}
          </div>
          <ColumnTable columns={cols} rowCount={ds.row_count ?? undefined} />
        </section>
      ) : null}
    </>
  )
}
