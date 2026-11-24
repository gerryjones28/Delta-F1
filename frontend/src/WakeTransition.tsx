import { useLayoutEffect, useRef } from 'react'
import { circuits } from './Archive'

type Emission = { shot: number; now: number; trails?: number[][][] }

type Particle = {
  x: number; y: number; vx: number; vy: number
  destX: number; destY: number; released: number
}

function smooth(value: number) {
  const t = Math.max(0, Math.min(1, value))
  return t*t*(3-2*t)
}

// Separate the near and far edges of the grid without holding the entire grid still.
function releaseDelay(index: number, lane: number) {
  return lane * 45 + (index % 4) * 23
}

function captureTime(index: number, lane: number) {
  return 1450 + lane * 125 + (index % 4) * 33
}

// Trace each side from the top midpoint to the bottom midpoint. These coordinates
// follow the center of the CSS border in viewport pixels, including its corner radius.
function panelSides(panel: HTMLElement, rect: DOMRect) {
  const style = getComputedStyle(panel)
  const inset = parseFloat(style.borderTopWidth) / 2
  const radius = Math.max(0, parseFloat(style.borderTopLeftRadius) - inset)
  const top = rect.top + inset, bottom = rect.bottom - inset
  const middle = rect.left + rect.width / 2
  const curve = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  return [-1, 1].map(side => {
    const edge = side < 0 ? rect.left + inset : rect.right - inset
    const tangent = edge - side * radius
    const sweep = side < 0 ? 0 : 1
    curve.setAttribute('d', `M ${middle} ${top} H ${tangent} A ${radius} ${radius} 0 0 ${sweep} ${edge} ${top+radius}
      V ${bottom-radius} A ${radius} ${radius} 0 0 ${sweep} ${tangent} ${bottom} H ${middle}`)
    const length = curve.getTotalLength()
    const segments = Math.min(220, Math.max(32, Math.ceil(length / 5)))
    return Array.from({length:segments+1}, (_, i) => curve.getPointAtLength(i * length / segments))
  })
}

type ContourGroup = { element: Element; rect: DOMRect; sides: DOMPoint[][]; panel: boolean; info?: Element | null }

function measurePage(page: Element, includeControls = false) {
  const groups: ContourGroup[] = []
  function addPanel(panel: HTMLElement) {
    const rect = panel.getBoundingClientRect()
    if (rect.width && rect.top < innerHeight && rect.bottom > 0)
      groups.push({element:panel, rect, sides:panelSides(panel, rect), panel:true})
  }
  page.querySelectorAll<HTMLElement>('.method-grid article').forEach(addPanel)
  page.querySelectorAll<HTMLElement>('[data-venue]').forEach(card => {
    const outline = card.querySelector<SVGSVGElement>('.outline')
    const matrix = outline?.getScreenCTM()
    const circuit = circuits[card.dataset.venue ?? '']
    const rect = card.getBoundingClientRect()
    if (!outline || !matrix || !circuit || rect.top >= innerHeight || rect.bottom < 0) return
    const points = [...circuit.points,circuit.points[0]].map(([x,y]) => new DOMPoint(x,y).matrixTransform(matrix))
    groups.push({element:outline, rect, sides:[points], panel:false, info:card.parentElement?.querySelector('.card-info')})
  })
  // An empty search or offline archive still has real bordered controls.
  if (includeControls && !groups.length)
    page.querySelectorAll<HTMLElement>('.search,.filter,.timing-panel,.driver-controls,.notice').forEach(addPanel)
  return groups
}

function wavePhase(u: number, ms: number, i: number, seed: number) {
  return 12*u-ms*(.011+(i%3)*.001)+seed+1.45*Math.sin(5*u+ms*.004+seed)
}

function waveX(phase: number, u: number, ms: number, seed: number) {
  return Math.cos(phase*.92)+.46*Math.sin(8*u-ms*.008+seed)
}

function waveY(phase: number, ms: number) {
  return Math.sin(phase)+.37*Math.sin(2.2*phase+ms*.003)
}

