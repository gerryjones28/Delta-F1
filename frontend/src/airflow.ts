import * as THREE from 'three'

type Knot = [number, number, number]
const samples = 100

// Artist-directed stream tubes in car coordinates. These traces are independent of lap telemetry.
function streamPaths() {
  const paths: THREE.CatmullRomCurve3[] = []
  function lane(knots: Knot[], side: number) {
    paths.push(new THREE.CatmullRomCurve3(knots.map(([x, y, z]) => new THREE.Vector3(x, y, z * side))))
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

export function createAirflow() {
  const group = new THREE.Group()
  group.name = 'Illustrative airflow'
  const paths = streamPaths()
  const positions: number[] = []
  const flow: number[] = []
  const table = new Float32Array(samples * paths.length * 4)
  paths.forEach((path, row) => {
    const vertices = path.getSpacedPoints(samples - 1)
    vertices.forEach((point, i) => {
      table.set([point.x, point.y, point.z, 1], (row * samples + i) * 4)
      if (i === 0) return
      positions.push(...vertices[i - 1].toArray(), ...point.toArray())
      flow.push((i - 1) / (samples - 1), row, i / (samples - 1), row)
    })
  })
  const tracks = new THREE.DataTexture(table, samples, paths.length, THREE.RGBAFormat, THREE.FloatType)
  tracks.needsUpdate = true
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('flow', new THREE.Float32BufferAttribute(flow, 2))
  const uniforms = { uTime: { value: 0 }, uReveal: { value: 1 }, uDpr: { value: 1 } }
  const lineMaterial = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: `attribute vec2 flow;
      varying vec2 vFlow;
      void main(){vFlow=flow;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader: `uniform float uTime,uReveal;
      varying vec2 vFlow;
      void main(){
        float s=vFlow.x;
        float edge=smoothstep(0.,.14,s)*(1.-smoothstep(.82,1.,s));
        float pulse=pow(max(0.,cos(6.28318*(s*1.6-uTime*.27+vFlow.y*.093))),8.);
        float sweep=1.-smoothstep(uReveal*1.18-.18,uReveal*1.18,s);
        float alpha=edge*sweep*(.15+.25*pulse)*(.77+.23*cos(vFlow.y*1.3));
        gl_FragColor=vec4(.69,.75,.78,alpha);
      }`,
  })
  const wires = new THREE.LineSegments(geometry, lineMaterial)
  group.add(wires)
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
  function resize(width: number, worldWidth: number, dpr: number) {
    uniforms.uDpr.value = dpr
    for (const label of labels) {
      const widthUnits = (worldWidth * (width < 480 ? 82 : 96)) / width
      label.scale.set(widthUnits, (widthUnits * 54) / 288, 1)
    }
  }
  function update(time: number, reveal: number) {
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
  return { group, resize, update, dispose }
}
