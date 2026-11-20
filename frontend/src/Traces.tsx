import { useLayoutEffect, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { Activity, SlidersHorizontal } from 'lucide-react'
import { signed, type Comparison } from './api'

const refColor = '#72bdff'
const cmpColor = '#ffb67c'
const channels = [
  { key: 'speed_kmh', label: 'Speed', unit: 'km/h' },
  { key: 'throttle_pct', label: 'Throttle', unit: '%' },
  { key: 'brake', label: 'Brake', unit: '0 / 1' },
  { key: 'delta_s', label: 'Cumulative delta', unit: 's' },
] as const
type Channel = (typeof channels)[number]

function Trace({
  data,
  channel,
  index,
  setIndex,
}: {
  data: Comparison
  channel: Channel
  index: number
  setIndex: (i: number) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const plot = useRef<uPlot | null>(null)
  const current = useRef(index)
  current.current = index
  const { estimated, meta } = data
  const isDelta = channel.key === 'delta_s'
  const a = channel.key === 'delta_s' ? estimated.delta_s : estimated.series.reference[channel.key]
  const b = channel.key === 'delta_s' ? undefined : estimated.series.compare[channel.key]
  useLayoutEffect(() => {
    const el = host.current
    if (!el) return
    const x = estimated.axis.progress.map((p) => p * 100)
    const fixedY =
      channel.key === 'brake' ? [-0.1, 1.1] : channel.key === 'throttle_pct' ? [-5, 105] : undefined
    const style = (stroke: string): uPlot.Series => ({
      stroke,
      width: 1.65,
      points: { show: false },
      paths: channel.key === 'brake' ? uPlot.paths.stepped?.({ align: 1 }) : undefined,
    })
    const chart = new uPlot(
      {
        width: Math.max(1, el.clientWidth),
        height: 132,
        padding: [16, 24, 0, 4],
        legend: { show: false },
        select: { show: false, left: 0, top: 0, width: 0, height: 0 },
        cursor: {
          y: false,
          points: { show: false },
          drag: { x: false, y: false },
          bind: { dblclick: () => null },
        },
        scales: { x: { time: false, range: [0, 100] }, y: { range: fixedY as [number, number] | undefined } },
        axes: [
          {
            size: 27,
            stroke: '#9ba7b6',
            font: '10px monospace',
            grid: { show: false },
            ticks: { show: false },
            splits: () => [0, 25, 50, 75, 100],
            values: (_u, v) => v.map((n) => n + '%'),
          },
          {
            size: 45,
            stroke: '#9ba7b6',
            font: '10px monospace',
            space: 26,
            grid: { stroke: '#252d38', width: 1 },
            ticks: { show: false },
            splits:
              channel.key === 'brake'
                ? () => [0, 1]
                : channel.key === 'throttle_pct'
                  ? () => [0, 50, 100]
                  : undefined,
          },
        ],
        series: [{}, style(isDelta ? '#d7dfff' : refColor), ...(b ? [style(cmpColor)] : [])],
        hooks: {
          drawAxes: [
            (u) => {
              const ctx = u.ctx,
                ratio = u.bbox.width / (u.over.clientWidth || 1)
              ctx.save()
              ctx.strokeStyle = '#59677a'
              ctx.fillStyle = '#aab9cc'
              ctx.font = 10 * ratio + 'px monospace'
              ctx.setLineDash([3 * ratio, 4 * ratio])
              let start = 0
              for (const boundary of estimated.axis.sector_boundaries) {
                const pos = u.valToPos(boundary.progress * 100, 'x', true)
                const middle = u.valToPos((start + boundary.progress) * 50, 'x', true)
                ctx.fillText('S' + boundary.sector, middle, u.bbox.top + 10 * ratio)
                if (boundary.progress < 1) {
                  ctx.beginPath()
                  ctx.moveTo(pos, u.bbox.top)
                  ctx.lineTo(pos, u.bbox.top + u.bbox.height)
                  ctx.stroke()
                }
                start = boundary.progress
              }
              ctx.restore()
            },
          ],
          setCursor: [
            (u) => {
              const sample = u.cursor.idx
              if (u.cursor.left == null || u.cursor.left < 0 || sample == null) return
              const left = u.valToPos(x[sample], 'x')
              if (Math.abs(left - u.cursor.left) > 0.5) u.setCursor({ left, top: 15 }, false)
              setIndex(sample)
            },
          ],
        },
      },
      b ? [x, a, b] : [x, a],
      el,
    )
    plot.current = chart
    const sync = () => chart.setCursor({ left: chart.valToPos(x[current.current], 'x'), top: 15 }, false)
    const observer = new ResizeObserver(() => {
      chart.setSize({ width: Math.max(1, el.clientWidth), height: 132 })
      sync()
    })
    observer.observe(el)
    // Preserve the selected sample after a pointer leaves the plot.
    chart.over.addEventListener('mouseleave', sync)
    return () => {
      observer.disconnect()
      chart.over.removeEventListener('mouseleave', sync)
      chart.destroy()
      plot.current = null
    }
  }, [estimated, a, b, isDelta, channel, setIndex])
  useLayoutEffect(() => {
    const chart = plot.current
    if (chart)
      chart.setCursor({ left: chart.valToPos(estimated.axis.progress[index] * 100, 'x'), top: 15 }, false)
  }, [index, estimated])
  const readoutLabel = (role: 'reference' | 'compare') =>
    meta[role].driver_code +
    (meta.reference.driver_code === meta.compare.driver_code ? ' L' + meta[role].lap_number : '')
  return (
    <section className="trace">
      <div className="trace-head">
        <h3>
          {channel.label} <small>{channel.unit}</small>
        </h3>
        <div className="trace-values">
          {isDelta ? (
            <span>Δ {signed(a[index])} s</span>
          ) : (
            <>
              <span className="ref">
                {readoutLabel('reference')} {a[index]}
              </span>
              <span className="cmp">
                {readoutLabel('compare')} {b![index]}
              </span>
            </>
          )}
        </div>
      </div>
      <div className="plot" ref={host} role="img" aria-label={channel.label + ' by estimated lap progress'} />
    </section>
  )
}

export default function Traces({ data }: { data: Comparison }) {
  const [index, setIndex] = useState(0)
  const { axis } = data.estimated
  const sector = axis.sector_boundaries.find((b) => axis.progress[index] <= b.progress)?.sector ?? 3
  return (
    <section className="traces">
      <p className="section-label">
        <Activity size={14} /> INTERPOLATED TELEMETRY
      </p>
      <h2>
        Aligned traces<span className="heading-dot">.</span>
      </h2>
      <p className="quality-line">
        {data.meta.grid_points} samples · Shared coverage{' '}
        {(data.coverage.compared_progress.end * 100).toFixed(2)}% · Alignment uncertainty{' '}
        {data.uncertainty.stated_seconds.toFixed(3)} s
      </p>
      <div className="scrubber">
        <div>
          <label htmlFor="lap-progress">
            <SlidersHorizontal size={15} /> Lap progress
          </label>
          <output htmlFor="lap-progress">
            S{sector} <i /> {(axis.progress[index] * 100).toFixed(2)}% <i />{' '}
            {axis.distance_m[index].toFixed(0)} m
          </output>
        </div>
        <input
          id="lap-progress"
          type="range"
          min="0"
          max={axis.progress.length - 1}
          step="1"
          value={index}
          aria-valuetext={`Sector ${sector}, ${(axis.progress[index] * 100).toFixed(2)} percent`}
          onChange={(e) => setIndex(Number(e.target.value))}
        />
      </div>
      {channels.map((channel) => (
        <Trace key={channel.key} data={data} channel={channel} index={index} setIndex={setIndex} />
      ))}
    </section>
  )
}
