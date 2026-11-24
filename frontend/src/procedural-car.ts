import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

type Point = [number, number, number]
type Section = [x: number, halfWidth: number, bottom: number, top: number]
type Finish = THREE.MeshStandardMaterial

const TAU = Math.PI * 2
const V = (p: Point) => new THREE.Vector3(...p)
const signedPower = (value: number, power: number) => Math.sign(value) * Math.abs(value) ** power

function surface(rows: number, columns: number, sample: (u: number, v: number) => Point, closed = false) {
  const positions: number[] = [],
    uv: number[] = [],
    indices: number[] = []
  for (let row = 0; row <= rows; row++) {
    for (let col = 0; col <= columns; col++) {
      positions.push(...sample(row / rows, col / columns))
      uv.push(row / rows, col / columns)
      if (row < rows && col < columns) {
        const a = row * (columns + 1) + col,
          b = a + columns + 1
        indices.push(a, b, a + 1, b, b + 1, a + 1)
      }
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  if (closed) {
    // Duplicate UVs at the wrap, but share one normal so a softbox crosses the seam continuously.
    const normals = geometry.getAttribute('normal')
    const left = new THREE.Vector3(), right = new THREE.Vector3()
    for (let row = 0; row <= rows; row++) {
      const first = row * (columns + 1), last = first + columns
      left.fromBufferAttribute(normals, first).add(right.fromBufferAttribute(normals, last)).normalize()
      normals.setXYZ(first, left.x, left.y, left.z)
      normals.setXYZ(last, left.x, left.y, left.z)
    }
  }
  return geometry
}

export function carSculpture() {
  const batches = new Map<Finish, THREE.BufferGeometry[]>()
  const textures: THREE.Texture[] = []
  function finish(color: string, metalness: number, roughness: number) {
    return new THREE.MeshStandardMaterial({ color, metalness, roughness, side: THREE.DoubleSide })
  }
  const lacquer = new THREE.MeshPhysicalMaterial({
    color: '#202123',
    metalness: 0.27,
    roughness: 0.32,
    clearcoat: 0.88,
    clearcoatRoughness: 0.105,
    ior: 1.48,
    side: THREE.DoubleSide,
  })
  const pearl = new THREE.MeshPhysicalMaterial({
    color: '#aaa9a4', metalness: 0.19, roughness: 0.33,
    clearcoat: 0.83, clearcoatRoughness: 0.16, ior: 1.48, side: THREE.DoubleSide,
  })
  const satin = finish('#555656', 0.91, 0.37),
    titanium = finish('#9d9e9c', 0.96, 0.215)
  const carbon = finish('#202021', 0.14, 0.47),
    black = finish('#121213', 0.29, 0.38)
  // A mipmapped twill modulates the clear resin's roughness at grazing angles.
  const weaveSize = 32
  const weave = new Uint8Array(weaveSize * weaveSize * 4)
  for (let y = 0; y < weaveSize; y++) {
    for (let x = 0; x < weaveSize; x++) {
      const warp = (Math.floor(x / 4) + Math.floor(y / 4)) % 4 < 2
      const fiber = Math.cos(((warp ? x : y) * Math.PI) / 2)
      const value = Math.round(190 + (warp ? 22 : 0) + 25 * fiber)
      weave.set([value, value, value, 255], (y * weaveSize + x) * 4)
    }
  }
  const resin = new THREE.DataTexture(weave, weaveSize, weaveSize)
  resin.wrapS = resin.wrapT = THREE.RepeatWrapping
  resin.repeat.set(8, 8)
  resin.generateMipmaps = true
  resin.minFilter = THREE.LinearMipmapLinearFilter
  resin.magFilter = THREE.LinearFilter
  resin.needsUpdate = true
  carbon.roughnessMap = resin
  textures.push(resin)
  const rubber = finish('#1e1e1f', 0, 0.78),
    sidewall = finish('#282829', 0, 0.54)
  // Circumferential wear and fine grain soften the wide, chalky highlight on each slick.
  const grainSize = 128
  const grain = new Uint8Array(grainSize * grainSize * 4)
  let seed = 301
  for (let y = 0; y < grainSize; y++) {
    for (let x = 0; x < grainSize; x++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      const wear = Math.sin(y * TAU / 8 + 0.3 * Math.sin(x * TAU / grainSize))
      const value = Math.round(200 + wear * 15 + 34 * (seed / 4294967296 - 0.5))
      grain.set([value, value, value, 255], 4 * (y * grainSize + x))
    }
  }
  const tread = new THREE.DataTexture(grain, grainSize, grainSize)
  tread.wrapS = tread.wrapT = THREE.RepeatWrapping
  tread.repeat.set(6, 1)
  tread.generateMipmaps = true
  tread.minFilter = THREE.LinearMipmapLinearFilter
  tread.magFilter = THREE.LinearFilter
  tread.needsUpdate = true
  rubber.roughnessMap = tread
  rubber.bumpMap = tread
  rubber.bumpScale = 0.00055
  textures.push(tread)
  const recess = finish('#09090a', 0.04, 0.78)
  const greyInk = finish('#787876', 0.19, 0.46)
  const materials: Finish[] = [
    lacquer,
    pearl,
    satin,
    titanium,
    carbon,
    black,
    rubber,
    sidewall,
    recess,
    greyInk,
  ]
  const glass = new THREE.MeshPhysicalMaterial({
    color: '#d6dadb',
    metalness: 0.03,
    roughness: 0.075,
    transmission: 0.82,
    thickness: 0.049,
    ior: 1.49,
    dispersion: 0.075,
    attenuationColor: new THREE.Color('#a3aaad'),
    attenuationDistance: 0.21,
    clearcoat: 1,
    clearcoatRoughness: 0.055,
    side: THREE.DoubleSide,
  })
  materials.push(glass)
  const identity = new THREE.Matrix4()
  const quat = new THREE.Quaternion(),
    up = new THREE.Vector3(0, 1, 0)
  function add(geometry: THREE.BufferGeometry, material: Finish, p?: Point, rot?: Point, scale?: Point) {
    let converted = geometry
    if (geometry.index) {
      converted = geometry.toNonIndexed()
      geometry.dispose()
    }
    for (const key of Object.keys(converted.attributes)) {
      if (!['position', 'normal', 'uv'].includes(key)) converted.deleteAttribute(key)
    }
    if (p || rot || scale) {
      quat.setFromEuler(new THREE.Euler(...(rot ?? ([0, 0, 0] as Point))))
      identity.compose(V(p ?? [0, 0, 0]), quat, V(scale ?? [1, 1, 1]))
      converted.applyMatrix4(identity)
    }
    if (!batches.has(material)) batches.set(material, [])
    batches.get(material)!.push(converted)
  }
  function ball(p: Point, scale: Point, mat: Finish, rot?: Point) {
    add(new THREE.SphereGeometry(1, 32, 18), mat, p, rot, scale)
  }
  function strut(a: Point, b: Point, radius: number, mat: Finish, flatten = 1) {
    const start = V(a),
      end = V(b),
      direction = end.clone().sub(start)
    const g = new THREE.CylinderGeometry(radius, radius * 0.82, direction.length(), 9)
    g.scale(1, 1, flatten)
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, direction.normalize()))
    const mid = start.lerp(end, 0.5)
    g.translate(mid.x, mid.y, mid.z)
    add(g, mat)
  }
  function tube(points: Point[], radius: number, mat: Finish) {
    const curve = new THREE.CatmullRomCurve3(points.map(V))
    add(new THREE.TubeGeometry(curve, Math.max(14, points.length * 8), radius, 10, false), mat)
  }
  function skin(sections: Section[], mat: Finish, zOffset = 0, exponent = 0.8) {
    const mid = new THREE.CatmullRomCurve3(
      sections.map(([x, , b, t]) => new THREE.Vector3(x, b, t)),
      false,
      'catmullrom',
      0.35,
    )
    const widths = new THREE.CatmullRomCurve3(
      sections.map(([x, w]) => new THREE.Vector3(x, w, 0)),
      false,
      'catmullrom',
      0.35,
    )
    function point(u: number, angle: number, offset = 0): Point {
      const { x, y: bottom, z: top } = mid.getPoint(u)
      return [
        x,
        (top + bottom) / 2 + ((top - bottom) / 2 + offset) * signedPower(Math.sin(angle), exponent),
        zOffset + (widths.getPoint(u).y + offset) * signedPower(Math.cos(angle), exponent),
      ]
    }
    add(
      surface(sections.length * 5, 36, (u, v) => point(u, v * TAU), true),
      mat,
    )
    return point
  }
  function plate(outline: [number, number][], bottom: number, thickness: number, mat: Finish) {
    const shape = new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, -z)))
    const g = new THREE.ExtrudeGeometry(shape, {
      depth: thickness,
      bevelEnabled: true,
      bevelSegments: 2,
      bevelSize: 0.012,
      bevelThickness: 0.009,
    })
    g.rotateX(-Math.PI / 2)
    g.translate(0, bottom, 0)
    add(g, mat)
  }
  function endplate(outline: [number, number][], side: number, z: number, mat: Finish) {
    const g = new THREE.ExtrudeGeometry(new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y))), {
      depth: 0.014,
      bevelEnabled: true,
      bevelSegments: 2,
      bevelSize: 0.012,
      bevelThickness: 0.007,
    })
    g.translate(0, 0, side * z - 0.007)
    add(g, mat)
  }
  function wing(
    x: number,
    y: number,
    width: number,
    chord: number,
    lift: number,
    sweep: number,
    mat: Finish,
    split = 0,
  ) {
    // A closed lenticular profile across the span. Each wing element has its own camber.
    for (const side of [-1, 1]) {
      add(
        surface(36, 32, (u, v) => {
          const span = split + (1 - split) * u,
            a = v * TAU,
            f = (1 - Math.cos(a)) * 0.5
          return [
            x + sweep * span ** 1.6 + f * chord * (1 - 0.18 * span),
            y + lift * span ** 1.8 + 0.025 * Math.sin(a) + 0.052 * f ** 2,
            side * span * width,
          ]
        }, true),
        mat,
      )
    }
  }

  // Flat floor and individually shaped outer fences.
  plate(
    [
      [-1.16, -0.36],
      [-0.78, -0.73],
      [-0.48, -0.86],
      [1.18, -0.86],
      [1.48, -0.62],
      [2.22, -0.6],
      [2.39, -0.41],
      [2.39, 0.41],
      [2.22, 0.6],
      [1.48, 0.62],
      [1.18, 0.86],
      [-0.48, 0.86],
      [-0.78, 0.73],
      [-1.16, 0.36],
    ],
    0.09,
    0.049,
    carbon,
  )
  const nose = skin(
    [
      [-2.84, 0.003, 0.27, 0.28],
      [-2.81, 0.072, 0.245, 0.323],
      [-2.71, 0.128, 0.225, 0.374],
      [-2.17, 0.147, 0.267, 0.437],
      [-1.65, 0.185, 0.307, 0.52],
      [-1.12, 0.242, 0.258, 0.6],
      [-0.77, 0.289, 0.199, 0.61],
      [-0.43, 0.347, 0.18, 0.47],
      [0.01, 0.39, 0.16, 0.423],
      [0.51, 0.376, 0.14, 0.48],
      [1.05, 0.3, 0.14, 0.54],
      [1.8, 0.16, 0.125, 0.48],
      [2.13, 0.045, 0.12, 0.37],
    ],
    lacquer,
    0,
    0.7,
  )
  // Ivory paint follows the surface through the nose and onto the cockpit bulkhead.
  add(
    surface(72, 12, (u, v) => {
      const halfWidth = 0.22 + 0.83 * Math.sin(Math.PI * u) ** 0.8
      return nose(0.035 + u * 0.482, Math.PI / 2 + (2 * v - 1) * halfWidth, 0.004)
    }),
    pearl,
  )
  // The open cockpit, heel box, shoulder pads and engine airbox form separate surfaces.
  ball([-0.085, 0.465, 0], [0.54, 0.082, 0.269], recess)
  ball([0.202, 0.489, 0], [0.184, 0.125, 0.205], black, [0, 0, -0.33])
  ball([0.25, 0.622, 0], [0.1, 0.124, 0.127], recess, [0, 0, -0.28])
  strut([-0.4, 0.476, 0], [-0.286, 0.603, 0], 0.025, carbon)
  ball([-0.295, 0.596, 0], [0.035, 0.055, 0.134], black, [0, 0, -0.12])
  for (const s of [-1, 1]) {
    skin(
      [
        [-0.64, 0.026, 0.46, 0.55],
        [-0.41, 0.07, 0.398, 0.595],
        [-0.04, 0.079, 0.369, 0.566],
        [0.29, 0.076, 0.38, 0.607],
        [0.53, 0.04, 0.41, 0.656],
      ],
      lacquer,
      0.276 * s,
    )
    tube(
      [
        [-0.59, 0.55, 0.2 * s],
        [-0.39, 0.593, 0.26 * s],
        [-0.08, 0.564, 0.29 * s],
        [0.18, 0.584, 0.283 * s],
        [0.38, 0.646, 0.2 * s],
      ],
      0.015,
      black,
    )
    tube(
      [
        [-0.455, 0.747, 0],
        [-0.405, 0.766, 0.162 * s],
        [-0.254, 0.762, 0.252 * s],
        [0.086, 0.705, 0.286 * s],
        [0.339, 0.619, 0.265 * s],
      ],
      0.038,
      titanium,
    )
    tube(
      [
        [0.33, 0.618, 0.26 * s],
        [0.287, 0.585, 0.31 * s],
        [0.257, 0.525, 0.334 * s],
      ],
      0.036,
      carbon,
    )
  }
  tube(
    [
      [-0.58, 0.539, 0],
      [-0.555, 0.632, 0],
      [-0.455, 0.747, 0],
    ],
    0.032,
    carbon,
  )
  // Laminated wind deflector, open above and behind for the halo and cockpit.
  const deflector = (u: number, v: number): Point => {
    const z = u * 2 - 1,
      taper = 1 - z * z
    return [
      -0.607 + 0.204 * z * z + v * 0.024,
      0.554 + 0.013 * z * z + v * (0.068 + 0.038 * taper),
      0.235 * z,
    ]
  }
  add(surface(38, 6, deflector), glass)
  tube(
    Array.from({ length: 10 }, (_, i) => deflector(i / 9, 1)),
    0.0047,
    titanium,
  )
  const cowl = skin(
    [
      [0.3, 0.137, 0.509, 0.737],
      [0.416, 0.196, 0.486, 0.86],
      [0.525, 0.189, 0.445, 0.97],
      [0.7, 0.168, 0.388, 0.915],
      [0.92, 0.177, 0.36, 0.793],
      [1.19, 0.161, 0.317, 0.704],
      [1.54, 0.115, 0.238, 0.624],
      [1.87, 0.059, 0.22, 0.517],
      [2.13, 0.025, 0.25, 0.423],
    ],
    lacquer,
  )
  ball([0.492, 0.837, 0], [0.093, 0.115, 0.14], pearl, [0, 0, -0.26])
  ball([0.421, 0.844, 0], [0.045, 0.076, 0.101], recess, [0, 0, -0.26])
  endplate(
    [
      [0.61, 0.904],
      [0.73, 0.925],
      [1.53, 0.774],
      [1.79, 0.632],
      [1.71, 0.576],
      [1.04, 0.698],
    ],
    1,
    0,
    lacquer,
  )
  // Deep undercut sidepods, the intake lips and a tapering outer shoulder.
  for (const s of [-1, 1]) {
    skin(
      [
        [-0.53, 0.045, 0.27, 0.347],
        [-0.36, 0.144, 0.238, 0.414],
        [0.02, 0.179, 0.189, 0.434],
        [0.58, 0.168, 0.162, 0.391],
        [1.16, 0.12, 0.158, 0.319],
        [1.56, 0.041, 0.177, 0.24],
      ],
      black,
      s * 0.412,
      0.67,
    )
    const pod = skin(
      [
        [-0.48, 0.035, 0.43, 0.54],
        [-0.399, 0.165, 0.364, 0.584],
        [-0.229, 0.222, 0.336, 0.628],
        [0.15, 0.227, 0.329, 0.638],
        [0.55, 0.194, 0.3, 0.574],
        [0.93, 0.147, 0.261, 0.464],
        [1.21, 0.104, 0.226, 0.365],
        [1.47, 0.023, 0.209, 0.263],
      ],
      lacquer,
      s * 0.456,
      0.66,
    )
    ball([-0.404, 0.475, 0.462 * s], [0.043, 0.078, 0.145], recess, [0, 0, -0.48])
    tube(
      [
        [-0.423, 0.512, 0.32 * s],
        [-0.441, 0.54, 0.446 * s],
        [-0.4, 0.538, 0.567 * s],
        [-0.335, 0.502, 0.626 * s],
      ],
      0.015,
      pearl,
    )
    const sideAngle = (angle: number) => (s === 1 ? angle : Math.PI - angle)
    add(
      surface(58, 5, (u, v) => {
        const f = 0.17 + u * 0.74,
          height = 0.28 + 0.55 * Math.sin(u * Math.PI * 0.87)
        return pod(f, sideAngle(height + (v - 0.5) * 0.88 * Math.sin(u * Math.PI)), 0.006)
      }),
      pearl,
    )
    add(
      surface(58, 2, (u, v) => {
        const f = 0.18 + u * 0.7,
          height = 0.09 + 0.46 * Math.sin(u * Math.PI * 0.87)
        return pod(f, sideAngle(height + (v - 0.5) * 0.065 * Math.sin(u * Math.PI)), 0.008)
      }),
      titanium,
    )
    add(
      surface(40, 5, (u, v) => {
        const width = 0.75 * Math.sin(Math.PI * u) ** 0.62
        return cowl(0.17 + 0.69 * u, sideAngle(0.38 + 0.74 * u + v * width), 0.006)
      }),
      pearl,
    )
    for (let i = 0; i < 8; i++) {
      add(
        surface(4, 6, (u, v) =>
          pod(0.385 + i * 0.037 + u * 0.013 + v * 0.022, sideAngle(0.78 + v * 0.64), 0.005),
        ),
        black,
      )
    }
    plate(
      [
        [-0.89, 0.44 * s],
        [-0.739, 0.766 * s],
        [-0.49, 0.77 * s],
        [-0.71, 0.49 * s],
      ],
      0.165,
      0.021,
      black,
    )
    tube(
      [
        [-0.66, 0.164, 0.744 * s],
        [-0.379, 0.177, 0.828 * s],
        [0.672, 0.155, 0.846 * s],
        [1.12, 0.143, 0.824 * s],
      ],
      0.013,
      satin,
    )
    for (let i = 0; i < 3; i++) {
      const x = 0.6 + i * 0.178
      tube(
        [
          [x, 0.163, (0.806 - 0.012 * i) * s],
          [x + 0.06, 0.187, 0.824 * s],
          [x + 0.127, 0.172, 0.849 * s],
        ],
        0.012,
        carbon,
      )
    }
    strut([-0.317, 0.558, 0.28 * s], [-0.365, 0.615, 0.571 * s], 0.013, carbon)
    ball([-0.365, 0.633, 0.598 * s], [0.089, 0.035, 0.051], lacquer)
  }
  // Stacked front flaps sweep up and outboard. The rear wing has a dished main plane.
  wing(-2.96, 0.133, 0.955, 0.29, 0.042, 0.214, carbon)
  wing(-2.757, 0.184, 0.944, 0.186, 0.062, 0.169, pearl, 0.12)
  wing(-2.604, 0.231, 0.932, 0.151, 0.089, 0.083, carbon, 0.18)
  wing(-2.472, 0.266, 0.907, 0.105, 0.108, 0.061, satin, 0.21)
  for (const s of [-1, 1]) {
    endplate(
      [
        [-2.768, 0.167],
        [-2.702, 0.305],
        [-2.552, 0.412],
        [-2.4, 0.409],
        [-2.306, 0.261],
        [-2.383, 0.133],
        [-2.674, 0.129],
      ],
      s,
      0.95,
      carbon,
    )
    strut([-2.607, 0.274, 0.093 * s], [-2.53, 0.155, 0.136 * s], 0.025, black)
    tube(
      [
        [-2.644, 0.359, 0.065 * s],
        [-2.29, 0.418, 0.084 * s],
        [-1.9, 0.47, 0.112 * s],
        [-1.52, 0.513, 0.14 * s],
      ],
      0.009,
      titanium,
    )
  }
  wing(2.155, 0.768, 0.797, 0.355, 0.064, 0.055, carbon)
  wing(2.362, 0.872, 0.794, 0.19, 0.039, 0.049, pearl)
  wing(2.055, 0.302, 0.578, 0.243, 0.065, 0.044, black)
  for (const s of [-1, 1]) {
    endplate(
      [
        [2.116, 0.822],
        [2.16, 0.936],
        [2.572, 0.951],
        [2.584, 0.814],
        [2.52, 0.689],
        [2.43, 0.623],
        [2.327, 0.672],
        [2.258, 0.756],
      ],
      s,
      0.801,
      satin,
    )
    tube(
      [
        [1.91, 0.305, 0.068 * s],
        [2.005, 0.44, 0.073 * s],
        [2.103, 0.678, 0.082 * s],
        [2.216, 0.79, 0.097 * s],
      ],
      0.037,
      carbon,
    )
    for (let i = 0; i < 3; i++) {
      const z = (0.18 + 0.145 * i) * s
      endplate(
        [
          [1.59, 0.144],
          [1.77, 0.174],
          [2.35, 0.338],
          [2.384, 0.147],
          [2.314, 0.106],
          [1.62, 0.102],
        ],
        1,
        z,
        black,
      )
    }
  }
  strut([1.73, 0.495, 0], [2.16, 0.489, 0], 0.064, titanium)
  ball([2.157, 0.489, 0], [0.009, 0.05, 0.05], recess)

  // One shared decal texture across all wheels. Print stays on each outer sidewall.
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 384
  const ctx = canvas.getContext('2d')!
  function wheelText(label: string, a: number, spacing: number) {
    ctx.font = '600 14px Arial'
    ctx.fillStyle = '#929390'
    ctx.textAlign = 'center'
    for (const ch of label) {
      ctx.save()
      ctx.translate(192, 192)
      ctx.rotate(a)
      ctx.fillText(ch, 0, -145)
      ctx.restore()
      a += spacing
    }
  }
  wheelText('D E L T A', -0.63, 0.12)
  wheelText('R A D I A L', 2.5, 0.097)
  const frontRadius = 0.373
  const frontWidth = 0.294
  // Integrate one short rotary exposure once. The front-facing decal already spans the hub.
  const wheelFace = document.createElement('canvas')
  wheelFace.width = wheelFace.height = canvas.width
  const face = wheelFace.getContext('2d')!
  face.drawImage(canvas, 0, 0)
  face.translate(192, 192)
  const pixelsPerMeter = canvas.width / (2.05 * frontRadius)
  face.scale(pixelsPerMeter, -pixelsPerMeter)
  face.lineWidth = 0.021
  face.strokeStyle = '#727271'
  for (let i = 0; i < 12; i++) {
    const a = (i * TAU) / 12
    face.beginPath()
    face.moveTo(0.065 * Math.cos(a), 0.065 * Math.sin(a))
    face.lineTo(0.191 * Math.cos(a + 0.169), 0.191 * Math.sin(a + 0.169))
    face.stroke()
  }
  const shutterCanvas = document.createElement('canvas')
  shutterCanvas.width = shutterCanvas.height = canvas.width
  const shutterCtx = shutterCanvas.getContext('2d')!
  shutterCtx.translate(192, 192)
  shutterCtx.globalCompositeOperation = 'lighter'
  shutterCtx.globalAlpha = 1 / 28
  for (let i = 0; i < 28; i++) {
    shutterCtx.save()
    shutterCtx.rotate((i / 27 - 0.5) * 0.71)
    shutterCtx.drawImage(wheelFace, -192, -192)
    shutterCtx.restore()
  }
  const shutter = new THREE.CanvasTexture(shutterCanvas)
  shutter.colorSpace = THREE.SRGBColorSpace
  textures.push(shutter)
  const print = new THREE.CanvasTexture(canvas)
  print.colorSpace = THREE.SRGBColorSpace
  textures.push(print)
  const lettering = new THREE.MeshStandardMaterial({
    map: print,
    transparent: true,
    depthWrite: false,
    roughness: 0.7,
    side: THREE.FrontSide,
  })
  const exposure = { value: 0 }
  lettering.onBeforeCompile = (shader) => {
    shader.uniforms.wheelExposure = exposure
    shader.uniforms.shutterMap = { value: shutter }
    shader.fragmentShader =
      'uniform float wheelExposure; uniform sampler2D shutterMap;\n' + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `
      vec4 sharp = texture2D(map, vMapUv);
      vec4 swept = texture2D(shutterMap, vMapUv);
      float coverage = mix(sharp.a, swept.a, wheelExposure);
      vec3 ink = mix(sharp.rgb * sharp.a, swept.rgb * swept.a, wheelExposure);
      diffuseColor *= vec4(ink / max(coverage, 0.0001), coverage);
    `,
    )
  }
  const spokes = carbon.clone()
  spokes.transparent = true
  spokes.forceSinglePass = true
  materials.push(lettering, spokes)
  function ring(x: number, y: number, z: number, r: number, thick: number, mat: Finish) {
    add(new THREE.TorusGeometry(r, thick, 6, 64), mat, [x, y, z])
  }
  // Pad-printed test indices and a small original laboratory logotype follow the paint.
  const inkCanvas = document.createElement('canvas')
  inkCanvas.width = 384
  inkCanvas.height = 256
  const ink = inkCanvas.getContext('2d')!
  ink.fillStyle = '#222222'
  ink.textAlign = 'center'
  ink.textBaseline = 'middle'
  ink.font = 'italic 900 142px Arial'
  ink.fillText('01', 192, 116)
  ink.font = 'bold 26px Arial'
  ink.fillText('D E L T A', 192, 204)
  const stamp = new THREE.CanvasTexture(inkCanvas)
  stamp.colorSpace = THREE.SRGBColorSpace
  textures.push(stamp)
  const paintPrint = new THREE.MeshStandardMaterial({
    map: stamp,
    transparent: true,
    depthWrite: false,
    roughness: 0.36,
    side: THREE.DoubleSide,
  })
  materials.push(paintPrint)
  add(
    surface(16, 16, (u, v) => nose(0.337 + v * 0.065, 2.37 - u * 1.58, 0.009)),
    paintPrint,
  )
  const group = new THREE.Group()
  const wheels: THREE.Group[] = []
  for (const front of [true, false]) {
    const x = front ? -1.743 : 1.654
    const radius = front ? frontRadius : 0.39
    const width = front ? frontWidth : 0.36
    const y = radius
    for (const s of [-1, 1]) {
      const z = (front ? 0.794 : 0.805) * s
      const wheel = new THREE.Group()
      wheel.name = `wheel-${front ? 'front' : 'rear'}-${s === 1 ? 'left' : 'right'}`
      wheel.position.set(x, y, z)
      wheel.rotation.order = 'ZYX'
      wheel.rotation.y = s === 1 ? 0 : Math.PI
      wheel.scale.set(radius / frontRadius, radius / frontRadius, width / frontWidth)
      wheel.matrixAutoUpdate = false
      wheel.updateMatrix()
      wheels.push(wheel)
      group.add(wheel)
      for (const [a, b, r] of [
        [[x - 0.41, 0.377, 0.19 * s], [x, 0.397, z - 0.095 * s], 0.025],
        [[x + 0.451, 0.433, 0.22 * s], [x, 0.408, z - 0.09 * s], 0.031],
        [[x - 0.3, 0.227, 0.2 * s], [x, 0.247, z - 0.103 * s], 0.026],
        [[x + 0.444, 0.247, 0.275 * s], [x, 0.238, z - 0.1 * s], 0.03],
        [[x + 0.29, 0.485, 0.214 * s], [x - 0.025, 0.267, z - 0.13 * s], 0.02],
        [[x + 0.345, 0.324, 0.175 * s], [x + 0.039, 0.332, z - 0.092 * s], 0.012],
      ] as [Point, Point, number][])
        strut(a, b, r, carbon, 0.72)
      ball([x, y, z - 0.118 * s], [0.115, 0.147, 0.086], black)
    }
  }
  strut([-0.841, 0.586, 0.028], [-0.87, 0.7, 0.031], 0.006, black)
  function flushBatches(attach: (geometry: THREE.BufferGeometry, material: Finish) => void) {
    for (const [material, geometries] of batches) {
      const merged = mergeGeometries(geometries, false)
      if (merged) attach(merged, material)
      geometries.forEach((geometry) => geometry.dispose())
    }
    batches.clear()
  }

  flushBatches((geometry, material) => group.add(new THREE.Mesh(geometry, material)))

  // Batch one local wheel by finish, then instance it on the four independent hub transforms.
  const outer = frontWidth * 0.5
  const profile = [
    [0.196, -0.47],
    [0.264, -0.511],
    [0.319, -0.492],
    [0.353, -0.415],
    [0.37, -0.292],
    [0.373, -0.16],
    [0.374, 0.1],
    [0.372, 0.275],
    [0.363, 0.39],
    [0.343, 0.475],
    [0.308, 0.509],
    [0.253, 0.516],
    [0.204, 0.475],
    [0.196, 0.425],
    [0.196, -0.47],
  ]
  const g = new THREE.LatheGeometry(
    profile.map(([r, h]) => new THREE.Vector2((r * frontRadius) / 0.374, h * frontWidth)),
    80,
  )
  g.rotateX(Math.PI / 2)
  add(g, rubber)
  add(new THREE.CircleGeometry(0.219, 64), black, [0, 0, outer - 0.039])
  ring(0, 0, outer - 0.012, 0.202, 0.011, satin)
  ring(0, 0, outer + 0.003, 0.217, 0.004, sidewall)
  ring(0, 0, outer + 0.005, 0.306, 0.0027, greyInk)
  ring(0, 0, outer + 0.007, 0.249, 0.0026, sidewall)
  const disk = new THREE.CylinderGeometry(0.144, 0.144, 0.014, 44)
  disk.rotateX(Math.PI / 2)
  add(disk, satin, [0, 0, outer - 0.026])
  for (let i = 0; i < 12; i++) {
    const a = (i * TAU) / 12
    strut(
      [Math.cos(a) * 0.065, Math.sin(a) * 0.065, outer + 0.009],
      [Math.cos(a + 0.169) * 0.191, Math.sin(a + 0.169) * 0.191, outer - 0.007],
      0.012,
      spokes,
    )
  }
  const nut = new THREE.CylinderGeometry(0.049, 0.055, 0.046, 8)
  nut.rotateX(Math.PI / 2)
  add(nut, titanium, [0, 0, outer + 0.009])
  ball([0, 0, outer + 0.04], [0.024, 0.024, 0.008], black)
  add(new THREE.PlaneGeometry(frontRadius * 2.05, frontRadius * 2.05), lettering, [0, 0, outer + 0.022])

  const rollingParts: THREE.InstancedMesh[] = []
  flushBatches((geometry, material) => {
    const part = new THREE.InstancedMesh(geometry, material, wheels.length)
    part.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    wheels.forEach((wheel, index) => part.setMatrixAt(index, wheel.matrix))
    part.computeBoundingSphere()
    // Spherical wheel bounds are invariant under the hub rotation.
    rollingParts.push(part)
    group.add(part)
  })

  function advanceWheels(distance: number, speed: number) {
    exposure.value = THREE.MathUtils.smoothstep(speed, 2, 10)
    spokes.opacity = 1 - 0.86 * exposure.value
    if (!distance) return
    for (const [index, wheel] of wheels.entries()) {
      wheel.rotation.z = (wheel.rotation.z + distance / wheel.position.y) % TAU
      wheel.updateMatrix()
      for (const part of rollingParts) part.setMatrixAt(index, wheel.matrix)
    }
    for (const part of rollingParts) part.instanceMatrix.needsUpdate = true
  }

  return { group, materials, textures, advanceWheels }
}

