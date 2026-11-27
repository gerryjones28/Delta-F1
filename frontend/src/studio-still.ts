import * as THREE from 'three'
import { GradientEquirectTexture, WebGLPathTracer } from 'three-gpu-pathtracer'
import { loadVehicle } from './vehicle'
import { studioRig } from './studio-rig'

const status = document.querySelector<HTMLParagraphElement>('#status')!
const canvas = document.querySelector('canvas')!
const embedded = window.parent !== window && new URLSearchParams(location.search).has('embed')
if (embedded) document.documentElement.classList.add('embedded')
function notifyParent(message: string) {
  if (embedded) window.parent.postMessage(message, location.origin)
}
async function photograph() {
  const renderer = new THREE.WebGLRenderer({canvas, powerPreference:'high-performance'})
  canvas.addEventListener('webglcontextlost', () => notifyParent('studio-trace-unavailable'))
  const gl = renderer.getContext()
  const info = gl.getExtension('WEBGL_debug_renderer_info')
  if (embedded && info && /swiftshader|llvmpipe|software rasterizer/i.test(gl.getParameter(info.UNMASKED_RENDERER_WEBGL))) {
    renderer.dispose()
    throw new Error('Software renderer')
  }
  if (!renderer.extensions.has('EXT_color_buffer_float')) throw new Error('Floating-point WebGL targets are unavailable on this device.')
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = .94
  const width = Math.min(960, Math.round(canvas.clientWidth))
  renderer.setSize(width, Math.round(width/1.88), false)
  const car = await loadVehicle(new AbortController().signal, false)
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(.0025,.0025,.003)
  const environment = new GradientEquirectTexture(128)
  environment.topColor.setRGB(.12,.13,.14)
  environment.bottomColor.setRGB(.014,.014,.016)
  environment.update()
  scene.environment = environment
  scene.add(car.group)
  const cards = studioRig()
  for (const panel of cards.rig.children) {
    if (!(panel instanceof THREE.Mesh)) continue
    const radiance = panel.material.uniforms.radiance.value
    const lamp = new THREE.RectAreaLight(new THREE.Color(radiance.x,radiance.y,radiance.z), .7, panel.scale.x, panel.scale.y)
    lamp.position.copy(panel.position)
    lamp.quaternion.copy(panel.quaternion)
    lamp.rotateY(Math.PI)
    scene.add(lamp)
  }
  cards.dispose()
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200,200),new THREE.MeshStandardMaterial({color:0x191a1b,roughness:.72}))
  ground.rotation.x = -Math.PI/2
  ground.position.y = -.003
  scene.add(ground)
  const distance = 9.2, aspect = canvas.width/canvas.height
  const camera = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(2*Math.atan(2.82/(distance*aspect))),aspect,.1,100)
  camera.position.set(-.33+distance*Math.sin(-1.045)*Math.cos(.20),.45+distance*Math.sin(.20),distance*Math.cos(-1.045)*Math.cos(.20))
  camera.lookAt(-.33,.45,0)
  const tracer = new WebGLPathTracer(renderer)
  tracer.bounces = 5
  tracer.tiles.set(2,2)
  tracer.textureSize.set(256,256)
  tracer.rasterizeScene = false
  tracer.minSamples = 1
  tracer.renderDelay = tracer.fadeDuration = 0
  tracer.setScene(scene,camera)
  const limit = 384
  let previous = -1
  function sample() {
    if (!document.hidden) {
      tracer.renderSample()
      const count = Math.floor(tracer.samples)
      if (count !== previous) {
        status.textContent = count === limit ? 'Studio still complete · ' + limit + ' samples per pixel' : 'Rendering · ' + count + ' / ' + limit + ' samples per pixel'
        if (count === 16) notifyParent('studio-trace-ready')
        previous = count
      }
    }
    if (tracer.samples < limit) requestAnimationFrame(sample)
  }
  sample()
}
photograph().catch(error => {notifyParent('studio-trace-unavailable'); status.textContent = 'Studio still unavailable. ' + error.message})
