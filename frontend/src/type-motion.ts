import { createDecoder } from './glyph-decode'

// The blue channel stores when each piece of ink arrives. Red and green give
// its displacement. The map is made once per heading, never once per frame.
function makeField(bounds: DOMRect, ink: DOMRect, reverse: boolean, lines: DOMRect[]) {
  const {left,top,width,height}=bounds
  const inkLeft=ink.left, inkTop=ink.top, inkHeight=ink.height
  const cols=Math.min(192,Math.max(32,Math.ceil(width/2)))
  const rows=Math.max(12,Math.min(96,Math.round(cols*height/width)))
  // Write the three mask channels directly. A small uncompressed BMP needs
  // neither a synchronous canvas readback nor PNG encoding on the scroll path.
  const stride=(cols*3+3)&~3
  const bytes=new Uint8Array(54+rows*stride)
  const header=new DataView(bytes.buffer)
  bytes.set([0x42,0x4d])
  header.setUint32(2,bytes.length,true)
  header.setUint32(10,54,true)
  header.setUint32(14,40,true)
  header.setInt32(18,cols,true)
  header.setInt32(22,-rows,true)
  header.setUint16(26,1,true)
  header.setUint16(28,24,true)
  const grain = Math.max(2, Math.min(4.5, inkHeight / 16))
  for (let y=0; y<rows; y++) {
    const screenY = top + (y+.5)/rows*height
    const py=screenY-inkTop
    const line = lines.length>1 ? lines.findIndex(r=>screenY<=r.bottom) : 0
    const row = line<0 ? lines.length-1 : line
    const lineRect = lines[row] ?? ink
    const lineLeft=lineRect.left, lineWidth=Math.max(1,lineRect.width)
    for (let x=0; x<cols; x++) {
      const px = left + (x+.5)/cols*width - inkLeft
      const band = Math.floor((py + .055*px + grain*.6*Math.sin(px/77))/grain)
      const phase = Math.sin(band*17.19+2.4)
      const tile = Math.floor(px/(grain*6.5) + phase)
      const chip = Math.sin(tile*16.71 + band*7.13)
      const fraction = (px+inkLeft-lineLeft)/lineWidth
      const across = reverse ? 1-fraction : fraction
      const sweep = lines.length>1 ? .56*across+.44*row/(lines.length-1) : across
      const i=54+y*stride+x*3
      bytes[i+2] = 128+(reverse?-1:1)*(42+68*phase+14*chip)
      bytes[i+1] = 117+22*Math.min(1,Math.max(0,py/inkHeight))
      bytes[i] = 255*Math.min(.97,Math.max(.03,.18+.64*sweep+.12*phase+.065*chip))
    }
  }
  return URL.createObjectURL(new Blob([bytes],{type:'image/bmp'}))
}

type Shot = 'intro' | 'launch' | 'return' | 'transfer' | 'read'
const ns = 'http://www.w3.org/2000/svg'
let sequence = 0
// All active batches use one browser frame callback, including batches queued
// by different IntersectionObserver deliveries during a continuous scroll.
const ticks=new Set<FrameRequestCallback>()
let raf=0
function schedule(tick:FrameRequestCallback) {
  ticks.add(tick)
  if(!raf) raf=requestAnimationFrame(now=>{
    raf=0
    const ready=Array.from(ticks)
    ticks.clear()
    ready.forEach(run=>run(now))
  })
}
const headings = 'h1,.section-head h2,.method-grid h2,.card-info h3,.pair-header h2,.traces > h2'
const pageCopy = ['.method-grid p','.method-grid a','.full-archive .section-label',
  '.full-archive .filter select','.full-archive .search input','.full-archive .archive-tools .muted',
  '.archive .country','.card-info h3','.card-info p','.card-meta','.card-stats > span',
  '.workspace-intro .section-label','.workspace-intro .venue','.session-facts > span:nth-child(-n+2)','.full-archive .loading-signal',
  '.full-archive .empty','.full-archive .notice strong','.full-archive .notice p','.full-archive .notice button'].join(',')
