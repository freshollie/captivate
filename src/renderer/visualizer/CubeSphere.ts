import * as THREE from 'three'
import VisualizerBase, { UpdateResource } from './VisualizerBase'
import { random } from '../../shared/util'
import { Vector3 } from 'three'

const ARRAY = Array(20).fill(0)

export interface CubeSphereConfig {
  type: 'CubeSphere'
}

export function initCubeSphereConfig(): CubeSphereConfig {
  return {
    type: 'CubeSphere',
  }
}

class RandomCube {
  mesh: THREE.Mesh
  axis: Vector3

  constructor(scene: THREE.Scene) {
    const size = 3 //random(5, 5)
    const geometry = new THREE.BoxGeometry(size, size, size)
    this.mesh = new THREE.Mesh(geometry, new THREE.MeshNormalMaterial())
    this.mesh.rotation.x = random(100)
    this.mesh.rotation.y = random(100)
    this.mesh.rotation.z = random(100)
    const x = random(-3, 3)
    const y = random(-2, 2)
    geometry.translate(0, 0, 0)
    this.axis = new Vector3(x, y, 0).normalize()
    scene.add(this.mesh)
  }

  update(dt: number, {}: UpdateResource) {
    this.mesh.rotateOnAxis(this.axis, dt / 10000)
  }
}

export default class CubeSphere extends VisualizerBase {
  private cubes: RandomCube[]

  constructor() {
    super()
    this.cubes = ARRAY.map((_) => new RandomCube(this.scene))
  }

  update(dt: number, res: UpdateResource): void {
    this.cubes.forEach((cube) => cube.update(dt, res))
  }
}
