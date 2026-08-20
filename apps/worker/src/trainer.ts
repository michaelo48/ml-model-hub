import { Worker } from 'node:worker_threads'
import type { Algorithm, ArtifactMetrics, Hyperparameters, LinearModel, Task } from '@modelforge/ml'

/**
 * Main-thread side of the training thread. Spawns the compiled
 * dist/train-thread.js with a signed dataset URL and the model spec, relays
 * per-epoch metrics through a callback, and resolves once with the outcome.
 *
 * Stop is cooperative: flipping a shared Int32 makes the thread's onEpoch
 * return false after the current epoch, so a shutdown never leaves a half
 * trained model in flight. Once an outcome is known the thread is terminated,
 * which is a no-op if it already exited on its own.
 */

export interface TrainSpec {
  task: Task
  algorithm: Algorithm
  target_column: string
  feature_columns: string[]
  hyperparameters: Hyperparameters
  seed: number
}

export interface ThreadInput {
  /** Signed, short-lived URL of the dataset CSV; the thread streams it. */
  datasetUrl: string
  /** Abort the download if no bytes arrive for this long. */
  stallTimeoutMs: number
  spec: TrainSpec
  stop: SharedArrayBuffer
}

export const STOP_REQUESTED = 1

export type ThreadMessage =
  | { type: 'loaded'; nRows: number; nFeatures: number }
  | { type: 'epoch'; epoch: number; loss: number; elapsed_ms: number }
  | { type: 'done'; model: LinearModel; metrics: ArtifactMetrics }
  | { type: 'stopped'; epochsRun: number }
  | { type: 'error'; kind: 'data' | 'internal'; message: string }

export type TrainOutcome =
  | { kind: 'done'; model: LinearModel; metrics: ArtifactMetrics }
  | { kind: 'stopped'; epochsRun: number }
  | { kind: 'error'; errorKind: 'data' | 'internal'; message: string }

export interface TrainHooks {
  onLoaded?: (info: { nRows: number; nFeatures: number }) => void
  onEpoch: (m: { epoch: number; loss: number; elapsed_ms: number }) => void
}

export interface TrainHandle {
  result: Promise<TrainOutcome>
  /** Ask the thread to stop after the current epoch. Idempotent. */
  stop: () => void
}

/**
 * The thread entry is always the compiled file. From dist/index.js this is a
 * sibling; from src/trainer.ts (vitest) it is the build output next door, so
 * tests run against what ships. `pnpm build` (or the pretest hook) produces it.
 */
export const THREAD_ENTRY = new URL('../dist/train-thread.js', import.meta.url)
// dist/ is built with code splitting: train-thread.js imports shared chunks
// from the same directory. Ship the whole dist/ directory, never just the two
// entry files.

export interface TrainOptions {
  /** Abort the dataset download if no bytes arrive for this long. Default 30 s. */
  stallTimeoutMs?: number
}

export function trainInThread(
  datasetUrl: string,
  spec: TrainSpec,
  hooks: TrainHooks,
  opts: TrainOptions = {}
): TrainHandle {
  const stopBuf = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  const stopFlag = new Int32Array(stopBuf)
  const input: ThreadInput = {
    datasetUrl,
    stallTimeoutMs: opts.stallTimeoutMs ?? 30_000,
    spec,
    stop: stopBuf,
  }

  const worker = new Worker(THREAD_ENTRY, { workerData: input })

  const result = new Promise<TrainOutcome>((resolve) => {
    let settled = false
    const finish = (o: TrainOutcome): void => {
      if (settled) return
      settled = true
      resolve(o)
      void worker.terminate()
    }
    worker.on('message', (m: ThreadMessage) => {
      switch (m.type) {
        case 'loaded':
          hooks.onLoaded?.({ nRows: m.nRows, nFeatures: m.nFeatures })
          break
        case 'epoch':
          hooks.onEpoch({ epoch: m.epoch, loss: m.loss, elapsed_ms: m.elapsed_ms })
          break
        case 'done':
          finish({ kind: 'done', model: m.model, metrics: m.metrics })
          break
        case 'stopped':
          finish({ kind: 'stopped', epochsRun: m.epochsRun })
          break
        case 'error':
          finish({ kind: 'error', errorKind: m.kind, message: m.message })
          break
      }
    })
    worker.on('error', (err) => {
      finish({ kind: 'error', errorKind: 'internal', message: `training thread crashed: ${err.message}` })
    })
    worker.on('exit', (code) => {
      finish({ kind: 'error', errorKind: 'internal', message: `training thread exited early (code ${code})` })
    })
  })

  return {
    result,
    stop: () => {
      Atomics.store(stopFlag, 0, STOP_REQUESTED)
    },
  }
}
