import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { columnsSchema } from '@/lib/csv/infer'
import { PageHeader } from '@/components/layout/AppShell'
import { ModelBuilder, type BuilderDataset } from '@/components/models/ModelBuilder'

export const metadata: Metadata = { title: 'New model' }

export default async function NewModelPage({ searchParams }: PageProps<'/models/new'>) {
  const params = await searchParams
  const initialDatasetId = typeof params.dataset === 'string' ? params.dataset : undefined

  const supabase = await createClient()
  const { data } = await supabase
    .from('datasets')
    .select('id, name, row_count, columns')
    .eq('status', 'ready')
    .order('created_at', { ascending: false })

  const datasets: BuilderDataset[] = (data ?? []).flatMap((d) => {
    const cols = columnsSchema.safeParse(d.columns)
    return cols.success ? [{ id: d.id, name: d.name, row_count: d.row_count, columns: cols.data }] : []
  })

  return (
    <>
      <PageHeader title="New model" description="Choose the data, the target, and how to fit it. Training starts from the model page." />
      <ModelBuilder datasets={datasets} initialDatasetId={initialDatasetId} />
    </>
  )
}
