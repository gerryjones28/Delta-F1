// The blue channel stores when each piece of ink arrives. Red and green give
// its displacement. The map is made once per heading, never once per frame.
function makeField(bounds: DOMRect, ink: DOMRect, reverse: boolean, lines: DOMRect[]) {
  const canvas = document.createElement('canvas')
  canvas.width = 192
  canvas.height = Math.max(12, Math.min(96, Math.round(192 * bounds.height / bounds.width)))
  const ctx = canvas.getContext('2d')!
  const image = ctx.createImageData(canvas.width, canvas.height)
  const grain = Math.max(2, Math.min(4.5, ink.height / 16))
  for (let y=0; y<canvas.height; y++) {
    const screenY = bounds.top + (y+.5)/canvas.height*bounds.height
    const line = lines.length>1 ? lines.findIndex(r=>screenY<=r.bottom) : 0
    const row = line<0 ? lines.length-1 : line
    const lineRect = lines[row] ?? ink
    for (let x=0; x<canvas.width; x++) {
      const px = bounds.left + (x+.5)/canvas.width*bounds.width - ink.left
      const py = bounds.top + (y+.5)/canvas.height*bounds.height - ink.top
      const band = Math.floor((py + .055*px + grain*.6*Math.sin(px/77))/grain)
      const phase = Math.sin(band*17.19+2.4)
      const tile = Math.floor(px/(grain*6.5) + phase)
      const chip = Math.sin(tile*16.71 + band*7.13)
      const fraction = (px+ink.left-lineRect.left)/Math.max(1,lineRect.width)
      const across = reverse ? 1-fraction : fraction
      const sweep = lines.length>1 ? .56*across+.44*row/(lines.length-1) : across
      const i = (y*canvas.width+x)*4
      image.data[i] = 128+(reverse?-1:1)*(42+68*phase+14*chip)
      image.data[i+1] = 117+22*Math.min(1,Math.max(0,py/ink.height))
      image.data[i+2] = 255*Math.min(.97,Math.max(.03,.18+.64*sweep+.12*phase+.065*chip))
      image.data[i+3] = 255
    }
  }
  ctx.putImageData(image,0,0)
  return canvas.toDataURL()
}

type Shot = 'intro' | 'launch' | 'return' | 'transfer' | 'read'
const ns = 'http://www.w3.org/2000/svg'
let sequence = 0
const headings = 'h1,.section-head h2,.method-grid h2,.card-info h3,.pair-header h2,.traces > h2'
const pageCopy = ['.method-grid p','.method-grid a','.full-archive .section-label',
  '.full-archive .filter select','.full-archive .search input','.full-archive .archive-tools .muted',
  '.archive .country','.card-info h3','.card-info p','.card-meta','.card-stats > span',
  '.workspace-intro .section-label','.workspace-intro .venue','.session-facts > span','.full-archive .loading-signal',
  '.full-archive .empty','.full-archive .notice strong','.full-archive .notice p','.full-archive .notice button'].join(',')
const targets = headings+','+pageCopy
const presented = new WeakSet<Element>()

