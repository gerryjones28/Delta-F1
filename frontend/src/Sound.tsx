import { useCallback, useEffect, useRef, useState } from 'react'
import { Volume2, VolumeX } from 'lucide-react'

type Cue = 'select' | 'navigate' | 'confirmed'

function createMixer() {
  const context = new AudioContext()
  const master = context.createGain()
  master.gain.value = 0
  master.connect(context.destination)
  return { context, master }
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
  const level = useRef(volume)
  const stopPass = useRef<(() => void) | null>(null)
  const [error, setError] = useState(false)

  function rememberMuted(muted: boolean) {
    try { localStorage.setItem('delta.muted', String(muted)) } catch { /* Private browsing. */ }
  }

  const cue = useCallback((kind: Cue) => {
    if (!active.current || !level.current) return
    try {
      const bus = mixer.current ??= createMixer()
      if (bus.context.state === 'suspended') void bus.context.resume().catch(() => {})
      bus.master.gain.setTargetAtTime(level.current, bus.context.currentTime, .025)
      const { context, master } = bus
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
    } catch { /* Sound effects are optional when Web Audio is unavailable. */ }
  }, [])

  const pass = useCallback((returning: boolean) => {
    stopPass.current?.()
    const bus = mixer.current
    if (!active.current || !level.current || !bus || bus.context.state !== 'running') return
    const { context, master } = bus
    const start = context.currentTime
    const effects = context.createGain()
    effects.connect(master)
    const tone = (from: number, to: number, offset: number, duration: number, gain: number, wave: OscillatorType) => {
      const osc = context.createOscillator(), env = context.createGain()
      const t = start + offset
      osc.type = wave
      osc.frequency.setValueAtTime(from,t)
      osc.frequency.exponentialRampToValueAtTime(to,t+duration)
      env.gain.setValueAtTime(.0001,t)
      env.gain.exponentialRampToValueAtTime(gain,t+duration*.36)
      env.gain.exponentialRampToValueAtTime(.0001,t+duration)
      osc.connect(env).connect(effects)
      osc.onended = () => { osc.disconnect(); env.disconnect() }
      osc.start(t)
      osc.stop(t+duration)
    }
    tone(43,66,0,.34,.095,'sine')
    tone(returning ? 188 : 64, returning ? 59 : 224,.13,.85,.061,'triangle')
    tone(returning ? 670 : 810,returning ? 805 : 610,1.04,.14,.032,'sine')
    const buffer = context.createBuffer(1,Math.ceil(context.sampleRate*.42),context.sampleRate)
    const data = buffer.getChannelData(0)
    for(let i=0;i<data.length;i++) data[i]=(Math.random()*2-1)*Math.sin(Math.PI*i/data.length)**2
    const wind=context.createBufferSource(), filter=context.createBiquadFilter(), gain=context.createGain()
    wind.buffer=buffer
    filter.type='bandpass'
    const at=start+(returning ? .13 : .59)
    filter.frequency.setValueAtTime(returning ? 510 : 1620,at)
    filter.frequency.exponentialRampToValueAtTime(returning ? 1620 : 460,at+.42)
    gain.gain.value=.12
    wind.connect(filter).connect(gain).connect(effects)
    wind.onended=()=>{wind.disconnect();filter.disconnect();gain.disconnect()}
    wind.start(at)
    const stop = () => {
      if (stopPass.current !== stop) return
      stopPass.current=null
      effects.disconnect()
    }
    stopPass.current=stop
    return stop
  }, [])

  async function toggle() {
    const ticket = ++generation.current
    setError(false)
    if (active.current) {
      stopPass.current?.()
      active.current = false
      const bus = mixer.current
      if (bus) {
        bus.master.gain.cancelScheduledValues(bus.context.currentTime)
        bus.master.gain.setValueAtTime(0, bus.context.currentTime)
      }
      rememberMuted(true)
      setEnabled(false)
      return
    }
    try {
      active.current = true
      setEnabled(true)
      const bus = mixer.current ??= createMixer()
      bus.master.gain.cancelScheduledValues(bus.context.currentTime)
      bus.master.gain.setTargetAtTime(level.current, bus.context.currentTime, .035)
      await bus.context.resume()
      if (generation.current === ticket) {
        rememberMuted(false)
        cue('confirmed')
      }
    } catch {
      if (generation.current !== ticket) return
      active.current = false
      setEnabled(false)
      setError(true)
    }
  }

  function adjust(value: number) {
    setVolume(value)
    level.current = value
    const bus = mixer.current
    if (bus && active.current) bus.master.gain.setTargetAtTime(value, bus.context.currentTime, 0.035)
    try { localStorage.setItem('delta.masterVolume', String(value)) } catch { /* Session setting still applies. */ }
  }
  useEffect(() => {
    let muted = false
    try { muted = localStorage.getItem('delta.muted') === 'true' } catch { /* Use the low default. */ }
    active.current = !muted
    setEnabled(!muted)
    return () => {
      stopPass.current?.()
      generation.current++
      active.current = false
      if (mixer.current) void mixer.current.context.close()
      mixer.current = null
    }
  }, [])
  return { enabled, volume, error, toggle, adjust, cue, pass }
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
