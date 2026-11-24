import * as THREE from 'three'

type Surface = 'rubber' | 'carbon' | 'lacquer'

// Both renderers sample the same mipmapped microstructure in object space.
function surfaceMaps(kind: Surface) {
  const size = 128
  const height = new Float32Array(size * size)
  const roughness = new Uint8Array(size * size * 4)
  const normals = new Uint8Array(roughness.length)
  let seed = 217
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const grain = seed / 4294967296
    const u = 2 * Math.PI * x / size, v = 2 * Math.PI * y / size
    const twill = Math.sin(8 * (u + v)) * Math.cos(4 * (u - v))
    const scrub = Math.sin(11 * v + 0.9 * Math.sin(2 * u))
    const relief = kind === 'carbon' ? twill : kind === 'rubber' ? .30 * scrub + .62 * grain : .5 * Math.sin(4*u)*Math.sin(5*v) + .5 * grain
    const i = y * size + x
    height[i] = relief
    roughness.fill(Math.round(212 + 34 * relief), 4*i, 4*i+3)
    roughness[4*i+3] = 255
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x
    normals[4*i] = 128 + 56 * (height[i] - height[y*size + (x+1)%size])
    normals[4*i+1] = 128 + 56 * (height[i] - height[((y+1)%size)*size+x])
    normals[4*i+2] = normals[4*i+3] = 255
  }
  function tile(bytes: Uint8Array) {
    const map = new THREE.DataTexture(bytes, size, size)
    map.wrapS = map.wrapT = THREE.RepeatWrapping
    map.magFilter = THREE.LinearFilter
    map.minFilter = THREE.LinearMipmapLinearFilter
    map.generateMipmaps = true
    map.anisotropy = 4
    map.needsUpdate = true
    return map
  }
  return { normal: tile(normals), rough: tile(roughness) }
}

export function finishVehicle(group: THREE.Group, compact: boolean) {
  const maps = new Map<Surface, ReturnType<typeof surfaceMaps>>()
  group.traverse(mesh => {
    if (!(mesh instanceof THREE.Mesh)) return
    const m = mesh.material
    if (!(m instanceof THREE.MeshPhysicalMaterial)) return
    let surface: Surface
    switch (m.name) {
      case 'Pearl ceramic white':
      case 'Obsidian lacquer':
        surface = 'lacquer'
        m.metalness = .015
        m.ior = 1.52
        m.clearcoat = .96
        m.clearcoatRoughness = .105
        m.roughness = .35
        if (m.name === 'Pearl ceramic white') m.color.setRGB(.34,.355,.37)
        else m.color.setRGB(.006,.007,.009)
        break
      case 'Satin carbon composite':
        surface = 'carbon'
        m.metalness = 0
        m.roughness = .53
        m.clearcoat = .34
        m.clearcoatRoughness = .23
        break
      case 'Scrubbed slick rubber':
        surface = 'rubber'
        m.color.setRGB(.009,.0095,.01)
        m.ior = 1.49
        m.roughness = .69
        break
      case 'Machined titanium':
        m.roughness = .36
        return
      default: return
    }
    if (compact) return
    let textures = maps.get(surface)
    if (!textures) { textures = surfaceMaps(surface); maps.set(surface, textures) }
    const g = mesh.geometry
    const pos = g.getAttribute('position')
    const uv = new Float32Array(pos.count * 2)
    for (let i=0; i<pos.count; i++) {
      const x=pos.getX(i), y=pos.getY(i), z=pos.getZ(i)
      uv[2*i] = surface === 'rubber' ? Math.atan2(y,x) * 2 / Math.PI : 4*x+2*y
      uv[2*i+1] = surface === 'rubber' ? 4*z+Math.hypot(x,y) : 4*z-2*y
    }
    g.setAttribute('uv',new THREE.BufferAttribute(uv,2))
    m.roughnessMap = textures.rough
    m.normalMap = textures.normal
    m.normalScale.setScalar(surface === 'rubber' ? .29 : surface === 'carbon' ? .32 : .045)
    if (surface === 'lacquer') {
      m.clearcoatNormalMap = textures.normal
      m.clearcoatNormalScale.setScalar(.09)
    }
  })
  return [...maps.values()].flatMap(pair => [pair.normal, pair.rough])
}
