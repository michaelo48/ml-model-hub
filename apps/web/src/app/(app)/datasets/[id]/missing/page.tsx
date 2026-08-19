import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getMissingReport } from '@/lib/datasets/missing-actions'
import { PageHeader } from '@/components/layout/AppShell'
import { MissingEditor } from '@/components/datasets/MissingEditor'

export const metadata: Metadata = { title: 'Fix missing values' }

export default async function MissingValuesPage({ params }: PageProps<'/datasets/[id]/missing'>) {
  const { id } = await params
  const supabase = await createClient()
  const { data: ds } = await supabase.from('datasets').select('id, name, status').eq('id', id).maybeSingle()
  if (!ds) notFound()

  const report = ds.status === 'ready' ? await getMissingReport(id) : null

  return (
    <>
      <PageHeader
        title="Fix missing values"
        description={ds.name}
        action={
          <Link href={`/datasets/${id}`} className="text-sm text-fg-muted hover:text-fg">
            Back to dataset
          </Link>
        }
      />
      {!report ? (
        <p className="text-sm text-fg-muted">This dataset is not ready, so it cannot be edited.</p>
      ) : !report.ok ? (
        <p role="alert" className="rounded-sm border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger">
          {report.error}
        </p>
      ) : (
        <MissingEditor
          datasetId={id}
          report={report.data}
          columnTypes={report.data.columnTypes}
          hasOriginal={report.data.hasOriginal}
        />
      )}
    </>
  )
}
