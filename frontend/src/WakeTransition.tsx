import { useLayoutEffect, useRef } from 'react'
import { circuits } from './Archive'
import { startTypeMotion } from './type-motion'

type Emission = { shot: number; now: number; trails?: number[][][]; ownership:number; dpr:number; receive?:(row:number,points:number[][],opacity:number)=>void }

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

export type ContourGroup = { element: Element; rect: DOMRect; sides: DOMPoint[][]; panel: boolean }

// Keep the actual crossings at the viewport edges, without inventing a border
// across the clipped portion of a tall panel.
function visibleArcs(points: DOMPoint[]) {
  const arcs: DOMPoint[][] = []
  let arc: DOMPoint[] | undefined
  for (let i=1; i<points.length; i++) {
    const a=points[i-1], b=points[i], dy=b.y-a.y
    if (Math.max(a.y,b.y)<0 || Math.min(a.y,b.y)>innerHeight) { arc=undefined; continue }
    const edge = (p:DOMPoint) => {
      if (p.y>=0 && p.y<=innerHeight) return p
      const y=Math.max(0, Math.min(innerHeight,p.y))
      return new DOMPoint(a.x+(b.x-a.x)*(y-a.y)/dy,y)
    }
    if (!arc) { arc=[edge(a)]; arcs.push(arc) }
    arc.push(edge(b))
    if (b.y<0 || b.y>innerHeight) arc=undefined
  }
  return arcs
}

export function measurePage(page: Element, includeControls = false) {
  const groups: ContourGroup[] = []
  function addPanel(panel: HTMLElement) {
    const rect = panel.getBoundingClientRect()
    if (rect.width && rect.height && rect.top < innerHeight && rect.bottom > 0)
      groups.push({element:panel, rect, sides:panelSides(panel, rect), panel:true})
  }
  page.querySelectorAll<HTMLElement>('.method-grid article').forEach(addPanel)
  page.querySelectorAll<HTMLElement>('[data-venue]').forEach(card => {
    const outline = card.querySelector<SVGSVGElement>('.outline')
    const matrix = outline?.getScreenCTM()
    const circuit = circuits[card.dataset.venue ?? '']
    const rect = card.getBoundingClientRect()
    if (!outline || !matrix || !circuit || !card.closest('.session-card')) {
      // A session without a mapped circuit can still contribute its real card border.
      const panel = includeControls && card.closest<HTMLElement>('.session-card')
      if (panel) addPanel(panel)
      return
    }
    if (rect.top >= innerHeight || rect.bottom < 0) return
    const points = [...circuit.points,circuit.points[0]].map(([x,y]) => new DOMPoint(x,y).matrixTransform(matrix))
    groups.push({element:outline, rect, sides:[points], panel:false})
  })
  // An empty search or offline archive still has real bordered controls.
  if (includeControls)
    page.querySelectorAll<HTMLElement>('.trace,.circuit-view,.timing-panel,.driver-controls,.limitations').forEach(addPanel)
  if (includeControls && !groups.length)
    page.querySelectorAll<HTMLElement>('.session-card,.search,.filter,.notice,.loading-view,.pending-card,.empty,.workspace-intro').forEach(addPanel)
  return groups.filter(group => {
    if (group.rect.top < 0 || group.rect.bottom > innerHeight)
      group.sides = group.sides.flatMap(visibleArcs)
    return group.sides.length > 0
  })
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

type InkSample = (x:number,y:number)=>void
function animateWake(svg: SVGSVGElement, returning: boolean, captured: ContourGroup[], sample:InkSample) {
  const strands: {path: SVGPathElement; particles: Particle[]; lane: number; trail: number; last: number}[] = []
  const arrivals: Animation[] = []
  const returnWidth = parseFloat(getComputedStyle(svg).strokeWidth)*.77
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
      strands.push({path,particles,lane,trail:(returning ? i : i*3+1)%trailCount,last:0})
      return i
    }

    const page = svg.parentElement?.querySelector('.route-body')
    if (!page) return
    for (const {element, rect, sides, panel} of returning ? captured : measurePage(page,true)) {
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
          delay:delay-(element.matches('.method-grid article') ? 440 : 210), duration:end-start+305, easing:'ease-out', fill:'both',
        }))
      }
      const frames = panel
        ? [{borderColor:'transparent'}, {borderColor:getComputedStyle(element).borderTopColor}]
        : [{opacity:0}, {opacity:1}]
      arrivals.push(element.animate(returning ? frames.reverse() : frames, {
        delay:panel || returning ? delay : Math.max(0,delay),
        duration:end-start+(returning ? 100 : 145), fill:'both',
      }))
    }
  }
  function emit(event: Event) {
    const {shot,now,trails,ownership,dpr,receive} = (event as CustomEvent<Emission>).detail
    const elapsed = now - shot
    if (!strands.length && trails) bind(shot,now,trails.length)
    strands.forEach(({path,particles,lane,trail,last},i) => {
      const vertices: string[] = []
      const screenPoints:number[][] = []
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
        // Zip onto the moving stream from its downstream tip. Once a section
        // attaches it has the stream's position and velocity on every frame.
        const attach = returning ? smooth((elapsed-releaseDelay(i,lane)*.35-65-(1-u)*210)/345) : 0
        const loose = 1-attach
        let x=freeX+loose*((p.destX-freeX)*(pull+recoil)+slack*curl)
        let y=freeY+loose*((p.destY-freeY)*(pull+recoil)+slack*bend)
        if (returning && trails) {
          // Keep the upstream tail in shot while its downstream end rides the
          // car. Extend along the inlet tangent, with no kink at the join.
          const [inlet,next]=trails[trail]
          const dx=inlet[0]-next[0], dy=inlet[1]-next[1]
          const length=Math.hypot(dx,dy) || 1
          const tail=Math.max(0,inlet[0]-innerWidth*.34)*Math.pow(1-u,4)*
            attach*(1-smooth((elapsed-790)/330))
          x+=dx/length*tail
          y+=dy/length*tail
        }
        vertices.push((j?'L':'M')+x.toFixed(1)+' '+y.toFixed(1))
        if(j===Math.floor(particles.length/2) || j===0) sample(x+originX,y+originY)
        if(receive) screenPoints.push([x+originX,y+originY])
      })
      strands[i].last=now
      path.setAttribute('d',vertices.join(' '))
      const outlineMix = returning
        ? smooth((elapsed - releaseDelay(i, lane)) / 100)
        : 1 - smooth((ms - lock) / 145)
      const opacity=(.52+.25*smooth((ms-630)/180))*outlineMix
      if(returning && receive) {
        const taper=smooth((elapsed-200)/350)
        path.style.strokeWidth=String(returnWidth+(.88/dpr-returnWidth)*taper)
        if(i<(trails?.length ?? 0)) receive(trail,screenPoints,opacity)
        path.style.opacity=String(opacity*(1-ownership))
      } else path.style.opacity=String(smooth((ms-300)/165)*opacity)
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
      const slice = points.slice(Math.round(j*end/pieces), Math.round((j+1)*end/pieces)+1)
      return slice.length>=2 ? slice : [pointAt(points,j/pieces),pointAt(points,(j+1)/pieces)]
    })
  })
}

