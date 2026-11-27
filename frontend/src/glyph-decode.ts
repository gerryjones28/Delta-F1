// Only cells currently decoding are cut out of the original text. Everything
// outside those cells retains native kerning, gradients and font rendering.
export function createDecoder(node: HTMLElement, reverse: boolean) {
  const frame = node.querySelector<HTMLElement>(':scope > .ink-frame')
  const source = frame?.firstElementChild as HTMLElement | null
  if (!frame || !source || !CSS.supports('clip-path','path(evenodd,"M0 0H10V10Z")')) return
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const box = frame.getBoundingClientRect()
  const smallTouch = matchMedia('(pointer: coarse) and (max-width: 900px)').matches
  const scale = Math.min(devicePixelRatio, smallTouch ? 1.25 : 2)
  canvas.width = Math.ceil(box.width * scale)
  canvas.height = Math.ceil(box.height * scale)
  canvas.setAttribute('aria-hidden','true')
  ctx.scale(scale,scale)
  ctx.textAlign = 'center'
  const text = source.textContent ?? ''
  let seed = 2166136261
  for (const ch of text) seed = Math.imul(seed ^ ch.charCodeAt(0),16777619)
  function random() {
    seed = (Math.imul(seed,1664525)+1013904223) >>> 0
    return seed/4294967296
  }
  const hero = node.matches('.hero h1')
  const prose = node.matches('p')
  const glyphs: {x:number;y:number;width:number;height:number;baseline:number;font:string;color:string;
    begin:number;end:number;phase:number;rate:number;alphabet:string;code:number;step:number}[] = []
  const range = document.createRange()
  const walker = document.createTreeWalker(source,NodeFilter.SHOW_TEXT)
  for (let run=walker.nextNode(); run; run=walker.nextNode()) {
    const style = getComputedStyle(run.parentElement!)
    const font = style.fontStyle+' '+style.fontWeight+' '+style.fontSize+' '+style.fontFamily
    ctx.font = font
    const metrics = ctx.measureText('Hg')
    const ascent = metrics.fontBoundingBoxAscent ?? parseFloat(style.fontSize)*.8
    const descent = metrics.fontBoundingBoxDescent ?? parseFloat(style.fontSize)*.2
    const value = run.textContent ?? ''
    for (let i=0;i<value.length;i++) {
      const letter=value[i]
      if (!/[a-z]/i.test(letter) || random()>(prose ? .10 : hero ? .93 : .72)*(smallTouch ? .8 : 1)) continue
      range.setStart(run,i)
      range.setEnd(run,i+1)
      const rect = range.getBoundingClientRect()
      if (!rect.width || !rect.height) continue
      const x=rect.x-box.x, y=rect.y-box.y
      const across=(x+rect.width/2)/box.width
      const lane=(reverse ? 1-across : across)*.72 + Math.max(0,y/box.height)*.28
      const begin=.14+lane*.43+random()*.12
      const upper=letter===letter.toUpperCase()
      const alphabet=/[iltfj]/i.test(letter) ? 'ijlt/|' :
        /[abdegopq]/i.test(letter) ? (upper ? 'QDRBO' : 'eopqd') : (upper ? 'NRXHKVZ/+' : 'rnsuvxz/=')
      glyphs.push({x,y,width:rect.width,height:rect.height,baseline:y+(rect.height-ascent-descent)/2+ascent,
        font,color:run.parentElement!.closest('em')?'#b4b5b7':style.color,
        begin,end:begin+(hero ? .25 : prose ? .14 : .20)+random()*.09,
        phase:random(),rate:smallTouch ? 11 : hero?15:17,alphabet,code:Math.floor(random()*97),step:-1})
    }
  }
  if (!glyphs.length) return
  frame.append(canvas)
  let done=false
  function dispose() {
    if(done) return
    done=true
    sizing.disconnect()
    source!.style.removeProperty('clip-path')
    canvas.remove()
  }
  // A late font or changed line wrap can invalidate measured cells. Settle
  // directly into the original text rather than painting against old metrics.
  const sizing=new ResizeObserver(([entry])=>{
    if(Math.abs(entry.contentRect.width-box.width)>1 || Math.abs(entry.contentRect.height-box.height)>1) dispose()
  })
  sizing.observe(frame)
  function update(progress:number) {
    if(done) return
    let changed=false
    for (const g of glyphs) {
      const step=progress>=g.begin && progress<g.end ? Math.floor((progress-g.begin)*g.rate+g.phase) : -1
      if(step!==g.step) { g.step=step; changed=true }
    }
    if(!changed) return
    ctx!.clearRect(0,0,box.width,box.height)
    const holes:string[]=[]
    for(const g of glyphs) {
      if(g.step<0) continue
      holes.push(`M${g.x} ${g.y}h${g.width}v${g.height}h-${g.width}Z`)
      ctx!.font=g.font
      ctx!.fillStyle=g.color
      ctx!.fillText(g.alphabet[(g.code+g.step)%g.alphabet.length],g.x+g.width/2,g.baseline,g.width)
    }
    source!.style.clipPath=holes.length
      ? `path(evenodd,"M-10 -10H${box.width+10}V${box.height+10}H-10Z ${holes.join(' ')}")` : ''
  }
  return {update,dispose}
}
