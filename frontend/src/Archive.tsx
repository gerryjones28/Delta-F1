import { useState } from 'react'
import {
  Activity,
  CalendarDays,
  ChevronDown,
  Flag,
  FolderOpen,
  Layers,
  MapPin,
  Plus,
  Search,
  UsersRound,
  X,
} from 'lucide-react'
import { lapTime, type Session } from './api'
import circuitData from './circuits.json'

export interface Circuit {
  name: string
  locality: string
  iso2: string
  points: number[][]
}
export const circuits: Record<string, Circuit> = circuitData
export function Outline({ circuit, id }: { circuit: Circuit; id: string }) {
  const path = circuit.points.map((p, i) => (i ? 'L' : 'M') + p.join(' ')).join(' ') + ' Z'
  return (
    <svg
      className="outline"
      viewBox="0 0 180 110"
      aria-label={circuit.name + ' circuit schematic'}
      role="img"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2=".4" y2="1" gradientUnits="objectBoundingBox">
          <stop stopColor="#eeeee9" />
          <stop offset=".45" stopColor="#a2a5a7" />
          <stop offset="1" stopColor="#686f74" />
        </linearGradient>
      </defs>
      <path
        d={path}
        transform="translate(0 3)"
        fill="none"
        stroke="#36393c"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path d={path} fill="none" stroke={`url(#${id})`} strokeWidth="2" strokeLinejoin="round" />
    </svg>
  )
}

export function ConnectionNotice({ error, retry }: { error: string; retry: () => void }) {
  return (
    <div className="notice" role="status">
      <Activity size={22} />
      <div>
        <strong>Connection unavailable</strong>
        <p>{error}</p>
      </div>
      <button className="ghost" onClick={retry}>
        Retry connection
      </button>
    </div>
  )
}

function SessionCard({ session }: { session: Session }) {
  const circuit = circuits[session.id]
  return (
    <a className="session-card" href={'#session/' + encodeURIComponent(session.id)}>
      <div className="card-art" data-venue={session.id}>
        <div className="print-grid" />
        <span className="country">
          <MapPin size={12} />
          {circuit?.iso2.toUpperCase() || session.year}
        </span>
        {circuit ? (
          <Outline circuit={circuit} id={'path-' + session.id} />
        ) : (
          <Flag className="unknown-track" />
        )}
        <span className="art-cross">+</span>
      </div>
      <div className="card-info">
        <div className="card-meta">
          <span className="quali-dot" />
          {session.session_type} <i /> {session.year}
        </div>
        <h3>{session.event_name}</h3>
        {circuit && <p>{circuit.name}</p>}
        <div className="card-stats">
          <span>
            <UsersRound size={14} />
            {session.drivers} drivers
          </span>
          <span>
            <Layers size={14} />
            {session.laps} laps
          </span>
          <Plus size={16} />
        </div>
      </div>
    </a>
  )
}

export function Archive({
  sessions,
  error,
  retry,
  full = false,
}: {
  sessions?: Session[]
  error?: string
  retry: () => void
  full?: boolean
}) {
  const [query, setQuery] = useState('')
  const [year, setYear] = useState('')
  const years = Array.from(new Set(sessions?.map((x) => x.year))).sort((a, b) => b - a)
  const filtered = sessions?.filter(
    (s) =>
      (!year || String(s.year) === year) &&
      [s.event_name, String(s.year), circuits[s.id]?.name, circuits[s.id]?.locality]
        .join(' ')
        .toLowerCase()
        .includes(query.toLowerCase().trim()),
  )
  const visible = full ? filtered : filtered?.slice(0, 3)
  return (
    <section className={'archive shell ' + (full ? 'full-archive' : '')} id="archive">
      <div className="section-head">
        <div>
          <p className="section-label">
            <FolderOpen size={14} /> QUALIFYING · MOSTLY 2025
          </p>
          <h2>
            Sessions<span className="heading-dot">.</span>
          </h2>
        </div>
        {!full ? (
          <a className="ghost" href="#archive">
            <Layers size={15} /> View all sessions{' '}
            {sessions && <span className="count">{sessions.length}</span>}
          </a>
        ) : (
          <label className="filter">
            <CalendarDays size={15} />
            <select aria-label="Filter by season" value={year} onChange={(e) => setYear(e.target.value)}>
              <option value="">All seasons</option>
              {years.map((y) => (
                <option key={y}>{y}</option>
              ))}
            </select>
            <ChevronDown size={14} />
          </label>
        )}
      </div>
      {full && (
        <div className="archive-tools">
          <label className="search">
            <Search size={17} />
            <input
              placeholder="Search events or circuits"
              aria-label="Search events or circuits"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button aria-label="Clear search" onClick={() => setQuery('')}>
                <X size={15} />
              </button>
            )}
          </label>
          {filtered && <span className="muted">{filtered.length} sessions</span>}
        </div>
      )}
      {error ? (
        <ConnectionNotice error={error} retry={retry} />
      ) : !visible ? (
        <div className="archive-pending">
          <p role="status" className="loading-signal">Loading qualifying sessions…</p>
          <div className="card-grid" aria-hidden="true">
            {[0, 1, 2].map(index => <div key={index} className="pending-card"><i /><i /></div>)}
          </div>
        </div>
      ) : !visible.length ? (
        <p className="empty">
          {sessions?.length ? 'No sessions match this search.' : 'No qualifying sessions are stored.'}
        </p>
      ) : (
        <div className="card-grid">
          {visible.map((s) => (
            <SessionCard key={s.id} session={s} />
          ))}
        </div>
      )}
    </section>
  )
}

export function SessionFacts({ session }: { session: Session }) {
  return (
    <div className="session-facts">
      <span>
        <UsersRound />
        {session.drivers} drivers
      </span>
      <span>
        <Layers />
        {session.laps_with_telemetry} laps with telemetry
      </span>
      <span>
        <Flag />
        Fastest lap {lapTime(session.best_lap_s)}
      </span>
    </div>
  )
}
