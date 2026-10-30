import * as THREE from 'three/webgpu';
import { Fn, cameraProjectionMatrix, cos, modelViewMatrix, positionGeometry, sin, vec2, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';

/**
 * Camera-facing quad: `centerSize` is the per-instance centre (xyz) and size (w), `angle` an
 * optional per-instance roll, `scale` an optional per-instance size factor (0 drops the quad).
 * The quad is expanded in view space, so it always faces the camera.
 */
export function billboardVertex(centerSize: Node<'vec4'>, angle?: Node<'float'>, scale?: Node<'float'>) {
  return Fn(() => {
    const mv = modelViewMatrix.mul(vec4(centerSize.xyz, 1.0)).toVar();
    const x = positionGeometry.x, y = positionGeometry.y;
    let q = vec2(x, y);
    if (angle) {
      const c = cos(angle), s = sin(angle);
      q = vec2(c.mul(x).sub(s.mul(y)), s.mul(x).add(c.mul(y)));
    }
    const size = scale ? centerSize.w.mul(scale) : centerSize.w;
    return cameraProjectionMatrix.mul(vec4(mv.xy.add(q.mul(size)), mv.zw));
  })();
}

/** Unit quad drawn `count` times, one instance per particle. */
export function billboardGeometry(count: number) {
  const plane = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setIndex(plane.index);
  for (const name of ['position', 'normal', 'uv']) geo.setAttribute(name, plane.getAttribute(name));
  geo.instanceCount = count;
  return geo;
}

/** Per-instance attribute that is rewritten every frame. */
export function dynamicInstanced(count: number, itemSize: number) {
  return new THREE.InstancedBufferAttribute(new Float32Array(count * itemSize), itemSize).setUsage(THREE.DynamicDrawUsage);
}
