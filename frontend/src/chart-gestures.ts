export type Domain = [number, number]
export type ChartControls = {
  domain: Domain
  full: Domain
  pan: boolean
  scrub: (percent: number) => void
  zoom: (range: Domain) => void
  pause: () => void
}

export function nearest(values: number[], value: number) {
  let lo = 0, hi = values.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (values[mid] < value) lo = mid + 1
    else hi = mid
  }
  return lo && value-values[lo-1] < values[lo]-value ? lo-1 : lo
}

export function bindChartGestures(surface: HTMLElement, read: () => ChartControls) {
  const pointers = new Map<number,number>()
  let mode: 'scrub' | 'select' | 'pan' | 'pinch' = 'scrub'
  let start = 0, span = 0, initial: Domain = [0,100]
  const selection = document.createElement('i')
  selection.className = 'trace-selection'
  surface.append(selection)
  function position(e: MouseEvent) {
    const bounds = surface.getBoundingClientRect()
    return Math.max(0,Math.min(1,(e.clientX-bounds.left)/bounds.width))
  }
  function value(x: number, domain: Domain) { return domain[0]+x*(domain[1]-domain[0]) }
  function down(e: PointerEvent) {
    if (e.button !== 0) return
    const c = read()
    c.pause()
    const x = position(e)
    pointers.set(e.pointerId,x)
    surface.setPointerCapture(e.pointerId)
    initial = c.domain
    if (pointers.size === 2) {
      const [a,b] = pointers.values()
      start=(a+b)/2; span=Math.max(.01,Math.abs(a-b)); mode='pinch'
      selection.hidden=true
    } else if (pointers.size === 1) {
      start=x
      mode=c.pan || e.shiftKey ? 'pan' : e.pointerType==='touch' ? 'scrub' : 'select'
      c.scrub(value(x,initial))
    }
  }
  function move(e: PointerEvent) {
    const c=read(), x=position(e)
    if (!pointers.size) { if (e.pointerType!=='touch') c.scrub(value(x,c.domain)); return }
    if (!pointers.has(e.pointerId)) return
    pointers.set(e.pointerId,x)
    if (mode==='pinch' && pointers.size===2) {
      const [a,b]=pointers.values()
      const width=(initial[1]-initial[0])*span/Math.max(.01,Math.abs(a-b))
      const left=value(start,initial)-(a+b)*width/2
      c.zoom([left,left+width])
    } else if (mode==='pan') {
      const shift=(start-x)*(initial[1]-initial[0])
      c.zoom([initial[0]+shift,initial[1]+shift])
    } else if (mode!=='pinch') {
      c.scrub(value(x,initial))
      if (mode==='select') {
        selection.hidden=false
        selection.style.left=Math.min(start,x)*100+'%'
        selection.style.width=Math.abs(x-start)*100+'%'
      }
    }
  }
  function end(e: PointerEvent) {
    if (!pointers.delete(e.pointerId)) return
    const x=position(e)
    if (e.type==='pointerup' && mode==='select' && Math.abs(x-start)*surface.clientWidth>7)
      read().zoom([value(Math.min(start,x),initial),value(Math.max(start,x),initial)])
    selection.hidden=true
    if (pointers.size===1) {
      start=[...pointers.values()][0]; initial=read().domain; mode='pan'
    }
  }
  function wheel(e: WheelEvent) {
    e.preventDefault()
    const c=read(), x=position(e), anchor=value(x,c.domain)
    const delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?surface.clientHeight:1)
    const width=(c.domain[1]-c.domain[0])*Math.exp(Math.max(-1,Math.min(1,delta*.003)))
    c.scrub(anchor)
    c.zoom([anchor-x*width,anchor+(1-x)*width])
  }
  const reset=()=>read().zoom(read().full)
  const controller=new AbortController()
  const options={signal:controller.signal}
  surface.addEventListener('pointerdown',down,options)
  surface.addEventListener('pointermove',move,options)
  surface.addEventListener('pointerup',end,options)
  surface.addEventListener('pointercancel',end,options)
  surface.addEventListener('wheel',wheel,{...options,passive:false})
  surface.addEventListener('dblclick',reset,options)
  return ()=>{controller.abort();selection.remove()}
}
