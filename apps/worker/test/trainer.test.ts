/**
 * Drives the real compiled training thread (dist/train-thread.js, built by the
 * pretest hook) against a local HTTP server that serves CSVs, so the stream
 * path, the stop flag and the error classification are exercised without
 * Supabase.
 */
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_HYPERPARAMETERS, type Hyperparameters } from '@modelforge/ml'
import { trainInThread, type TrainSpec } from '../src/trainer'

const housing = readFileSync(fileURLToPath(new URL('../../../fixtures/housing.csv', import.meta.url)))

let server: Server
let base = ''
const files = new Map<string, Buffer | string>()

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/stall.csv') {
      // Headers and one chunk, then silence: a dead socket mid-body.
      res.writeHead(200, { 'content-type': 'text/csv' })
      res.write('x,y\n1,2\n')
      return
    }
    const body = files.get(req.url ?? '')
    if (body === undefined) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/csv' })
    // Dribble the body out in small chunks so the thread really streams.
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body)
    let off = 0
    const step = () => {
      if (off >= buf.length) return res.end()
      res.write(buf.subarray(off, off + 97))
      off += 97
      setImmediate(step)
    }
    step()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  base = `http://127.0.0.1:${addr.port}`
  files.set('/housing.csv', housing)
  files.set('/bad.csv', 'x,y\n1,2\noops,3\n')
  // Big enough that SGD epochs take real time, for the stop test.
  const lines = ['a,b,y']
  for (let i = 0; i < 20_000; i++) lines.push(`${i % 97},${i % 13},${(i % 97) * 2 - (i % 13) + 1}`)
  files.set('/big.csv', lines.join('\n'))
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

const spec = (over: Partial<TrainSpec> = {}, hp: Partial<Hyperparameters> = {}): TrainSpec => ({
  task: 'regression',
  algorithm: 'linear_regression',
  target_column: 'price',
  feature_columns: ['sqft', 'bedrooms'],
  hyperparameters: { ...DEFAULT_HYPERPARAMETERS.adam, epochs: 25, ...hp },
  seed: 1,
  ...over,
})

describe('trainInThread', () => {
  it('streams the CSV, reports every epoch, and resolves with a fitted model', async () => {
    const epochs: Array<{ epoch: number; loss: number }> = []
    let loaded: { nRows: number; nFeatures: number } | null = null
    const h = trainInThread(`${base}/housing.csv`, spec({}, { learning_rate: 0.05, epochs: 60 }), {
      onLoaded: (i) => (loaded = i),
      onEpoch: (m) => epochs.push({ epoch: m.epoch, loss: m.loss }),
    })
    const out = await h.result
    expect(loaded).toEqual({ nRows: 200, nFeatures: 2 })
    expect(epochs.map((e) => e.epoch)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1))
    expect(epochs[59]!.loss).toBeLessThan(epochs[0]!.loss)
    expect(out.kind).toBe('done')
    if (out.kind !== 'done') return
    expect(out.model.weights).toHaveLength(2)
    expect(out.metrics.epochs_run).toBe(60)
    // train_loss is recomputed on the final weights: it equals the last epoch's reported loss.
    expect(out.metrics.train_loss).toBeCloseTo(epochs[59]!.loss, 6)
    expect(Number.isFinite(out.metrics.r2)).toBe(true)
  })

  it('stops after the current epoch when asked and reports epochs run', async () => {
    let seen = 0
    const h = trainInThread(
      `${base}/big.csv`,
      spec({ target_column: 'y', feature_columns: ['a', 'b'] }, { optimizer: 'sgd', epochs: 5000, batch_size: 1, learning_rate: 0.001 }),
      {
        onEpoch: () => {
          seen++
          if (seen === 3) h.stop()
        },
      }
    )
    const out = await h.result
    expect(out.kind).toBe('stopped')
    if (out.kind !== 'stopped') return
    // The flag is read after each epoch; the thread may be an epoch or two
    // ahead of the message the main thread reacted to.
    expect(out.epochsRun).toBeGreaterThanOrEqual(3)
    expect(out.epochsRun).toBeLessThan(20)
  })

  it('classifies bad cells as a data error with row and column', async () => {
    const out = await trainInThread(`${base}/bad.csv`, spec({ target_column: 'y', feature_columns: ['x'] }), {
      onEpoch: () => {},
    }).result
    expect(out).toEqual({
      kind: 'error',
      errorKind: 'data',
      message: 'Row 3, column "x": "oops" is not a number or true/false value.',
    })
  })

  it('classifies a diverging run as a data error', async () => {
    const out = await trainInThread(
      `${base}/housing.csv`,
      spec({}, { optimizer: 'batch_gd', learning_rate: 10, epochs: 300 }),
      { onEpoch: () => {} }
    ).result
    expect(out.kind).toBe('error')
    if (out.kind !== 'error') return
    expect(out.errorKind).toBe('data')
    expect(out.message).toMatch(/diverged/)
  })

  it('classifies a failed download as internal (retryable)', async () => {
    const out = await trainInThread(`${base}/missing.csv`, spec(), { onEpoch: () => {} }).result
    expect(out).toEqual({ kind: 'error', errorKind: 'internal', message: 'dataset download failed: HTTP 404' })
  })

  it('aborts a stalled download after the stall deadline and classifies it as internal', async () => {
    const t0 = Date.now()
    const out = await trainInThread(
      `${base}/stall.csv`,
      spec({ target_column: 'y', feature_columns: ['x'] }),
      { onEpoch: () => {} },
      { stallTimeoutMs: 400 }
    ).result
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(out.kind).toBe('error')
    if (out.kind !== 'error') return
    expect(out.errorKind).toBe('internal')
    expect(out.message).toMatch(/stalled \(no data for 400 ms\)/)
  })

  it('classifies an unexpected throw in the thread as internal', async () => {
    // epochs: 0 passes the zod layer in the worker only because tests bypass
    // it; trainGradient throws a plain Error, which is "internal", not "data".
    const out = await trainInThread(`${base}/housing.csv`, spec({}, { epochs: 0 }), { onEpoch: () => {} }).result
    expect(out.kind).toBe('error')
    if (out.kind !== 'error') return
    expect(out.errorKind).toBe('internal')
    expect(out.message).toMatch(/epochs/)
  })
})
