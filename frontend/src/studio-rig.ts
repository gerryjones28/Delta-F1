import * as THREE from 'three'
type Point = [number, number, number]
const V = (p: Point) => new THREE.Vector3(...p)

// Capture luminous diffusion panels in linear HDR once. The studio stays invisible to the camera.
export function studioRig() {
  const rig = new THREE.Scene()
  rig.background = new THREE.Color().setRGB(0.009, 0.009, 0.01)
  const panel = new THREE.PlaneGeometry(1, 1)
  const emitters: THREE.ShaderMaterial[] = []
  function softbox(position: Point, width: number, height: number, radiance: Point, roll = 0) {
    const emitter = new THREE.ShaderMaterial({
      uniforms: { radiance: { value: V(radiance) } },
      vertexShader: `varying vec2 vUv;
        void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader: `uniform vec3 radiance; varying vec2 vUv;
        void main(){
          vec2 edge=abs(2.*vUv-1.);
          float diffuser=1.-smoothstep(.72,1.,max(edge.x,edge.y));
          float bank=mix(.10,1.,pow(1.-vUv.y,.7));
          gl_FragColor=vec4(radiance*diffuser*bank,1.);
        }`,
    })
    const card = new THREE.Mesh(panel, emitter)
    card.position.copy(V(position))
    card.lookAt(0, 0, 0)
    card.rotateZ(roll)
    card.scale.set(width, height, 1)
    rig.add(card)
    emitters.push(emitter)
  }
  // Ceiling silk, long side banks, rear kicker and the dim frontal bounce card.
  softbox([-0.8, 4.8, 0.4], 6.6, 2.85, [3.3, 3.5, 3.8], 0.22)
  softbox([1.3, 2.2, -4.3], 8.2, 0.72, [13, 13.2, 13.5], -0.12)
  softbox([1.9, 1.45, 4.8], 6.1, 0.43, [12.5, 12.3, 11.9], 0.16)
  softbox([4.6, 2.9, 0.6], 2.1, 1.8, [7.6, 7.8, 8.0])
  softbox([2.4, 0.95, -3.8], 6.4, 0.31, [8.2, 8.4, 8.6], -0.09)
  softbox([-5, 1.8, -1.3], 2.8, 1.7, [1.4, 1.45, 1.54])
  // A narrow ceiling strip draws a long edge on the nose and halo.
  softbox([-1.7, 3.5, -1.4], 6.8, 0.42, [14, 14.4, 15.2], -0.28)
  return { rig, dispose() { panel.dispose(); emitters.forEach(material => material.dispose()) } }
}
