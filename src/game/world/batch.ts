import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Collects static geometry and merges it into one mesh per material.
 * UVs are regenerated in world space (planar per face orientation) so tiling
 * textures keep a constant texel density on objects of any size.
 */
export class StaticBatch {
  private lists = new Map<THREE.Material, { geos: THREE.BufferGeometry[]; shadow: boolean }>();

  constructor(private uvScale = 0.25) {}

  add(geo: THREE.BufferGeometry, mat: THREE.Material, matrix: THREE.Matrix4, castShadow = true) {
    const g = (geo.index ? geo.toNonIndexed() : geo.clone()).applyMatrix4(matrix);
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    const pos = g.attributes.position as THREE.BufferAttribute;
    const nor = g.attributes.normal as THREE.BufferAttribute;
    const uv = new Float32Array(pos.count * 2);
    const s = this.uvScale;
    for (let i = 0; i < pos.count; i++) {
      const ax = Math.abs(nor.getX(i)), ay = Math.abs(nor.getY(i)), az = Math.abs(nor.getZ(i));
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (ay >= ax && ay >= az) { uv[i * 2] = x * s; uv[i * 2 + 1] = z * s; }
      else if (ax >= az) { uv[i * 2] = z * s; uv[i * 2 + 1] = y * s; }
      else { uv[i * 2] = x * s; uv[i * 2 + 1] = y * s; }
    }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    let entry = this.lists.get(mat);
    if (!entry) {
      entry = { geos: [], shadow: castShadow };
      this.lists.set(mat, entry);
    }
    entry.geos.push(g);
  }

  box(center: THREE.Vector3Like, size: THREE.Vector3Like, mat: THREE.Material, rot?: THREE.Quaternion, castShadow = true) {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(center.x, center.y, center.z),
      rot ?? new THREE.Quaternion(),
      new THREE.Vector3(size.x, size.y, size.z),
    );
    this.add(UNIT_BOX, mat, m, castShadow);
  }

  build(parent: THREE.Object3D) {
    for (const [mat, { geos, shadow }] of this.lists) {
      const merged = mergeGeometries(geos);
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      parent.add(mesh);
    }
    this.lists.clear();
  }
}

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
