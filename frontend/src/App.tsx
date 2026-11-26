import { lazy, Suspense, useEffect, useState } from 'react'
import {
  Activity,
  AudioWaveform,
  ChartNoAxesCombined,
  Check,
  Flag,
  Layers3,
  Menu,
  Unplug,
  X,
} from 'lucide-react'
import { flushSync } from 'react-dom'
import { WakeHandoff, measurePage, type ContourGroup } from './WakeTransition'
import { observePageCopy } from './type-motion'
import Hero, { InstrumentRail } from './Hero'
import { SoundControls, useStudioSound } from './Sound'
import { Archive, ConnectionNotice } from './Archive'
import { useQuery, type Session } from './api'

const Workspace = lazy(() => import('./Workspace'))
function Brand() {
  return (
    <a href="#overview" className="brand" aria-label="Delta F1 home">
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
      <h1>
        About the data<span className="heading-dot">.</span>
      </h1>
      <div className="method-grid">
        <article>
          <Flag />
          <h2>The project</h2>
          <p>I built Delta F1 for a graduate database project. It combines historical Formula 1 data with telemetry to compare qualifying laps. The database contains selected sessions, mostly from 2025.</p>
        </article>
        <article>
          <ChartNoAxesCombined />
          <h2>Data sources</h2>
          <p>F1DB provides historical information about drivers, events, and circuits. OpenF1 provides session and timing data through its API. TracingInsights archives lap telemetry. These sources can share underlying timing and telemetry records.</p>
        </article>
        <article>
          <Activity />
          <h2>How it works</h2>
          <p>I import the data into PostgreSQL hosted on Supabase. A Python backend built with FastAPI serves the stored records to a React frontend. Three.js renders the car and circuit views. The site shows past sessions and updates only when I import more data.</p>
        </article>
        <article>
          <Layers3 />
          <h2>What the times mean</h2>
          <p>Lap and sector times are recorded at timing lines. Between those lines, the charts use telemetry to estimate the time difference. Some laps have gaps or no usable telemetry, so an exact time gain at a corner cannot be read from the charts.</p>
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
  const { cue, pass } = sound
  const [route, setRoute] = useState(getRoute)
  const [revealing, setRevealing] = useState(
    () => getRoute() === 'overview' && !matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  const [studioVisited, setStudioVisited] = useState(() => getRoute() === 'overview')
  const [flight, setFlight] = useState<{direction: 'launch' | 'return' | 'transfer'; start: number; source: string; scroll: number; sourceTop: number; captured: ContourGroup[]} | null>(null)
  const [revision, setRevision] = useState(0)
  const [menu, setMenu] = useState(false)
  const [statusOpen, setStatusOpen] = useState(false)
  const result = useQuery<{ sessions: Session[] }>('/api/sessions', revision)
  const sessions = result.data?.sessions
  const retry = () => setRevision((v) => v + 1)
  // The preview can be ready before its local sessions API finishes starting.
  useEffect(() => {
    if (!result.error || revision >= 3) return
    const timer = window.setTimeout(() => setRevision(v => v + 1), 1500 * 2 ** revision)
    return () => window.clearTimeout(timer)
  }, [result.error, revision])
  // Prepare the return shot during idle time once the destination page is usable.
  useEffect(() => {
    const ready = route === 'method' || ((route === 'archive' || route.startsWith('session/')) && !!sessions)
    if (studioVisited || !ready || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const prepare = () => setStudioVisited(true)
    if (typeof window.requestIdleCallback === 'function') {
      const idle = window.requestIdleCallback(prepare, {timeout: 2000})
      return () => window.cancelIdleCallback(idle)
    }
    const timer = window.setTimeout(prepare, 500)
    return () => window.clearTimeout(timer)
  }, [route, sessions, studioVisited])
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
    // The router scrolls after commit. Keep Back from restoring Home's scroll
    // before the return transition measures the outgoing Sessions grid.
    const restoration = history.scrollRestoration
    history.scrollRestoration = 'manual'
    let previous = getRoute()
    let generation = 0
    let transition: ViewTransition | undefined
    const navigate = async () => {
      const next = getRoute()
      if (next === previous) return
      const hasWake = (path: string) => path === 'method' || path === 'archive' || path.startsWith('session/')
      const stage = document.querySelector('.stage')?.getBoundingClientRect()
      const carVisible = stage && stage.bottom > stage.height * .24 && stage.top < innerHeight
      const direction = previous === 'overview' && hasWake(next) ? (carVisible ? 'launch' : 'transfer')
        : next === 'overview' && hasWake(previous) ? 'return'
        : hasWake(previous) && hasWake(next) ? 'transfer' : null
      const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
      const cinematic = direction && !reducedMotion &&
        !document.querySelector('.laboratory[data-flight]') &&
        (direction === 'transfer' || (!!document.querySelector('.stage[data-live="true"] .render-host:not([data-static])') &&
          !document.querySelector('[aria-label="Resume studio motion"]')))
      cue('navigate')
      const request = ++generation
      const venue = (next.startsWith('session/') ? next : previous).split('/')[1]
      const source = previous
      const scroll = window.scrollY
      const outgoing = document.querySelector('.route-body')
      const sourceTop = outgoing ? outgoing.getBoundingClientRect().top - (document.querySelector('#main')!.getBoundingClientRect().top + scroll) : -scroll
      const captured = cinematic && outgoing && direction !== 'launch' ? measurePage(outgoing,true) : []
      previous = next
      const markVenue = () => {
        if (!venue) return
        const el = document.querySelector<HTMLElement>(`[data-venue="${CSS.escape(venue)}"]`)
        if (el) el.style.viewTransitionName = 'venue-outline'
      }
      const commit = () => {
        if (request !== generation) return
        flushSync(() => {
          if (next === 'overview') setStudioVisited(true)
          setFlight(cinematic && direction ? {direction, start: performance.now(), source, scroll, sourceTop, captured} : null)
          setRoute(next)
          setMenu(false)
          setStatusOpen(false)
        })
        const main = document.getElementById('main')
        if (main && !cinematic && !document.startViewTransition) main.classList.add('route-arrival')
        window.scrollTo({ top: 0, behavior: 'instant' })
        main?.focus({ preventScroll: true })
        if (reducedMotion && direction && (source === 'method' || next === 'method')) {
          // Echo the handoff with stationary light on the destination geometry.
          if (next === 'method') {
            main?.querySelectorAll('.method-grid article').forEach(panel =>
              panel.animate([{borderColor:'#747678'}, {}], {duration:240, easing:'ease-out'}))
          } else if (next === 'overview') {
            main?.querySelector('.studio-light')?.animate([{opacity:.65}, {opacity:1}], {duration:240})
          }
        }
      }
      transition?.skipTransition()
      if (direction || !document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) {
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
      history.scrollRestoration = restoration
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
  useEffect(() => {
    if (!flight) return
    const stopAudio = flight.direction === 'transfer' ? undefined : pass(flight.direction === 'return')
    const finish = () => setFlight(null)
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') finish() }
    const motion = matchMedia('(prefers-reduced-motion: reduce)')
    const timer = window.setTimeout(finish, Math.max(0, flight.start + (flight.direction === 'transfer' ? 1420 : flight.direction === 'launch' ? 1840 : 1580) - performance.now()))
    motion.addEventListener('change', finish)
    window.addEventListener('keydown', escape)
    window.addEventListener('resize', finish)
    return () => {
      stopAudio?.()
      clearTimeout(timer)
      motion.removeEventListener('change', finish)
      window.removeEventListener('keydown', escape)
      window.removeEventListener('resize', finish)
    }
  }, [flight, pass])
  const active = route.startsWith('session/') ? 'archive' : route
  useEffect(()=>{
    if(flight || revealing) return
    const body=document.querySelector('.route-body')
    if(!body) return
    const selector=route.startsWith('session/') ? '.workspace-intro' : '.methodology,.archive'
    const page=body.querySelector(selector)
    if(page) return observePageCopy(page)
    // On a direct session link the workspace can arrive after the route commit.
    let stop:(()=>void) | undefined
    const pending=new MutationObserver(()=>{
      const loaded=body.querySelector(selector)
      if(loaded) { pending.disconnect(); stop=observePageCopy(loaded) }
    })
    pending.observe(body,{childList:true,subtree:true})
    return ()=>{pending.disconnect();stop?.()}
  },[route,flight,revealing])
  const state = sessions ? 'online' : result.error ? 'offline' : 'connecting'
  const layers = flight ? [flight.source, route] : [route]
  return (
    <div data-flight={flight?.direction} data-scrolled={flight && flight.scroll > 0 || undefined} data-flight-start={flight?.start} className={revealing && route === 'overview' ? 'laboratory is-revealing' : 'laboratory'}>
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
              ['overview', 'Home'],
              ['archive', 'Sessions'],
              ['method', 'About the data'],
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
              {state === 'online' ? 'Loaded' : state === 'offline' ? 'Offline' : 'Loading'}
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
                  <strong>Database connection</strong>
                </div>
                <p>
                  {sessions
                    ? sessions.length + ' qualifying sessions in the database.'
                    : result.error || 'Loading sessions…'}
                </p>
                <button className="ghost" onClick={retry}>
                  Check again
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        {studioVisited && <div className="studio-layer" style={flight?.direction==='launch' ? {top:-flight.scroll} : undefined} hidden={route !== 'overview' && (!flight || flight.direction === 'transfer')} inert={route !== 'overview' || !!flight}>
            <Hero
              revealing={revealing}
              skipReveal={() => setRevealing(false)}
              enter={() => {
                window.location.hash = 'archive'
              }}
            />
        </div>}
        {flight && <WakeHandoff key={flight.start} direction={flight.direction} start={flight.start} captured={flight.captured} />}
        {flight && <button className="skip-flight ghost" type="button" onClick={() => {setFlight(null); document.getElementById('main')?.focus()}}>Skip transition</button>}
        {layers.map(page => {
          const outgoing = flight && page === flight.source
          const session = sessions?.find(s => 'session/' + encodeURIComponent(s.id) === page)
          return <div className={outgoing ? 'route-outgoing' : 'route-body'} key={page}
            style={outgoing ? {top:flight.sourceTop} : undefined}
            inert={!!flight} aria-hidden={flight ? true : undefined}>
            {page === 'overview' ? (<>
                <InstrumentRail count={sessions?.length} />
                <Archive sessions={sessions} error={result.error} retry={retry} />
              </>
            ) : page === 'archive' ? (
              <Archive sessions={sessions} error={result.error} retry={retry} full />
            ) : page === 'method' ? (
              <Method />
            ) : page.startsWith('session/') && session ? (
              <Suspense fallback={<p className="shell empty loading-view" role="status">Loading lap comparison…</p>}>
                <Workspace session={session} cue={cue} />
              </Suspense>
            ) : page.startsWith('session/') && !sessions ? (
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
                  Browse sessions
                </a>
              </section>
            )}
            </div>
        })}
      </main>
      <footer>
        <div className="shell">
          <span>
            <AudioWaveform size={16} /> DELTA F1
          </span>
        </div>
      </footer>
    </div>
  )
}
