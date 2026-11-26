import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

import { markerPoint, type LapMap } from './lap-map'

export type CameraMode = 'overview' | 'reference' | 'compare'

export function drawCircuit(host: HTMLElement, points: number[][], map?: LapMap | null) {
  const breaks = map?.breaks
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
  const el = renderer.domElement
  host.appendChild(el)
  el.tabIndex = 0
  el.setAttribute('aria-label', 'Circuit. Drag or use arrow keys to rotate.')
  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-100, 100, 66, -66, 1, 650)
  camera.position.set(16, 165, 100)
  const controls = new OrbitControls(camera, el)
  controls.enablePan = false
  controls.enableZoom = false
  controls.maxPolarAngle = 1.2
  const vertices: number[] = []
  const colors: number[] = []
  const indices: number[] = []
  const asphalt = new THREE.Color(map ? 0x393d43 : 0x95bedc)
  const shoulder = new THREE.Color(map ? 0x82878b : 0xbad4e7)
  const n = breaks ? points.length : points.length - 1
  for (let i = 0; i < n; i++) {
    const [x, y] = points[i],
      prev = breaks?.has(i) ? points[i] : points[(i - 1 + n) % n],
      nextIndex = (i + 1) % n,
      next = breaks?.has(nextIndex) ? points[i] : points[nextIndex]
    const tangent = new THREE.Vector2(next[0] - prev[0], next[1] - prev[1]).normalize()
    for (const lateral of [-1.2, -1.07, 1.07, 1.2]) {
      vertices.push(x - 90 - lateral * tangent.y, 0, y - 55 + lateral * tangent.x)
      const color = Math.abs(lateral) === 1.2 ? shoulder : asphalt
      colors.push(color.r, color.g, color.b)
    }
    if (breaks?.has(nextIndex)) continue
    for (let strip = 0; strip < 3; strip++) {
      const a = i * 4 + strip, b = nextIndex * 4 + strip
      indices.push(a, a + 1, b + 1, a, b + 1, b)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    roughness: map ? .94 : .36,
    metalness: map ? .04 : .32,
  })
  const mesh = new THREE.Mesh(geometry, material)
  scene.add(mesh, new THREE.AmbientLight(0xcbdef8, 1.6))
  const light = new THREE.DirectionalLight(0xffffff, 3)
  light.position.set(-30, 80, 60)
  scene.add(light)
  const overview = camera.position.clone()
  const followOffset = new THREE.Vector3(18, 32, 30)
  const rigOffset = new THREE.Vector3(), panOffset = new THREE.Vector3(), aim = new THREE.Vector3()
  const motion = matchMedia('(prefers-reduced-motion: reduce)')
  const globe = new THREE.SphereGeometry(1, 16, 12)
  const haloCanvas=document.createElement('canvas')
  haloCanvas.width=haloCanvas.height=32
  const ctx=haloCanvas.getContext('2d')!
  const gradient=ctx.createRadialGradient(16,16,2,16,16,16)
  gradient.addColorStop(0,'#fff');gradient.addColorStop(1,'transparent')
  ctx.fillStyle=gradient;ctx.fillRect(0,0,32,32)
  const haloTexture=new THREE.CanvasTexture(haloCanvas)
  const haloMaterials: THREE.SpriteMaterial[]=[]
  const orbs = [0x72bdff, 0xffad72].map((color, i) => {
    const finish = new THREE.MeshStandardMaterial({
      color:i ? 0xde6618 : 0x2575bd, emissive:color, emissiveIntensity:.48, metalness:.12, roughness:.28,
      depthTest:false, depthWrite:false,
    })
    const orb = new THREE.Mesh(globe, finish)
    const haloMaterial=new THREE.SpriteMaterial({map:haloTexture,color,transparent:true,
      opacity:.22, blending:THREE.AdditiveBlending, depthTest:false,depthWrite:false})
    haloMaterials.push(haloMaterial)
    const halo=new THREE.Sprite(haloMaterial)
    halo.scale.setScalar(4.3)
    orb.add(halo)
    orb.visible=false
    orb.renderOrder=2+i
    scene.add(orb)
    return orb
  })
  const grid = new THREE.GridHelper(240, 40, 0x363b41, 0x282c31)
  grid.material.transparent=true
  grid.material.opacity=.28
  grid.position.y=-.04
  if(map) scene.add(grid)

  let mode: CameraMode='overview'
  let settling=false, enteringMode=false, frame=0, previous=0, height=1
  function invalidate() {
    if(!frame) frame=requestAnimationFrame(draw)
  }
  function draw(now:number) {
    frame=0
    const dt=previous ? Math.min((now-previous)/1000,.05) : 1/60
    previous=now
    let moving=false
    if(settling && (mode==='overview' || orbs[mode==='reference'?0:1].visible)) {
      const follow=mode!=='overview'
      const offset = follow ? followOffset : overview
      const zoom = follow ? 6.4 : 1
      aim.set(0,0,0)
      if (follow) {
        aim.copy(orbs[mode==='reference'?0:1].position)
        aim.y += 1.1
      }
      // Ease the change of shot. After it settles, the rig translates exactly
      // with the interpolated orb, including on scrubs and fast playback.
      if (enteringMode) {
        panOffset.subVectors(controls.target, aim)
        rigOffset.subVectors(camera.position, controls.target)
        enteringMode = false
      }
      const blend=motion.matches ? 1 : 1-Math.exp(-dt*10)
      panOffset.multiplyScalar(1-blend)
      rigOffset.lerp(offset,blend)
      camera.zoom+=(zoom-camera.zoom)*blend
      moving=rigOffset.distanceToSquared(offset)>.0004 ||
        panOffset.lengthSq()>.0004 || Math.abs(camera.zoom-zoom)>.001
      if(!moving) {
        rigOffset.copy(offset); panOffset.set(0,0,0); camera.zoom=zoom
        settling=false; controls.enabled=!follow
      }
      controls.target.copy(aim).add(panOffset)
      camera.position.copy(controls.target).add(rigOffset)
      camera.lookAt(controls.target)
      camera.updateProjectionMatrix()
      if(!moving && !follow) controls.update()
    }
    const units=(camera.top-camera.bottom)/(camera.zoom*height)
    orbs[0].scale.setScalar(4.6*units)
    orbs[1].scale.setScalar(3.1*units)
    renderer.render(scene,camera)
    if(moving) invalidate()
    else previous=0
  }
  function setSamples(ref:number, cmp:number, playback=false) {
    if(!map) return
    for(const [i,orb] of orbs.entries()) {
      const index=i===0?ref:cmp
      const p=playback ? map.playback[i](index) : markerPoint(i===0?map.reference:map.compare,index)
      orb.visible=!!p
      if(p) orb.position.set(p[0]-90,.4,p[1]-55)
    }
    if(mode!=='overview') settling=true
    if (playback) {
      cancelAnimationFrame(frame)
      draw(performance.now())
    } else invalidate()
  }
  function setMode(next:CameraMode) {
    if(next===mode) return
    mode=next; controls.enabled=false; settling=true; enteringMode=true
    invalidate()
  }
  controls.addEventListener('change', invalidate)
  const key = (e: KeyboardEvent) => {
    const direction = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(e.key)
    if (!controls.enabled || direction < 0) return
    e.preventDefault()
    const spherical = new THREE.Spherical().setFromVector3(camera.position)
    if (direction < 2) spherical.theta += direction === 0 ? -0.12 : 0.12
    else spherical.phi = THREE.MathUtils.clamp(spherical.phi + (direction === 2 ? -0.1 : 0.1), 0.08, 1.2)
    camera.position.setFromSpherical(spherical)
    controls.update()
  }
  el.addEventListener('keydown', key)
  const resize = () => {
    const w = host.clientWidth,
      h = host.clientHeight
    if (!w || !h) return
    height=h
    renderer.setSize(w, h)
    const half = Math.max(56, (96 * h) / w)
    camera.top = half
    camera.bottom = -half
    camera.left = (-half * w) / h
    camera.right = -camera.left
    camera.updateProjectionMatrix()
    controls.update()
    invalidate()
  }
  const observer = new ResizeObserver(resize)
  observer.observe(host)
  resize()
  function dispose() {
    cancelAnimationFrame(frame)
    grid.geometry.dispose();grid.material.dispose()
    haloTexture.dispose();haloMaterials.forEach(mat=>mat.dispose())
    globe.dispose();orbs.forEach(orb=>orb.material.dispose())
    observer.disconnect()
    el.removeEventListener('keydown', key)
    controls.dispose()
    geometry.dispose()
    material.dispose()
    renderer.dispose()
    el.remove()
  }
  return {dispose,setSamples,setMode}
}
