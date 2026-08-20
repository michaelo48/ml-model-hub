'use client'

import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { epochTicks, formatNumber, formatTick, logTicks, niceTicks, scaleLinear } from '@/lib/charts/scale'
import { nearestPointIndex, type MetricPoint } from '@/lib/training/metrics'

const HEIGHT = 300
const MARGIN = { top: 14, bottom: 30 }
const CHAR_W = 6.6 // IBM Plex Mono at 11px, used to size the left gutter so tick labels never clip
const LABEL_W = 98 // right gutter for direct labels ("val 0.0123")
const FONT = 'font-mono text-[11px]'

/**
 * Live loss curve. Custom SVG on purpose (CLAUDE.md §2, §8): direct labels at
 * the line ends instead of a legend, round tick values, fixed epoch axis so
 * the curve grows left to right as epochs land, and a hover readout for
 * precise values. Colors come from the design tokens so it follows the theme.
 */
export function LossChart({
  points,
  totalEpochs,
  live,
}: {
  points: MetricPoint[]
  /** Planned epoch count from the hyperparameters; fixes the x axis so the curve fills in. */
  totalEpochs: number | null
  /** Whether more points may still arrive (draws the end marker). */
  live: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<number | null>(null) // index into points
  // Log scale is the honest view once the first epochs dwarf the rest; linear is the default.
  const [yScale, setYScale] = useState<'linear' | 'log'>('linear')

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setWidth(Math.floor(entry.contentRect.width))
    })
    ro.observe(el)
    setWidth(Math.floor(el.getBoundingClientRect().width))
    return () => ro.disconnect()
  }, [])

  const hasVal = useMemo(() => points.some((p) => p.val_loss != null && Number.isFinite(p.val_loss)), [points])
  // A log axis needs strictly positive data. If it is not, the toggle is
  // disabled and linear is shown as the pressed state, so the UI never claims
  // a scale it is not drawing.
  const canLog = useMemo(
    () =>
      points.length > 0 &&
      points.every((p) => p.loss > 0 && (p.val_loss == null || !Number.isFinite(p.val_loss) || p.val_loss > 0)),
    [points]
  )
  const effectiveScale: 'linear' | 'log' = yScale === 'log' && canLog ? 'log' : 'linear'

  const geom = useMemo(() => {
    if (width === 0) return null
    const last = points[points.length - 1]
    const xMax = Math.max(totalEpochs ?? 0, last?.epoch ?? 0, 1)
    const single = xMax === 1
    const xTicks = epochTicks(xMax)
    const xDomain = single ? { min: 0, max: 2 } : { min: 1, max: xMax }

    let lo = Infinity
    let hi = -Infinity
    for (const p of points) {
      if (Number.isFinite(p.loss)) {
        if (p.loss < lo) lo = p.loss
        if (p.loss > hi) hi = p.loss
      }
      if (p.val_loss != null && Number.isFinite(p.val_loss)) {
        if (p.val_loss < lo) lo = p.val_loss
        if (p.val_loss > hi) hi = p.val_loss
      }
    }
    // Log scale needs positive data; otherwise fall back to linear silently.
    const useLog = effectiveScale === 'log'
    const yTicks = lo === Infinity ? [0, 0.25, 0.5, 0.75, 1] : useLog ? logTicks(lo, hi) : niceTicks(lo, hi, 6)
    const yDomain = { min: yTicks[0] ?? 0, max: yTicks[yTicks.length - 1] ?? 1 }
    const yLabels = yTicks.map((t) => (useLog ? formatNumber(t) : formatTick(t, yTicks)))
    const left = Math.max(...yLabels.map((s) => s.length)) * CHAR_W + 14
    const right = points.length > 0 ? LABEL_W : 16
    const plotW = Math.max(10, width - left - right)
    const plotH = HEIGHT - MARGIN.top - MARGIN.bottom
    const x = scaleLinear(xDomain, { min: left, max: left + plotW })
    const yRange = { min: MARGIN.top + plotH, max: MARGIN.top }
    const y = useLog
      ? (() => {
          const f = scaleLinear({ min: Math.log10(yDomain.min), max: Math.log10(yDomain.max) }, yRange)
          return (v: number) => (v > 0 ? f(Math.log10(v)) : NaN)
        })()
      : scaleLinear(yDomain, yRange)

    const trainPath = pathFor(points, (p) => p.loss, x, y)
    const valPath = hasVal ? pathFor(points, (p) => p.val_loss, x, y) : ''

    return { x, y, xDomain, xTicks, yTicks, yLabels, left, right, plotW, plotH, trainPath, valPath, last, useLog }
  }, [points, totalEpochs, width, hasVal, effectiveScale])

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    if (!geom || points.length === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    // Invert x to an epoch, then snap to the nearest recorded point.
    const { min, max } = geom.xDomain
    const epoch = min + ((px - geom.left) / Math.max(1, geom.plotW)) * (max - min)
    setHover(nearestPointIndex(points, epoch))
  }

  const hovered = hover != null ? points[hover] : null

  return (
    <div ref={ref} className="relative w-full select-none" style={{ height: HEIGHT }}>
      {points.length > 0 ? (
        <div
          className="absolute top-0 right-0 z-10 flex gap-px font-mono text-[11px]"
          role="group"
          aria-label="Loss axis scale"
        >
          {(['linear', 'log'] as const).map((s) => {
            const disabled = s === 'log' && !canLog
            return (
              <button
                key={s}
                type="button"
                aria-pressed={effectiveScale === s}
                disabled={disabled}
                title={disabled ? 'Log scale needs positive losses' : undefined}
                onClick={() => setYScale(s)}
                className={`px-1.5 py-0.5 ${
                  effectiveScale === s ? 'text-fg' : disabled ? 'text-fg-muted/50' : 'text-fg-muted hover:text-fg'
                }`}
              >
                {s}
              </button>
            )
          })}
        </div>
      ) : null}
      {geom ? (
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          aria-label="Training loss by epoch"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          className="block overflow-visible"
        >
          {/* Horizontal gridlines and y tick labels */}
          {geom.yTicks.map((t, i) => (
            <g key={`y${t}`}>
              <line
                x1={geom.left}
                x2={geom.left + geom.plotW}
                y1={geom.y(t)}
                y2={geom.y(t)}
                className="stroke-line"
                strokeWidth={1}
                strokeDasharray={i === 0 ? undefined : '2 3'}
              />
              <text x={geom.left - 8} y={geom.y(t)} dy="0.35em" textAnchor="end" className={`${FONT} fill-fg-muted`}>
                {geom.yLabels[i]}
              </text>
            </g>
          ))}

          {/* X axis ticks */}
          {geom.xTicks.map((t) => (
            <g key={`x${t}`}>
              <line
                x1={geom.x(t)}
                x2={geom.x(t)}
                y1={MARGIN.top + geom.plotH}
                y2={MARGIN.top + geom.plotH + 4}
                className="stroke-line"
                strokeWidth={1}
              />
              <text
                x={geom.x(t)}
                y={MARGIN.top + geom.plotH + 8}
                dy="0.9em"
                textAnchor="middle"
                className={`${FONT} fill-fg-muted`}
              >
                {t}
              </text>
            </g>
          ))}
          <text x={geom.left + geom.plotW} y={HEIGHT - 2} textAnchor="end" className={`${FONT} fill-fg-muted`}>
            epoch
          </text>

          {/* Series */}
          {geom.valPath ? (
            <path d={geom.valPath} fill="none" className="stroke-fg-muted" strokeWidth={1.25} strokeDasharray="4 3" />
          ) : null}
          {geom.trainPath ? (
            <path d={geom.trainPath} fill="none" className="stroke-accent" strokeWidth={1.5} strokeLinejoin="round" />
          ) : null}

          {/* Direct labels at the line ends */}
          {geom.last && Number.isFinite(geom.y(geom.last.loss)) ? (
            <EndLabels
              x={geom.x(geom.last.epoch) + 7}
              train={{ y: geom.y(geom.last.loss), text: `train ${formatNumber(geom.last.loss)}` }}
              val={
                hasVal && geom.last.val_loss != null && Number.isFinite(geom.y(geom.last.val_loss))
                  ? { y: geom.y(geom.last.val_loss), text: `val ${formatNumber(geom.last.val_loss)}` }
                  : null
              }
              live={live}
              dotX={geom.x(geom.last.epoch)}
            />
          ) : null}

          {/* Hover readout */}
          {hovered && Number.isFinite(geom.y(hovered.loss)) ? (
            <Readout
              x={geom.x(hovered.epoch)}
              yTrain={geom.y(hovered.loss)}
              yVal={
                hovered.val_loss != null && Number.isFinite(geom.y(hovered.val_loss)) ? geom.y(hovered.val_loss) : null
              }
              top={MARGIN.top}
              bottom={MARGIN.top + geom.plotH}
              flip={geom.x(hovered.epoch) > geom.left + geom.plotW * 0.6}
              point={hovered}
            />
          ) : null}

          {points.length === 0 ? (
            <text
              x={geom.left + geom.plotW / 2}
              y={MARGIN.top + geom.plotH / 2}
              textAnchor="middle"
              className={`${FONT} fill-fg-muted`}
            >
              Waiting for the first epoch
            </text>
          ) : null}
        </svg>
      ) : null}
    </div>
  )
}

