import * as THREE from 'three'

// Pack crushed aggregate and low-frequency binder variation into one seamless, mipmapped tile.
function asphaltTexture() {
  const size = 256
  const pixels = new Uint8Array(size * size * 4)
  let seed = 92843
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  const stones = Float32Array.from({ length: 64 * 64 }, random)
  const binder = Float32Array.from({ length: 16 * 16 }, random)
  function periodic(field: Float32Array, cells: number, x: number, y: number) {
    const u = (x * cells) / size,
      v = (y * cells) / size
    const i = Math.floor(u),
      j = Math.floor(v)
    const at = (a: number, b: number) => field[(b % cells) * cells + (a % cells)]
    const f = u - i,
      g = v - j
    return THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(at(i, j), at(i + 1, j), f),
      THREE.MathUtils.lerp(at(i, j + 1), at(i + 1, j + 1), f),
      g,
    )
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const grit = random()
      const stone = periodic(stones, 64, x, y)
      const index = (y * size + x) * 4
      pixels[index] = Math.round(255 * (0.32 * grit + 0.55 * stone + 0.13 * grit ** 6))
      pixels[index + 1] = Math.round(255 * periodic(binder, 16, x, y))
      pixels[index + 2] = Math.round(255 * grit)
      pixels[index + 3] = 255
    }
  }
  const texture = new THREE.DataTexture(pixels, size, size)
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.generateMipmaps = true
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.anisotropy = 2
  texture.needsUpdate = true
  return texture
}

export function createRollingRoad() {
  const asphalt = asphaltTexture()
  const distance = { value: 0 }
  const exposure = { value: 0 }
  const pulse = { value: -1 }
  const material = new THREE.MeshPhysicalMaterial({
    color: 0x202022,
    metalness: 0,
    roughness: 0.92,
    specularIntensity: 0.26,
    transparent: true,
    depthWrite: false,
  })
  material.onBeforeCompile = (shader) => {
    shader.uniforms.roadTexture = { value: asphalt }
    shader.uniforms.travel = distance
    shader.uniforms.roadExposure = exposure
    shader.uniforms.roadPulse = pulse
    shader.vertexShader = 'varying vec2 roadPosition;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\nroadPosition = position.xz;',
    )
    shader.fragmentShader =
      `
      varying vec2 roadPosition;
      uniform sampler2D roadTexture;
      uniform float travel;
      uniform float roadExposure;
      uniform float roadPulse;
    ` + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `
      #include <color_fragment>
      vec2 p = roadPosition;
      vec2 asphaltUv = vec2(p.x - travel, p.y);
      vec3 grit = texture2D(roadTexture, asphaltUv * vec2(0.72, 1.12)).rgb;
      float binder = texture2D(roadTexture, asphaltUv * vec2(0.09, 0.54) + 0.37).g;
      float lanes = 1.0 - smoothstep(0.05, 0.31, abs(abs(p.y) - 0.80));
      float streak = texture2D(roadTexture, asphaltUv * vec2(0.045, 1.12)).r;
      float aggregate = (0.52 + 1.25 * mix(grit.r, streak, roadExposure * 0.69)) * (0.82 + 0.35 * binder);
      // Occasional flecks sit on the belt border. The broken line and grain share the same travel.
      float marker = (1.0 - smoothstep(0.012, 0.028, abs(p.y + 1.53)))
        * (1.0 - smoothstep(0.20, 0.24, abs(mod(asphaltUv.x + 1.6, 3.2) - 1.6)));
      diffuseColor.rgb *= aggregate * (1.0 - 0.18 * lanes) + marker * (1.1 + 2.5 * grit.b);
      float edge = 1.0 - smoothstep(0.45, 1.0, length(p / vec2(5.1, 2.55)));
      diffuseColor.a *= edge;
    `,
    )
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      `
      #include <roughnessmap_fragment>
      roughnessFactor = clamp(roughnessFactor + (binder-0.5)*0.12 - lanes*0.1, 0.5, 0.99);
    `,
    )
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      `
      #include <normal_fragment_maps>
      vec2 grainUv = asphaltUv * vec2(0.72,1.12);
      vec2 slope = vec2(texture2D(roadTexture,grainUv+vec2(1.0/256.0,0.0)).r,
                        texture2D(roadTexture,grainUv+vec2(0.0,1.0/256.0)).r)-grit.rr;
      normal = normalize(normal - mat3(viewMatrix)*vec3(slope.x,0.0,slope.y)*mix(0.14,0.055,roadExposure));
    `,
    )
    // Apply contact occlusion after physical lighting, so highlights cannot lift the tire patches.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `
      vec2 axle = abs(vec2(min(abs(p.x + 1.743), abs(p.x - 1.654)), abs(p.y) - 0.800));
      vec2 footprint = axle / vec2(0.17, 0.22);
      float contact = exp(-dot(footprint, footprint));
      vec2 hull = (p - vec2(0.16, -0.06)) / vec2(2.05, 0.69);
      float bodyShade = exp(-dot(hull, hull));
      outgoingLight *= (1.0 - 0.92 * contact) * (1.0 - 0.73 * bodyShade);
      // A pulse of grazing light travels across the aggregate once on entry.
      if (roadPulse >= 0.0 && roadPulse < 1.0) {
        float radius = 5.8 * (1.0 - pow(1.0 - roadPulse, 2.0));
        float band = abs(length(p - vec2(-0.55, 0.0)) - radius);
        float core = exp(-band * 62.0) + 0.16 * exp(-band * 9.0);
        outgoingLight += vec3(0.23,0.25,0.26) * core * sin(roadPulse*3.14159) * (0.5+grit.r);
      }
      #include <opaque_fragment>
    `,
    )
  }
  const geometry = new THREE.PlaneGeometry(12, 6.6)
  geometry.rotateX(-Math.PI / 2)
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'rolling-road'
  mesh.position.y = -0.002
  mesh.renderOrder = -5
  return {
    mesh,
    setPulse(progress: number) {
      pulse.value = progress
    },
    advance(step: number, speed: number) {
      // 800 m is a shared whole number of periods for both grain scales and the paint.
      distance.value = (distance.value + step) % 800
      exposure.value = THREE.MathUtils.smoothstep(speed, 2, 12)
    },
    dispose() {
      geometry.dispose()
      material.dispose()
      asphalt.dispose()
    },
  }
}
