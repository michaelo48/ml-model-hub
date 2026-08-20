import { buildArtifact, type ArtifactMetrics, type LinearModel } from '@modelforge/ml'
import {
  deleteArtifactRow,
  deleteJobMetrics,
  heartbeat,
  InfraError,
  insertArtifactRow,
  insertMetrics,
  loadDataset,
  loadModel,
  markJobFailed,
  markJobRunning,
  markJobSucceeded,
  ModelConfigError,
  nextArtifactVersion,
  removeArtifactObject,
  requeueJob,
  setModelStatus,
  signDatasetUrl,
  uploadArtifact,
  type Db,
  type JobRow,
  type MetricRow,
  type ModelRow,
} from './db'
import type { Env } from './env'
import { log } from './log'
import { MetricsSink } from './metrics-sink'
import { trainInThread, type TrainHandle } from './trainer'

/**
 * Run one claimed job to completion.
 *
 *   claimed -> running -> succeeded | failed | queued (released)
 *
 * Failure policy:
 *   - Data/config problems (bad cells, diverging loss, invalid model row) fail
 *     the job immediately with a message the user can act on.
 *   - Infra problems (storage, DB) requeue the job while attempts remain,
 *     then fail it. `attempt` was incremented by claim_training_job.
 *   - A shutdown request stops training after the current epoch and releases
 *     the job with its attempt count restored, so another worker picks it up.
 *
 * Ownership: every job-state write is fenced on claimed_by (db.ts). If a
 * fence misses, the reaper has handed this job to someone else while we were
 * stalled; we log it and touch nothing else, including models.status and any
 * artifact we were about to record.
 */

export interface JobContext {
  db: Db
  env: Env
}

export interface RunningJob {
  jobId: string
  stop: () => void
}

