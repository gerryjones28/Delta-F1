import { useEffect, useId, useRef, useState } from 'react'
import { Box, Orbit } from 'lucide-react'
import { Outline, type Circuit } from './Archive'

export default function CircuitView({ circuit, sessionId }: { circuit: Circuit; sessionId: string }) {
  const host = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(false)
  const [status, setStatus] = useState('')
  const id = useId()
  useEffect(() => {
    if (!active || !host.current) return
    const el = host.current
    let cancelled = false
    let cleanup: (() => void) | undefined
    import('./circuit-scene')
      .then(({ drawCircuit }) => {
        if (cancelled) return
        cleanup = drawCircuit(el, circuit.points)
        setStatus('Drag to orbit · Arrow keys to rotate')
      })
      .catch(() => {
        if (!cancelled) {
          setActive(false)
          setStatus('3D unavailable · Showing plan view')
        }
      })
    return () => {
      cancelled = true
      cleanup?.()
    }
  }, [active, circuit])
  return (
    <div className="circuit-view">
      <div className="print-grid" />
      <div className="circuit-head">
        <span className="technical">
          <Box size={13} /> Circuit schematic
        </span>
        <button
          className="ghost mini"
          onClick={() => {
            setStatus('')
            setActive(!active)
          }}
        >
          <Orbit size={13} />
          {active ? 'Plan view' : 'Explore 3D'}
        </button>
      </div>
      <div className="circuit-stage" data-venue={sessionId}>
        {!active && <Outline circuit={circuit} id={id} />}
        <div className="circuit-canvas" ref={host} />
      </div>
      <p>{status || 'North-up plan · Reference geometry'}</p>
    </div>
  )
}