function animateWake(svg: SVGSVGElement, returning: boolean) {
  const strands: {path: SVGPathElement; particles: Particle[]; lane: number; trail: number; last: number}[] = []
  const arrivals: Animation[] = []
  let originX = 0, originY = 0, reach = 0

  function bind(shot: number, now: number, trailCount: number) {
    const origin = svg.getBoundingClientRect()
    originX = origin.left
    originY = origin.top
    reach = Math.min(52, origin.width*.078)
    function addStrand(points: DOMPoint[], lane: number) {
      const particles = points.map(point => ({
        x:0, y:0, vx:0, vy:0, released:0,
        destX:point.x-originX, destY:point.y-originY,
      }))
      const path = document.createElementNS('http://www.w3.org/2000/svg','path')
      svg.appendChild(path)
      const i = strands.length
      strands.push({path,particles,lane,trail:(i*3+1)%trailCount,last:0})
      return i
    }

    const page = svg.parentElement?.querySelector('.route-body')
    if (!page) return
    for (const {element, rect, sides, panel, info} of measurePage(page)) {
      const timings = sides.map((points, side) => {
        const fraction = panel ? (side ? .75 : .25) : .5
        const lane = (rect.left - originX + rect.width*fraction) / origin.width
        const i = addStrand(points, lane)
        return returning ? releaseDelay(i, lane) : captureTime(i, lane)
      })
      const start = Math.min(...timings)
      const end = Math.max(...timings)
      const delay = shot - now + start
      if (panel && !returning) {
        arrivals.push(element.animate([{opacity:0}, {opacity:1}], {
          delay:delay-210, duration:end-start+305, easing:'ease-out', fill:'both',
        }))
      }
      const frames = panel
        ? [{borderColor:'transparent'}, {borderColor:getComputedStyle(element).borderTopColor}]
        : [{opacity:0}, {opacity:1}]
      arrivals.push(element.animate(returning ? frames.reverse() : frames, {
        delay:panel || returning ? delay : Math.max(0,delay),
        duration:end-start+(returning ? 100 : 145), fill:'both',
      }))
      if (!returning && info)
        arrivals.push(info.animate([{opacity:0},{opacity:1}],{delay:Math.max(0,delay)-35,duration:170,fill:'both'}))
    }
  }
  function emit(event: Event) {
    const {shot,now,trails} = (event as CustomEvent<Emission>).detail
    const elapsed = now - shot
    if (!strands.length && trails) bind(shot,now,trails.length)
    strands.forEach(({path,particles,lane,trail,last},i) => {
      const vertices: string[] = []
      const lock = captureTime(i,lane)
      // Run the same capture and turbulence envelopes backward. Attachment still uses
      // the current car and camera, so its velocity at the join is the live velocity.
      const ms = returning ? lock + 25 + releaseDelay(i, lane) - elapsed : elapsed
      const seed = i*2.39996
      particles.forEach((p,j) => {
        const u = j/(particles.length-1)
        const release = 635+(i%4)*19+(1-u)*78
        if (trails && (returning || !p.released)) {
          const knots = trails[trail], pos = u*(knots.length-1)
          const a = knots[Math.floor(pos)], b = knots[Math.ceil(pos)], f = pos%1
          const x = a[0]+(b[0]-a[0])*f-originX, y = a[1]+(b[1]-a[1])*f-originY
          if (!returning && last) { p.vx=(x-p.x)/Math.max(1,now-last); p.vy=(y-p.y)/Math.max(1,now-last) }
          p.x=x; p.y=y
          if (!returning && ms>=release) p.released=now
        } else if (!returning && !p.released && last) {
          // A slow render can skip the last attached frame.
          p.released=last
        }
        // Integrated exponential drag starts at the measured release velocity.
        const coast = p.released ? -68*Math.expm1(-(now-p.released)/68) : 0
        const freeX=p.x+p.vx*coast, freeY=p.y+p.vy*coast
        const capture=900+lane*83+(i%3)*43+(1-u)*104
        const pull=smooth((ms-capture)/(lock-capture))
        const phase=wavePhase(u,ms,i,seed)
        const slack=reach*smooth((ms-310)/430)*Math.pow(1-pull,1.35)*(.20+.8*u+.8*smooth((ms-release)/210)*(1-u))
        const bend=waveY(phase,ms)
        const curl=waveX(phase,u,ms,seed)
        const recoilLimit = Math.min(.012, 4/Math.max(1, Math.hypot(p.destX-freeX,p.destY-freeY)))
        const recoil=i%3===1 ? 0 : recoilLimit*Math.sin(Math.PI*smooth((ms-lock+100)/160))
        const x=freeX+(p.destX-freeX)*(pull+recoil)+slack*curl
        const y=freeY+(p.destY-freeY)*(pull+recoil)+slack*bend
        vertices.push((j?'L':'M')+x.toFixed(1)+' '+y.toFixed(1))
      })
      strands[i].last=now
      path.setAttribute('d',vertices.join(' '))
      const outlineMix = returning
        ? smooth((elapsed - releaseDelay(i, lane)) / 100)
        : 1 - smooth((ms - lock) / 145)
      path.style.opacity=String(smooth((ms-300)/165)*(.52+.25*smooth((ms-630)/180))*outlineMix)
    })
  }
  window.addEventListener('studio-emission',emit)
  return () => {
    window.removeEventListener('studio-emission',emit)
    arrivals.forEach(animation=>animation.cancel())
    strands.forEach(strand=>strand.path.remove())
  }
}

