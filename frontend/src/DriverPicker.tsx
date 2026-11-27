import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import type { Driver } from './api'
import './driver-picker.css'

const portraits = import.meta.glob<string>('./driver-portraits/*.webp', {
  eager: true, query: '?url&no-inline', import: 'default',
})
const unavailable = new Set<string>()
const normalize = (text: string) => text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

function DriverIdentity({ driver }: { driver: Driver }) {
  const nameKey = normalize(driver.full_name).replace(/[^a-z0-9]/g, '')
  const url = portraits[`./driver-portraits/${driver.driver_code.toLowerCase()}-${nameKey}.webp`]
  const [failed, setFailed] = useState('')
  const initials = driver.full_name.trim().split(/\s+/).map(word => word[0]).filter((_, i, words) => i === 0 || i === words.length - 1).join('')
  return <>
    <span className="driver-photo" aria-hidden="true">
      {url && url !== failed && !unavailable.has(url)
        ? <img src={url} alt="" draggable={false} onError={() => { unavailable.add(url); setFailed(url) }} />
        : <span>{initials}</span>}
    </span>
    <span className="driver-identity"><b>{driver.driver_code}</b><span>{driver.full_name}</span></span>
  </>
}

type Props = { side: 'Reference' | 'Comparison'; drivers: Driver[]; code: string; onChange: (code: string) => void }

export default function DriverPicker({ side, drivers, code, onChange }: Props) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number; above: boolean } | null>(null)
  const search = useRef({ prefix: '', time: 0 })
  const selected = drivers.findIndex(driver => driver.driver_code === code)
  const theme = side === 'Reference' ? 'reference' : 'comparison'
  const show = (index = Math.max(0, selected)) => { setActive(index); setOpen(true) }
  const choose = (index: number) => {
    if (drivers[index]) onChange(drivers[index].driver_code)
    setOpen(false)
    trigger.current?.focus({ preventScroll: true })
  }

  useLayoutEffect(() => {
    if (!open) return
    function place() {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const viewport = window.visualViewport
      const left = viewport?.offsetLeft ?? 0
      const top = viewport?.offsetTop ?? 0
      const right = left + (viewport?.width ?? document.documentElement.clientWidth)
      const bottom = top + (viewport?.height ?? window.innerHeight)
      const below = bottom - rect.bottom - 12
      const above = rect.top - top - 12
      if (rect.bottom < top || rect.top > bottom) { setOpen(false); return }
      const flip = below < Math.min(296, drivers.length * 46 + 10) && above > below
      const width = Math.min(Math.max(230, rect.width), right - left - 16)
      setPosition({ left: Math.max(left + 8, Math.min(rect.left, right - width - 8)),
        top: flip ? rect.top - 4 : rect.bottom + 4, width,
        maxHeight: Math.max(0, Math.min(296, flip ? above : below)), above: flip })
    }
    function scroll(event: Event) {
      if (!(event.target instanceof Node && list.current?.contains(event.target))) place()
    }
    place()
    window.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', place)
    window.visualViewport?.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', place)
      window.visualViewport?.removeEventListener('resize', place)
    }
  }, [open, drivers.length])

  useLayoutEffect(() => {
    if (!open || !position || !list.current) return
    const element = list.current.children[active] as HTMLElement | undefined
    if (!element) return
    const panel = list.current
    if (element.offsetTop < panel.scrollTop) panel.scrollTop = element.offsetTop
    else if (element.offsetTop + element.offsetHeight > panel.scrollTop + panel.clientHeight)
      panel.scrollTop = element.offsetTop + element.offsetHeight - panel.clientHeight
  }, [open, position, active])

  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !list.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss, true)
    return () => document.removeEventListener('pointerdown', dismiss, true)
  }, [open])

  function keyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const last = drivers.length - 1
    switch (event.key) {
      case 'Tab': setOpen(false); return
      case 'Escape': if (!open) return; event.stopPropagation(); setOpen(false); break
      case 'ArrowDown': open ? setActive(Math.min(last, active + 1)) : show(); break
      case 'ArrowUp': open ? setActive(Math.max(0, active - 1)) : show(); break
      case 'Home': show(0); break
      case 'End': show(last); break
      case ' ': case 'Enter': open ? choose(active) : show(); break
      default: {
        if (event.key.length !== 1) return
        const now = performance.now()
        const key = normalize(event.key)
        const prefix = now - search.current.time < 650 ? search.current.prefix + key : key
        search.current = { prefix, time: now }
        const repeated = [...prefix].every(char => char === key)
        const start = open ? active : Math.max(0, selected)
        for (let step = 0; step < drivers.length; step++) {
          const i = (start + step + Number(repeated)) % drivers.length
          const words = normalize(drivers[i].full_name).split(/\s+/)
          if ([normalize(drivers[i].driver_code), ...words].some(word => word.startsWith(repeated ? key : prefix))) { show(i); break }
        }
      }
    }
    event.preventDefault()
  }

  return <div className="driver-field">
    <label htmlFor={id}>Driver</label>
    <button type="button" ref={trigger} id={id} className={`driver-trigger ${theme}`}
      role="combobox" aria-label={side + ' driver'} aria-haspopup="listbox" aria-expanded={open}
      aria-controls={position ? id + '-list' : undefined} aria-activedescendant={open ? id + '-' + active : undefined}
      disabled={!drivers.length} onKeyDown={keyDown} onBlur={() => setOpen(false)}
      onClick={() => open ? setOpen(false) : show()}>
      {selected >= 0 ? <DriverIdentity driver={drivers[selected]} /> : <span>{drivers.length ? 'Select driver' : 'No drivers available'}</span>}
      <ChevronDown size={14} aria-hidden="true" />
    </button>
    {position && createPortal(<div ref={list} id={id + '-list'} role="listbox" aria-label={side + ' driver'}
      aria-hidden={!open} inert={!open} data-open={open} data-above={position.above} className={`driver-list ${theme}`}
      style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight }}>
      {drivers.map((driver, index) => <div key={driver.driver_code} id={id + '-' + index} role="option"
        aria-selected={index === selected} data-active={index === active}
        onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}>
        <DriverIdentity driver={driver} />
        {index === selected && <Check size={14} aria-hidden="true" />}
      </div>)}
    </div>, document.body)}
  </div>
}