function pathFor(
  points: MetricPoint[],
  pick: (p: MetricPoint) => number | null,
  x: (v: number) => number,
  y: (v: number) => number
): string {
  let d = ''
  let pen = false
  for (const p of points) {
    const v = pick(p)
    const yy = v == null ? NaN : y(v)
    if (!Number.isFinite(yy)) {
      // Missing value (or non-positive on a log axis): lift the pen.
      pen = false
      continue
    }
    d += `${pen ? 'L' : 'M'}${x(p.epoch).toFixed(1)},${yy.toFixed(1)}`
    pen = true
  }
  return d
}

function EndLabels({
  x,
  dotX,
  train,
  val,
  live,
}: {
  x: number
  dotX: number
  train: { y: number; text: string }
  val: { y: number; text: string } | null
  live: boolean
}) {
  // Push the two labels apart if they would overlap.
  let ty = train.y
  let vy = val?.y ?? null
  if (vy != null && Math.abs(ty - vy) < 13) {
    const mid = (ty + vy) / 2
    const dir = ty <= vy ? -1 : 1
    ty = mid + dir * 6.5
    vy = mid - dir * 6.5
  }
  return (
    <g>
      {live ? <circle cx={dotX} cy={train.y} r={2.5} className="fill-accent" /> : null}
      <text x={x} y={ty} dy="0.35em" className={`${FONT} fill-accent`}>
        {train.text}
      </text>
      {val && vy != null ? (
        <text x={x} y={vy} dy="0.35em" className={`${FONT} fill-fg-muted`}>
          {val.text}
        </text>
      ) : null}
    </g>
  )
}

