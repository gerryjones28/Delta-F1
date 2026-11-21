import { lazy, Suspense, useEffect, useState } from 'react'
import {
  Activity,
  AudioWaveform,
  BookOpen,
  ChartNoAxesCombined,
  Check,
  Database,
  Flag,
  Layers3,
  Menu,
  Unplug,
  X,
} from 'lucide-react'
import { flushSync } from 'react-dom'
import Hero, { InstrumentRail } from './Hero'
import { SoundControls, useStudioSound } from './Sound'
import { Archive, ConnectionNotice } from './Archive'
import { useQuery, type Session } from './api'

const Workspace = lazy(() => import('./Workspace'))
function Brand() {
  return (
    <a href="#overview" className="brand" aria-label="Delta F1 overview">
      <img src="/delta.svg" alt="" />
      <span>
        DELTA <b>F1</b>
      </span>
    </a>
  )
}
function Method() {
  return (
    <section className="shell methodology">
      <p className="section-label">
        <BookOpen size={15} /> ANALYSIS NOTES
      </p>
      <h1>
        Methodology<span className="heading-dot">.</span>
      </h1>
      <div className="method-grid">
        <article>
          <Flag />
          <h2>Recorded timing</h2>
          <p>
            Lap durations and the three sector splits come directly from the stored timing records. Compare
            the two laps at each timing line using the measured table.
          </p>
        </article>
        <article>
          <ChartNoAxesCombined />
          <h2>Aligned telemetry</h2>
          <p>
            The service aligns each sector on a common distance axis and samples the overlapping trace at 500
            positions. Speed, throttle, brake and cumulative delta share this axis.
          </p>
        </article>
        <article>
          <Activity />
          <h2>Reading the delta</h2>
          <p>
            Delta is reference minus comparison. A positive value means the reference lap took longer to reach
            that position. Use the reported uncertainty to judge whether a change is distinguishable.
          </p>
        </article>
        <article>
          <Layers3 />
          <h2>Coverage and geography</h2>
          <p>
            Traces end where shared coverage ends. The scrubber follows estimated distance along the lap.
            Circuit schematics show the venue layout independently of the telemetry.
          </p>
          <a href="/licenses/circuits.txt" target="_blank" rel="noreferrer">
            Circuit data credits
          </a>
        </article>
      </div>
    </section>
  )
}
function getRoute() {
  return window.location.hash.slice(1) || 'overview'
}
export default function App() {
  const sound = useStudioSound()
  const { cue } = sound
  const [route, setRoute] = useState(getRoute)
  const [revealing, setRevealing] = useState(
    () => getRoute() === 'overview' && !matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  const [revision, setRevision] = useState(0)
  const [menu, setMenu] = useState(false)
  const [statusOpen, setStatusOpen] = useState(false)
  const result = useQuery<{ sessions: Session[] }>('/api/sessions', revision)
  const sessions = result.data?.sessions
  const retry = () => setRevision((v) => v + 1)
  useEffect(() => {
    if (!revealing) return
    const finish = () => setRevealing(false)
    const motion = matchMedia('(prefers-reduced-motion: reduce)')
    // Navigation and panel timing are independent of WebGL and the network.
    const timer = window.setTimeout(finish, 2720)
    motion.addEventListener('change', finish)
    window.addEventListener('pointerdown', finish, { once: true })
    window.addEventListener('keydown', finish, { once: true })
    window.addEventListener('hashchange', finish, { once: true })
    return () => {
      window.clearTimeout(timer)
      motion.removeEventListener('change', finish)
      window.removeEventListener('pointerdown', finish)
      window.removeEventListener('keydown', finish)
      window.removeEventListener('hashchange', finish)
    }
  }, [revealing])
  useEffect(() => {
    let previous = getRoute()
    let generation = 0
    let transition: ViewTransition | undefined
    const navigate = async () => {
      const next = getRoute()
      cue('navigate')
      const request = ++generation
      const venue = (next.startsWith('session/') ? next : previous).split('/')[1]
      previous = next
      const markVenue = () => {
        if (!venue) return
        const el = document.querySelector<HTMLElement>(`[data-venue="${CSS.escape(venue)}"]`)
        if (el) el.style.viewTransitionName = 'venue-outline'
      }
      const commit = () => {
        if (request !== generation) return
        flushSync(() => {
          setRoute(next)
          setMenu(false)
          setStatusOpen(false)
        })
        const main = document.getElementById('main')
        if (main && !document.startViewTransition) main.classList.add('route-arrival')
        window.scrollTo({ top: 0, behavior: 'instant' })
        main?.focus({ preventScroll: true })
      }
      transition?.skipTransition()
      if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) {
        commit()
        return
      }
      markVenue()
      transition = document.startViewTransition(() => {
        commit()
        markVenue()
      })
      await transition.finished
      if (request === generation)
        document
          .querySelectorAll<HTMLElement>('[data-venue]')
          .forEach((el) => el.style.removeProperty('view-transition-name'))
    }
    window.addEventListener('hashchange', navigate)
    return () => {
      generation++
      transition?.skipTransition()
      window.removeEventListener('hashchange', navigate)
    }
  }, [cue])
  useEffect(() => {
    if (!menu && !statusOpen) return
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenu(false)
        setStatusOpen(false)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [menu, statusOpen])
  const active = route.startsWith('session/') ? 'archive' : route
  const state = sessions ? 'online' : result.error ? 'offline' : 'connecting'
  const session = sessions?.find((s) => 'session/' + encodeURIComponent(s.id) === route)
  return (
    <div className={revealing && route === 'overview' ? 'laboratory is-revealing' : 'laboratory'}>
      <a
        className="skip"
        href="#main"
        onClick={(e) => {
          e.preventDefault()
          document.getElementById('main')?.focus()
        }}
      >
        Skip to content
      </a>
      <header className="topbar">
        <div className="shell top-inner">
          <Brand />
          <nav aria-label="Main navigation" className={menu ? 'open' : ''}>
            {[
              ['overview', 'Control room'],
              ['archive', 'Session archive'],
              ['method', 'Methodology'],
            ].map(([id, label]) => (
              <a
                key={id}
                href={'#' + id}
                aria-current={active === id ? 'page' : undefined}
                className={active === id ? 'active' : ''}
              >
                {label}
              </a>
            ))}
          </nav>
          <div className="top-right">
            <SoundControls sound={sound} />
            <button
              className={'connection ' + state}
              aria-expanded={statusOpen}
              onClick={() => {
                cue('select')
                setStatusOpen(!statusOpen)
                setMenu(false)
              }}
            >
              <span />
              {state === 'online' ? 'System online' : state === 'offline' ? 'API offline' : 'Connecting'}
            </button>
            <button
              className="menu-button"
              aria-label="Toggle navigation"
              aria-expanded={menu}
              onClick={() => {
                setMenu(!menu)
                setStatusOpen(false)
              }}
            >
              {menu ? <X /> : <Menu />}
            </button>
            {statusOpen && (
              <div className="status-pop">
                <div>
                  {sessions ? <Check size={17} /> : <Unplug size={17} />}
                  <strong>Telemetry connection</strong>
                </div>
                <p>
                  {sessions
                    ? sessions.length + ' qualifying sessions available via the local API.'
                    : result.error || 'Requesting the session archive…'}
                </p>
                <button className="ghost" onClick={retry}>
                  Refresh connection
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} key={route}>
        {route === 'overview' ? (
          <>
            <Hero
              revealing={revealing}
              skipReveal={() => setRevealing(false)}
              enter={() => {
                window.location.hash = 'archive'
              }}
            />
            <InstrumentRail count={sessions?.length} />
            <Archive sessions={sessions} error={result.error} retry={retry} />
          </>
        ) : route === 'archive' ? (
          <Archive sessions={sessions} error={result.error} retry={retry} full />
        ) : route === 'method' ? (
          <Method />
        ) : route.startsWith('session/') && session ? (
          <Suspense fallback={<p className="shell empty loading-view" role="status">Opening analysis workspace…</p>}>
            <Workspace session={session} cue={cue} />
          </Suspense>
        ) : route.startsWith('session/') && !sessions ? (
          <section className="shell archive">
            {result.error ? (
              <ConnectionNotice error={result.error} retry={retry} />
            ) : (
              <p className="empty loading-view" role="status">Opening session…</p>
            )}
          </section>
        ) : (
          <section className="shell empty">
            <h1>Session unavailable</h1>
            <a className="ghost" href="#archive">
              Browse session archive
            </a>
          </section>
        )}
      </main>
      <footer>
        <div className="shell">
          <span>
            <AudioWaveform size={16} /> DELTA F1 <i /> Telemetry Laboratory
          </span>
          <span>
            <Database size={13} /> Read-only data service
          </span>
        </div>
      </footer>
    </div>
  )
}
