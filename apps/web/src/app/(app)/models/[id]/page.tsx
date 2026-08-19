import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { hyperparametersSchema, OPTIMIZER_LABELS, relevantHyperparameters } from '@modelforge/ml'
import { createClient } from '@/lib/supabase/server'
import { PageHeader, StatusBadge } from '@/components/layout/AppShell'
import { ModelActions } from '@/components/models/ModelActions'

export const metadata: Metadata = { title: 'Model' }

export default async function ModelPage({ params }: PageProps<'/models/[id]'>) {
  const { id } = await params
  const supabase = await createClient()
  const { data: model } = await supabase
    .from('models')
    .select('*, datasets(id, name, row_count)')
    .eq('id', id)
    .maybeSingle()
  if (!model) notFound()

  const { data: jobs } = await supabase
    .from('training_jobs')
    .select('id, status, created_at, started_at, finished_at, error_message, attempt')
    .eq('model_id', id)
    .order('created_at', { ascending: false })

  const hp = hyperparametersSchema.safeParse(model.hyperparameters)
  const shown = hp.success ? relevantHyperparameters(hp.data.optimizer) : []
  const latestJob = jobs?.[0]

  return (
    <>
      <PageHeader
        title={model.name}
        description={`Created ${new Date(model.created_at).toLocaleString()}`}
        action={<ModelActions modelId={model.id} name={model.name} status={model.status} />}
      />

      <dl className="mb-6 grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-4">
        <Item label="Status">
          <StatusBadge status={model.status} />
        </Item>
        <Item label="Dataset">
          <Link href={`/datasets/${model.datasets?.id}`} className="text-fg hover:text-accent">
            {model.datasets?.name ?? '–'}
          </Link>
          <span className="ml-1 font-mono text-xs text-fg-muted">
            {model.datasets?.row_count?.toLocaleString() ?? '?'} rows
          </span>
        </Item>
        <Item label="Task">
          <span className="font-mono text-xs">{model.task}</span>
        </Item>
        <Item label="Algorithm">
          <span className="font-mono text-xs">{model.algorithm}</span>
        </Item>
        <Item label="Target">
          <span className="font-mono text-xs">{model.target_column}</span>
        </Item>
        <Item label={`Features (${model.feature_columns.length})`}>
          <span className="font-mono text-xs">{model.feature_columns.join(', ')}</span>
        </Item>
      </dl>

      {latestJob?.status === 'failed' && latestJob.error_message ? (
        <p role="alert" className="mb-6 rounded-sm border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger">
          Last training failed: {latestJob.error_message}
        </p>
      ) : null}

      <section className="mb-8">
        <h2 className="mb-2 text-sm font-medium">Hyperparameters</h2>
        {hp.success ? (
          <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-5">
            <Item label="Optimizer">
              <span className="text-xs">{OPTIMIZER_LABELS[hp.data.optimizer]}</span>
            </Item>
            {shown.includes('learning_rate') ? <Item label="Learning rate"><Mono>{hp.data.learning_rate}</Mono></Item> : null}
            {shown.includes('epochs') ? <Item label="Epochs"><Mono>{hp.data.epochs}</Mono></Item> : null}
            {shown.includes('batch_size') ? <Item label="Batch size"><Mono>{hp.data.batch_size}</Mono></Item> : null}
            <Item label="L2"><Mono>{hp.data.l2}</Mono></Item>
          </dl>
        ) : (
          <p className="text-sm text-fg-muted">Unreadable hyperparameters.</p>
        )}
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-sm font-medium">Training jobs</h2>
        {!jobs || jobs.length === 0 ? (
          <p className="rounded-sm border border-line bg-surface px-4 py-6 text-center text-sm text-fg-muted">
            No training runs yet. Press Train to enqueue one.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-sm border border-line">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-surface text-left text-xs text-fg-muted">
                <tr>
                  <th className="border-b border-line px-3 py-1.5 font-medium">Job</th>
                  <th className="border-b border-line px-3 py-1.5 font-medium">Status</th>
                  <th className="border-b border-line px-3 py-1.5 text-right font-medium">Attempt</th>
                  <th className="border-b border-line px-3 py-1.5 text-right font-medium">Queued</th>
                  <th className="border-b border-line px-3 py-1.5 text-right font-medium">Duration</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id} className="border-b border-line last:border-0 hover:bg-surface">
                    <td className="px-3 py-2">
                      <Link href={`/jobs/${j.id}`} className="font-mono text-xs text-fg hover:text-accent">
                        {j.id.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="px-3 py-2"><StatusBadge status={j.status} /></td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{j.attempt}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-fg-muted">{new Date(j.created_at).toLocaleString()}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-fg-muted">{duration(j.started_at, j.finished_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium">Artifacts and metrics</h2>
        <p className="text-sm text-fg-muted">Appear here after a successful training run.</p>
      </section>
    </>
  )
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  )
}
function Mono({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-xs">{children}</span>
}
function duration(start: string | null, end: string | null): string {
  if (!start) return '–'
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime()
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}