function Readout({
  x,
  yTrain,
  yVal,
  top,
  bottom,
  flip,
  point,
}: {
  x: number
  yTrain: number
  yVal: number | null
  top: number
  bottom: number
  flip: boolean
  point: MetricPoint
}) {
  const lines = [
    `epoch ${point.epoch}`,
    `loss ${formatNumber(point.loss)}`,
    ...(point.val_loss != null ? [`val ${formatNumber(point.val_loss)}`] : []),
    ...(point.elapsed_ms != null ? [`${(point.elapsed_ms / 1000).toFixed(1)}s`] : []),
  ]
  const w = Math.max(...lines.map((l) => l.length)) * CHAR_W + 16
  const h = lines.length * 14 + 10
  const bx = flip ? x - 10 - w : x + 10
  const by = Math.min(Math.max(top, yTrain - h / 2), bottom - h)
  return (
    <g pointerEvents="none">
      <line x1={x} x2={x} y1={top} y2={bottom} className="stroke-fg-muted" strokeWidth={1} strokeDasharray="2 2" />
      <circle cx={x} cy={yTrain} r={3} className="fill-accent" />
      {yVal != null ? <circle cx={x} cy={yVal} r={3} className="fill-fg-muted" /> : null}
      <rect x={bx} y={by} width={w} height={h} rx={3} className="fill-surface stroke-line" strokeWidth={1} />
      {lines.map((l, i) => (
        <text key={l} x={bx + 8} y={by + 5 + (i + 1) * 14 - 3} className={`${FONT} fill-fg`}>
          {l}
        </text>
      ))}
    </g>
  )
}