export function startTypeMotion(root: Element, shot: Shot, start: number, onDone?:()=>void) {
  const defs = document.createElementNS(ns,'svg')
  defs.setAttribute('aria-hidden','true')
  defs.style.cssText='position:absolute;width:0;height:0;pointer-events:none'
  const regions: {node:HTMLElement; filterStyle:string; rect:DOMRect; enter:boolean; delay:number; duration:number;
    solid:Element; edge:Element; shift:Element; distance:number; nearY:number; last:number; amplitude:number;
    proximity:number; lean:number; targetProximity:number; targetLean:number}[] = []
  const motion = matchMedia('(prefers-reduced-motion: reduce)')
  let frame=0
  let previous=start
  let disposed=false
  let finishing=false

  function collect(scope: Element | null, enter:boolean, delay:number, duration:number, reverse:boolean) {
    if (!scope) return
    const nodes = Array.from(scope.querySelectorAll<HTMLElement>(targets))
    if(scope instanceof HTMLElement && scope.matches(targets)) nodes.unshift(scope)
    for (const node of nodes) {
      if(shot==='read' && presented.has(node)) continue
      const bounds=node.getBoundingClientRect()
      if (!bounds.width || bounds.bottom<=0 || bounds.top>=innerHeight) continue
      const range=document.createRange()
      range.selectNodeContents(node)
      const ink=node.matches('input,select') ? bounds : range.getBoundingClientRect()
      if (!ink.width || !ink.height || regions.some(r=>r.node===node)) continue
      const id='ink-field-'+(++sequence)
      const filter=document.createElementNS(ns,'filter')
      filter.id=id
      filter.setAttribute('color-interpolation-filters','sRGB')
      // Wide section headings can occupy the full shell. Rasterize only the
      // ink and its travel margin, including italic overhang and ascenders.
      const box=new DOMRect(ink.left-18,ink.top-8,ink.width+36,ink.height+16)
      filter.setAttribute('x',String((box.left-bounds.left)/bounds.width))
      filter.setAttribute('y',String((box.top-bounds.top)/bounds.height))
      filter.setAttribute('width',String(box.width/bounds.width))
      filter.setAttribute('height',String(box.height/bounds.height))
      function primitive(tag:string, attrs:Record<string,string>) {
        const el=document.createElementNS(ns,tag)
        for (const [key,value] of Object.entries(attrs)) el.setAttribute(key,value)
        filter.append(el)
        return el
      }
      const prose=node.matches('.method-grid p')
      const lines=prose ? Array.from(range.getClientRects()).filter(r=>r.width>0) : []
      primitive('feImage',{href:makeField(box,ink,reverse,lines),preserveAspectRatio:'none',result:'field'})
      const solid=primitive('feColorMatrix',{in:'field',type:'matrix',result:'settled'})
      const edge=primitive('feColorMatrix',{in:'field',type:'matrix',result:'front'})
      primitive('feComposite',{in:'SourceGraphic',in2:'settled',operator:'in',result:'ink'})
      primitive('feComposite',{in:'front',in2:'settled',operator:'out',result:'seam'})
      primitive('feComposite',{in:'SourceGraphic',in2:'seam',operator:'in',result:'pieces'})
      const shift=primitive('feDisplacementMap',{in:'pieces',in2:'field',xChannelSelector:'R',yChannelSelector:'G',result:'shifted'})
      primitive('feComposite',{in:'ink',in2:'shifted',operator:'over'})
      defs.append(filter)
      const stagger=Math.min(110,Math.max(0,ink.top/innerHeight)*70+ink.left/innerWidth*45)
      const bodyCopy=node.matches(pageCopy)
      const panelArrival=enter && bodyCopy && (shot==='launch' || shot==='transfer')
      const detailDelay = enter && bodyCopy ? (node.matches('.card-stats > span,.method-grid a') ? 90 : node.matches('p') ? 52 : 12) : 0
      node.style.filter='url(#'+id+')'
      regions.push({node,filterStyle:node.style.filter,rect:ink,enter,delay:(panelArrival ? (shot==='launch' ? 1440 : 1000) : delay)+stagger+detailDelay,
        duration:panelArrival ? 680 : duration,solid,edge,shift,
        distance:Infinity,nearY:ink.top,last:-1,amplitude:bodyCopy ? (prose ? 16 : 12) : Math.min(23,Math.max(7,ink.height*.26)),
        proximity:0,lean:0,targetProximity:0,targetLean:0})
      if(enter) presented.add(node)
    }
  }
  function dispose() {
    if(disposed) return
    disposed=true
    cancelAnimationFrame(frame)
    regions.forEach(r=>{ if(r.node.style.filter===r.filterStyle) r.node.style.removeProperty('filter') })
    defs.remove()
    motion.removeEventListener('change',dispose)
    onDone?.()
  }
  // Wake vertices are already in viewport coordinates. Nearby ink catches the
  // advancing front earlier. Progress stays monotonic as a strand moves away.
  function sample(x:number,y:number) {
    for (const r of regions) {
      if (r.last===1) continue
      const dx=Math.max(r.rect.left-x,0,x-r.rect.right)
      const dy=Math.max(r.rect.top-y,0,y-r.rect.bottom)
      const distance=dx*dx+dy*dy
      if(distance<r.distance) { r.distance=distance; r.nearY=y }
    }
  }
  function draw(now:number) {
    if(finishing && root.closest('.laboratory')?.hasAttribute('data-flight')) { dispose(); return }
    let pending=false
    // The studio may emit at 30 Hz on a high-refresh display. Hold its most
    // recent observation between emissions and approach it in elapsed time.
    const blend=1-Math.exp(-Math.max(0,now-previous)/58)
    previous=now
    for(const r of regions) {
      const time=Math.min(1,Math.max(0,(now-start-r.delay)/r.duration))
      if (Number.isFinite(r.distance)) {
        r.targetProximity=Math.exp(-r.distance/18000)
        r.targetLean=Math.max(-1,Math.min(1,2*(r.nearY-r.rect.top)/r.rect.height-1))
      }
      r.proximity+=(r.targetProximity-r.proximity)*blend
      r.lean+=(r.targetLean-r.lean)*blend
      const influence=r.proximity*Math.sin(Math.PI*time)
      const catchUp=influence*.13
      const progress=Math.max(r.last,Math.min(1,time+catchUp))
      r.distance=Infinity
      pending ||= progress<1
      if(progress===r.last) continue
      r.last=progress
      const p=r.enter ? progress : 1-progress
      // Only the narrow seam has displaced ink. Completed areas display the
      // original DOM glyphs at their original position and subpixel weight.
      const tilt=r.lean*influence*7
      const gate='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 '+tilt.toFixed(3)+' -12 0 '
      const cutoff=(p*1.42-.27)*12-tilt*.5
      r.solid.setAttribute('values',gate+cutoff.toFixed(3))
      r.edge.setAttribute('values',gate+(cutoff+2.1).toFixed(3))
      r.shift.setAttribute('scale',String(r.amplitude*(1-p*.8)))
      if(progress===1 && r.enter) r.node.style.removeProperty('filter')
    }
    if(pending) frame=requestAnimationFrame(draw)
    else if(shot==='read' || finishing) dispose()
  }
  function begin(now:number) {
    if(disposed || motion.matches) return
    document.body.append(defs)
    const incoming=root.querySelector('.route-body'), outgoing=root.querySelector('.route-outgoing')
    const hero=root.querySelector('.studio-layer')
    if(shot==='read') collect(root,true,0,710,false)
    else if(shot==='intro') collect(root,true,1200,1140,true)
    else {
      collect(shot==='launch'?hero:outgoing,false,0,shot==='launch'?330:440,shot==='return')
      collect(shot==='return'?hero:incoming,true,shot==='launch'?1010:shot==='return'?815:615,
        shot==='launch'?650:610,shot!=='transfer' || !!outgoing?.querySelector('.method-grid'))
    }
    draw(now)
  }
  // The router establishes destination scroll just after its layout effects.
  if(!motion.matches) frame=requestAnimationFrame(begin)
  motion.addEventListener('change',dispose)
  function finishFlight() {
    const fullLength=shot==='launch' ? 1840 : 1420
    if((shot==='launch' || shot==='transfer') && performance.now()-start >= fullLength-40 &&
        regions.some(r=>r.enter && r.last<1 && r.node.isConnected)) {
      // Let smaller text resolve on the fully lit panel after the strands land.
      // Controls are already interactive and the navigation clock is finished.
      finishing=true
      return
    }
    dispose()
  }
  return {sample,dispose,finishFlight}
}

// Each text element below the fold reconstructs when it first scrolls into view.
export function observePageCopy(page: Element) {
  if(matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const active=new Set<ReturnType<typeof startTypeMotion>>()
  const registered=new WeakSet<Element>()
  function reveal(group:Element) {
    const animation=startTypeMotion(group,'read',performance.now(),()=>active.delete(animation))
    active.add(animation)
  }
  const observer=new IntersectionObserver(entries=>{
    for(const entry of entries) {
      if(!entry.isIntersecting) continue
      observer.unobserve(entry.target)
      // A group may already contain native text from the route handoff.
      if(!presented.has(entry.target)) reveal(entry.target)
    }
  })
  function register() {
    page.querySelectorAll(targets).forEach(el=>{
      if(registered.has(el) || presented.has(el)) return
      registered.add(el)
      observer.observe(el)
    })
  }
  register()
  const changes=new MutationObserver(register)
  changes.observe(page,{childList:true,subtree:true})
  return ()=>{observer.disconnect();changes.disconnect();active.forEach(a=>a.dispose())}
}
