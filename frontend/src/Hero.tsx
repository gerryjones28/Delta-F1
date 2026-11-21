import { useEffect, useRef, useState } from 'react'
import { Orbit, Box, Layers3, ScanLine, RotateCcw, Pause, Play } from 'lucide-react'

export default function Hero({ enter, revealing, skipReveal }: { enter: () => void; revealing: boolean; skipReveal: () => void }) {
  const host = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [deferred, setDeferred] = useState(false)
  const [paused, setPaused] = useState(false)
  const [revealStart] = useState(() => (revealing ? performance.now() : undefined))

  useEffect(() => {
    const element = host.current
    if (!element) return
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
          dispose = mountSculpture(
            element,
            () => {
              setReady(true)
              setFailed(false)
            },
            revealStart,
            lost,
            () => setDeferred(true),
          )
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
      element.removeEventListener('webglcontextlost', lost, true)
      dispose?.()
    }
  }, [revealStart])
  return (
    <section className="hero">
      <div className="hero-atmosphere" aria-hidden="true" />
      <div className="studio-light" aria-hidden="true" />
      {revealing && (
        <div className="ignition" aria-hidden="true">
          <i />
          <b />
          <span>DELTA F1</span>
        </div>
      )}
      <div className="stage" data-live={ready}>
        <img
          className="poster"
          src={revealing && !failed && !ready ? (deferred ? '/studio-descent.webp' : '/studio-overhead.webp') : '/sculpture.webp'}
          fetchPriority="high"
          alt={ready ? '' : 'Black and pearl-white open-wheel sculpture under a studio spotlight'}
        />
        <div
          className="render-host"
          ref={host}
          tabIndex={ready ? 0 : -1}
          role="group"
          aria-hidden={!ready}
          aria-label="Open-wheel studio. Move the pointer to steer the light. Drag or use arrow keys to orbit. Press Home to reset."
        />
      </div>
      <div className="hero-shell shell">
        {revealing && (
          <button type="button" className="skip-reveal" onClick={skipReveal}>Skip intro</button>
        )}
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
          <span>Illustrative airflow</span>
        </div>
        <div className="stage-controls" title={ready ? 'Move the pointer to steer the light. Drag to orbit.' : undefined}>
          <span>
            <Orbit size={17} />
            {failed ? 'Studio still' : ready ? 'Drag to orbit' : 'Loading studio'}
          </span>
          {ready && (
            <>
              <button
                className="motion-toggle"
                type="button"
                aria-label={paused ? 'Resume studio motion' : 'Pause studio motion'}
                title={paused ? 'Resume studio motion' : 'Pause studio motion'}
                onClick={() => {
                  host.current?.dispatchEvent(new CustomEvent('studio-motion', { detail: !paused }))
                  setPaused(!paused)
                }}
              >
                {paused ? <Play size={14} /> : <Pause size={14} />}
              </button>
              <button
                title="Reset camera view"
                aria-label="Reset camera view"
                onClick={() => host.current?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }))}
              >
                <RotateCcw size={14} />
              </button>
            </>
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
