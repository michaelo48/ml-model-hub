import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { PageHeader, StatusBadge } from '@/components/layout/AppShell'

export const metadata: Metadata = { title: 'Training job' }

export default async function JobDetailPage({ params }: PageProps<'/jobs/[id]'>) {
  const { id } = await params
  const supabase = await createClient()
  const { data: job } = await supabase
    .from('training_jobs')
    .select('*, models(id, name)')
    .eq('id', id)
    .maybeSingle()
  if (!job) notFound()

  return (
    <>
      <PageHeader
        title={`Training ${job.models?.name ?? ''}`}
        description={`Job ${job.id.slice(0, 8)}, queued ${new Date(job.created_at).toLocaleString()}`}
        action={
          <Link href={`/models/${job.model_id}`} className="text-sm text-fg-muted hover:text-fg">
            Back to model
          </Link>
        }
      />
      <div className="mb-6 flex items-center gap-3 text-sm">
        <StatusBadge status={job.status} />
        {job.claimed_by ? <span className="font-mono text-xs text-fg-muted">worker {job.claimed_by}</span> : null}
        {job.attempt > 1 ? <span className="font-mono text-xs text-fg-muted">attempt {job.attempt}</span> : null}
      </div>
      {job.error_message ? (
        <p role="alert" className="mb-6 rounded-sm border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger">
          {job.error_message}
        </p>
      ) : null}
      <p className="text-sm text-fg-muted">
        {job.status === 'queued'
          ? 'Waiting for a worker to pick this job up.'
          : 'Live loss curve arrives with the next step (worker + Realtime).'}
      </p>
    </>
  )
}
