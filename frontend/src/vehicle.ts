import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import wrapper from 'three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js?url'
import decoder from 'three/examples/jsm/libs/draco/gltf/draco_decoder.wasm?url'
import { studioAsset } from './vehicle-source'

import { finishVehicle } from './vehicle-finishes'

export async function loadVehicle(signal: AbortSignal, compact: boolean) {
  const response = await fetch(studioAsset(compact ? 'vehicle-compact.glb' : 'vehicle.glb'), { signal })
  if (!response.ok) throw new Error('Vehicle unavailable')
  const bytes = await response.arrayBuffer()
  signal.throwIfAborted()
  const manager = new THREE.LoadingManager()
  manager.setURLModifier(url => {
    if (url.endsWith('draco_wasm_wrapper.js')) return wrapper
    if (url.endsWith('draco_decoder.wasm')) return decoder
    return url
  })
  const draco = new DRACOLoader(manager).setWorkerLimit(1)
  const loader = new GLTFLoader(manager).setDRACOLoader(draco)
  try {
    const { scene: group } = await loader.parseAsync(bytes, '')
    const wheels: THREE.Object3D[] = []
    const finishes = new Set<THREE.Material>()
    group.traverse(object => {
      if (object.userData.rollingRadius > 0) wheels.push(object)
      if (object instanceof THREE.Mesh) {
        const slots: THREE.Material[] = Array.isArray(object.material) ? object.material : [object.material]
        slots.forEach(material => finishes.add(material))
      }
    })
    const textures = finishVehicle(group, compact)
    return {
      group, materials: [...finishes], textures,
      advanceWheels(distance: number) {
        for (const wheel of wheels) {
          wheel.rotation.z = (wheel.rotation.z + distance / wheel.userData.rollingRadius) % (2 * Math.PI)
        }
      },
    }
  } finally {
    draco.dispose()
  }
}
