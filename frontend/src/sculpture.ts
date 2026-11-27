import * as THREE from 'three'
import { createStudioNodes } from './studio-nodes'
import { createAirflow } from './airflow'
import { createRollingRoad } from './road'
import { createStudioBloom } from './studio-bloom'

import { studioRig } from './studio-rig'

interface Vehicle {
  group: THREE.Group
  materials: THREE.Material[]
  textures: THREE.Texture[]
  advanceWheels: (distance: number, speed: number) => void
}

function disposeVehicle(car: Vehicle) {
  car.group.traverse(item => {
    if (item instanceof THREE.InstancedMesh) item.dispose()
    if (item instanceof THREE.Mesh) item.geometry.dispose()
  })
  car.materials.forEach(material => material.dispose())
  car.textures.forEach(texture => texture.dispose())
}

/** Mount into a sized container. The caller controls the poster and its accessible label. */
export function mountSculpture(
  host: HTMLElement,
  onReady: () => void,
  revealStart?: number,
  onUnavailable?: () => void,
  onDeferred?: () => void,
): () => void {
  const surface = document.createElement('canvas')
  const gl = surface.getContext('webgl2', { alpha: true, antialias: true, powerPreference: 'low-power' })
  if (!gl) throw new Error('WebGL 2 unavailable')
  const context = gl
  const info = context.getExtension('WEBGL_debug_renderer_info')
  const software =
    !!info &&
    /swiftshader|llvmpipe|softpipe|basic render|software rasterizer|lavapipe/i.test(
      String(context.getParameter(info.UNMASKED_RENDERER_WEBGL)),
    )
  const controller = new AbortController()
  let studio: (() => void) | undefined
  let car: Vehicle | undefined
  let delay = 0
  let readyToRender = true

  function build() {
    if (!car || !readyToRender || controller.signal.aborted) return
    const renderer = new THREE.WebGLRenderer({ canvas: surface, context, alpha: true })
    try {
      studio = createStudio(host, renderer, car, onReady, software, revealStart)
      car = undefined // The mounted studio now owns the GPU resources.
    } catch (error) {
      renderer.dispose()
      throw error
    }
  }
  function failed() {
    if (controller.signal.aborted) return
    if (car) disposeVehicle(car)
    car = undefined
    context.getExtension('WEBGL_lose_context')?.loseContext()
    surface.remove()
    onUnavailable?.()
  }
  const smallTouch = matchMedia('(pointer: coarse) and (max-width: 900px)').matches
  // Let the poster and first text paint before building render targets on touch devices.
  const wait = revealStart !== undefined && (software || smallTouch)
    ? revealStart + (software ? 2840 : 280) - performance.now() : 0
  if (wait > 0) {
    onDeferred?.()
    readyToRender = false
    delay = window.setTimeout(() => {
      readyToRender = true
      try { build() } catch { failed() }
    }, wait)
  }
  // Use the authored LOD of the same vehicle on small touch displays.
  const vehicle = import('./vehicle').then(module => module.loadVehicle(controller.signal, software || smallTouch))
  vehicle.then(result => {
    if (controller.signal.aborted) {
      disposeVehicle(result)
      return
    }
    car = result
    build()
  }).catch(failed)
  return () => {
    controller.abort()
    clearTimeout(delay)
    if (studio) studio()
    else {
      if (car) disposeVehicle(car)
      context.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }
}

function createStudio(
  host: HTMLElement,
  renderer: THREE.WebGLRenderer,
  car: Vehicle,
  onReady: () => void,
  software: boolean,
  revealStart?: number,
) {
  renderer.setClearColor(0, 0)
  renderer.transmissionResolutionScale = 0.5
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMappingExposure = 0.94
  const canvas = renderer.domElement
  canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:pan-y;'
  canvas.setAttribute('aria-hidden', 'true')
  host.appendChild(canvas)
  const scene = new THREE.Scene()
  car.group.traverse(part => { if (part instanceof THREE.Mesh) part.layers.enable(2) })
  scene.add(car.group)
  const cards = studioRig()
  const pmrem = new THREE.PMREMGenerator(renderer)
  const env = pmrem.fromScene(cards.rig, 0, 0.1, 24)
  pmrem.dispose()
  cards.dispose()
  scene.environment = env.texture
  scene.environmentIntensity = 0.87
  scene.add(new THREE.HemisphereLight(0xf0f0ed, 0x141414, 0.23))
  // The front softbox grazes the nose and cockpit. Its feathered edge falls across the tail.
  const key = new THREE.SpotLight(0xf7f8ff, 89, 14, 0.61, 0.86, 2)
  key.name = 'Front softbox'
  key.position.set(-2.6, 3.7, 2.4)
  key.target.position.set(-0.57, 0.25, 0)
  scene.add(key, key.target)
  const rim = new THREE.DirectionalLight(0xe6edff, 1.85)
  rim.name = 'Rear strip light'
  // The static back strip casts a cached depth map. Rotating slicks retain their silhouette.
  rim.position.set(1.6, 4.8, -3.4)
  renderer.shadowMap.enabled = !software
  renderer.shadowMap.type = THREE.PCFShadowMap
  renderer.shadowMap.autoUpdate = false
  renderer.shadowMap.needsUpdate = !software
  rim.castShadow = !software
  const smallTouch = matchMedia('(pointer: coarse) and (max-width: 900px)').matches
  const shadowSize = smallTouch ? 512 : 1024
  rim.shadow.mapSize.set(shadowSize, shadowSize)
  Object.assign(rim.shadow.camera, { left: -3.8, right: 3.8, top: 3.4, bottom: -3.4, near: 0.2, far: 12 })
  rim.shadow.camera.updateProjectionMatrix()
  rim.shadow.radius = 4
  rim.shadow.intensity = 0.65
  rim.shadow.normalBias = 0.009
  rim.shadow.bias = -0.00015
  car.group.traverse(part => {
    if (part instanceof THREE.Mesh) part.castShadow = part.receiveShadow = !software
  })
  scene.add(rim)
  const front = car.group.getObjectByName('wheel-front-left')!.position
  const rear = car.group.getObjectByName('wheel-rear-left')!.position
  const axles = new THREE.Vector4(front.x, Math.abs(front.z), rear.x, Math.abs(rear.z))
  const airflow = createAirflow(axles)
  scene.add(airflow.group)
  const nodes = createStudioNodes(host,axles)
  const lightSurface = host.closest('.hero') ?? host
  const pointer = new THREE.Vector2()
  const lightOffset = new THREE.Vector2()
  const parallax = new THREE.Vector2()
  let lastPointerMove = -Infinity
  const motes = new THREE.BufferGeometry()
  const points = new Float32Array(38 * 3)
  for (let i = 0; i < 38; i++) {
    const seed = (n: number) => (Math.sin((i + 1) * n) * 43758.5453) % 1
    points[i * 3] = seed(12.9898) * 4.7
    points[i * 3 + 1] = 0.62 + Math.abs(seed(78.233)) * 1.22
    points[i * 3 + 2] = -1.05 - Math.abs(seed(38.871)) * 1.9
  }
  motes.setAttribute('position', new THREE.BufferAttribute(points, 3))
  const mistMaterial = new THREE.PointsMaterial({
    color: 0xc0c0bf,
    size: 0.009,
    opacity: 0.19,
    transparent: true,
    depthWrite: false,
  })
  const mist = new THREE.Points(motes, mistMaterial)
  scene.add(mist)
  const road = createRollingRoad(axles)
  road.mesh.receiveShadow = !software
  scene.add(road.mesh)
  const standOff = 9.2
  const silhouette = new THREE.WebGLRenderTarget(1,1)
  const matte = new THREE.MeshBasicMaterial({color:0xffffff, side:THREE.DoubleSide})
  let bloom = !software && renderer.extensions.has('EXT_color_buffer_float') ? createStudioBloom(renderer,silhouette.texture) : undefined
  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 40)
  const aim = new THREE.Vector3(-0.33, 0.45, 0),
    motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  let visible = true,
    dead = false,
    dirty = true,
    frame = 0,
    lastFrame = 0,
    elapsed = 0,
    flowClock = 0,
    slow = 0
  const hero = host.closest<HTMLElement>('.laboratory')
  const restingX = car.group.position.x
  const shotTarget = new THREE.Vector3()
  let stillWhenIdle = false
  let paused = false
  let frameInterval = 1000 / 60 - 1
  let idleMix = 0
  const minDpr = software ? 0.65 : 0.85
  let dpr = Math.min(window.devicePixelRatio || 1, software ? 0.85 : smallTouch ? 1.25 : 1.65)
  renderer.setPixelRatio(dpr)
  let studioWidth = 0, centerShift = 0, launchShift = 0
  const previousCenter = new THREE.Vector3(), center = new THREE.Vector3()
  const shutter = new THREE.Vector2()
  let previousShot = -1
  // Sample only the aft portion of the existing stream tubes. Farther points
  // retain older vehicle positions, stretching a wake out behind the rear wing.
  const aftPaths = airflow.paths.map(path => path.getSpacedPoints(42).slice(-15))
  const returnPaths = airflow.paths.map(path => path.getSpacedPoints(99))
  const projected = new THREE.Vector3()
  function launchTravel(progress: number) {
    const exit = THREE.MathUtils.smootherstep(progress, .21, .72)
    return -20 * exit * (.37 + .63 * exit)
  }
  function returnTravel(progress: number) {
    const approach = 1 - THREE.MathUtils.smootherstep(progress, .24, .70)
    const settle = THREE.MathUtils.smootherstep(progress, .63, .90)
    return 10.6 * approach - .15 * Math.sin(Math.PI * settle) ** 2
  }
  function resize() {
    const bounds = host.getBoundingClientRect()
    const { width, height } = bounds
    if (width < 1 || height < 1) return
    if (Math.floor(width*dpr) !== canvas.width || Math.floor(height*dpr) !== canvas.height) {
      renderer.setSize(width, height, false)
    }
    bloom?.resize(canvas.width, canvas.height)
    silhouette.setSize(Math.ceil(canvas.width/2),Math.ceil(canvas.height/2))
    const shell = lightSurface.getBoundingClientRect()
    const wide = hero?.dataset.flight === 'launch'
    if (!wide || !studioWidth) {
      studioWidth = width
      centerShift = (2*(bounds.left-shell.left)+width)/shell.width-1
    }
    launchShift = wide ? centerShift : 0
    const aspect = studioWidth / height,
      halfWidth = Math.max(2.82, 1.11 * aspect)
    nodes.resize(width,height)
    airflow.resize(width, height, halfWidth * 2, dpr)
    camera.aspect = width / height
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(halfWidth / (standOff * aspect)))
    camera.updateProjectionMatrix()
    dirty = true
    schedule()
  }
  function schedule() {
    if (!frame && !dead && visible && !document.hidden) frame = requestAnimationFrame(draw)
  }
  function draw(now: number) {
    frame = 0
    if (dead || !visible || document.hidden) return
    if (!dirty && now - lastFrame < frameInterval) {
      schedule()
      return
    }
    const interval = lastFrame ? now - lastFrame : 42
    const dt = Math.min(0.1, interval / 1000)
    lastFrame = now
    const staticCamera = motion.matches || stillWhenIdle || paused
    if (!staticCamera) elapsed += dt
    // Absolute poses prevent cumulative camera error on Back, skip, and repeated launches.
    const direction = staticCamera ? undefined : hero?.dataset.flight
    const progress = THREE.MathUtils.clamp((now - Number(hero?.dataset.flightStart ?? now)) / 1580, 0, 1)
    const ease = (a: number, b: number) => THREE.MathUtils.smootherstep(progress, a, b)
    const launching = direction === 'launch'
    const returning = direction === 'return'
    const dip = launching ? ease(0,.23) * (1-ease(.31,.63)) : 0
    const chase = returning ? 1-ease(.42,.93) : 0
    const exit = launching ? ease(.21,.72) : 0
    const thrust = launching ? ease(.07,.49) : chase
    // The tracking rig reacts after the chassis takes off. The passing wake then rings down.
    const follow = launching ? ease(.255,.77) : 0
    const wakeAge = launching ? Math.max(0, progress-.43) : 0
    const recoil = Math.sin(wakeAge*48)*Math.exp(-wakeAge*12)
    const travel = returning ? returnTravel(progress) : launching ? launchTravel(progress) : 0
    const movingShadow = car.group.position.x !== restingX + travel
    car.group.position.x = restingX + travel
    if (movingShadow && renderer.shadowMap.enabled) renderer.shadowMap.needsUpdate = true
    road.setVehicleOffset(travel)
    airflow.group.position.x = travel
    const inReveal = !staticCamera && revealStart !== undefined && hero?.classList.contains('is-revealing')
    const shotTime = inReveal ? Math.max(0, (now - revealStart) / 1000) : 3
    const overhead = 1 - THREE.MathUtils.smootherstep(shotTime, 0.42, 2.06)
    road.setPulse(staticCamera ? -1 : (shotTime - 0.19) / 1.22)
    const speed = staticCamera
      ? 0
      : 14 * THREE.MathUtils.smoothstep(elapsed, 0.05, 0.8) * THREE.MathUtils.smoothstep(shotTime, 0.48, 1.12)
    const distance = speed * (1 + 4.6 * thrust) * dt
    flowClock += distance / 14
    car.advanceWheels(distance, speed)
    road.advance(distance, speed * (1 + 4.6 * thrust))
    // Ease into vibration after the entrance. The settled heading has no input-driven rotation.
    if (motion.matches) idleMix = 0
    else if (!staticCamera) idleMix = THREE.MathUtils.damp(idleMix, shotTime > 2.06 ? 1 : 0, 2.4, dt)
    // Most of the movement is slower than a wheel revolution. Different frequencies
    // and drifting phase keep the camera from rocking about a single pivot.
    const settle = idleMix * (launching ? 1-ease(0,.18) : returning ? ease(.73,1) : 1)
    const sway = Math.sin(elapsed*.94 + .48*Math.sin(elapsed*.37))
    const heave = Math.sin(elapsed*1.17 + .64*Math.sin(elapsed*.59))
    const drift = settle*(.014*sway + .0035*Math.sin(elapsed*1.73))
    const rise = settle*(.0065*heave + .0017*Math.sin(elapsed*2.46))
    const azimuth = -1.045 + overhead * 0.90 + drift + .79 * chase + .21*dip + .86*exit
    const elevation = 0.20 + overhead * 1.26 + rise - .139*dip - .06*chase + .005*thrust*Math.sin(now*.043)
    const activePointer = !staticCamera && now - lastPointerMove < 1100
    const damping = staticCamera ? 0 : 1 - Math.exp(-dt * (activePointer ? 3.6 : 1.45))
    lightOffset.x += ((activePointer ? pointer.x : 0) - lightOffset.x) * damping
    lightOffset.y += ((activePointer ? pointer.y : 0) - lightOffset.y) * damping
    if (motion.matches) {
      parallax.set(0, 0)
      lightOffset.set(0, 0)
    } else if (!staticCamera) {
      const follow = 1 - Math.exp(-dt * 3.8)
      parallax.x += (pointer.x * idleMix - parallax.x) * follow
      parallax.y += (pointer.y * idleMix - parallax.y) * follow
    }
    const sweep = .53 * thrust + Math.sin(elapsed * 0.24) * 0.25 + lightOffset.x * 0.62
    const lift = Math.sin(elapsed * 0.17) * 0.16 + lightOffset.y * 0.72
    key.position.set(-3.55 * Math.cos(0.74 + sweep - overhead * 1.08), 3.85 + lift, 3.55 * Math.sin(0.74 + sweep - overhead * 1.08))
    key.target.position.set(-0.62 + sweep * 0.62, 0.28, lift * 0.12)
    key.intensity = 89 * (motion.matches ? 1 : 0.27 + 0.73 * THREE.MathUtils.smoothstep(shotTime, 0.3, 1.14))
    airflow.update(flowClock, staticCamera ? 1 : THREE.MathUtils.smoothstep(shotTime, 0.78, 1.65), thrust, launching ? ease(.24,.42)*(1-ease(.44,.515)) : 0)
    mist.position.x = Math.sin(elapsed * 0.085) * 0.22
    // A little extra clearance at mid-descent keeps both wings inside the frame.
    const clearance = Math.sin(Math.PI * overhead) * Math.max(0.11, (camera.aspect - 1.65) * 0.42)
    const radius = standOff * (1 - .26*dip + .12*chase + 0.17 * overhead + clearance + settle * .0045 * Math.sin(elapsed*.79 + .3*heave))
    shotTarget.copy(aim)
    shotTarget.x -= .72*dip + 1.85*follow - 2.5*chase
    camera.position.set(
      shotTarget.x + radius * Math.sin(azimuth) * Math.cos(elevation),
      aim.y + radius * Math.sin(elevation),
      radius * Math.cos(azimuth) * Math.cos(elevation),
    )
    shotTarget.x += 1.05*chase - 1.45*follow
    camera.lookAt(shotTarget)
    camera.rotateZ(-.026*chase - .039*dip + .017*follow + .007*recoil + settle * (.0042*Math.sin(elapsed*1.08 + .4*heave) + .0011*Math.sin(elapsed*2.7)))
    // Off-axis projection holds a plane just behind the chassis steady. Near tires and
    // foreground asphalt move against the wake without changing the hero lens or heading.
    const truck = parallax.x * 0.135
    const pedestal = parallax.y * 0.058
    camera.translateX(truck + settle*(.066*sway + .018*Math.sin(elapsed*1.82)))
    camera.translateY(pedestal + .025*recoil + settle*(.036*heave + .009*Math.sin(elapsed*2.09)))
    const lens = camera.projectionMatrix.elements
    lens[8] = -launchShift -lens[0] * truck / (radius + 0.75)
    lens[9] = -lens[5] * pedestal / (radius + 0.75)
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()
    // Both layers use this render timestamp and the current camera projection.
    const shot = Number(hero?.dataset.flightStart)
    const ownership = returning ? ease(.24,.34) : 0
    airflow.beginReturn(returning, returning ? ease(.48,.68) : 1, ownership)
    if ((launching && progress > .19) || returning) {
      let trails: number[][][] | undefined
      let receive: ((row:number,points:number[][],opacity:number)=>void) | undefined
      if (returning || progress < .53) {
        camera.updateMatrixWorld()
        const bounds = canvas.getBoundingClientRect()
        if(returning) receive=(row,points,opacity)=>airflow.receive(row,points,bounds,opacity)
        trails = (returning ? returnPaths : aftPaths).map(path => path.map((point,i) => {
          const age = i/(path.length-1)
          projected.copy(point)
          // Returning tips attach to the vehicle in this frame's camera.
          projected.x += returning ? airflow.group.position.x : launchTravel(progress-age*.24)
          projected.project(camera)
          return [bounds.left+(1+projected.x)*bounds.width/2, bounds.top+(1-projected.y)*bounds.height/2]
        }))
      }
      window.dispatchEvent(new CustomEvent('studio-emission', {detail:{shot,now,trails,ownership,receive,dpr}}))
    }
    const started = performance.now()
    shutter.set(0,0)
    if (bloom && direction) {
      camera.updateMatrixWorld()
      center.set(car.group.position.x,.44,0).project(camera)
      if (shot === previousShot && center.z < 1 && Math.abs(center.x)<2.4) {
        // The car-only shutter tracks projected velocity. Shorten the exposure as the rig catches up.
        shutter.set((center.x-previousCenter.x)*canvas.width,(center.y-previousCenter.y)*canvas.height)
          .multiplyScalar((launching ? 11 + 10*ease(.25,.44) : 25)/Math.max(interval,1))
          .clampLength(0,launching ? 54 : 64)
          .multiplyScalar(launching ? 1-ease(.51,.63) : 1-ease(.61,.82))
        if (shutter.lengthSq()<1) shutter.set(0,0)
        shutter.x/=canvas.width
        shutter.y/=canvas.height
      }
      previousCenter.copy(center)
      previousShot = shot
    }
    const maskStrength = returning ? 1-ease(.74,.96) : 0
    if (maskStrength || shutter.lengthSq()>0) {
      const layers = camera.layers.mask, override = scene.overrideMaterial
      camera.layers.set(2)
      scene.overrideMaterial=matte
      renderer.setRenderTarget(silhouette)
      renderer.render(scene,camera)
      scene.overrideMaterial=override
      camera.layers.mask=layers
      renderer.setRenderTarget(null)
    }
    airflow.setSilhouette(silhouette.texture,maskStrength)
    if (bloom) bloom.render(scene, camera, shutter)
    else renderer.render(scene, camera)
    nodes.update(camera,flowClock,!staticCamera && !direction && shotTime>2.06,airflow.sampleParticle)
    if (!staticCamera && !dirty && (performance.now() - started > 31 || interval > frameInterval * 2.25 + 12))
      slow++
    else slow = Math.max(0, slow - 1)
    if (slow > 8) {
      if (smallTouch && dpr > minDpr) {
        dpr = Math.max(minDpr, dpr - 0.2)
        renderer.setPixelRatio(dpr)
        resize()
      } else if (bloom || renderer.shadowMap.enabled) {
        bloom?.dispose()
        bloom = undefined
        renderer.shadowMap.enabled = false
      } else if (frameInterval < 25) {
        frameInterval = 1000 / 30 - 1
      } else if (dpr > minDpr) {
        dpr = Math.max(minDpr, dpr - 0.25)
        renderer.setPixelRatio(dpr)
        resize()
      } else {
        stillWhenIdle = true
        host.dataset.static = 'true'
      }
      slow = 0
    }
    dirty = false
    if (!staticCamera) schedule()
  }
  function refresh() {
    dirty = true
    schedule()
  }
  function handleVisibility() {
    lastFrame = 0
    refresh()
  }
  function inspectLight(event: PointerEvent) {
    if (hero?.dataset.flight || motion.matches || stillWhenIdle || paused || event.buttons !== 0 || event.pointerType === 'touch') return
    nodes.point(event)
    const bounds = lightSurface.getBoundingClientRect()
    pointer.set(
      THREE.MathUtils.clamp((2 * (event.clientX - bounds.left)) / bounds.width - 1, -1, 1),
      THREE.MathUtils.clamp(1 - (2 * (event.clientY - bounds.top)) / bounds.height, -1, 1),
    )
    lastPointerMove = performance.now()
    schedule()
  }
  function releaseLight() {
    nodes.leave()
    pointer.set(0, 0)
    lastPointerMove = -Infinity
  }
  function toggleMotion(event: Event) {
    paused = (event as CustomEvent<boolean>).detail
    lastFrame = 0
    refresh()
  }
  function contextLost() {
    dead = true
    cancelAnimationFrame(frame)
  }
  const viewport = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting
    if (visible) handleVisibility()
  })
  const sizes = new ResizeObserver(resize)
  lightSurface.addEventListener('pointermove', inspectLight as EventListener, { passive: true })
  lightSurface.addEventListener('pointerleave', releaseLight)
  canvas.addEventListener('webglcontextlost', contextLost)
  host.addEventListener('studio-motion', toggleMotion)
  motion.addEventListener('change', refresh)
  document.addEventListener('visibilitychange', handleVisibility)
  viewport.observe(host)
  sizes.observe(host)
  resize()
  cancelAnimationFrame(frame)
  frame = 0
  draw(performance.now())
  onReady()
  return () => {
    dead = true
    cancelAnimationFrame(frame)
    lightSurface.removeEventListener('pointermove', inspectLight as EventListener)
    lightSurface.removeEventListener('pointerleave', releaseLight)
    motion.removeEventListener('change', refresh)
    canvas.removeEventListener('webglcontextlost', contextLost)
    host.removeEventListener('studio-motion', toggleMotion)
    document.removeEventListener('visibilitychange', handleVisibility)
    viewport.disconnect()
    sizes.disconnect()
    disposeVehicle(car)
    motes.dispose()
    mistMaterial.dispose()
    nodes.dispose()
    airflow.dispose()
    road.dispose()
    bloom?.dispose()
    silhouette.dispose()
    matte.dispose()
    rim.shadow.dispose()
    env.dispose()
    renderer.dispose()
    renderer.forceContextLoss()
    canvas.remove()
  }
}
