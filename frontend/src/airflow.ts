import * as THREE from 'three'

type Knot = [number, number, number]
const samples = 100

// Artist-directed stream tubes in car coordinates. These traces are independent of lap telemetry.
function streamPaths(axles: THREE.Vector4) {
  const paths: THREE.CatmullRomCurve3[] = []
  function lane(knots: Knot[], side: number) {
    paths.push(new THREE.CatmullRomCurve3(knots.map(([x, y, z]) => {
      const t = THREE.MathUtils.clamp((x + 1.743) / 3.397, 0, 1)
      const station = x + THREE.MathUtils.lerp(axles.x + 1.743, axles.z - 1.654, t)
      const track = THREE.MathUtils.lerp(axles.y, axles.w, t)
      const lift = 0.10 * Math.sin(t * Math.PI) * THREE.MathUtils.smoothstep(y, 0.52, 0.92)
      return new THREE.Vector3(station, y + lift, z * side * track / 0.8)
    })))
  }
  for (const side of [-1, 1]) {
    // The outer edge of the front wing turns these paths outside the tire shoulders.
    for (let i = 0; i < 4; i++) {
      const h = 0.14 + i * 0.068,
        w = i * 0.046
      lane(
        [
          [-3.75, h, 0.67 + w],
          [-2.98, h + 0.05, 0.79 + w],
          [-2.45, h + 0.11, 1.0 + w],
          [-1.77, h + 0.12, 1.06 + w],
          [-1.03, h + 0.08, 0.91 + w],
          [-0.15, h + 0.12, 0.83 + w],
          [0.84, h + 0.15, 0.87 + w],
          [1.66, h + 0.18, 1.05 + w],
          [2.48, h + 0.23, 0.99 + w],
          [3.52, h + 0.32, 0.88 + w],
        ],
        side,
      )
    }
    // A second family rises over the front slick and skirts the outer sidepod.
    for (let i = 0; i < 3; i++) {
      const z = 0.65 + i * 0.08,
        h = i * 0.033
      lane(
        [
          [-3.48, 0.25 + h, z],
          [-2.68, 0.43 + h, z],
          [-2.1, 0.75 + h, z + 0.03],
          [-1.7, 0.83 + h, z + 0.05],
          [-1.13, 0.66 + h, z + 0.06],
          [-0.39, 0.7 + h, z + 0.07],
          [0.52, 0.64 + h, z + 0.06],
          [1.28, 0.8 + h, z + 0.07],
          [1.75, 0.87 + h, z + 0.06],
          [2.43, 0.94 + h, z + 0.12],
          [3.44, 1.0 + h, z + 0.16],
        ],
        side,
      )
    }
    // The inner streams climb over the halo and engine cover into the rear-wing wake.
    for (let i = 0; i < 2; i++) {
      const z = 0.12 + i * 0.12,
        h = i * 0.05
      lane(
        [
          [-3.46, 0.29 + h, z],
          [-2.7, 0.43 + h, z],
          [-1.7, 0.53 + h, z + 0.02],
          [-0.92, 0.69 + h, z + 0.04],
          [-0.38, 0.86 + h, z + 0.06],
          [0.18, 1.01 + h, z + 0.07],
          [0.57, 1.105 + h, z + 0.08],
          [1.27, 1.0 + h, z + 0.09],
          [1.91, 1.06 + h, z + 0.11],
          [2.45, 1.1 + h, z + 0.14],
          [3.4, 1.14 + h, z + 0.21],
        ],
        side,
      )
    }
  }
  return paths
}

