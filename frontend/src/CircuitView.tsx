import { useEffect, useLayoutEffect, useId, useRef, useState } from 'react'
import { Box, Orbit } from 'lucide-react'
import { Outline, type Circuit } from './Archive'

import { markerPoint, type LapMap } from './lap-map'

import type { CameraMode, drawCircuit } from './circuit-scene'

export type MarkerFrame = (reference?: number, compare?: number) => void

export default function CircuitView({ circuit, sessionId, map, index=0, comparisonIndex=index, markerFrame, drivers }: { circuit: Circuit; sessionId: string; map?:LapMap|null; index?:number; comparisonIndex?:number; markerFrame?: React.RefObject<MarkerFrame | null>; drivers?: [string,string] }) {
  const host = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(!!map)
  const [status, setStatus] = useState('')
  const id = useId()
  const overlay = useRef<HTMLDivElement>(null)
  const scene = useRef<ReturnType<typeof drawCircuit>|null>(null)
  const [mode,setMode]=useState<CameraMode>('overview')
  const modeRef=useRef(mode)
  modeRef.current=mode
  const sample = useRef([index,comparisonIndex])
  sample.current=[index,comparisonIndex]
  const frameSample=useRef<number[] | null>(null)
  function markers() {
    if(!map) return
    const [ref,cmp]=frameSample.current ?? sample.current
    if(scene.current) {scene.current.setSamples(ref,cmp,!!frameSample.current); return}
    if(!overlay.current) return
    const svg=host.current?.parentElement?.querySelector('svg')
    const matrix=svg?.getScreenCTM()
    const rect=overlay.current.getBoundingClientRect()
    Array.from(overlay.current.children).forEach((el,i)=>{
      const dot=el as HTMLElement
      const idx=i===0?ref:cmp
      const p=frameSample.current ? map.playback[i](idx) : markerPoint(i===0?map.reference:map.compare,idx)
      dot.hidden=!p || !matrix
      if(!p || !matrix) return
      const pos=new DOMPoint(...p).matrixTransform(matrix)
      dot.style.left=pos.x-rect.x+'px';dot.style.top=pos.y-rect.y+'px'
    })
  }
  useLayoutEffect(()=>{
    if(!markerFrame) return
    markerFrame.current=(reference,compare)=>{
      frameSample.current=reference===undefined ? null : [reference,compare ?? reference]
      markers()
    }
    return ()=>{markerFrame.current=null}
  },[markerFrame,map,active])
  useLayoutEffect(()=>{if (!frameSample.current) markers()},[index,comparisonIndex,map,active])
  useEffect(()=>{
    if(!map || !overlay.current) return
    const ro=new ResizeObserver(markers);ro.observe(overlay.current)
    return ()=>ro.disconnect()
  },[map,active])
  useEffect(() => {
    if (!active || !host.current) return
    const el = host.current
    let cancelled = false
    function lost() {
      setActive(false)
      setMode('overview')
      setStatus('3D unavailable · Showing plan view')
    }
    el.addEventListener('webglcontextlost',lost,true)
    import('./circuit-scene')
      .then(({ drawCircuit }) => {
        if (cancelled) return
        scene.current = drawCircuit(el, map?.points ?? circuit.points,map)
        scene.current.setMode(modeRef.current)
        markers()
        setStatus('Drag to orbit · Arrow keys to rotate')
      })
      .catch(() => {
        if (!cancelled) lost()
      })
    return () => {
      el.removeEventListener('webglcontextlost',lost,true)
      cancelled = true
      scene.current?.dispose()
      scene.current=null
    }
  }, [active, circuit, map])
  return (
    <div className="circuit-view">
      <div className="print-grid" />
      <div className="circuit-head">
        <span className="technical">
          <Box size={13} /> Circuit
        </span>
        {map && active && drivers ? <div className="circuit-modes" role="group" aria-label="Circuit camera">
          {(['overview','reference','compare'] as const).map((next,i)=><button key={next} type="button"
            className={next} aria-pressed={mode===next}
            aria-label={i===0?'Overview':'Follow '+next+' lap '+drivers[i-1]}
            onClick={()=>{setMode(next);scene.current?.setMode(next)}}>
            {i===0?'Overview':drivers[i-1]}
          </button>)}
        </div> : <button
          className="ghost mini"
          onClick={() => {
            setStatus('')
            setActive(!active)
          }}
        >
          <Orbit size={13} />
          {active ? 'Plan view' : 'Explore 3D'}
        </button>}
      </div>
      <div className="circuit-stage" data-venue={sessionId}>
        {!active && map && <svg className="outline lap-xy" viewBox="0 0 180 110" aria-label="Circuit traced from lap telemetry"><path d={map.path} fill="none" stroke="#afb9c3" strokeWidth="2"/></svg>}
        {!active && !map && <Outline circuit={circuit} id={id} />}
        <div className="circuit-canvas" ref={host} />
        {map && !active && <div className="lap-dots" ref={overlay} aria-hidden="true"><i hidden/><b hidden/></div>}
      </div>
      {(!active || !map) && <p>{status || 'Plan view'}</p>}
    </div>
  )
}

