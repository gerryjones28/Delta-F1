import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

export function drawCircuit(host: HTMLElement, points: number[][]) {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
  const el = renderer.domElement
  host.appendChild(el)
  el.tabIndex = 0
  el.setAttribute('aria-label', 'Circuit schematic. Drag or use arrow keys to rotate.')
  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-100, 100, 66, -66, 1, 650)
  camera.position.set(16, 165, 100)
  const controls = new OrbitControls(camera, el)
  controls.enablePan = false
  controls.enableZoom = false
  controls.maxPolarAngle = 1.2
  const vertices: number[] = []
  const sides: number[] = []
  const n = points.length - 1
  for (let i = 0; i < n; i++) {
    const [x, y] = points[i],
      prev = points[(i - 1 + n) % n],
      next = points[(i + 1) % n]
    const tangent = new THREE.Vector2(next[0] - prev[0], next[1] - prev[1]).normalize()
    for (const height of [3, 0])
      for (const sign of [-1, 1]) {
        vertices.push(x - 90 - sign * tangent.y * 1.2, height, y - 55 + sign * tangent.x * 1.2)
      }
    const a = i * 4,
      b = ((i + 1) % n) * 4
    sides.push(
      a,
      a + 1,
      b + 1,
      a,
      b + 1,
      b,
      a,
      b,
      b + 2,
      a,
      b + 2,
      a + 2,
      a + 1,
      b + 3,
      b + 1,
      a + 1,
      a + 3,
      b + 3,
    )
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
  geometry.setIndex(sides)
  geometry.computeVertexNormals()
  const material = new THREE.MeshStandardMaterial({
    color: 0x95bedc,
    side: THREE.DoubleSide,
    roughness: 0.36,
    metalness: 0.32,
  })
  const mesh = new THREE.Mesh(geometry, material)
  scene.add(mesh, new THREE.AmbientLight(0xcbdef8, 1.6))
  const light = new THREE.DirectionalLight(0xffffff, 3)
  light.position.set(-30, 80, 60)
  scene.add(light)
  const draw = () => renderer.render(scene, camera)
  controls.addEventListener('change', draw)
  const key = (e: KeyboardEvent) => {
    const direction = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].indexOf(e.key)
    if (direction < 0) return
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
    renderer.setSize(w, h)
    const half = Math.max(56, (96 * h) / w)
    camera.top = half
    camera.bottom = -half
    camera.left = (-half * w) / h
    camera.right = -camera.left
    camera.updateProjectionMatrix()
    controls.update()
    draw()
  }
  const observer = new ResizeObserver(resize)
  observer.observe(host)
  resize()
  return () => {
    observer.disconnect()
    el.removeEventListener('keydown', key)
    controls.dispose()
    geometry.dispose()
    material.dispose()
    renderer.dispose()
    el.remove()
  }
}
