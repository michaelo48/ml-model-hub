'use client'

import Link from 'next/link'
import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  ALGORITHM_FOR_TASK,
  DEFAULT_HYPERPARAMETERS,
  HYPERPARAMETER_LIMITS,
  OPTIMIZER_LABELS,
  optimizersForAlgorithm,
  relevantHyperparameters,
  type Hyperparameters,
  type Optimizer,
  type Task,
} from '@modelforge/ml'
import type { ColumnMeta } from '@/lib/csv/infer'
import { createModel } from '@/lib/models/actions'
import { Field, FormMessage, SubmitButton } from '@/components/ui/form'

export type BuilderDataset = { id: string; name: string; row_count: number | null; columns: ColumnMeta[] }

const TASK_LABELS: Record<Task, { label: string; hint: string }> = {
  regression: { label: 'Regression', hint: 'Predict a number (price, temperature, score).' },
  binary_classification: { label: 'Binary classification', hint: 'Predict yes/no, 0/1, true/false.' },
}

export function ModelBuilder({ datasets, initialDatasetId }: { datasets: BuilderDataset[]; initialDatasetId?: string }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  const [datasetId, setDatasetId] = useState(initialDatasetId && datasets.some((d) => d.id === initialDatasetId) ? initialDatasetId : datasets[0]?.id ?? '')
  const [name, setName] = useState('')
  const [task, setTask] = useState<Task>('regression')
  const [target, setTarget] = useState('')
  const [features, setFeatures] = useState<string[]>([])
  const [hp, setHp] = useState<Hyperparameters>(DEFAULT_HYPERPARAMETERS.ols)

  const dataset = datasets.find((d) => d.id === datasetId)
  const algorithm = ALGORITHM_FOR_TASK[task]
  const optimizers = optimizersForAlgorithm(algorithm)
  const relevant = relevantHyperparameters(hp.optimizer)

  // Columns usable as target/features: numeric or boolean. Text columns and
  // columns with missing values are listed but disabled with the reason.
  const columns = useMemo(() => dataset?.columns ?? [], [dataset])
  const targetCandidates = columns.filter((c) => (task === 'regression' ? c.type === 'number' : c.type !== 'string'))
  const usable = (c: ColumnMeta) => c.type !== 'string' && c.missing === 0
  const featureCandidates = columns.filter((c) => c.name !== target)
  const anyMissing = columns.some((c) => c.type !== 'string' && c.missing > 0)

  function switchDataset(id: string) {
    setDatasetId(id)
    setTarget('')
    setFeatures([])
    setFieldErrors({})
  }
  function switchTask(t: Task) {
    setTask(t)
    const opts = optimizersForAlgorithm(ALGORITHM_FOR_TASK[t])
    if (!opts.includes(hp.optimizer)) setHp(DEFAULT_HYPERPARAMETERS[opts[0]!])
    setTarget('')
    setFieldErrors({})
  }
  function switchOptimizer(o: Optimizer) {
    // Keep l2 (user intent), reset the rest to that optimizer's defaults.
    setHp({ ...DEFAULT_HYPERPARAMETERS[o], l2: hp.l2 })
  }
  function toggleFeature(colName: string) {
    setFeatures((f) => (f.includes(colName) ? f.filter((x) => x !== colName) : [...f, colName]))
  }
  function selectAllUsable() {
    setFeatures(featureCandidates.filter(usable).map((c) => c.name))
  }

  function submit() {
    setError(null)
    setFieldErrors({})
    if (!dataset) {
      setError('Pick a dataset.')
      return
    }
    start(async () => {
      const res = await createModel({
        name: name.trim(),
        dataset_id: dataset.id,
        task,
        algorithm,
        target_column: target,
        feature_columns: features,
        hyperparameters: hp,
      })
      if (!res.ok) {
        setError(res.error)
        setFieldErrors(res.fieldErrors ?? {})
        return
      }
      router.push(`/models/${res.data.id}`)
    })
  }

  if (datasets.length === 0) {
    return (
      <p className="rounded-sm border border-line bg-surface px-6 py-10 text-center text-sm text-fg-muted">
        You need a ready dataset first.{' '}
        <Link href="/datasets/new" className="text-fg underline underline-offset-2 hover:text-accent">
          Upload one
        </Link>
        .
      </p>
    )
  }

  const num = (k: keyof Hyperparameters, v: string) => {
    const n = Number(v)
    setHp((h) => ({ ...h, [k]: Number.isFinite(n) ? n : h[k] }))
  }

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      {error ? <FormMessage tone="error">{error}</FormMessage> : null}

      <Section n={1} title="Dataset">
        <select
          value={datasetId}
          onChange={(e) => switchDataset(e.target.value)}
          disabled={pending}
          className="h-9 w-full max-w-md rounded-sm border border-line bg-surface px-2 text-sm"
        >
          {datasets.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} ({d.row_count?.toLocaleString() ?? '?'} rows, {d.columns.length} cols)
            </option>
          ))}
        </select>
        {anyMissing && dataset ? (
          <p className="mt-2 text-xs text-warning">
            Some columns have missing values and cannot be used until fixed.{' '}
            <Link href={`/datasets/${dataset.id}/missing`} className="underline underline-offset-2">
              Fix missing values
            </Link>
          </p>
        ) : null}
      </Section>

      <Section n={2} title="Name">
        <div className="max-w-md">
          <Field label="Model name" name="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} disabled={pending} error={fieldErrors.name} placeholder={dataset ? `${dataset.name} model` : ''} />
        </div>
      </Section>

      <Section n={3} title="Task">
        <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
          {(Object.keys(TASK_LABELS) as Task[]).map((t) => (
            <label key={t} className="flex cursor-pointer items-start gap-2 text-sm">
              <input type="radio" name="task" checked={task === t} onChange={() => switchTask(t)} disabled={pending} className="mt-1 accent-accent" />
              <span>
                <span className="font-medium">{TASK_LABELS[t].label}</span>
                <span className="block text-xs text-fg-muted">{TASK_LABELS[t].hint}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="mt-2 font-mono text-xs text-fg-muted">algorithm: {algorithm}</p>
      </Section>

      <Section n={4} title="Target column">
        <select
          value={target}
          onChange={(e) => {
            setTarget(e.target.value)
            setFeatures((f) => f.filter((x) => x !== e.target.value))
          }}
          disabled={pending}
          aria-invalid={fieldErrors.target_column ? true : undefined}
          className={`h-9 w-full max-w-md rounded-sm border bg-surface px-2 text-sm ${fieldErrors.target_column ? 'border-danger' : 'border-line'}`}
        >
          <option value="">Choose a column...</option>
          {targetCandidates.map((c) => (
            <option key={c.name} value={c.name} disabled={c.missing > 0}>
              {c.name} ({c.type}{c.missing > 0 ? `, ${c.missing} missing` : ''})
            </option>
          ))}
        </select>
        {fieldErrors.target_column ? <p className="mt-1 text-xs text-danger">{fieldErrors.target_column}</p> : null}
        {targetCandidates.length === 0 ? (
          <p className="mt-1 text-xs text-fg-muted">
            No {task === 'regression' ? 'numeric' : 'numeric or boolean'} columns in this dataset.
          </p>
        ) : null}
      </Section>

      <Section n={5} title="Feature columns" action={
        <button type="button" onClick={selectAllUsable} disabled={pending} className="text-xs text-fg-muted underline underline-offset-2 hover:text-fg">
          Select all usable
        </button>
      }>
        <div className={`overflow-hidden rounded-sm border ${fieldErrors.feature_columns ? 'border-danger' : 'border-line'}`}>
          <table className="w-full border-collapse text-sm">
            <tbody>
              {featureCandidates.map((c) => {
                const ok = usable(c)
                const reason = c.type === 'string' ? 'text column' : c.missing > 0 ? `${c.missing} missing` : null
                return (
                  <tr key={c.name} className="border-b border-line last:border-0">
                    <td className="w-8 px-3 py-1.5">
                      <input type="checkbox" checked={features.includes(c.name)} onChange={() => toggleFeature(c.name)} disabled={!ok || pending} aria-label={c.name} className="accent-accent" />
                    </td>
                    <td className={`px-2 py-1.5 font-mono text-xs ${ok ? '' : 'text-fg-muted'}`}>{c.name}</td>
                    <td className="px-2 py-1.5 font-mono text-xs text-fg-muted">{c.type}</td>
                    <td className="px-3 py-1.5 text-right text-xs text-fg-muted">{reason ?? ''}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {fieldErrors.feature_columns ? <p className="mt-1 text-xs text-danger">{fieldErrors.feature_columns}</p> : null}
        <p className="mt-1 text-xs text-fg-muted">{features.length} selected. Boolean columns are encoded as 0/1.</p>
      </Section>

      <Section n={6} title="Optimizer and hyperparameters">
        <div className="flex flex-col gap-4">
          <select value={hp.optimizer} onChange={(e) => switchOptimizer(e.target.value as Optimizer)} disabled={pending} className="h-9 w-full max-w-md rounded-sm border border-line bg-surface px-2 text-sm">
            {optimizers.map((o) => (
              <option key={o} value={o}>{OPTIMIZER_LABELS[o]}</option>
            ))}
          </select>
          <div className="grid max-w-md grid-cols-2 gap-3">
            {relevant.includes('learning_rate') ? (
              <Field label="Learning rate" name="learning_rate" type="number" step="any" min={HYPERPARAMETER_LIMITS.learningRate.min} max={HYPERPARAMETER_LIMITS.learningRate.max} value={hp.learning_rate} onChange={(e) => num('learning_rate', e.target.value)} disabled={pending} />
            ) : null}
            {relevant.includes('epochs') ? (
              <Field label="Epochs" name="epochs" type="number" step={1} min={HYPERPARAMETER_LIMITS.epochs.min} max={HYPERPARAMETER_LIMITS.epochs.max} value={hp.epochs} onChange={(e) => num('epochs', e.target.value)} disabled={pending} />
            ) : null}
            {relevant.includes('batch_size') ? (
              <Field label="Batch size" name="batch_size" type="number" step={1} min={HYPERPARAMETER_LIMITS.batchSize.min} max={HYPERPARAMETER_LIMITS.batchSize.max} value={hp.batch_size} onChange={(e) => num('batch_size', e.target.value)} disabled={pending} />
            ) : null}
            <Field label="L2 penalty" name="l2" type="number" step="any" min={HYPERPARAMETER_LIMITS.l2.min} max={HYPERPARAMETER_LIMITS.l2.max} value={hp.l2} onChange={(e) => num('l2', e.target.value)} disabled={pending} hint="0 disables regularization." />
          </div>
          {hp.optimizer === 'ols' ? (
            <p className="text-xs text-fg-muted">OLS solves the normal equations directly. No epochs, no learning rate, no loss curve.</p>
          ) : null}
          {fieldErrors.hyperparameters ? <p className="text-xs text-danger">{fieldErrors.hyperparameters}</p> : null}
        </div>
      </Section>

      <div className="max-w-xs">
        <SubmitButton type="button" pending={pending} pendingLabel="Creating..." disabled={!dataset || !target || features.length === 0 || name.trim() === ''} onClick={submit}>
          Create model
        </SubmitButton>
        <p className="mt-2 text-xs text-fg-muted">Creates a draft. You start training from the model page.</p>
      </div>
    </div>
  )
}

function Section({ n, title, action, children }: { n: number; title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-medium">
          <span className="mr-2 font-mono text-xs text-fg-muted">{n}</span>
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  )
}
