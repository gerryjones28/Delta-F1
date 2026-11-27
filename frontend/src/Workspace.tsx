import { InkText } from './InkText'
import DriverPicker from './DriverPicker'
﻿import { lazy, Suspense, useEffect, useState } from 'react'
import { Activity, AlertTriangle, ChevronDown, ChevronLeft, Flag, Layers3, Timer } from 'lucide-react'
import { circuits, SessionFacts } from './Archive'
import { lapTime, signed, useQuery, type Comparison, type Driver, type Lap, type Session } from './api'
import CircuitView from './CircuitView'

// The handoff measures this shell on its first frame. Charts load after comparison.
const Traces = lazy(() => import('./Traces'))

function ErrorLine({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="error-line" role="alert">
      <AlertTriangle size={16} />
      {message}
      <button onClick={retry}>Retry</button>
    </div>
  )
}
function useLapSelection(base: string, code: string, revision: number) {
  const result = useQuery<{ laps: Lap[] }>(
    code ? base + '/laps?driver_code=' + encodeURIComponent(code) : null,
    revision,
  )
  const [selected, setSelected] = useState<{ code: string; number: number } | null>(null)
  const fastest = result.data?.laps
    .filter((l) => l.eligible)
    .sort((a, b) => a.lap_duration_s! - b.lap_duration_s!)[0]
  const chosen =
    (selected?.code === code &&
      result.data?.laps.find((l) => l.eligible && l.lap_number === selected.number)) ||
    fastest
  return {
    laps: result.data?.laps,
    error: result.error,
    chosen,
    select: (number: number) => setSelected({ code, number }),
  }
}
function DriverControls({
  side,
  drivers,
  code,
  setCode,
  selection,
}: {
  side: 'Reference' | 'Comparison'
  drivers: Driver[]
  code: string
  setCode: (code: string) => void
  selection: ReturnType<typeof useLapSelection>
}) {
  return (
    <fieldset className={'driver-controls ' + (side === 'Reference' ? 'a' : 'b')}>
      <legend>
        <i />
        {side} lap
      </legend>
      <DriverPicker side={side} drivers={drivers} code={code} onChange={setCode} />
      <label>
        Qualifying lap
        <div className="select-wrap">
          <select
            aria-label={side + ' qualifying lap'}
            value={selection.chosen?.lap_number ?? ''}
            disabled={!selection.laps?.some((l) => l.eligible)}
            onChange={(e) => selection.select(Number(e.target.value))}
          >
            {!selection.chosen && (
              <option value="">{selection.laps ? 'No comparable laps' : 'Loading laps…'}</option>
            )}
            {selection.laps?.map((l) => (
              <option key={l.lap_number} value={l.lap_number} disabled={!l.eligible}>
                Lap {l.lap_number} · {lapTime(l.lap_duration_s)}
                {l.reason ? ' · ' + l.reason : ''}
              </option>
            ))}
          </select>
          <ChevronDown />
        </div>
      </label>
    </fieldset>
  )
}

