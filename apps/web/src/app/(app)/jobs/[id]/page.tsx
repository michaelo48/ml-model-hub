import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { hyperparametersSchema, OPTIMIZER_LABELS } from '@modelforge/ml'
import { createClient } from '@/lib/supabase/server'
import { fetchAllMetrics, metricsWindow } from '@/lib/training/metrics'
import { formatUtc } from '@/lib/time'
import { PageHeader } from '@/components/layout/AppShell'
import { LiveTraining } from '@/components/training/LiveTraining'

export const metadata: Metadata = { title: 'Training job' }

/**
 * Training page. The server render seeds the job row and every metric of the
 * current attempt already written (so a refresh or a late visit shows the
 * full curve instantly); the client component then subscribes to Realtime
 * for the rest.
 */
export default async function JobDetailPage({ params }: PageProps<'/jobs/[id]'>) {
  const { id } = await params
  const supabase = await createClient()
  const { data: job } = await supabase
    .from('training_jobs')
    .select('*, models(id, name, hyperparameters)')
    .eq('id', id)
    .maybeSingle()
  if (!job) notFound()

  const { models: model, ...jobRow } = job
  const points = await fetchAllMetrics(supabase, id, metricsWindow(jobRow))

  const hp = hyperparametersSchema.safeParse(model?.hyperparameters)
  // OLS reports one synthetic epoch; every GD optimizer reports hp.epochs.
  const totalEpochs = hp.success ? (hp.data.optimizer === 'ols' ? 1 : hp.data.epochs) : null
  const optimizerLabel = hp.success ? OPTIMIZER_LABELS[hp.data.optimizer] : null

  return (
    <>
      <PageHeader
        title={`Training ${model?.name ?? ''}`}
        description={[`Job ${job.id.slice(0, 8)}`, optimizerLabel, `queued ${formatUtc(job.created_at)}`]
          .filter(Boolean)
          .join(', ')}
        action={
          <Link href={`/models/${job.model_id}`} className="text-sm text-fg-muted hover:text-fg">
            Back to model
          </Link>
        }
      />
      <LiveTraining initialJob={jobRow} initialPoints={points} totalEpochs={totalEpochs} modelId={job.model_id} />
    </>
  )
}
