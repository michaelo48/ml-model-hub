/**
 * Training thread entry point (node:worker_threads).
 *
 * Training is synchronous CPU work. Running it here keeps the main thread's
 * event loop free to heartbeat the job, batch-insert metrics and react to
 * shutdown while epochs are spinning. Protocol: see trainer.ts.
 *
 * The dataset is streamed: the response body of a signed Storage URL is fed
 * chunk by chunk into the CSV parser, which emits numeric rows as it goes.
 * Only X and y are materialized.
 */
import { parentPort, workerData } from 'node:worker_threads'
import {
  accuracy,
  DivergenceError,
  fitModel,
  logLoss,
  mse,
  predictClass,
  predictLinear,
  predictProba,
  r2,
  rmse,
  SingularMatrixError,
  type ArtifactMetrics,
  type EpochMetrics,
} from '@modelforge/ml'
import { DataError, loadTrainingDataFromStream, type TrainingData } from './dataset'
import { STOP_REQUESTED, type ThreadInput, type ThreadMessage } from './trainer'

const input = workerData as ThreadInput
const stop = new Int32Array(input.stop)
const post = (m: ThreadMessage): void => parentPort!.postMessage(m)

/** Storage/network failures while streaming are retryable, not the user's fault. */
class FetchError extends Error {
  override readonly name = 'FetchError'
}

/**
 * Stream the dataset with a stall deadline: if no bytes arrive for
 * `stallTimeoutMs` (headers included) the request is aborted and the job
 * takes the retryable path, instead of the thread hanging on a dead socket
 * while the main thread keeps heartbeating a job that will never finish.
 */
async function fetchDataset(): Promise<TrainingData> {
  const ac = new AbortController()
  let timer: NodeJS.Timeout | null = null
  const arm = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => ac.abort(new Error(`no data for ${input.stallTimeoutMs} ms`)), input.stallTimeoutMs)
  }
  const reason = (err: unknown): string =>
    ac.signal.aborted ? `stalled (${String(ac.signal.reason instanceof Error ? ac.signal.reason.message : ac.signal.reason)})`
    : err instanceof Error ? err.message : String(err)

  arm()
  let res: Response
  try {
    res = await fetch(input.datasetUrl, { signal: ac.signal })
  } catch (err) {
    throw new FetchError(`dataset download failed: ${reason(err)}`)
  }
  if (!res.ok || !res.body) throw new FetchError(`dataset download failed: HTTP ${res.status}`)

  const body = res.body
  async function* chunks(): AsyncIterable<Uint8Array> {
    for await (const chunk of body) {
      arm()
      yield chunk
    }
  }
  try {
    return await loadTrainingDataFromStream(chunks(), input.spec)
  } catch (err) {
    if (err instanceof DataError) throw err
    throw new FetchError(`dataset stream failed: ${reason(err)}`)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function run(): Promise<void> {
  const { spec } = input
  const data = await fetchDataset()
  post({ type: 'loaded', nRows: data.nRows, nFeatures: spec.feature_columns.length })

  const t0 = performance.now()
  let epochsRun = 0
  const onEpoch = (m: EpochMetrics): boolean => {
    epochsRun = m.epoch
    post({ type: 'epoch', epoch: m.epoch, loss: m.loss, elapsed_ms: Math.round(performance.now() - t0) })
    return Atomics.load(stop, 0) !== STOP_REQUESTED
  }

  const model = fitModel(spec.algorithm, spec.hyperparameters, data.X, data.y, { seed: spec.seed, onEpoch })
  if (Atomics.load(stop, 0) === STOP_REQUESTED) {
    post({ type: 'stopped', epochsRun })
    return
  }

  // Final metrics are recomputed on the final weights for both tasks, so
  // train_loss means the same thing regardless of algorithm.
  let metrics: ArtifactMetrics
  if (spec.algorithm === 'logistic_regression') {
    const proba = predictProba(model, data.X)
    metrics = {
      train_loss: logLoss(data.y, proba),
      accuracy: accuracy(data.y, predictClass(model, data.X)),
      n_rows: data.nRows,
      epochs_run: epochsRun,
    }
  } else {
    const yhat = predictLinear(model, data.X)
    metrics = {
      train_loss: mse(data.y, yhat),
      rmse: rmse(data.y, yhat),
      r2: r2(data.y, yhat),
      n_rows: data.nRows,
      epochs_run: epochsRun,
    }
  }

  post({ type: 'done', model, metrics })
}

run().catch((err: unknown) => {
  if (err instanceof DataError) {
    post({ type: 'error', kind: 'data', message: err.message })
  } else if (err instanceof DivergenceError) {
    post({
      type: 'error',
      kind: 'data',
      message: `Training diverged at epoch ${err.epoch} (loss became infinite). Lower the learning rate and retrain.`,
    })
  } else if (err instanceof SingularMatrixError) {
    post({
      type: 'error',
      kind: 'data',
      message:
        'OLS could not solve: the features are collinear (one is a combination of the others). Remove a redundant feature or add a small L2 penalty.',
    })
  } else {
    post({ type: 'error', kind: 'internal', message: err instanceof Error ? err.message : String(err) })
  }
})
