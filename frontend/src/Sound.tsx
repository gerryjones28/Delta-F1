import { useCallback, useEffect, useRef, useState } from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import soundtrack from '../_Liminal_ Dark Ambient Music 2025 Deep Soundscape - No Copyright Free Music [FREE FOR PROFIT].mp3?url'

type Cue = 'select' | 'navigate' | 'confirmed'

function createMixer() {
  const context = new AudioContext()
  const master = context.createGain()
  master.gain.value = 0
  master.connect(context.destination)
  const music = new Audio(soundtrack)
  music.loop = true
  const source = context.createMediaElementSource(music)
  source.connect(master)
  return { context, master, music }
}

function savedVolume() {
  try {
    const stored = localStorage.getItem('delta.masterVolume')
    const value = stored === null ? NaN : Number(stored)
    if (Number.isFinite(value)) return Math.max(0, Math.min(1, value))
  } catch { /* Storage can be unavailable in private browsing. */ }
  return 0.14
}

export function useStudioSound() {
  const mixer = useRef<ReturnType<typeof createMixer> | null>(null)
  const generation = useRef(0)
  const active = useRef(false)
  const [enabled, setEnabled] = useState(false)
  const [volume, setVolume] = useState(savedVolume)
  const [error, setError] = useState(false)

  const cue = useCallback((kind: Cue) => {
    if (!active.current || !mixer.current) return
    const { context, master } = mixer.current
    const start = context.currentTime
    const notes = kind === 'confirmed' ? [440, 660] : kind === 'navigate' ? [294] : [520]
    notes.forEach((pitch, i) => {
      const time = start + i * 0.084
      const oscillator = context.createOscillator()
      const envelope = context.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(pitch, time)
      oscillator.frequency.exponentialRampToValueAtTime(pitch * 0.97, time + 0.09)
      envelope.gain.setValueAtTime(0.0001, time)
      envelope.gain.exponentialRampToValueAtTime(0.11, time + 0.008)
      envelope.gain.exponentialRampToValueAtTime(0.0001, time + 0.14)
      oscillator.connect(envelope).connect(master)
      oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect() }
      oscillator.start(time)
      oscillator.stop(time + 0.15)
    })
  }, [])

  async function toggle() {
    const ticket = ++generation.current
    setError(false)
    if (active.current && mixer.current) {
      active.current = false
      const { master, context } = mixer.current
      master.gain.cancelScheduledValues(context.currentTime)
      master.gain.setValueAtTime(0, context.currentTime)
      mixer.current.music.pause()
      setEnabled(false)
      return
    }
    try {
      const { context, master, music } = mixer.current ??= createMixer()
      active.current = true
      setEnabled(true)
      master.gain.cancelScheduledValues(context.currentTime)
      master.gain.setValueAtTime(0, context.currentTime)
      master.gain.setTargetAtTime(volume, context.currentTime, 0.09)
      // Both operations start in the explicit enable gesture, including on touch browsers.
      await Promise.all([context.resume(), music.play()])
      if (generation.current === ticket) cue('confirmed')
    } catch {
      if (generation.current !== ticket) return
      active.current = false
      mixer.current?.music.pause()
      setEnabled(false)
      setError(true)
    }
  }

  function adjust(value: number) {
    setVolume(value)
    const bus = mixer.current
    if (bus && active.current) bus.master.gain.setTargetAtTime(value, bus.context.currentTime, 0.035)
    try { localStorage.setItem('delta.masterVolume', String(value)) } catch { /* Session setting still applies. */ }
  }
  useEffect(() => () => {
    generation.current++
    active.current = false
    const bus = mixer.current
    if (bus) {
      bus.music.pause()
      bus.music.removeAttribute('src')
      bus.music.load()
      void bus.context.close()
    }
  }, [])
  return { enabled, volume, error, toggle, adjust, cue }
}

export function SoundControls({ sound }: { sound: ReturnType<typeof useStudioSound> }) {
  const [open, setOpen] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    const outside = (event: Event) => {
      if (!panel.current?.contains(event.target as Node)) close()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { close(); trigger.current?.focus() }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    document.addEventListener('keydown', escape)
    window.addEventListener('hashchange', close)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('hashchange', close)
    }
  }, [open])
  return <div ref={panel} className="sound">
    <button ref={trigger} className="sound-trigger" aria-label="Sound controls" title="Sound controls"
      aria-controls="studio-sound" aria-expanded={open} onClick={() => setOpen(!open)}>
      {sound.enabled && sound.volume > 0 ? <Volume2 size={15} /> : <VolumeX size={15} />}
    </button>
    <div id="studio-sound" className="sound-panel" hidden={!open}>
      <button className="sound-switch" aria-pressed={sound.enabled} onClick={sound.toggle}>
        Studio sound <span>{sound.enabled ? 'On' : 'Off'}</span>
      </button>
      <label>Master volume <output>{Math.round(sound.volume * 100)}%</output>
        <input aria-label="Master volume" type="range" min="0" max="100" value={Math.round(sound.volume * 100)}
          onChange={e => sound.adjust(Number(e.target.value) / 100)} />
      </label>
      {sound.error && <p role="status">Audio unavailable. Enable sound to retry.</p>}
    </div>
  </div>
}
