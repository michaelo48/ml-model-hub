import { describe, expect, it, vi } from 'vitest'
import type { MetricRow } from '../src/db'
import { MetricsSink } from '../src/metrics-sink'

const row = (epoch: number): MetricRow => ({ epoch, loss: 1 / epoch, elapsed_ms: epoch })
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('MetricsSink', () => {
  it('batches pushes and writes them in order', async () => {
    const batches: MetricRow[][] = []
    const sink = new MetricsSink(
      async (rows) => {
        batches.push(rows)
      },
      { flushMs: 10, maxBatch: 3 }
    )
    for (let e = 1; e <= 7; e++) sink.push(row(e))
    const stats = await sink.close()
    expect(stats).toEqual({ written: 7, dropped: 0 })
    expect(batches.flat().map((r) => r.epoch)).toEqual([1, 2, 3, 4, 5, 6, 7])
    // Rows pushed while a flush is pending coalesce into it; fewer, larger
    // writes are the point.
    expect(batches.length).toBeLessThanOrEqual(3)
  })

  it('serializes concurrent flushes so a slow write never reorders rows', async () => {
    const seen: number[] = []
    const sink = new MetricsSink(
      async (rows) => {
        await tick(rows[0]!.epoch === 1 ? 30 : 0) // first batch is slow
        seen.push(...rows.map((r) => r.epoch))
      },
      { flushMs: 1, maxBatch: 2 }
    )
    for (let e = 1; e <= 6; e++) sink.push(row(e))
    await sink.close()
    expect(seen).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('retries a failed batch in front of newer rows, then succeeds', async () => {
    let calls = 0
    const written: number[] = []
    const onError = vi.fn()
    const sink = new MetricsSink(
      async (rows) => {
        calls++
        if (calls === 1) throw new Error('transient')
        written.push(...rows.map((r) => r.epoch))
      },
      { flushMs: 5, maxBatch: 2, onError }
    )
    sink.push(row(1))
    sink.push(row(2)) // triggers flush 1 -> fails
    await tick(2)
    sink.push(row(3))
    const stats = await sink.close()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(written).toEqual([1, 2, 3])
    expect(stats).toEqual({ written: 3, dropped: 0 })
  })

  it('drops a batch after maxRetries consecutive failures and keeps going', async () => {
    const written: number[] = []
    const dropped: Array<[number[], string]> = []
    let poison = true
    const sink = new MetricsSink(
      async (rows) => {
        if (poison && rows.some((r) => r.epoch === 1)) throw new Error('permanent')
        written.push(...rows.map((r) => r.epoch))
      },
      { flushMs: 1, maxBatch: 2, maxRetries: 3, onDrop: (rows, reason) => dropped.push([rows.map((r) => r.epoch), reason]) }
    )
    sink.push(row(1))
    sink.push(row(2))
    for (let i = 0; i < 100 && dropped.length === 0; i++) await tick(5)
    expect(dropped).toEqual([[[1, 2], 'retries']])
    poison = false
    sink.push(row(3))
    const stats = await sink.close()
    expect(written).toEqual([3])
    expect(stats).toEqual({ written: 1, dropped: 2 })
  })

  it('bounds memory by dropping the oldest rows past maxBuffered', async () => {
    const dropped: string[] = []
    const sink = new MetricsSink(
      async () => {
        throw new Error('down')
      },
      { flushMs: 1000, maxBatch: 1000, maxBuffered: 5, onDrop: (_r, reason) => dropped.push(reason) }
    )
    for (let e = 1; e <= 8; e++) sink.push(row(e))
    expect(dropped).toEqual(['overflow', 'overflow', 'overflow'])
    const stats = await sink.discard()
    expect(stats.dropped).toBe(8)
  })

  it('close keeps retrying the tail until it lands', async () => {
    let failures = 2
    const written: number[] = []
    const sink = new MetricsSink(
      async (rows) => {
        if (failures-- > 0) throw new Error('flaky')
        written.push(...rows.map((r) => r.epoch))
      },
      { flushMs: 1, maxBatch: 100 }
    )
    sink.push(row(1))
    const stats = await sink.close()
    expect(written).toEqual([1])
    expect(stats).toEqual({ written: 1, dropped: 0 })
  })

  it('discard writes nothing buffered and ignores later pushes', async () => {
    const write = vi.fn(async () => {})
    const sink = new MetricsSink(write, { flushMs: 1000, maxBatch: 1000 })
    sink.push(row(1))
    const stats = await sink.discard()
    sink.push(row(2))
    await tick(5)
    expect(write).not.toHaveBeenCalled()
    expect(stats).toEqual({ written: 0, dropped: 1 })
  })
})
