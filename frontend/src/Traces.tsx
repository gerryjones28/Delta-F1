import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { Play, Pause, RotateCcw } from 'lucide-react'
import { signed, type Comparison } from './api'

import { markerIndex, useLapMap } from './lap-map'
import CircuitView, { type MarkerFrame } from './CircuitView'
import { circuits } from './Archive'
import { bindChartGestures, nearest, type ChartControls, type Domain } from './chart-gestures'

const refColor = '#72bdff'
const cmpColor = '#ffb67c'
const channels = [
  { key: 'speed_kmh', label: 'Speed', unit: 'km/h' },
  { key: 'throttle_pct', label: 'Throttle', unit: '%' },
  { key: 'brake', label: 'Brake', unit: '0 / 1' },
  { key: 'delta_s', label: 'Estimated time difference', unit: 's' },
] as const
type Channel = (typeof channels)[number]

function Trace({
  data,
  channel,
  index,
  controls,
}: {
  data: Comparison
  channel: Channel
  index: number
  controls: ChartControls
}) {
  const host = useRef<HTMLDivElement>(null)
  const plot = useRef<uPlot | null>(null)
  const controlRef = useRef(controls)
  controlRef.current = controls
  const cursor = useRef<HTMLElement | null>(null)
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
        cursor: { show:false },
        scales: { x: { time:false }, y: { range:fixedY as Domain | undefined } },
        axes: [
          {
            size: 27,
            stroke: '#9ba7b6',
            font: '10px monospace',
            grid: { show: false },
            ticks: { show: false },
            space: 56,
            values: (_u, v) => v.map((n) => Number(n.toFixed(2)) + '%'),
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
              ctx.beginPath()
              ctx.rect(u.bbox.left,u.bbox.top,u.bbox.width,u.bbox.height)
              ctx.clip()
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
        },
      },
      b ? [x, a, b] : [x, a],
      el,
    )
    plot.current = chart
    const marker = document.createElement('i')
    marker.className='trace-crosshair'
    chart.over.append(marker)
    cursor.current=marker
    const unbind=bindChartGestures(chart.over,()=>controlRef.current)
    const observer = new ResizeObserver(() => {
      chart.setSize({ width: Math.max(1, el.clientWidth), height: 132 })
      marker.style.left=chart.valToPos(x[current.current],'x')+'px'
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      unbind()
      cursor.current=null
      chart.destroy()
      plot.current = null
    }
  }, [estimated, a, b, isDelta, channel])
  useLayoutEffect(() => {
    const chart = plot.current
    chart?.setScale('x',{min:controls.domain[0],max:controls.domain[1]})
  }, [controls.domain])
  useLayoutEffect(() => {
    if (plot.current && cursor.current)
      cursor.current.style.left=plot.current.valToPos(estimated.axis.progress[index]*100,'x')+'px'
  }, [index, estimated, controls.domain])
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
      <div className="plot" ref={host} role="slider" tabIndex={0} aria-valuemin={controls.domain[0]} aria-valuemax={controls.domain[1]}
        aria-valuenow={estimated.axis.progress[index]*100} onKeyDown={e=>{
          const step=e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0
          if (!step) return
          e.preventDefault()
          const next=Math.max(0,Math.min(a.length-1,index+step))
          controls.scrub(estimated.axis.progress[next]*100)
        }} aria-label={channel.label + ' by estimated lap progress'} />
    </section>
  )
}