// Split longer outlines into adjoining arcs when the two pages have different
// counts. Every piece starts and ends on real geometry, even in a single column.
function divideContours(groups: ContourGroup[], count: number) {
  const contours = groups.flatMap(group => group.sides)
  return contours.flatMap((points, i) => {
    const pieces = Math.floor((i+1)*count/contours.length) - Math.floor(i*count/contours.length)
    return Array.from({length:pieces}, (_, j) => {
      const end = points.length-1
      return points.slice(Math.round(j*end/pieces), Math.round((j+1)*end/pieces)+1)
    })
  })
}

function pointAt(points: DOMPoint[], fraction: number) {
  const t = fraction*(points.length-1)
  const a = points[Math.floor(t)], b = points[Math.ceil(t)]
  return new DOMPoint(a.x+(b.x-a.x)*(t%1), a.y+(b.y-a.y)*(t%1))
}

function transferWake(svg: SVGSVGElement, shot: number) {
  let frame = 0
  const animations: Animation[] = []
  function begin(now: number) {
    const root = svg.parentElement!
    const outgoing = root.querySelector('.route-outgoing')!
    const incoming = root.querySelector('.route-body')!
    const from = measurePage(outgoing,true), to = measurePage(incoming,true)
    if (!from.length || !to.length) {
      // A lazy comparison view can mount just after the navigation commit.
      if (now-shot < 400) frame = requestAnimationFrame(begin)
      return
    }
    const origin = svg.getBoundingClientRect()
    const count = Math.max(...[from,to].map(groups => groups.reduce((sum,g) => sum+g.sides.length,0)))
    const source = divideContours(from,count), destination = divideContours(to,count)
    const sign = outgoing.querySelector('.method-grid') ? -1 : 1
    for (const [groups,departing] of [[from,true], [to,false]] as const) {
      for (const {element,panel} of groups) {
        const frames = panel
          ? [{borderColor:'transparent'}, {borderColor:getComputedStyle(element).borderTopColor}]
          : [{opacity:0}, {opacity:1}]
        animations.push(element.animate(departing ? frames.reverse() : frames, {
          delay:shot-now+(departing ? 20 : 1030), duration:departing ? 180 : 260, fill:'both',
        }))
      }
    }
    const strands = source.map((points,i) => {
      const target = destination[i]
      // Include the original vertices of both shapes to retain corners at each end.
      const fractions = [...new Set([...points.map((_,j)=>j/(points.length-1)),
        ...target.map((_,j)=>j/(target.length-1))])].sort((a,b)=>a-b)
      const vertices = fractions.map(u => ({u, a:pointAt(points,u), b:pointAt(target,u)}))
      const lane = (points[0].x-origin.left)/origin.width
      const path = document.createElementNS('http://www.w3.org/2000/svg','path')
      svg.appendChild(path)
      return {path,vertices,delay:releaseDelay(i,lane), lane}
    })
    const reach = Math.min(52,origin.width*.078)
    function draw(now: number) {
      const ms = now-shot
      strands.forEach(({path,vertices,delay,lane},i) => {
        const seed = i*2.39996
        const arrival = 1030 + lane*82 + (i%4)*39
        const d = vertices.map(({u,a,b},j) => {
          const release = delay + 82*(1-u)
          const t = smooth((ms-release)/(arrival+70*u-release))
          const loose = 4*t*(1-t)
          const phase = wavePhase(u,ms,i,seed)
          const x = a.x+(b.x-a.x)*t-origin.left + loose*reach*(sign*1.6+waveX(phase,u,ms,seed))
          const y = a.y+(b.y-a.y)*t-origin.top + loose*reach*waveY(phase,ms)
          return (j?'L':'M')+x.toFixed(1)+' '+y.toFixed(1)
        })
        path.setAttribute('d',d.join(' '))
        path.style.opacity=String(.77*smooth((ms-delay+65)/150)*(1-smooth((ms-arrival-70)/125)))
      })
      if (ms < 1420) frame = requestAnimationFrame(draw)
    }
    draw(now)
  }
  // Measure after the router restores the destination scroll position.
  frame = requestAnimationFrame(begin)
  return () => {
    cancelAnimationFrame(frame)
    animations.forEach(animation=>animation.cancel())
    svg.replaceChildren()
  }
}

export function WakeHandoff({ direction, start }: { direction: 'launch' | 'return' | 'transfer'; start: number }) {
  const layer = useRef<SVGSVGElement>(null)
  useLayoutEffect(() => {
    return direction === 'transfer' ? transferWake(layer.current!,start) : animateWake(layer.current!,direction === 'return')
  },[direction,start])
  return <svg ref={layer} className="circuit-handoff" fill="none" stroke="#d5dadb" strokeWidth="1.28" strokeLinejoin="round" aria-hidden="true" />
}