function Results({ data, sessionId }: { data: Comparison; sessionId:string }) {
  const { meta, measured: m, coverage, uncertainty } = data
  return (
    <div className="results">
      <div className="section-head">
        <div>
          <p className="section-label">
            <Timer size={14} /> RECORDED TIMES
          </p>
          <h2>
            Lap and sector times<span className="heading-dot">.</span>
          </h2>
        </div>
      </div>
      <div className="timing-panel">
        <div className="timing-scores">
          {(['reference', 'compare'] as const).map((role, i) => (
            <div key={role}>
              <span className={i ? 'cmp' : 'ref'}>
                {meta[role].driver_code} · LAP {meta[role].lap_number}
              </span>
              <strong>{lapTime(m.lap_duration_s[role])}</strong>
            </div>
          ))}
          <div>
            <span>LAP TIME DIFFERENCE</span>
            <strong>
              {signed(m.lap_delta_s)} <small>s</small>
            </strong>
          </div>
        </div>
        <div className="table-scroll">
          <table>
            <caption className="sr-only">Official sector times in seconds</caption>
            <thead>
              <tr>
                <th>Sector</th>
                <th>
                  {meta.reference.driver_code} · L{meta.reference.lap_number}
                </th>
                <th>
                  {meta.compare.driver_code} · L{meta.compare.lap_number}
                </th>
                <th>Difference (s)</th>
              </tr>
            </thead>
            <tbody>
              {m.sector_deltas_s.map((delta, i) => (
                <tr key={i}>
                  <th>S{i + 1}</th>
                  <td>{m.sector_times_s.reference[i].toFixed(3)} s</td>
                  <td>{m.sector_times_s.compare[i].toFixed(3)} s</td>
                  <td>{signed(delta)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="sign-note">
          Time difference is reference minus comparison. A positive value means the reference lap was slower. A negative value means it was faster.
        </p>
      </div>
      {!coverage.complete_lap && (
        <div className="coverage-warning">
          <AlertTriangle size={18} />
          <p>
            <strong>Partial telemetry coverage</strong>
            <br />
            {coverage.notes.join(' ') || 'At least one trace has incomplete lap coverage.'}
          </p>
        </div>
      )}
      <Suspense fallback={<p role="status">Loading telemetry charts…</p>}>
        <Traces data={data} sessionId={sessionId} />
      </Suspense>
      <details className="limitations">
        <summary>
          <Layers3 size={16} /> Coverage, uncertainty and limitations
        </summary>
        <p>
          Uncovered distance · Reference {coverage.reference.uncovered_m.toFixed(1)} m · Comparison{' '}
          {coverage.compare.uncovered_m.toFixed(1)} m
        </p>
        <p>
          {uncertainty.note} Changes below {uncertainty.stated_seconds.toFixed(3)} s are within the stated
          alignment uncertainty.
        </p>
        <p>Replay follows the reference lap clock. Both markers show aligned lap progress.</p>
        {!coverage.complete_lap && <p>Readings hold at the last available sample when telemetry ends early.</p>}
        {!data.estimated.series.reference.positions?.some(Boolean) && <p>Reference lap coordinates unavailable.</p>}
        {!data.estimated.series.compare.positions?.some(Boolean) && <p>Comparison lap coordinates unavailable.</p>}
        <ul>
          {[...new Set([...coverage.notes, ...data.limitations])].map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </details>
    </div>
  )
}
export default function Workspace({ session, cue }: { session: Session; cue: (type: 'confirmed' | 'select') => void }) {
  const [revision, setRevision] = useState(0)
  const base = '/api/sessions/' + encodeURIComponent(session.id)
  const drivers = useQuery<{ drivers: Driver[] }>(base + '/drivers', revision)
  const list = drivers.data?.drivers ?? []
  const eligible = list.filter((d) => d.laps_with_telemetry > 0)
  const [refSelection, setRef] = useState('')
  const [cmpSelection, setCmp] = useState('')
  const refCode = refSelection || eligible[0]?.driver_code || list[0]?.driver_code || ''
  const cmpCode =
    cmpSelection || eligible[1]?.driver_code || eligible[0]?.driver_code || list[1]?.driver_code || ''
  const ref = useLapSelection(base, refCode, revision)
  const cmp = useLapSelection(base, cmpCode, revision)
  const same = !!ref.chosen && refCode === cmpCode && ref.chosen.lap_number === cmp.chosen?.lap_number
  const spec =
    ref.chosen && cmp.chosen && !same
      ? JSON.stringify({
          reference: { session_id: session.id, driver_code: refCode, lap_number: ref.chosen.lap_number },
          compare: { session_id: session.id, driver_code: cmpCode, lap_number: cmp.chosen.lap_number },
          grid_points: 500,
        })
      : null
  const [submitted, setSubmitted] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const active = !!submitted && submitted === spec
  const result = useQuery<Comparison>(
    active ? '/api/compare' : null,
    attempt,
    active ? submitted! : undefined,
  )
  const busy = active && !result.data && !result.error
  const retry = () => setRevision((v) => v + 1)
  useEffect(() => {
    if (active && result.data) cue('confirmed')
  }, [active, result.data, cue])
  const run = () => {
    cue('select')
    setSubmitted(spec)
    setAttempt((v) => v + 1)
  }
  useEffect(() => {
    if (submitted && submitted !== spec) setSubmitted(null)
  }, [spec, submitted])
  const error = drivers.error || ref.error || cmp.error
  return (
    <section className="shell workspace">
      <a className="back" href="#archive">
        <ChevronLeft size={15} />
        Back to sessions
      </a>
      <div className="workspace-intro">
        <div>
          <p className="section-label">
            <Flag size={14} /> {session.year} / {session.session_type.toUpperCase()}
          </p>
          <h1><InkText>
            {session.event_name}
            <span className="heading-dot">.</span>
          </InkText></h1>
          {circuits[session.id] && (
            <p className="venue">
              {circuits[session.id].name} · {circuits[session.id].locality}
            </p>
          )}
          <SessionFacts session={session} />
        </div>
        {!result.data && circuits[session.id] && <CircuitView circuit={circuits[session.id]} sessionId={session.id} />}
      </div>
      <div className="pair-header">
        <h2>
          Choose two laps<span className="heading-dot">.</span>
        </h2>
      </div>
      <div className="pairing">
        <DriverControls side="Reference" drivers={list} code={refCode} setCode={setRef} selection={ref} />
        <DriverControls side="Comparison" drivers={list} code={cmpCode} setCode={setCmp} selection={cmp} />
      </div>
      {error && <ErrorLine message={error} retry={retry} />}
      <div className="run-row">
        <button className="primary" onClick={run} disabled={!spec || busy}>
          <Activity size={17} />
          {busy ? 'Comparing laps…' : 'Compare laps'}
        </button>
        <span role="status" className={busy || (!drivers.data && !error) ? 'loading-signal' : undefined}>
          {same
            ? 'Select two different laps.'
            : busy
              ? 'Loading telemetry for both laps.'
              : !drivers.data && !error
                ? 'Loading session drivers…'
                : !list.length && drivers.data
                  ? 'No drivers found for this session.'
                  : ''}
        </span>
      </div>
      {active && result.error && <ErrorLine message={result.error} retry={run} />}
      {active && result.data && <Results data={result.data} sessionId={session.id} />}
    </section>
  )
}
