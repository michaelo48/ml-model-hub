import { describe, expect, it } from 'vitest'
import {
  acceptsPoint,
  decideRefetch,
  mergePoints,
  metricsWindow,
  nearestPointIndex,
  normalizeBatch,
  type MetricPoint,
} from './metrics'

const pt = (epoch: number, loss = epoch): MetricPoint => ({ epoch, loss, val_loss: null, elapsed_ms: null })
const epochs = (ps: MetricPoint[]) => ps.map((p) => p.epoch)

describe('mergePoints', () => {
  it('appends a later batch (fast path)', () => {
    expect(epochs(mergePoints([pt(1), pt(2)], [pt(3), pt(4)]))).toEqual([1, 2, 3, 4])
  })
  it('interleaves out-of-order batches', () => {
    expect(epochs(mergePoints([pt(1), pt(3), pt(5)], [pt(2), pt(4), pt(6)]))).toEqual([1, 2, 3, 4, 5, 6])
  })
  it('lets incoming win on equal epochs without duplicating', () => {
    const out = mergePoints([pt(1, 10), pt(2, 20)], [pt(2, 99), pt(3, 30)])
    expect(out.map((p) => [p.epoch, p.loss])).toEqual([
      [1, 10],
      [2, 99],
      [3, 30],
    ])
  })
  it('does not mutate either input and returns inputs when one side is empty', () => {
    const a = [pt(1), pt(3)]
    const b = [pt(2)]
    mergePoints(a, b)
    expect(epochs(a)).toEqual([1, 3])
    expect(mergePoints(a, [])).toBe(a)
    expect(mergePoints([], b)).toBe(b)
  })
})

describe('normalizeBatch', () => {
  it('sorts and dedupes by epoch, last wins', () => {
    const out = normalizeBatch([pt(3, 1), pt(1, 1), pt(3, 2), pt(2, 1)])
    expect(out.map((p) => [p.epoch, p.loss])).toEqual([
      [1, 1],
      [2, 1],
      [3, 2],
    ])
  })
})

describe('nearestPointIndex', () => {
  const ps = [pt(1), pt(5), pt(10)]
  it('snaps to the closest recorded epoch', () => {
    expect(nearestPointIndex(ps, 0)).toBe(0)
    expect(nearestPointIndex(ps, 2.9)).toBe(0)
    expect(nearestPointIndex(ps, 3.1)).toBe(1)
    expect(nearestPointIndex(ps, 7.4)).toBe(1)
    expect(nearestPointIndex(ps, 7.6)).toBe(2)
    expect(nearestPointIndex(ps, 99)).toBe(2)
  })
})

const T0 = '2026-08-19T19:00:00.000+00:00'
const T1 = '2026-08-19T19:05:00.000+00:00'

describe('metricsWindow / acceptsPoint', () => {
  it('shows nothing while queued', () => {
    expect(metricsWindow({ status: 'queued', claimed_at: null })).toEqual({ kind: 'none' })
    expect(acceptsPoint({ status: 'queued', claimed_at: null }, T1)).toBe(false)
  })
  it('accepts only rows from the current attempt once claimed', () => {
    const job = { status: 'running' as const, claimed_at: T1 }
    expect(metricsWindow(job)).toEqual({ kind: 'since', since: T1 })
    expect(acceptsPoint(job, T0)).toBe(false) // previous attempt
    expect(acceptsPoint(job, T1)).toBe(true) // same instant is fine
    expect(acceptsPoint(job, '2026-08-19T19:05:00.001+00:00')).toBe(true)
  })
  it('shows whatever is left for a job the reaper failed (claimed_at nulled)', () => {
    expect(metricsWindow({ status: 'failed', claimed_at: null })).toEqual({ kind: 'all' })
    expect(acceptsPoint({ status: 'failed', claimed_at: null }, T0)).toBe(true)
  })
})

describe('decideRefetch', () => {
  it('clears when the job goes back to queued (shutdown requeue, reaper)', () => {
    expect(decideRefetch({ status: 'running', claimed_at: T0 }, { status: 'queued', claimed_at: null })).toBe('clear')
  })
  it('replaces when a new attempt claims the job, even at the same attempt number', () => {
    expect(decideRefetch({ status: 'queued', claimed_at: null }, { status: 'claimed', claimed_at: T1 })).toBe('replace')
    expect(decideRefetch({ status: 'running', claimed_at: T0 }, { status: 'claimed', claimed_at: T1 })).toBe('replace')
  })
  it('merges on a status change inside the same attempt', () => {
    expect(decideRefetch({ status: 'claimed', claimed_at: T1 }, { status: 'running', claimed_at: T1 })).toBe('merge')
    expect(decideRefetch({ status: 'running', claimed_at: T1 }, { status: 'succeeded', claimed_at: T1 })).toBe('merge')
  })
  it('ignores heartbeats', () => {
    expect(decideRefetch({ status: 'running', claimed_at: T1 }, { status: 'running', claimed_at: T1 })).toBe('none')
  })
})