export async function runJob(ctx: JobContext, job: JobRow, onStart?: (r: RunningJob) => void): Promise<void> {
  const { db, env } = ctx
  const me = env.WORKER_ID
  const jobLog = (msg: string, fields: Record<string, unknown> = {}): void =>
    log.info(msg, { jobId: job.id, modelId: job.model_id, attempt: job.attempt, ...fields })

  let model: ModelRow | null = null
  let handle: TrainHandle | null = null
  let sink: MetricsSink | null = null
  let heartbeatTimer: NodeJS.Timeout | null = null
  let lostOwnership = false

  const stopHeartbeat = (): void => {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  const lost = (where: string): void => {
    if (!lostOwnership) {
      lostOwnership = true
      log.warn('lost ownership of job (reaped and reclaimed, or deleted); leaving it alone', {
        jobId: job.id,
        where,
      })
    }
    handle?.stop()
  }

  try {
    model = await loadModel(db, job.model_id)
    if (!model) {
      // The model was deleted after enqueue (cascade removes the job too, but
      // a race is possible). Nothing to do.
      jobLog('model not found; dropping job')
      return
    }
    const dataset = await loadDataset(db, model.dataset_id)
    if (!dataset) throw new ModelConfigError('The dataset for this model no longer exists.')
    if (dataset.status !== 'ready') throw new ModelConfigError(`The dataset is ${dataset.status}, not ready.`)

    if (!(await markJobRunning(db, job.id, me))) {
      lost('markJobRunning')
      return
    }
    await setModelStatus(db, model.id, 'training')
    // Retries and requeues leave the previous attempt's curve behind.
    await deleteJobMetrics(db, job.id)
    jobLog('job running', { algorithm: model.algorithm, optimizer: model.hyperparameters.optimizer })

    const datasetUrl = await signDatasetUrl(db, dataset.storage_path, env.DATASET_URL_TTL_SECONDS)

    sink = new MetricsSink((rows: MetricRow[]) => insertMetrics(db, job.id, rows), {
      flushMs: env.METRICS_FLUSH_MS,
      maxBatch: 200,
      onError: (err, attempt) =>
        log.warn('metrics flush failed', { jobId: job.id, attempt, error: errMsg(err) }),
      onDrop: (rows, reason) =>
        log.warn('metrics dropped', { jobId: job.id, reason, count: rows.length, firstEpoch: rows[0]?.epoch }),
    })
    const currentSink = sink

    handle = trainInThread(
      datasetUrl,
      {
        task: model.task,
        algorithm: model.algorithm,
        target_column: model.target_column,
        feature_columns: model.feature_columns,
        hyperparameters: model.hyperparameters,
        seed: seedFromId(job.id),
      },
      {
        onLoaded: (info) => jobLog('training data loaded', info),
        onEpoch: (m) => currentSink.push(m),
      },
      { stallTimeoutMs: env.REQUEST_TIMEOUT_MS }
    )
    const current = handle
    onStart?.({ jobId: job.id, stop: () => current.stop() })

    heartbeatTimer = setInterval(() => {
      heartbeat(db, job.id, me)
        .then((owned) => {
          if (!owned) lost('heartbeat')
        })
        .catch((err: unknown) => log.warn('heartbeat failed', { jobId: job.id, error: errMsg(err) }))
    }, env.HEARTBEAT_INTERVAL_MS)

    const outcome = await handle.result
    stopHeartbeat()

    if (lostOwnership) {
      await sink.discard()
      return
    }

    switch (outcome.kind) {
      case 'done': {
        const stats = await sink.close()
        if (stats.dropped > 0) {
          log.warn('job finished with metrics missing from the curve', { jobId: job.id, ...stats })
        }
        // One last ownership check before doing irreversible work. Still a
        // window, which is why publish() is rolled back if the final fenced
        // write misses.
        if (!(await heartbeat(db, job.id, me))) {
          lost('pre-publish')
          return
        }
        const published = await publish(db, model, job, outcome.model, outcome.metrics)
        if (!(await markJobSucceeded(db, job.id, me))) {
          await published.rollback()
          lost('markJobSucceeded')
          return
        }
        await setModelStatus(db, model.id, 'succeeded')
        jobLog('job succeeded', { version: published.version, metrics: outcome.metrics })
        return
      }
      case 'stopped': {
        // Nothing buffered is worth writing: the next attempt starts the
        // curve over. Release first (fenced), and only if that matched clear
        // what already landed; if someone else owns the job now, the curve
        // being written is theirs.
        await sink.discard()
        if (!(await requeueJob(db, job.id, me, { attempt: Math.max(0, job.attempt - 1) }))) {
          lost('requeueJob')
          return
        }
        await deleteJobMetrics(db, job.id)
        await setModelStatus(db, model.id, 'queued')
        jobLog('job released for shutdown', { epochsRun: outcome.epochsRun })
        return
      }
      case 'error': {
        await sink.discard()
        if (outcome.errorKind === 'data') {
          await failJob(db, job, me, model, outcome.message)
          return
        }
        throw new InfraError(outcome.message)
      }
    }
  } catch (err) {
    stopHeartbeat()
    handle?.stop()
    await sink?.discard()
    if (lostOwnership) return
    if (err instanceof ModelConfigError) {
      await failJob(db, job, me, model, err.message).catch(logFinalizeError(job.id))
      return
    }
    const message = errMsg(err)
    if (job.attempt < env.MAX_ATTEMPTS) {
      log.warn('job hit an internal error; requeueing', { jobId: job.id, attempt: job.attempt, error: message })
      const ok = await requeueJob(db, job.id, me, {}).catch(logFinalizeError(job.id))
      if (ok && model) await setModelStatus(db, model.id, 'queued').catch(logFinalizeError(job.id))
      if (ok === false) lost('requeueJob')
      return
    }
    log.error('job failed after max attempts', { jobId: job.id, attempt: job.attempt, error: message })
    await failJob(db, job, me, model, `Training failed after ${job.attempt} attempts: ${message}`).catch(
      logFinalizeError(job.id)
    )
  }
}

interface Published {
  version: number
  /** Remove the artifact row and object; used when the final fenced job write misses. */
  rollback: () => Promise<void>
}

/**
 * Upload the artifact object, then record the row. Upload is an upsert to a
 * deterministic path, so a crash between the two steps leaves an orphan that
 * the retry simply overwrites. The row insert is what makes a version real.
 */
async function publish(
  db: Db,
  model: ModelRow,
  job: JobRow,
  fitted: LinearModel,
  metrics: ArtifactMetrics
): Promise<Published> {
  const artifact = buildArtifact({
    task: model.task,
    algorithm: model.algorithm,
    target_column: model.target_column,
    feature_columns: model.feature_columns,
    hyperparameters: model.hyperparameters,
    model: fitted,
    metrics,
    trained_at: new Date(),
  })
  const version = await nextArtifactVersion(db, model.id)
  const storagePath = `${model.user_id}/${model.id}/v${version}.json`
  await uploadArtifact(db, storagePath, JSON.stringify(artifact))
  let artifactId: string
  try {
    artifactId = await insertArtifactRow(db, {
      model_id: model.id,
      job_id: job.id,
      version,
      storage_path: storagePath,
      metrics,
    })
  } catch (err) {
    await removeArtifactObject(db, storagePath)
    throw err
  }
  log.info('artifact published', { jobId: job.id, modelId: model.id, version, storagePath })
  return {
    version,
    rollback: async () => {
      await deleteArtifactRow(db, artifactId)
      await removeArtifactObject(db, storagePath)
      log.warn('artifact rolled back', { jobId: job.id, modelId: model.id, version })
    },
  }
}

async function failJob(db: Db, job: JobRow, workerId: string, model: ModelRow | null, message: string): Promise<void> {
  if (!(await markJobFailed(db, job.id, workerId, message))) {
    log.warn('lost ownership of job before it could be failed', { jobId: job.id })
    return
  }
  if (model) await setModelStatus(db, model.id, 'failed')
  log.info('job failed', { jobId: job.id, modelId: job.model_id, error: message })
}

function logFinalizeError(jobId: string): (err: unknown) => undefined {
  return (err) => {
    log.error('could not finalize job state', { jobId, error: errMsg(err) })
    return undefined
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Stable per-job seed so a retry reproduces the same curve. FNV-1a over the uuid. */
export function seedFromId(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}
