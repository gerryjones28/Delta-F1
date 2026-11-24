import { useEffect, useState } from 'react'

export interface Session {
  id: string
  year: number
  event_name: string
  session_type: string
  laps: number
  drivers: number
  laps_with_telemetry: number
  best_lap_s: number | null
}
export interface Driver {
  driver_code: string
  full_name: string
  laps_with_telemetry: number
  best_lap_s: number | null
}
export interface Lap {
  lap_number: number
  lap_duration_s: number | null
  eligible: boolean
  reason: string | null
}
export interface LapRef {
  driver_code: string
  lap_number: number
}
export type Pair<T> = { reference: T; compare: T }
export type Series = { speed_kmh: number[]; throttle_pct: number[]; brake: number[]; elapsed_s: number[] }
export interface Comparison {
  meta: Pair<LapRef> & { grid_points: number }
  measured: {
    lap_duration_s: Pair<number>
    sector_times_s: Pair<number[]>
    sector_deltas_s: number[]
    lap_delta_s: number
    delta_sign: string
    source: string
  }
  estimated: {
    axis: {
      progress: number[]
      distance_m: number[]
      length_m: number
      sector_boundaries: { sector: number; progress: number }[]
    }
    series: Pair<Series>
    delta_s: number[]
  }
  coverage: Pair<{ progress: number; uncovered_m: number }> & {
    complete_lap: boolean
    compared_progress: { start: number; end: number }
    notes: string[]
  }
  uncertainty: { stated_seconds: number; typical_seconds: number; note: string }
  limitations: string[]
}

export async function request<T>(url: string, signal: AbortSignal, body?: string): Promise<T> {
  const response = await fetch(url, {
    signal,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    method: body ? 'POST' : 'GET',
    body,
  })
  if (!response.ok) {
    if (response.status >= 500)
      throw new Error('Could not load the data. Check the API and database connection.')
    const data = await response.json().catch(() => ({}))
    throw new Error(
      typeof data.detail === 'string' ? data.detail : 'Could not load this selection.',
    )
  }
  return response.json()
}

export function useQuery<T>(url: string | null, revision = 0, body?: string) {
  const key = JSON.stringify([url, revision, body])
  const [result, setResult] = useState<{ key: string; data?: T; error?: string }>({ key: '' })
  useEffect(() => {
    if (!url) return
    const controller = new AbortController()
    request<T>(url, controller.signal, body)
      .then((data) => {
        if (!controller.signal.aborted) setResult({ key, data })
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setResult({
            key,
            error:
              error instanceof Error && !(error instanceof TypeError)
                ? error.message
                : 'Could not connect to the API.',
          })
      })
    return () => controller.abort()
  }, [key, url, body])
  return result.key === key ? result : { key, data: undefined, error: undefined }
}

export function lapTime(seconds: number | null) {
  if (seconds === null) return '—'
  const ms = Math.round(seconds * 1000)
  return (
    Math.floor(ms / 60000) +
    ':' +
    String(Math.floor(ms / 1000) % 60).padStart(2, '0') +
    '.' +
    String(ms % 1000).padStart(3, '0')
  )
}
export function signed(seconds: number) {
  return (seconds >= 0 ? '+' : '−') + Math.abs(seconds).toFixed(3)
}
