import { InkText } from './InkText'
import { useEffect, useRef, useState } from 'react'
import { studioAsset } from './vehicle-source'
import { startTypeMotion, type TypeVisit } from './type-motion'
import { Layers3, ScanLine, Pause, Play } from 'lucide-react'

export default function Hero({ enter, revealing, skipReveal, visit }: { visit:TypeVisit; enter: () => void; revealing: boolean; skipReveal: () => void }) {
  const host = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [deferred, setDeferred] = useState(false)
  const [paused, setPaused] = useState(false)
  const [revealStart] = useState(() => (revealing ? performance.now() : undefined))
  useEffect(() => {
    const hero=host.current?.closest('.hero')
    if(revealing && hero && revealStart!==undefined)
      return startTypeMotion(hero,'intro',revealStart,visit).finishFlight
  },[revealing,revealStart,visit])

  useEffect(() => {
    if (!revealing || ready || failed || revealStart === undefined) return
    // Cover a slow first GLB fetch with the same camera path while the decoder warms up.
    const timer = window.setTimeout(() => setDeferred(true), Math.max(0, revealStart + 200 - performance.now()))
    return () => window.clearTimeout(timer)
  }, [revealing, ready, failed, revealStart])

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
          <span>AXIS F1</span>
        </div>
      )}
      <div className="stage" data-live={ready}>
        <img
          className="poster"
          src={studioAsset(revealing && !failed ? (deferred ? 'studio-descent.webp' : 'studio-overhead.webp') : 'sculpture.webp')}
          onError={event => {
            const image = event.currentTarget
            if (new URL(image.src).pathname.endsWith('/studio-descent.webp') || new URL(image.src).pathname.endsWith('/studio-overhead.webp')) image.src = '/sculpture.webp'
          }}
          fetchPriority="high"
          alt={ready ? '' : 'Black and pearl-white Formula car under a studio spotlight'}
        />
        <div
          className="render-host"
          ref={host}
          role="img"
          aria-hidden={!ready}
          aria-label="Pearl-white and black Formula car on a rolling road with illustrative airflow."
        />
      </div>
      <div className="hero-shell shell">
        {revealing && (
          <button type="button" className="skip-reveal" onClick={skipReveal}>Skip intro</button>
        )}
        <div className="hero-copy">
          <h1><InkText>
            Compare{' '}
            <br />
            <em>
              qualifying laps<span>.</span>
            </em>
          </InkText></h1>
          <p className="hero-desc">
            Explore Formula 1 qualifying data and compare drivers using lap times, sector times, speed, throttle, and braking.
          </p>
          <button className="primary" onClick={enter}>
            <ScanLine size={18} /> Explore sessions
          </button>
        </div>
        <div className="stage-controls">
          {ready ? (
            <button
              className="motion-toggle"
              type="button"
              aria-label={paused ? 'Resume studio motion' : 'Pause studio motion'}
              onClick={() => {
                host.current?.dispatchEvent(new CustomEvent('studio-motion', { detail: !paused }))
                setPaused(!paused)
              }}
            >
              {paused ? <Play size={13} /> : <Pause size={13} />}
              {paused ? 'Resume motion' : 'Pause motion'}
            </button>
          ) : <span>{failed ? 'Still image' : 'Loading car'}</span>}
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
          <span>Timing</span>
          <strong>By sector</strong>
        </div>
        <div>
          <Layers3 size={15} />
          <strong>500 aligned samples</strong>
        </div>
        <div>
          <span className="square-icon" aria-hidden="true" />
          <span>Archive</span>
          <strong>{count === undefined ? '—' : count + ' sessions'}</strong>
        </div>
      </div>
    </div>
  )
}
