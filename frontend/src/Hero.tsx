import { useEffect, useRef, useState } from 'react'
import { Orbit, Box, Layers3, ScanLine, RotateCcw } from 'lucide-react'

function Airflow() {
  return (
    <svg className="airflow" viewBox="0 0 1000 440" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="flow">
          <stop stopColor="#97b8db" stopOpacity="0" />
          <stop offset=".24" stopColor="#9ebad3" stopOpacity=".32" />
          <stop offset=".54" stopColor="#a1c7dd" stopOpacity=".06" />
          <stop offset=".78" stopColor="#b8d1eb" stopOpacity=".32" />
          <stop offset="1" stopColor="#6d92ba" stopOpacity="0" />
        </linearGradient>
      </defs>
      {Array.from({ length: 36 }, (_, i) => {
        const y = 52 + i * 7.6
        return (
          <path
            key={i}
            d={`M -70 ${y + 64} C 145 ${y + 68}, 225 ${y + 53}, 365 ${y + 5} S 588 ${y - 54 + Math.sin(i * 0.1) * 18}, 695 ${y - 35} S 880 ${y - 32}, 1060 ${y - 73}`}
            fill="none"
            stroke="url(#flow)"
            strokeWidth={i % 7 === 0 ? 1.1 : 0.58}
          />
        )
      })}
    </svg>
  )
}

export default function Hero({ enter, revealing }: { enter: () => void; revealing: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const element = host.current
    if (!element || revealing) return
    let cancelled = false
    let dispose: (() => void) | undefined
    setReady(false)
    setFailed(false)
    const lost = () => {
      setFailed(true)
      setReady(false)
    }
    element.addEventListener('webglcontextlost', lost, true)
    import('./sculpture')
      .then(({ mountSculpture }) => {
        if (!cancelled)
          dispose = mountSculpture(element, () => {
            setReady(true)
            setFailed(false)
          })
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
      element.removeEventListener('webglcontextlost', lost, true)
      dispose?.()
    }
  }, [revealing])
  return (
    <section className="hero">
      <div className="hero-atmosphere" aria-hidden="true"><Airflow /></div>
      <div className="studio-light" aria-hidden="true" />
      {revealing && <div className="ignition" aria-hidden="true"><i /><b /></div>}
      <div className="stage" data-live={ready}>
          <img
            className="poster"
            src="/sculpture.webp"
            fetchPriority="high"
            alt={ready ? '' : 'Black and pearl-white open-wheel sculpture under a studio spotlight'}
          />
        <div
          className="render-host"
          ref={host}
          tabIndex={ready ? 0 : -1}
          role="group"
          aria-label="Black and pearl-white open-wheel study. Drag or use arrow keys to orbit. Press Home to reset."
        />
      </div>
      <div className="hero-shell shell">
        <div className="hero-copy">
          <p className="kicker">
            <i /> MOTORSPORT ENGINEERING
          </p>
          <h1>
            Telemetry
            <br />
            <em>
              Laboratory<span>.</span>
            </em>
          </h1>
          <p className="hero-desc">
            A precision workspace for Formula 1 qualifying analysis. Explore every sector, trace and time
            delta.
          </p>
          <button className="primary" onClick={enter}>
            <ScanLine size={18} /> Enter workspace
          </button>
        </div>
        <div className="scene-tag">
          <span className="technical">
            <Box size={14} /> DF–01
          </span>
          <span>Aero study</span>
        </div>
        <div className="stage-controls">
          <span>
            <Orbit size={17} />
            {failed ? 'Studio still' : ready ? 'Drag to orbit' : 'Loading studio'}
          </span>
          {ready && (
            <button
              title="Reset camera view"
              aria-label="Reset camera view"
              onClick={() => host.current?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }))}
            >
              <RotateCcw size={14} />
            </button>
          )}
        </div>
      </div>
    </section>
  )
}

export function InstrumentRail({ count }: { count?: number }) {
  return (
    <div className="instrument">
      <div className="shell instrument-inner">
        <div>
          <span className="rail-bars" aria-hidden="true">
            ▂▅▃▇▄▆▃
          </span>
          <span>Signal processing</span>
          <strong>Sector-anchored</strong>
        </div>
        <div>
          <Layers3 size={15} />
          <span>Resolution</span>
          <strong>500 points / lap</strong>
        </div>
        <div>
          <span className="square-icon" aria-hidden="true" />
          <span>Archive</span>
          <strong>{count === undefined ? 'Awaiting link' : count + ' sessions'}</strong>
        </div>
      </div>
    </div>
  )
}