function labelTexture(text: string) {
  const canvas = document.createElement('canvas')
  canvas.width = 288
  canvas.height = 54
  const ctx = canvas.getContext('2d')!
  ctx.font = '32px monospace'
  ctx.fillStyle = '#c2d1d6'
  ctx.fillText(text, 8, 37)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

// Short filaments cross the incoming air, outer tire shoulders and expanding rear wake.
function speedStreaks(time: {value: number}, reveal: {value: number}, thrust: {value: number}, axles: THREE.Vector4) {
  const geometry = new THREE.BufferGeometry()
  const points: number[] = []
  const lanes: number[] = []
  const noise = (n: number) => THREE.MathUtils.euclideanModulo(Math.sin(n * 127.1 + 311.7) * 43758.5453, 1)
  for (let i = 0; i < 64; i++) {
    const layer = i < 16 ? 0 : i < 42 ? 1 : 2
    const side = i % 2 ? 1 : -1
    const width = layer === 2 ? 0.63 + noise(i + 5) * 0.72 : axles.y + 0.31 + noise(i + 5) * 0.96
    const height = 0.08 + noise(i + 17) * (layer === 1 ? 1.4 : 0.66)
    const start = layer === 2 ? axles.z - 0.15 : axles.x - 2.65
    // Two segments give each line a dim tail, a small bright core, and a tapered tip.
    for (const along of [0, 0.78, 0.78, 1]) {
      points.push(start, height, side * width)
      lanes.push(along, noise(i + 33), noise(i + 71), layer)
    }
  }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
  geometry.setAttribute('lane', new THREE.Float32BufferAttribute(lanes, 4))
  const material = new THREE.ShaderMaterial({
    uniforms: { clock: time, reveal, thrust, wheelbase: {value: axles.z - axles.x} },
    transparent: true, depthWrite: false,
    vertexShader: `attribute vec4 lane;
      uniform float clock, reveal, thrust, wheelbase;
      varying float alpha;
      void main() {
        float layer = lane.w;
        float transit = fract(lane.y + clock * (.48 + .47 * lane.z + layer * .06));
        float range = layer < .5 ? 3.3 : layer < 1.5 ? wheelbase + 5.1 : 3.25;
        float reach = (.20 + .61 * lane.z) * (layer < 1.5 ? 1. : 1.42);
        float path = transit * range + lane.x * reach * (1. + 3.5 * thrust);
        vec3 p = position + vec3(path, 0., 0.);
        float wake = layer > 1.5 ? path * path * .021 : 0.;
        p.z += sign(p.z) * (.10 * sin(path * .83 + lane.y * 4.) + wake);
        p.y += .038 * sin(path * 1.1 + lane.z * 5.) + wake * .42;
        float taper = 1. - smoothstep(.01, .20, abs(lane.x - .78));
        float gate = smoothstep(.01,.18,transit) * (1.-smoothstep(.75,1.,transit));
        alpha = (1. + .8 * thrust) * taper * gate * smoothstep(.24,1.,reveal) * (.12 + .15 * lane.z) * (layer == 1. ? .64 : 1.);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p,1.);
      }`,
    fragmentShader: `varying float alpha;
      void main(){gl_FragColor=vec4(.60,.64,.65,alpha);}`,
  })
  const streaks = new THREE.LineSegments(geometry, material)
  streaks.name = 'Atmospheric speed streaks'
  streaks.frustumCulled = false // The shader advances the lines beyond their authored start positions.
  return streaks
}

export function createAirflow(axles: THREE.Vector4) {
  const group = new THREE.Group()
  group.name = 'Illustrative airflow'
  const paths = streamPaths(axles)
  // Native WebGL lines commonly clamp to one pixel. Expand the existing path
  // into a screen-space ribbon to resolve the fractional width at every DPR.
  const positions: number[] = [], neighbors: number[] = [], indices: number[] = []
  const flow: number[] = []
  const table = new Float32Array(samples * paths.length * 4)
  paths.forEach((path, row) => {
    const vertices = path.getSpacedPoints(samples - 1)
    vertices.forEach((point, i) => {
      table.set([point.x, point.y, point.z, 1], (row * samples + i) * 4)
      const next = i === samples-1 ? i-1 : i+1
      for (const side of [-1, 1]) {
        positions.push(point.x, point.y, point.z)
        neighbors.push(vertices[next].x, vertices[next].y, vertices[next].z)
        flow.push(i/(samples-1), row, side, next/(samples-1))
      }
      const v = (row*samples+i)*2
      if (i) indices.push(v-2, v-1, v, v, v-1, v+1)
    })
  })
  const tracks = new THREE.DataTexture(table, samples, paths.length, THREE.RGBAFormat, THREE.FloatType)
  tracks.needsUpdate = true
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.setAttribute('neighbor', new THREE.Float32BufferAttribute(neighbors, 3))
  geometry.setAttribute('flow', new THREE.Float32BufferAttribute(flow, 4))
  const uniforms = { uTime: { value: 0 }, uFlutter: { value: 0 }, uViewport: { value: new THREE.Vector2(1,1) }, uReveal: { value: 1 }, uDpr: { value: 1 } }
  const lineMaterial = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    vertexShader: `attribute vec4 flow;
      attribute vec3 neighbor;
      uniform vec2 uViewport;
      varying vec2 vFlow;
      varying float vOffset;
      uniform float uTime,uFlutter;
      vec4 projectFlow(vec3 p,float t) {
        float phase=t*16.-uTime*4.8+flow.y*2.4;
        float loose=uFlutter*smoothstep(.15,.84,t);
        p.y+=loose*(.18*sin(phase)+.07*sin(2.2*phase));
        p.z+=loose*.21*cos(phase+.9*sin(5.*t));
        return projectionMatrix*modelViewMatrix*vec4(p,1.);
      }
      void main(){
        vFlow=flow.xy;
        vec4 point=projectFlow(position,flow.x), other=projectFlow(neighbor,flow.w);
        vec2 along=(other.xy*point.w-point.xy*other.w)*uViewport*sign(flow.w-flow.x);
        vec2 normal=vec2(-along.y,along.x)/max(.00001,length(along));
        vOffset=flow.z;
        point.xy+=normal*vOffset*2.*point.w/uViewport;
        gl_Position=point;
      }`,
    fragmentShader: `uniform float uTime,uReveal;
      varying vec2 vFlow;
      varying float vOffset;
      void main(){
        float s=vFlow.x;
        float edge=smoothstep(0.,.14,s)*(1.-smoothstep(.82,1.,s));
        float pulse=pow(max(0.,cos(6.28318*(s*1.6-uTime*.27+vFlow.y*.093))),8.);
        float sweep=1.-smoothstep(uReveal*1.18-.18,uReveal*1.18,s);
        float alpha=edge*sweep*(.12+.21*pulse)*(.77+.23*cos(vFlow.y*1.3));
        // Pixel coverage of a 0.88-pixel wide strand, centered on the same path.
        float coverage=max(0.,min(.44,vOffset+.5)-max(-.44,vOffset-.5));
        gl_FragColor=vec4(.69,.75,.78,alpha*coverage);
      }`,
  })
  const wires = new THREE.Mesh(geometry, lineMaterial)
  group.add(wires)
  const thrust = { value: 0 }
  const streaks = speedStreaks(uniforms.uTime, uniforms.uReveal, thrust, axles)
  group.add(streaks)
  const seeds: number[] = []
  paths.forEach((_, row) => {
    for (let j = 0; j < 3; j++) seeds.push(row, (j + ((row * 0.618) % 1)) / 3)
  })
  const dust = new THREE.BufferGeometry()
  dust.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array((seeds.length / 2) * 3), 3))
  dust.setAttribute('seed', new THREE.Float32BufferAttribute(seeds, 2))
  const particleMaterial = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uTracks: { value: tracks } },
    transparent: true,
    depthWrite: false,
    vertexShader: `attribute vec2 seed;
      uniform sampler2D uTracks;
      uniform float uTime,uDpr,uReveal;
      varying float vAlpha;
      void main(){
        float t=fract(seed.y+uTime*(.24+.025*sin(seed.x)));
        float n=t*${(samples - 1).toFixed(1)};
        vec2 uv=(vec2(floor(n),seed.x)+.5)/vec2(${samples.toFixed(1)},${paths.length.toFixed(1)});
        vec3 a=texture2D(uTracks,uv).xyz;
        vec3 b=texture2D(uTracks,uv+vec2(1./${samples.toFixed(1)},0.)).xyz;
        vec4 eye=modelViewMatrix*vec4(mix(a,b,fract(n)),1.);
        gl_Position=projectionMatrix*eye;
        gl_PointSize=uDpr*clamp((19.+5.*fract(seed.x*.67))/-eye.z,1.3,3.25);
        vAlpha=smoothstep(.02,.18,t)*(1.-smoothstep(.80,.99,t))*(1.-smoothstep(uReveal*1.18-.18,uReveal*1.18,t));
      }`,
    fragmentShader: `varying float vAlpha;
      void main(){float r=length(gl_PointCoord-.5);
        gl_FragColor=vec4(.85,.9,.92,.85*vAlpha*(1.-smoothstep(.1,.5,r)));}`,
  })
  const movingPoints = new THREE.Points(dust, particleMaterial)
  movingPoints.frustumCulled = false
  group.add(movingPoints)

  const leaderMaterial = new THREE.LineBasicMaterial({
    color: 0xaabac1,
    transparent: true,
    opacity: 0.48,
    depthWrite: false,
  })
  const leaders: number[] = []
  const labels: THREE.Sprite[] = []
  let labelGeometry: THREE.BufferGeometry | undefined
  // Identifiers index the drawn paths. They carry no physical units.
  for (const [row, t, dy, dz] of [
    [4, 0.23, 0.32, -0.42],
    [7, 0.71, 0.32, -0.39],
  ]) {
    const node = paths[row].getPointAt(t)
    const tip = node.clone().add(new THREE.Vector3(0.11, dy, dz))
    leaders.push(
      ...node.toArray(),
      ...tip.toArray(),
      ...node.clone().addScalar(-0.014).toArray(),
      ...node.clone().addScalar(0.014).toArray(),
    )
    const label = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: labelTexture('VEC / ' + String(row + 1).padStart(2, '0')),
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      }),
    )
    // Keep the renderer's disposal listener on a scene-owned quad.
    labelGeometry ??= label.geometry.clone()
    label.geometry = labelGeometry
    label.position.copy(tip)
    label.center.set(0.12, 0.1)
    label.userData.arrival = t
    labels.push(label)
    group.add(label)
  }
  const leaderGeometry = new THREE.BufferGeometry()
  leaderGeometry.setAttribute('position', new THREE.Float32BufferAttribute(leaders, 3))
  group.add(new THREE.LineSegments(leaderGeometry, leaderMaterial))
  function resize(width: number, height: number, worldWidth: number, dpr: number) {
    uniforms.uViewport.value.set(Math.max(1,Math.floor(width*dpr)), Math.max(1,Math.floor(height*dpr)))
    uniforms.uDpr.value = dpr
    for (const label of labels) {
      const widthUnits = (worldWidth * (width < 480 ? 82 : 96)) / width
      label.scale.set(widthUnits, (widthUnits * 54) / 288, 1)
    }
  }
  function update(time: number, reveal: number, acceleration = 0, flutter = 0) {
    uniforms.uFlutter.value = flutter
    thrust.value = acceleration
    uniforms.uTime.value = time
    uniforms.uReveal.value = reveal
    leaderMaterial.opacity = 0.48 * reveal
    labels.forEach((label) => {
      label.material.opacity = 0.85 * THREE.MathUtils.smoothstep(reveal, label.userData.arrival, label.userData.arrival + 0.16)
    })
  }
  function dispose() {
    geometry.dispose()
    dust.dispose()
    streaks.geometry.dispose()
    streaks.material.dispose()
    leaderGeometry.dispose()
    labelGeometry?.dispose()
    tracks.dispose()
    lineMaterial.dispose()
    particleMaterial.dispose()
    leaderMaterial.dispose()
    labels.forEach((label) => {
      label.material.map?.dispose()
      label.material.dispose()
    })
  }
  return { group, paths, resize, update, dispose }
}