const targets = headings+','+pageCopy
export type TypeVisit = Map<string,'revealing'|'revealed'>
const roles=targets.split(',')
function textKey(node:Element) {
  const card=node.closest('.session-card')
  const article=node.closest('.method-grid article')
  const scope=card?.getAttribute('href') ?? (article ? 'note-'+Array.from(article.parentElement!.children).indexOf(article) : '')
  const role=roles.find(selector=>node.matches(selector))
  const index=node.matches('.card-stats > span,.session-facts > span') ? Array.from(node.parentElement!.children).indexOf(node) : ''
  return scope+'|'+role+'|'+index
}

export function startTypeMotion(root: Element, shot: Shot, start: number, visit:TypeVisit, batch?:HTMLElement[], onDone?:()=>void) {
  const defs = document.createElementNS(ns,'svg')
  defs.setAttribute('aria-hidden','true')
  defs.style.cssText='position:absolute;width:0;height:0;pointer-events:none'
  const regions: {node:HTMLElement; filterStyle:string; rect:DOMRect; enter:boolean; delay:number; duration:number;
    solid:Element; edge:Element; shift:Element; distance:number; nearY:number; last:number; amplitude:number;
    proximity:number; lean:number; targetProximity:number; targetLean:number;
    key:string; reverse:boolean; decoderReady:boolean; decoder?:ReturnType<typeof createDecoder>}[] = []
  const motion = matchMedia('(prefers-reduced-motion: reduce)')
  let previous=start
  let introHold=0
  let disposed=false
  let finishing=false
  const maps:string[]=[]

  function collect(scope: Element | null, enter:boolean, delay:number, duration:number, reverse:boolean) {
    if (!scope) return
    const nodes = batch ?? Array.from(scope.querySelectorAll<HTMLElement>(targets))
    if(!batch && scope instanceof HTMLElement && scope.matches(targets)) nodes.unshift(scope)
    for (const node of nodes) {
      const key=textKey(node)
      if(enter && visit.has(key) && !batch) continue
      const bounds=node.getBoundingClientRect()
      const margin=shot==='read' ? 48 : 0
      const discoveryBounds=batch ? node.closest('.card-info')?.getBoundingClientRect() ?? bounds : bounds
      if (!bounds.width || discoveryBounds.bottom<=-margin || discoveryBounds.top>=innerHeight+margin) {
        if(batch) visit.set(key,'revealed') // A fast fling already passed this entry.
        continue
      }
      const range=document.createRange()
      range.selectNodeContents(node.querySelector('.ink-original') ?? node)
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
      const field=makeField(box,ink,reverse,lines)
      maps.push(field)
      primitive('feImage',{href:field,preserveAspectRatio:'none',result:'field'})
      const solid=primitive('feColorMatrix',{in:'field',type:'matrix',result:'settled'})
      const edge=primitive('feColorMatrix',{in:'field',type:'matrix',result:'front'})
      primitive('feComposite',{in:'SourceGraphic',in2:'settled',operator:'in',result:'ink'})
      primitive('feComposite',{in:'front',in2:'settled',operator:'out',result:'seam'})
      primitive('feComposite',{in:'SourceGraphic',in2:'seam',operator:'in',result:'pieces'})
      const shift=primitive('feDisplacementMap',{in:'pieces',in2:'field',xChannelSelector:'R',yChannelSelector:'G',result:'shifted'})
      primitive('feComposite',{in:'ink',in2:'shifted',operator:'over'})
      defs.append(filter)
      const stagger=shot==='read' ? Math.min(32,ink.left/innerWidth*32) : Math.min(110,Math.max(0,ink.top/innerHeight)*70+ink.left/innerWidth*45)
      const bodyCopy=node.matches(pageCopy)
      const label=node.matches('.section-label,.country,.card-meta,.card-stats > span,.session-facts > span')
      const panelArrival=enter && bodyCopy && (shot==='launch' || shot==='transfer')
      const detailDelay = enter && bodyCopy ? (node.matches('.card-stats > span,.method-grid a') ? 90 : node.matches('p') ? 52 : 12) : 0
      node.style.filter='url(#'+id+')'
      regions.push({node,key,reverse,decoderReady:!enter,filterStyle:node.style.filter,rect:ink,enter,delay:(panelArrival ? (shot==='launch' ? 1320 : 905) : delay)+stagger+(shot==='read'?detailDelay*.35:detailDelay),
        duration:label ? Math.min(340,duration) : panelArrival ? 680 : duration,solid,edge,shift,
        distance:Infinity,nearY:ink.top,last:-1,amplitude:label ? 5 : bodyCopy ? (prose ? 16 : 12) : Math.min(23,Math.max(7,ink.height*.26)),
        proximity:0,lean:0,targetProximity:0,targetLean:0})
      if(enter) visit.set(key,'revealing')
    }
  }
  function dispose() {
    if(disposed) return
    disposed=true
    ticks.delete(begin)
    ticks.delete(draw)
    batch?.forEach(node=>visit.set(textKey(node),'revealed'))
    regions.forEach(r=>{
      if(r.node.style.filter===r.filterStyle) r.node.style.removeProperty('filter')
      r.decoder?.dispose()
      if(r.enter) visit.set(r.key,'revealed')
    })
    defs.remove()
    maps.forEach(url=>URL.revokeObjectURL(url))
    motion.removeEventListener('change',dispose)
    window.removeEventListener('resize',dispose)
    window.removeEventListener('pointerdown',dispose,true)
    window.removeEventListener('keydown',dispose,true)
    window.removeEventListener('hashchange',dispose)
    document.removeEventListener('visibilitychange',onVisibility)
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
    if(disposed) return
    if(finishing && (!root.isConnected || root.closest('[hidden], [data-flight]'))) { dispose(); return }
    let pending=false
    // The studio may emit at 30 Hz on a high-refresh display. Hold its most
    // recent observation between emissions and approach it in elapsed time.
    const blend=1-Math.exp(-Math.max(0,now-previous)/58)
    // A cold GPU can occupy the main thread for several hundred milliseconds.
    // Preserve visible decoding time on first load; route shots keep real time.
    if(shot==='intro' && now-previous>150 && now-start<5000)
      introHold+=Math.max(0,now-Math.max(previous,start+900)-90)
    previous=now
    for(const r of regions) {
      const time=Math.min(1,Math.max(0,(now-start-introHold-r.delay)/r.duration))
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
      const p=r.enter ? (shot==='read' ? .19+.81*progress : progress) : 1-progress
      if(!r.decoderReady && p>.1 && p<.88) {
        r.decoderReady=true
        r.decoder=createDecoder(r.node,r.reverse)
      }
      r.decoder?.update(p)
      // Only the narrow seam has displaced ink. Completed areas display the
      // original DOM glyphs at their original position and subpixel weight.
      const tilt=r.lean*influence*7
      const gate='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 '+tilt.toFixed(3)+' -12 0 '
      const cutoff=(p*1.42-.27)*12-tilt*.5
      r.solid.setAttribute('values',gate+cutoff.toFixed(3))
      r.edge.setAttribute('values',gate+(cutoff+2.1).toFixed(3))
      r.shift.setAttribute('scale',String(r.amplitude*(1-p*.8)))
      if(progress===1 && r.enter) {
        r.node.style.removeProperty('filter')
        r.decoder?.dispose()
        r.decoder=undefined
        visit.set(r.key,'revealed')
      }
    }
    if(pending) schedule(draw)
    else if(shot==='read' || finishing) dispose()
  }
  function begin(now:number) {
    if(disposed || motion.matches) return
    document.body.append(defs)
    const incoming=root.querySelector('.route-body'), outgoing=root.querySelector('.route-outgoing')
    const hero=root.querySelector('.studio-layer')
    if(shot==='read') collect(root,true,0,610,false)
    else if(shot==='intro') collect(root,true,900,1050,true)
    else {
      collect(shot==='launch'?hero:outgoing,false,0,shot==='launch'?330:440,shot==='return')
      collect(shot==='return'?hero:incoming,true,shot==='launch'?1010:shot==='return'?815:615,
        shot==='launch'?650:610,shot!=='transfer' || !!outgoing?.querySelector('.method-grid'))
    }
    draw(now)
  }
  // The router establishes destination scroll just after its layout effects.
  if(!motion.matches) schedule(begin)
  motion.addEventListener('change',dispose)
  window.addEventListener('resize',dispose)
  function onVisibility() { if(document.hidden) dispose() }
  document.addEventListener('visibilitychange',onVisibility)
  if(shot==='intro') {
    window.addEventListener('pointerdown',dispose,true)
    window.addEventListener('keydown',dispose,true)
    window.addEventListener('hashchange',dispose)
  }
  function finishFlight() {
    if(disposed) return
    if(shot==='intro' && performance.now()-start>=2650 && root.isConnected && !root.closest('[hidden], [data-flight]') &&
      regions.some(r=>r.last<1)) { finishing=true; return }
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
export function observePageCopy(page: Element, visit:TypeVisit) {
  if(matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const active=new Set<ReturnType<typeof startTypeMotion>>()
  const registered=new WeakSet<Element>()
  let scroll=window.scrollY, lastScroll=performance.now(), fastUntil=0
  function onScroll() {
    const now=performance.now(), distance=Math.abs(window.scrollY-scroll)
    if(distance>innerHeight*.45 || distance/Math.max(16,now-lastScroll)>2.8) fastUntil=now+100
    scroll=window.scrollY
    lastScroll=now
  }
  window.addEventListener('scroll',onScroll,{passive:true})
  const observer=new IntersectionObserver(entries=>{
    const batch:HTMLElement[]=[]
    for(const entry of entries) {
      if(!entry.isIntersecting) continue
      observer.unobserve(entry.target)
      // Discover the card's text block once; a few more pixels of scrolling
      // must not start another pass down its title, venue and statistics.
      const fields=entry.target.matches('.card-info')
        ? entry.target.querySelectorAll<HTMLElement>(targets) : [entry.target as HTMLElement]
      const skip=performance.now()<fastUntil || performance.now()-entry.time>240 || matchMedia('(prefers-reduced-motion: reduce)').matches
      for(const field of fields) {
        const key=textKey(field)
        if(visit.has(key)) continue
        visit.set(key,skip ? 'revealed' : 'revealing')
        if(!skip) batch.push(field)
      }
    }
    if(batch.length) {
      const animation=startTypeMotion(page,'read',performance.now(),visit,batch,()=>active.delete(animation))
      active.add(animation)
    }
  },{rootMargin:'48px 0px'})
  function register(scope:Element) {
    const elements=Array.from(scope.querySelectorAll(targets))
    if(scope.matches(targets)) elements.push(scope)
    elements.forEach(el=>{
      const discovery=el.closest('.card-info') ?? el
      if(registered.has(discovery) || visit.has(textKey(el))) return
      registered.add(discovery)
      observer.observe(discovery)
    })
  }
  register(page)
  const changes=new MutationObserver(records=>{
    for(const record of records) for(const added of record.addedNodes)
      if(added instanceof HTMLElement && !(added instanceof HTMLCanvasElement)) register(added)
  })
  changes.observe(page,{childList:true,subtree:true})
  return ()=>{
    window.removeEventListener('scroll',onScroll)
    observer.disconnect()
    changes.disconnect()
    active.forEach(a=>a.dispose())
  }
}