export default function Traces({ data, sessionId, elapsedReplay = false }: { data: Comparison; sessionId:string; elapsedReplay?:boolean }) {
  const { axis, series, delta_s } = data.estimated
  const map=useLapMap(series)
  const progress=axis.progress
  const full: Domain=[progress[0]*100,progress[progress.length-1]*100]
  const [domain,setDomain]=useState<Domain>(full)
  const [index,setIndex]=useState(0)
  const [pan,setPan]=useState(false)
  const [playing,setPlaying]=useState(false)
  const [speed,setSpeed]=useState(1)
  const sector=axis.sector_boundaries.find(b=>progress[index]<=b.progress)?.sector ?? 3
  const first=Math.max(0,progress.findIndex(v=>v*100>=domain[0]-.000001))
  let last=nearest(progress,domain[1]/100)
  if(progress[last]*100>domain[1]+.000001) last--
  const [common,setCommon]=useState(elapsedReplay)
  const [compareIndex,setCompareIndex]=useState(0)
  const markerFrame=useRef<MarkerFrame | null>(null)
  const clock=useRef<number | null>(null)
  const times=series.reference.elapsed_s
  const compareTimes=series.compare.elapsed_s
  const durations=data.measured.lap_duration_s
  const whole=first===0 && last===progress.length-1
  const canRace=whole && data.coverage.complete_lap && times[0]<=.002 && compareTimes[0]<=.002 && !!map &&
    !!series.reference.positions?.some(Boolean) && !!series.compare.positions?.some(Boolean)
  const simultaneous=common && canRace
  const begin=first===0 ? 0 : times[first]
  const refEnd=last===progress.length-1 && full[1]>=99.999 ? durations.reference : times[last]
  const end=simultaneous ? Math.max(refEnd,durations.compare) : refEnd
  function manual() {
    setPlaying(false)
    setCommon(false)
    clock.current=null
    markerFrame.current?.()
  }
  function zoom(range:Domain) {
    manual()
    const width=Math.min(full[1]-full[0],Math.max(range[1]-range[0],(full[1]-full[0])*4/(progress.length-1)))
    const left=Math.max(full[0],Math.min(full[1]-width,range[0]))
    const right=left+width
    setDomain([left,right])
    setIndex(i=>{
      if(progress[i]*100<left) return progress.findIndex(v=>v*100>=left-.000001)
      if(progress[i]*100>right) {
        const j=nearest(progress,right/100)
        return progress[j]*100>right+.000001 ? j-1 : j
      }
      return i
    })
  }
  const controls:ChartControls={domain,full,pan,zoom,pause:manual,
    scrub:p=>{manual();setIndex(Math.max(first,Math.min(last,nearest(progress,p/100))))}}
  function togglePlayback() {
    if (!playing && (clock.current===null || clock.current>=end)) {
      clock.current=index===first || index>=last ? begin : times[index]
    }
    setPlaying(!playing)
  }
  useEffect(()=>{
    if(!playing) return
    const origin=performance.now(), start=clock.current ?? begin
    let frame=0
    function tick(now:number) {
      const t=Math.min(end,start+(now-origin)*speed/1000)
      clock.current=t
      const refMarker=t>=refEnd ? last : markerIndex(times,t,first,last)
      const cmpMarker=simultaneous
        ? (t>=durations.compare ? compareTimes.length-1 : markerIndex(compareTimes,t,0,compareTimes.length-1))
        : refMarker
      markerFrame.current?.(refMarker,cmpMarker)
      // Keep the finish sample for the recorded finish, even when the nearest
      // grid point would round up a fraction of a second earlier.
      setIndex(t>=refEnd ? last : Math.max(first,Math.min(last - (times[last]>=refEnd-.002 ? 1 : 0),nearest(times,t))))
      if(simultaneous) {
        setCompareIndex(t>=durations.compare ? compareTimes.length-1 :
          Math.min(compareTimes.length-2,nearest(compareTimes,t)))
      }
      if(t>=end) setPlaying(false)
      else frame=requestAnimationFrame(tick)
    }
    frame=requestAnimationFrame(tick)
    return ()=>cancelAnimationFrame(frame)
  },[playing,speed,times,compareTimes,first,last,begin,refEnd,end,simultaneous,durations.compare])
  const ranges: {label:string; range:Domain}[]=[{label:'Full lap',range:full}]
  axis.sector_boundaries.forEach((b,i)=>ranges.push({label:'S'+b.sector,
    range:[Math.max(full[0],i?axis.sector_boundaries[i-1].progress*100:0),Math.min(full[1],b.progress*100)]}))
  const pct=progress[index]*100
  return <section className="traces">
    <h2>Telemetry by lap progress<span className="heading-dot">.</span></h2>
    <p className="quality-line">{data.meta.grid_points} samples · Shared coverage {(data.coverage.compared_progress.start*100).toFixed(1)}–{(data.coverage.compared_progress.end*100).toFixed(1)}% · Alignment uncertainty {data.uncertainty.stated_seconds.toFixed(3)} s</p>
    <div className="analysis-grid">
      <aside className="lap-inspector" onPointerMove={e=>{
        if (e.pointerType!=='mouse' || e.buttons || !e.target || !(e.target as Element).closest('.circuit-stage')) return
        const box=e.currentTarget.getBoundingClientRect()
        e.currentTarget.style.setProperty('--inspection-angle',((e.clientX-box.left)/box.width*6-3).toFixed(2)+'deg')
      }} onPointerLeave={e=>e.currentTarget.style.removeProperty('--inspection-angle')}>
        {circuits[sessionId] && <CircuitView circuit={circuits[sessionId]} sessionId={sessionId} map={map} drivers={[data.meta.reference.driver_code,data.meta.compare.driver_code]} markerFrame={markerFrame} index={index} comparisonIndex={simultaneous ? compareIndex : index}/>}
        <div className="lap-position"><span>Aligned lap progress · S{sector}</span><strong>{pct.toFixed(1)}<small>%</small></strong></div>
        <div className="lap-ruler" aria-hidden="true">
          <b style={{left:domain[0]+'%',width:(domain[1]-domain[0])+'%'}}/>
          {axis.sector_boundaries.map((b,i)=>{
            const start=i ? axis.sector_boundaries[i-1].progress : 0
            return <span key={b.sector} style={{left:start*100+'%',width:(b.progress-start)*100+'%'}}>S{b.sector}</span>
          })}
          <em style={{left:pct+'%'}}/>
        </div>
        <div className="lap-metrics"><span>{axis.distance_m[index].toFixed(0)} m</span><span>Est. Δ {signed(delta_s[index])} s</span></div>
        <div className="lap-speeds">{(['reference','compare'] as const).map(role=><span className={role==='reference'?'ref':'cmp'} key={role}>{data.meta[role].driver_code} · L{data.meta[role].lap_number}<strong>{series[role].speed_kmh[index]} <small>km/h</small></strong></span>)}</div>
        <div className="replay-controls"><button className="ghost mini" onClick={togglePlayback}>{playing?<Pause size={13}/>:<Play size={13}/>} {playing?'Pause':'Play'}</button>
          <button className="ghost mini" aria-label="Restart aligned replay" onClick={()=>{setPlaying(false);clock.current=begin;markerFrame.current?.();setIndex(first);setCompareIndex(first)}}><RotateCcw size={13}/></button>
          <select aria-label="Playback speed" value={speed} onChange={e=>setSpeed(Number(e.target.value))}>{[.5,1,2,4].map(n=><option key={n} value={n}>{n}×</option>)}</select></div>
      </aside>
      <div className="trace-stack">
        <div className="chart-tools" aria-label="Chart range">{ranges.map(({label,range})=><button key={label} disabled={range[1]<=range[0]} aria-pressed={Math.abs(domain[0]-range[0])<.001 && Math.abs(domain[1]-range[1])<.001} onClick={()=>zoom(range)}>{label}</button>)}<button aria-pressed={pan} onClick={()=>{setPlaying(false);setPan(!pan)}}>Pan</button></div>
        <p className="plot-note">Hover or touch to inspect. Scroll or pinch to zoom. Drag to select a range, or turn on Pan to move it.</p>
        {channels.map(channel=><Trace key={channel.key} data={data} channel={channel} index={index} controls={controls}/>)}
      </div>
    </div>
  </section>
}
