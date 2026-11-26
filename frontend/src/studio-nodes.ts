import * as THREE from 'three'

// Fixed part identifiers and seed identifiers share the scene's camera and clock.
export function createStudioNodes(host: HTMLElement, axles: THREE.Vector4) {
  const parts = [
    [-2.65,.17,.55], [-2.05,.37,0], [axles.x,.48,axles.y], [axles.x,.48,-axles.y],
    [-.38,.88,.14], [.40,.57,.65], [1,.91,.12], [axles.z,.48,axles.w], [2.25,.96,.42],
  ].map(xyz => new THREE.Vector3(...xyz))
  const projected = new THREE.Vector3()
  const cursor = new THREE.Vector2(Infinity,Infinity)
  const particle = new THREE.Vector3()
  let width = 1, height = 1

  function label(kind: string) {
    const node = document.createElement('span')
    node.className = 'studio-node ' + kind
    node.setAttribute('aria-hidden','true')
    host.appendChild(node)
    return node
  }
  const partLabel = label('part-node'), particleLabels = [label('particle-node'), label('particle-node')]
  function place(node: HTMLElement, id: number, x: number, y: number, opacity: number) {
    const text = String(id).padStart(2,'0')
    if (node.textContent !== text) node.textContent = text
    node.style.transform = 'translate3d('+x.toFixed(1)+'px,'+y.toFixed(1)+'px,0)'
    node.style.opacity = String(opacity)
  }
  return {
    resize(w: number,h: number) { width=w; height=h },
    point(event: PointerEvent) {
      const rect = host.getBoundingClientRect()
      cursor.set(event.clientX-rect.left,event.clientY-rect.top)
    },
    leave() { cursor.set(Infinity,Infinity); partLabel.style.opacity='0' },
    update(camera: THREE.Camera, clock: number, enabled: boolean,
      sample: (seed: number,time: number,out: THREE.Vector3) => number) {
      let nearest = -1, x = 0, y = 0
      let radius = Math.min(54,width*.065)
      if (enabled && Number.isFinite(cursor.x)) {
        parts.forEach((part,i) => {
          projected.copy(part).project(camera)
          const px=(1+projected.x)*width/2, py=(1-projected.y)*height/2
          const dist=Math.hypot(cursor.x-px,cursor.y-py)
          if (dist < radius) { nearest=i; radius=dist; x=px; y=py }
        })
      }
      if (nearest>=0) place(partLabel,nearest+1,x,y,.82)
      else partLabel.style.opacity='0'

      // Stagger two near-side tracers so a label is usually in view as another wraps.
      particleLabels.forEach((node,i) => {
        if (!enabled) { node.style.opacity='0'; return }
        const seed=i===0 ? 32 : 39
        const t=sample(seed,clock,particle)
        projected.copy(particle).project(camera)
        const px=(1+projected.x)*width/2, py=(1-projected.y)*height/2
        const edge=Math.min(px,width-px,py,height-py)
        const alpha=.82*THREE.MathUtils.smoothstep(t,.04,.18)*
          (1-THREE.MathUtils.smoothstep(t,.78,.96))*THREE.MathUtils.smoothstep(edge,10,38)
        place(node,seed+1,px,py,nearest>=0 && Math.hypot(px-x,py-y)<38 ? 0 : alpha)
      })
    },
    dispose() { partLabel.remove(); particleLabels.forEach(node=>node.remove()) },
  }
}
