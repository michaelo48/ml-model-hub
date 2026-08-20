/**
 * Pure chart math for the custom SVG loss curve. No DOM, fully unit-tested.
 */

export interface Domain {
  min: number
  max: number
}

/**
 * "Nice" tick values covering [min, max] with roughly `count` ticks, using the
 * classic 1/2/5 step heuristic. The returned ticks extend to enclose the
 * domain, so callers can use ticks[0] / ticks[last] as the axis bounds and
 * every label sits on a round number.
 */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return []
  if (min > max) [min, max] = [max, min]
  if (min === max) {
    // Degenerate domain: open a symmetric window around the value.
    const pad = min === 0 ? 1 : Math.abs(min) * 0.1
    min -= pad
    max += pad
  }
  const step = niceStep((max - min) / Math.max(1, count - 1))
  const start = Math.floor(min / step) * step
  const end = Math.ceil(max / step) * step
  const ticks: number[] = []
  // Guard against float drift producing one tick too many or too few.
  const n = Math.round((end - start) / step)
  for (let i = 0; i <= n; i++) ticks.push(roundTo(start + i * step, step))
  return ticks
}

/** Nearest of 1, 2, 5, 10 (times a power of ten) to the rough step. */
function niceStep(rough: number): number {
  const exp = Math.floor(Math.log10(rough))
  const base = 10 ** exp
  const frac = rough / base
  // Thresholds follow d3's tickStep: round to the nearest of 1, 2, 5, 10.
  const mult = frac < 1.5 ? 1 : frac < 3 ? 2 : frac < 7 ? 5 : 10
  return mult * base
}

/** Round `v` to the precision implied by `step`, removing float drift like 0.30000000000000004. */
function roundTo(v: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1)
  return Number(v.toFixed(Math.min(decimals, 15)))
}

/**
 * Integer ticks for the epoch axis. Always includes the first and last epoch
 * and picks a round step (1, 2, 5, 10, 20, 50...) so interior labels read
 * well. The final tick is the true max even if it breaks the step, because
 * the reader wants to know where training ends.
 */
export function epochTicks(maxEpoch: number, count = 6): number[] {
  if (!Number.isFinite(maxEpoch) || maxEpoch < 1) return []
  const max = Math.floor(maxEpoch)
  if (max === 1) return [1]
  const step = Math.max(1, niceStep((max - 1) / Math.max(1, count - 1)))
  const ticks: number[] = [1]
  for (let t = step; t < max; t += step) {
    // Skip a tick that would crowd the first or last label.
    if (t - 1 >= step * 0.75 && max - t >= step * 0.75) ticks.push(t)
  }
  ticks.push(max)
  return ticks
}

/**
 * Ticks for a log10 axis over positive values: 1, 2, 5 multiples of powers of
 * ten inside [min, max], padded by one tick on each side so the data never
 * touches the plot edge. Thinned to decades, then every k-th decade, when the
 * range spans too many. Non-positive or non-finite bounds yield [].
 */
export function logTicks(min: number, max: number, count = 8): number[] {
  if (!(min > 0) || !(max > 0) || !Number.isFinite(min) || !Number.isFinite(max)) return []
  if (min > max) [min, max] = [max, min]
  const eLo = Math.floor(Math.log10(min))
  const eHi = Math.ceil(Math.log10(max))
  // Dense candidates: 1, 2, 5 per decade, one decade beyond the data each way.
  const dense: number[] = []
  for (let e = eLo - 1; e <= eHi + 1; e++) for (const m of [1, 2, 5]) dense.push(roundTo(m * 10 ** e, 10 ** e))
  const firstInside = dense.findIndex((v) => v >= min)
  let lastInside = dense.length - 1
  while (lastInside > 0 && dense[lastInside]! > max) lastInside--
  const ticks = dense.slice(Math.max(0, firstInside - 1), lastInside + 2)
  if (ticks.length <= count) return ticks
  // Too many: fall back to whole decades, which always enclose the data.
  let decades: number[] = []
  for (let e = eLo; e <= eHi; e++) decades.push(roundTo(10 ** e, 10 ** e))
  if (decades.length > count) {
    const k = Math.ceil((decades.length - 1) / (count - 1))
    const last = decades.length - 1
    decades = decades.filter((_, i) => i % k === 0 || i === last)
  }
  return decades
}

/** Map a value from a domain onto a pixel range. */
export function scaleLinear(domain: Domain, range: Domain): (v: number) => number {
  const span = domain.max - domain.min
  if (span === 0) return () => (range.min + range.max) / 2
  const k = (range.max - range.min) / span
  return (v) => range.min + (v - domain.min) * k
}

/**
 * Compact numeric label for axes and direct labels. Keeps three to four
 * significant figures, switches to exponent form for very small or very
 * large values, and never prints trailing zeros after the decimal point.
 */
export function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return String(v)
  if (v === 0) return '0'
  const abs = Math.abs(v)
  if (abs >= 1e6 || abs < 1e-3) {
    return v.toExponential(2).replace(/\.?0+e/, 'e')
  }
  const s = abs >= 100 ? v.toFixed(1) : abs >= 10 ? v.toFixed(2) : abs >= 1 ? v.toFixed(3) : v.toPrecision(3)
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s
}

/**
 * Label for a tick value that is shared with all other ticks, so that every
 * label on an axis has the same number of decimals (1.00, 1.25, 1.50 rather
 * than 1, 1.25, 1.5). Decimals are inferred from the tick step.
 */
export function formatTick(v: number, ticks: number[]): string {
  const [t0, t1] = ticks
  if (t0 === undefined || t1 === undefined) return formatNumber(v)
  const step = Math.abs(t1 - t0)
  const abs = Math.max(...ticks.map(Math.abs))
  if (abs >= 1e6 || (abs < 1e-3 && abs > 0)) {
    // Exponent form with enough mantissa digits to tell neighbouring ticks
    // apart: 9.108e+10, 9.110e+10 rather than 9.1e+10 five times over.
    if (v === 0) return '0'
    const mantissaDecimals = Math.max(0, Math.floor(Math.log10(Math.abs(v))) - Math.floor(Math.log10(step)))
    return v.toExponential(Math.min(mantissaDecimals, 6))
  }
  return v.toFixed(decimalsOf(step))
}

/** Number of decimal places needed to print `step` exactly (capped at 8). */
function decimalsOf(step: number): number {
  const s = step.toFixed(8).replace(/0+$/, '')
  const dot = s.indexOf('.')
  return dot === -1 ? 0 : s.length - dot - 1
}

/** Format a millisecond duration as `1.2s`, `45s`, `3m 12s`, `1h 04m`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-'
  const s = ms / 1000
  if (s < 10) return `${s.toFixed(1)}s`
  if (s < 60) return `${Math.floor(s)}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(Math.floor(s % 60)).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, '0')}m`
}