function pointAt(points: DOMPoint[], fraction: number) {
  const t = fraction*(points.length-1)
  const a = points[Math.floor(t)], b = points[Math.ceil(t)]
  return new DOMPoint(a.x+(b.x-a.x)*(t%1), a.y+(b.y-a.y)*(t%1))
}

function transferWake(svg: SVGSVGElement, shot: number, from: ContourGroup[], sample:InkSample) {
  let frame = 0
  const animations: Animation[] = []
  function begin(now: number) {
    const root = svg.parentElement!
    const outgoing = root.querySelector('.route-outgoing')!
    const incoming = root.querySelector('.route-body')!
    const to = measurePage(incoming,true)
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
          if(j===Math.floor(vertices.length/2) || j===0) sample(x+origin.left,y+origin.top)
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

export function WakeHandoff({ direction, start, captured }: { direction: 'launch' | 'return' | 'transfer'; start: number; captured: ContourGroup[] }) {
  const layer = useRef<SVGSVGElement>(null)
  useLayoutEffect(() => {
    const svg=layer.current!
    const ink=startTypeMotion(svg.parentElement!,direction,start)
    const stop=direction === 'transfer' ? transferWake(svg,start,captured,ink.sample) : animateWake(svg,direction === 'return',captured,ink.sample)
    return () => { stop(); ink.finishFlight() }
  },[direction,start,captured])
  return <svg ref={layer} className="circuit-handoff" fill="none" stroke="#d5dadb" strokeWidth="1.28" strokeLinejoin="round" aria-hidden="true" />
}
