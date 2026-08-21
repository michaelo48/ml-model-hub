import type { Metadata } from 'next'
import Link from 'next/link'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { artifactMetricsSchema, hyperparametersSchema, OPTIMIZER_LABELS, relevantHyperparameters } from '@modelforge/ml'
import { createClient } from '@/lib/supabase/server'
import { formatDuration, formatNumber } from '@/lib/charts/scale'
import { isTerminal } from '@/lib/training/metrics'
import { formatUtc } from '@/lib/time'
import { Empty, PageHeader, Stat, StatusBadge } from '@/components/layout/AppShell'
import { Num, Th } from '@/components/ui/table'
import { ModelActions } from '@/components/models/ModelActions'
import { ApiKeys } from '@/components/models/ApiKeys'
import { columnsSchema } from '@/lib/csv/infer'

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
    .select('*, datasets(id, name, row_count, columns)')
    .eq('id', id)
    .maybeSingle()
  if (!model) notFound()

  const [{ data: jobs }, { data: artifacts }, { data: apiKeys }, hdrs] = await Promise.all([
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
    supabase
      .from('api_keys')
      .select('id, name, key_prefix, created_at, last_used_at, revoked_at')
      .eq('model_id', id)
      .order('created_at', { ascending: false }),
    headers(),
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
  // version (CLAUDE.md §4), so the first row is what the endpoint serves. The
  // predict route must pick its artifact the same way or the badge below lies.
  const serving = artifacts?.[0]
  const servingMetrics = serving ? artifactMetricsSchema.safeParse(serving.metrics) : null

  // The curl example in the keys panel should be runnable as pasted, so build
  // the absolute endpoint URL and a body from the dataset's own sample values,
  // in the model's feature order.
  const endpoint = `${appOrigin(hdrs)}/api/v1/models/${model.id}/predict`
  const exampleBody = JSON.stringify([exampleRow(model.feature_columns, model.datasets?.columns)])

  return (
    <>
      <PageHeader
        title={model.name}
        description={`Created ${formatUtc(model.created_at)}`}
        action={<ModelActions modelId={model.id} name={model.name} status={model.status} />}
      />

      <dl className="mb-6 grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-4">
        <Stat label="Status" prose>
          <span className="flex items-center gap-2">
            <StatusBadge status={model.status} />
            {activeJob ? (
              <Link href={`/jobs/${activeJob.id}`} className="text-xs text-accent hover:text-accent-hover">
                watch live
              </Link>
            ) : null}
          </span>
        </Stat>
        <Stat label="Dataset" prose>
          <Link href={`/datasets/${model.datasets?.id}`} className="text-fg hover:text-accent">
            {model.datasets?.name ?? '-'}
          </Link>
          <span className="ml-1 font-mono text-xs text-fg-muted">
            {model.datasets?.row_count?.toLocaleString('en-US') ?? '?'} rows
          </span>
        </Stat>
        <Stat label="Task">{model.task}</Stat>
        <Stat label="Algorithm">{model.algorithm}</Stat>
        <Stat label="Target">{model.target_column}</Stat>
        <Stat label={`Features (${model.feature_columns.length})`}>{model.feature_columns.join(', ')}</Stat>
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
          <Empty>This version&apos;s metrics could not be read.</Empty>
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
                  <Th>Version</Th>
                  <Th right>{regression ? 'Train MSE' : 'Log loss'}</Th>
                  {regression ? (
                    <>
                      <Th right>RMSE</Th>
                      <Th right>R²</Th>
                    </>
                  ) : (
                    <Th right>Accuracy</Th>
                  )}
                  <Th right>Rows</Th>
                  <Th right>Epochs</Th>
                  <Th right>Train time</Th>
                  <Th>Job</Th>
                  <Th right>Trained</Th>
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
            <Stat label="Optimizer" prose>
              <span className="text-sm">{OPTIMIZER_LABELS[hp.data.optimizer]}</span>
            </Stat>
            {shown.includes('learning_rate') ? <Stat label="Learning rate">{hp.data.learning_rate}</Stat> : null}
            {shown.includes('epochs') ? <Stat label="Epochs">{hp.data.epochs}</Stat> : null}
            {shown.includes('batch_size') ? <Stat label="Batch size">{hp.data.batch_size}</Stat> : null}
            <Stat label="L2">{hp.data.l2}</Stat>
          </dl>
        ) : (
          <p className="text-sm text-fg-muted">Unreadable hyperparameters.</p>
        )}
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-sm font-medium">Training jobs</h2>
        {!jobs || jobs.length === 0 ? (
          <Empty>No training runs yet. Press Train to enqueue one.</Empty>
        ) : (
          <div className="overflow-x-auto rounded-sm border border-line">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-surface text-left text-xs text-fg-muted">
                <tr>
                  <Th>Job</Th>
                  <Th>Status</Th>
                  <Th right>Attempt</Th>
                  <Th right>Queued</Th>
                  <Th right>Duration</Th>
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
                    <Num>{j.attempt}</Num>
                    <Num muted>{formatUtc(j.created_at)}</Num>
                    <Num muted>{duration(j)}</Num>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-sm font-medium">API keys</h2>
          <code className="font-mono text-xs text-fg-muted">POST {endpoint}</code>
        </div>
        {!serving ? (
          <p className="mb-3 text-xs text-fg-muted">
            Keys can be created now; requests return 404 until a version has been trained.
          </p>
        ) : null}
        <ApiKeys modelId={model.id} keys={apiKeys ?? []} endpoint={endpoint} exampleBody={exampleBody} />
      </section>
    </>
  )
}

/**
 * Public origin of this deployment. NEXT_PUBLIC_APP_URL is the source of
 * truth; the request's Host header is only a convenience for local dev, where
 * the port varies, never something to build a URL from in production.
 */
function appOrigin(hdrs: Headers): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, '')
  if (configured) return configured
  return `http://${hdrs.get('host') ?? 'localhost:3000'}`
}

/**
 * One plausible request row for the curl example: the first sample value of
 * each feature column from the dataset's metadata, as a number (booleans as
 * 0/1), falling back to 0 when the metadata has nothing usable.
 */
function exampleRow(features: string[], columnsJson: unknown): Record<string, number> {
  const cols = columnsSchema.safeParse(columnsJson)
  const byName = new Map(cols.success ? cols.data.map((c) => [c.name, c]) : [])
  const row: Record<string, number> = {}
  for (const f of features) {
    const sample = byName.get(f)?.sample[0]?.trim().toLowerCase()
    const n = sample === undefined ? NaN : ['true', 'yes', 't', 'y'].includes(sample) ? 1 : ['false', 'no', 'f', 'n'].includes(sample) ? 0 : Number(sample)
    row[f] = Number.isFinite(n) ? n : 0
  }
  return row
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
 * a server timestamp into HTML that is stale the moment it is sent. A job the
 * reaper failed has no started_at either, and reads as a dash.
 */
function duration(job: JobTiming | undefined): string {
  if (!job?.started_at) return '-'
  if (!job.finished_at) return 'running'
  return formatDuration(new Date(job.finished_at).getTime() - new Date(job.started_at).getTime())
}
