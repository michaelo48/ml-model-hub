import type { MetricRow } from './db'

export interface MetricsSinkOptions {
  /** How often to flush buffered epochs, in ms. */
  flushMs: number
  /** Flush immediately once this many epochs are buffered. */
  maxBatch: number
  /** Consecutive failed attempts for one batch before its rows are dropped. Default 5. */
  maxRetries?: number
  /** Upper bound on buffered rows while the writer is failing; oldest are dropped past it. Default 20000. */
  maxBuffered?: number
  /** Called once per failed write attempt. */
  onError?: (err: unknown, attempt: number) => void
  /** Called when rows are abandoned (retry budget exhausted or buffer overflow). */
  onDrop?: (rows: MetricRow[], reason: 'retries' | 'overflow' | 'closed') => void
}

export interface MetricsSinkStats {
  written: number
  dropped: number
}

/**
 * Batches per-epoch metrics into periodic inserts. Fast optimizers can emit
 * thousands of epochs per second; one round trip per epoch would throttle
 * training and hammer Postgres. A short flush interval keeps the live curve
 * feeling immediate while bounding insert volume.
 *
 * Flushes are serialized so rows arrive in epoch order. A failed flush keeps
 * its rows in front of the buffer and retries on the next tick, up to
 * maxRetries per batch; after that the batch is dropped and reported, so one
 * poison batch cannot stall the curve for the rest of training. The writer
 * is expected to be idempotent (upsert), which makes retries safe.
 */
export class MetricsSink {
  private buffer: MetricRow[] = []
  private timer: NodeJS.Timeout | null = null
  private inflight: Promise<void> = Promise.resolve()
  private closed = false
  private failures = 0
  private readonly stats: MetricsSinkStats = { written: 0, dropped: 0 }
  private readonly maxRetries: number
  private readonly maxBuffered: number

  constructor(
    private readonly write: (rows: MetricRow[]) => Promise<void>,
    private readonly opts: MetricsSinkOptions
  ) {
    this.maxRetries = opts.maxRetries ?? 5
    this.maxBuffered = opts.maxBuffered ?? 20_000
  }

  push(row: MetricRow): void {
    if (this.closed) return
    this.buffer.push(row)
    if (this.buffer.length > this.maxBuffered) {
      const excess = this.buffer.splice(0, this.buffer.length - this.maxBuffered)
      this.stats.dropped += excess.length
      this.opts.onDrop?.(excess, 'overflow')
    }
    if (this.buffer.length >= this.opts.maxBatch) {
      this.schedule(0)
    } else if (!this.timer) {
      this.schedule(this.opts.flushMs)
    }
  }

  /** Flush everything buffered (with retries), then stop. Safe to call more than once. */
  async close(): Promise<MetricsSinkStats> {
    if (this.closed) {
      await this.inflight
      return { ...this.stats }
    }
    this.closed = true
    this.clearTimer()
    // Keep retrying the tail until it lands or the retry budget drops it.
    while (this.buffer.length > 0) {
      await this.flush()
      if (this.buffer.length > 0) await delay(this.opts.flushMs)
    }
    await this.inflight
    return { ...this.stats }
  }

  /** Stop without writing anything still buffered (e.g. the job was released). */
  async discard(): Promise<MetricsSinkStats> {
    this.closed = true
    this.clearTimer()
    await this.inflight
    if (this.buffer.length > 0) {
      this.stats.dropped += this.buffer.length
      this.opts.onDrop?.(this.buffer, 'closed')
      this.buffer = []
    }
    return { ...this.stats }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(ms: number): void {
    if (this.closed) return
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, ms)
  }

  private flush(): Promise<void> {
    this.inflight = this.inflight.then(async () => {
      if (this.buffer.length === 0) return
      const rows = this.buffer
      this.buffer = []
      try {
        await this.write(rows)
        this.failures = 0
        this.stats.written += rows.length
      } catch (err) {
        this.failures++
        this.opts.onError?.(err, this.failures)
        if (this.failures >= this.maxRetries) {
          this.failures = 0
          this.stats.dropped += rows.length
          this.opts.onDrop?.(rows, 'retries')
        } else {
          // Put them back in front of anything pushed meanwhile and retry later.
          this.buffer = rows.concat(this.buffer)
          this.schedule(this.opts.flushMs)
        }
      }
    })
    return this.inflight
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
