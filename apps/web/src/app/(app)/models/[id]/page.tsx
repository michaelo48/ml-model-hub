import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { artifactMetricsSchema, hyperparametersSchema, OPTIMIZER_LABELS, relevantHyperparameters } from '@modelforge/ml'
import { createClient } from '@/lib/supabase/server'
import { formatDuration, formatNumber } from '@/lib/charts/scale'
import { isTerminal } from '@/lib/training/metrics'
import { formatUtc } from '@/lib/time'
import { PageHeader, Stat, StatusBadge } from '@/components/layout/AppShell'
import { ModelActions } from '@/components/models/ModelActions'

export const metadata: Metadata = { title: 'Model' }

/** Just enough of a job row to say how long its training run took. */
type JobTiming = { started_at: string | null; finished_at: string | null }

/**
 * Model detail. Three things the owner comes here for, in that order: how good
 * the served model is, how it was configured, and what happened on the way
 * (versions and the runs that produced them). Everything is read under RLS
 * from the user's session, so a model that is not theirs simply does not exist.
 */
export default async function ModelPage({ params }: PageProps<'/models/[id]'>) {
  const { id } = await params
  const supabase = await createClient()
  const { data: model } = await supabase
    .from('models')
    .select('*, datasets(id, name, row_count)')
    .eq('id', id)
    .maybeSingle()
  if (!model) notFound()

  const [{ data: jobs }, { data: artifacts }] = await Promise.all([
    supabase
      .from('training_jobs')
      .select('id, status, created_at, started_at, finished_at, error_message, attempt')
      .eq('model_id', id)
      .order('created_at', { ascending: false }),
    supabase
      .from('model_artifacts')
      .select('id, job_id, version, metrics, created_at')
      .eq('model_id', id)
      .order('version', { ascending: false }),
  ])

  const hp = hyperparametersSchema.safeParse(model.hyperparameters)
  const shown = hp.success ? relevantHyperparameters(hp.data.optimizer) : []
  const latestJob = jobs?.[0]
  // At most one job per model is ever in flight (enqueueTraining refuses a
  // second), so the first non-terminal one is the run worth watching.
  const activeJob = jobs?.find((j) => !isTerminal(j.status))
  const jobById = new Map((jobs ?? []).map((j) => [j.id, j]))
  const regression = model.task === 'regression'
  // Artifacts come back version-descending and predictions use the highest
  // version (CLAUDE.md §4), so the first row is what the endpoint serves.
  const serving = artifacts?.[0]
  const servingMetrics = serving ? artifactMetricsSchema.safeParse(serving.metrics) : null

  return (
    <>
      <PageHeader
        title={model.name}
        description={`Created ${formatUtc(model.created_at)}`}
        action={<ModelActions modelId={model.id} name={model.name} status={model.status} />}
      />

      <dl className="mb-6 grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-4">
        <Item label="Status">
          <span className="flex items-center gap-2">
            <StatusBadge status={model.status} />
            {activeJob ? (
              <Link href={`/jobs/${activeJob.id}`} className="text-xs text-accent hover:text-accent-hover">
                watch live
              </Link>
            ) : null}
          </span>
        </Item>
        <Item label="Dataset">
          <Link href={`/datasets/${model.datasets?.id}`} className="text-fg hover:text-accent">
            {model.datasets?.name ?? '-'}
          </Link>
          <span className="ml-1 font-mono text-xs text-fg-muted">
            {model.datasets?.row_count?.toLocaleString('en-US') ?? '?'} rows
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
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-sm font-medium">
            Final metrics
            {serving ? <span className="ml-2 font-mono text-xs text-fg-muted">v{serving.version}, serving</span> : null}
          </h2>
          {serving ? (
            <span className="font-mono text-xs text-fg-muted">trained {formatUtc(serving.created_at)}</span>
          ) : null}
        </div>
        {!serving ? (
          <Empty>No trained version yet. Press Train to run this configuration against the dataset.</Empty>
        ) : !servingMetrics?.success ? (
          <Empty>This version was written in an older metrics format and cannot be summarized.</Empty>
        ) : (
          <dl className="grid grid-cols-2 gap-x-8 gap-y-3 rounded-sm border border-line bg-surface px-4 py-3 sm:grid-cols-6">
            <Stat label={regression ? 'Train MSE' : 'Log loss'}>{formatNumber(servingMetrics.data.train_loss)}</Stat>
            {regression ? (
              <>
                <Stat label="RMSE">{optional(servingMetrics.data.rmse)}</Stat>
                <Stat label="R²">{optional(servingMetrics.data.r2)}</Stat>
              </>
            ) : (
              <Stat label="Accuracy">{percent(servingMetrics.data.accuracy)}</Stat>
            )}
            <Stat label="Rows">{servingMetrics.data.n_rows.toLocaleString('en-US')}</Stat>
            <Stat label="Epochs">{servingMetrics.data.epochs_run.toLocaleString('en-US')}</Stat>
            <Stat label="Train time">{duration(jobById.get(serving.job_id))}</Stat>
          </dl>
        )}
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-sm font-medium">Versions</h2>
        {!artifacts || artifacts.length === 0 ? (
          <Empty>Each successful training run publishes a version here.</Empty>
        ) : (
          <div className="overflow-x-auto rounded-sm border border-line">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-surface text-left text-xs text-fg-muted">
                <tr>
                  <th className="border-b border-line px-3 py-1.5 font-medium">Version</th>
                  <th className="border-b border-line px-3 py-1.5 text-right font-medium">
                    {regression ? 'Train MSE' : 'Log loss'}
                  </th>
                  {regression ? (
                    <>
                      <th className="border-b border-line px-3 py-1.5 text-right font-medium">RMSE</th>
                      <th className="border-b border-line px-3 py-1.5 text-right font-medium">R²</th>
                    </>
                  ) : (
                    <th className="border-b border-line px-3 py-1.5 text-right font-medium">Accuracy</th>
                  )}
                  <th className="border-b border-line px-3 py-1.5 text-right font-medium">Rows</th>
                  <th className="border-b border-line px-3 py-1.5 text-right font-medium">Epochs</th>
                  <th className="border-b border-line px-3 py-1.5 text-right font-medium">Train time</th>
                  <th className="border-b border-line px-3 py-1.5 font-medium">Job</th>
                  <th className="border-b border-line px-3 py-1.5 text-right font-medium">Trained</th>
                </tr>
              </thead>
              <tbody>
                {artifacts.map((a, i) => {
                  const m = artifactMetricsSchema.safeParse(a.metrics)
                  return (
                    <tr key={a.id} className="border-b border-line last:border-0 hover:bg-surface">
                      <td className="px-3 py-2 font-mono text-xs">
                        v{a.version}
                        {i === 0 ? (
                          <span className="ml-2 rounded-sm border border-accent/40 px-1 py-px text-accent">serving</span>
                        ) : null}
                      </td>
                      <Num>{m.success ? formatNumber(m.data.train_loss) : '?'}</Num>
                      {regression ? (
                        <>
                          <Num>{m.success ? optional(m.data.rmse) : '-'}</Num>
                          <Num>{m.success ? optional(m.data.r2) : '-'}</Num>
                        </>
                      ) : (
                        <Num>{m.success ? percent(m.data.accuracy) : '-'}</Num>
                      )}
                      <Num muted>{m.success ? m.data.n_rows.toLocaleString('en-US') : '-'}</Num>
                      <Num muted>{m.success ? m.data.epochs_run.toLocaleString('en-US') : '-'}</Num>
                      <Num muted>{duration(jobById.get(a.job_id))}</Num>
                      <td className="px-3 py-2">
                        <Link href={`/jobs/${a.job_id}`} className="font-mono text-xs text-fg hover:text-accent">
                          {a.job_id.slice(0, 8)}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs text-fg-muted">{formatUtc(a.created_at)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-sm font-medium">Hyperparameters</h2>
        {hp.success ? (
          <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-5">
            <Item label="Optimizer">
              <span className="text-xs">{OPTIMIZER_LABELS[hp.data.optimizer]}</span>
            </Item>
            {shown.includes('learning_rate') ? (
              <Item label="Learning rate">
                <Mono>{hp.data.learning_rate}</Mono>
              </Item>
            ) : null}
            {shown.includes('epochs') ? (
              <Item label="Epochs">
                <Mono>{hp.data.epochs}</Mono>
              </Item>
            ) : null}
            {shown.includes('batch_size') ? (
              <Item label="Batch size">
                <Mono>{hp.data.batch_size}</Mono>
              </Item>
            ) : null}
            <Item label="L2">
              <Mono>{hp.data.l2}</Mono>
            </Item>
          </dl>
        ) : (
          <p className="text-sm text-fg-muted">Unreadable hyperparameters.</p>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium">Training jobs</h2>
        {!jobs || jobs.length === 0 ? (
          <Empty>No training runs yet. Press Train to enqueue one.</Empty>
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
                    <td className="px-3 py-2">
                      <StatusBadge status={j.status} />
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">{j.attempt}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-fg-muted">{formatUtc(j.created_at)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-fg-muted">{duration(j)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
function Num({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return <td className={`px-3 py-2 text-right font-mono text-xs ${muted ? 'text-fg-muted' : ''}`}>{children}</td>
}
function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-sm border border-line bg-surface px-4 py-6 text-center text-sm text-fg-muted">{children}</p>
  )
}

/** A metric the worker records for one task only; absent is a dash, not a zero. */
function optional(v: number | undefined): string {
  return v == null ? '-' : formatNumber(v)
}
function percent(v: number | undefined): string {
  return v == null ? '-' : `${(v * 100).toFixed(1)}%`
}

/**
 * How long a training run took. A job still in flight has no finished_at, and
 * the ticking clock belongs to the job page, so say so here rather than baking
 * a server timestamp into HTML that is stale the moment it is sent.
 */
function duration(job: JobTiming | undefined): string {
  if (!job?.started_at) return '-'
  if (!job.finished_at) return 'running'
  return formatDuration(new Date(job.finished_at).getTime() - new Date(job.started_at).getTime())
}
