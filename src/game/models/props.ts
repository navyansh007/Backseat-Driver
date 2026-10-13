import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { rng } from '../world/textures';

/** Paint a geometry with a flat vertex colour, optionally transformed. */
export function tint(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation, m?: THREE.Matrix4) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (m) g.applyMatrix4(m);
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  const c = new THREE.Color(color);
  const arr = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < arr.length; i += 3) {
    arr[i] = c.r;
    arr[i + 1] = c.g;
    arr[i + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

const T = (x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1));

const merge = (list: THREE.BufferGeometry[]) => {
  const g = mergeGeometries(list)!;
  g.computeBoundingSphere();
  return g;
};

export const propMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.05 });
export const propMaterialFlat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, flatShading: true });
export const propMaterialShiny = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.7 });

/** Traffic cone, 0.7 m. Origin at its centre of mass (≈ 0.25 m up). */
export function coneGeo() {
  const o = -0.25;
  return merge([
    tint(new THREE.BoxGeometry(0.4, 0.04, 0.4), 0x222222, T(0, 0.02 + o)),
    tint(new THREE.CylinderGeometry(0.035, 0.16, 0.66, 14, 1, true), 0xff5a1f, T(0, 0.37 + o)),
    tint(new THREE.CylinderGeometry(0.083, 0.11, 0.12, 14, 1, true), 0xf5f5f5, T(0, 0.42 + o)),
    tint(new THREE.CylinderGeometry(0.06, 0.068, 0.04, 14, 1, true), 0xf5f5f5, T(0, 0.58 + o)),
  ]);
}

/** Oil drum 0.9 m tall, centred. */
export function barrelGeo(color: number) {
  return merge([
    tint(new THREE.CylinderGeometry(0.29, 0.29, 0.88, 16), color),
    tint(new THREE.TorusGeometry(0.29, 0.012, 4, 16), 0x333333, T(0, 0.15, 0, Math.PI / 2)),
    tint(new THREE.TorusGeometry(0.29, 0.012, 4, 16), 0x333333, T(0, -0.15, 0, Math.PI / 2)),
  ]);
}

/** Cardboard box with tape, centred, given size. */
export function cardboardGeo(w: number, h: number, d: number) {
  return merge([
    tint(new THREE.BoxGeometry(w, h, d), 0xb98d58),
    tint(new THREE.BoxGeometry(w * 0.2, h + 0.004, d + 0.004), 0xd9c8a0),
  ]);
}

/** Shopping trolley, centred on its 0.9×1.0×0.6 box. */
export function trolleyGeo() {
  const parts: THREE.BufferGeometry[] = [];
  const steel = 0xc8ccd2;
  const y0 = -0.5;
  // basket frame (open box made of bars)
  const bar = (x: number, y: number, z: number, sx: number, sy: number, sz: number) =>
    parts.push(tint(new THREE.BoxGeometry(sx, sy, sz), steel, T(x, y + y0, z)));
  for (const s of [-1, 1]) {
    bar(s * 0.28, 0.85, 0, 0.02, 0.02, 0.9);
    bar(s * 0.28, 0.45, 0, 0.02, 0.02, 0.9);
    bar(s * 0.28, 0.65, 0.44, 0.02, 0.42, 0.02);
    bar(s * 0.28, 0.65, -0.44, 0.02, 0.42, 0.02);
    bar(s * 0.24, 0.24, 0, 0.02, 0.02, 0.9);
  }
  for (let i = -3; i <= 3; i++) bar(i * 0.08, 0.65, 0, 0.008, 0.42, 0.9);
  bar(0, 0.85, 0.44, 0.58, 0.02, 0.02);
  bar(0, 0.85, -0.44, 0.58, 0.02, 0.02);
  parts.push(tint(new THREE.CylinderGeometry(0.02, 0.02, 0.6, 8), 0xd63b3b, T(0, 0.95 + y0, -0.52, 0, 0, Math.PI / 2)));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    parts.push(tint(new THREE.BoxGeometry(0.02, 0.22, 0.02), steel, T(sx * 0.24, 0.13 + y0, sz * 0.4)));
    parts.push(tint(new THREE.CylinderGeometry(0.05, 0.05, 0.03, 10), 0x222222, T(sx * 0.24, 0.05 + y0, sz * 0.4, 0, 0, Math.PI / 2)));
  }
  return merge(parts);
}

/** Wheelie bin 0.6×1.05×0.7, centred. */
export function binGeo(color: number) {
  return merge([
    tint(new THREE.BoxGeometry(0.58, 0.95, 0.68), color, T(0, -0.05)),
    tint(new THREE.BoxGeometry(0.62, 0.06, 0.74), color, T(0, 0.46)),
    tint(new THREE.CylinderGeometry(0.1, 0.1, 0.06, 10), 0x222222, T(0.25, -0.45, -0.3, 0, 0, Math.PI / 2)),
    tint(new THREE.CylinderGeometry(0.1, 0.1, 0.06, 10), 0x222222, T(-0.25, -0.45, -0.3, 0, 0, Math.PI / 2)),
  ]);
}

/** Water-filled plastic road barrier 1.5×0.8×0.45, centred. */
export function barrierGeo(color: number) {
  const s = new THREE.Shape();
  s.moveTo(-0.22, -0.4);
  s.lineTo(0.22, -0.4);
  s.lineTo(0.16, -0.1);
  s.lineTo(0.09, 0.4);
  s.lineTo(-0.09, 0.4);
  s.lineTo(-0.16, -0.1);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 1.5, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 1 });
  g.translate(0, 0, -0.75);
  g.rotateY(Math.PI / 2);
  return merge([
    tint(g, color),
    tint(new THREE.BoxGeometry(1.2, 0.06, 0.1), 0xffffff, T(0, 0.2, 0)),
  ]);
}

/** Wooden pallet 1.2×0.14×1.0, centred. */
export function palletGeo() {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) parts.push(tint(new THREE.BoxGeometry(1.2, 0.025, 0.14), 0xa98257, T(0, 0.055, -0.43 + i * 0.215)));
  for (let i = -1; i <= 1; i++) parts.push(tint(new THREE.BoxGeometry(0.1, 0.09, 1.0), 0x8f6c45, T(i * 0.55, -0.02, 0)));
  return merge(parts);
}

/** Low-poly tree with vertex colours. Origin at the base. */
export function treeGeo(seed: number, kind: 'round' | 'pine' | 'tall') {
  const rand = rng(seed);
  const parts: THREE.BufferGeometry[] = [];
  const trunkH = kind === 'tall' ? 3.2 : kind === 'pine' ? 1.6 : 2.2;
  parts.push(tint(new THREE.CylinderGeometry(0.13, 0.2, trunkH, 6), 0x6b4f3a, T(0, trunkH / 2, 0)));
  const greens = [0x5f9a46, 0x6fa84f, 0x4f8a3e, 0x7bb35a, 0x8ab760];
  if (kind === 'pine') {
    for (let i = 0; i < 3; i++) {
      const r = 1.6 - i * 0.42;
      parts.push(tint(new THREE.ConeGeometry(r, 2.0, 7), 0x3f7a45 + i * 0x020802, T(0, trunkH + 0.6 + i * 1.05, 0, 0, rand() * 3)));
    }
  } else {
    const n = kind === 'tall' ? 4 : 3;
    for (let i = 0; i < n; i++) {
      const r = (kind === 'tall' ? 1.1 : 1.35) + rand() * 0.5;
      const g = new THREE.IcosahedronGeometry(r, 0);
      const ang = (i / n) * Math.PI * 2 + rand();
      const off = i === 0 ? 0 : 0.7;
      parts.push(
        tint(g, greens[(rand() * greens.length) | 0], T(Math.cos(ang) * off, trunkH + 0.7 + i * (kind === 'tall' ? 0.8 : 0.45), Math.sin(ang) * off, rand(), rand(), rand())),
      );
    }
  }
  return merge(parts);
}

export function hedgeGeo(len: number) {
  const parts: THREE.BufferGeometry[] = [];
  const rand = rng(len * 100);
  const n = Math.max(1, Math.round(len / 0.9));
  for (let i = 0; i < n; i++) {
    const g = new THREE.IcosahedronGeometry(0.62 + rand() * 0.15, 0);
    parts.push(tint(g, rand() > 0.5 ? 0x5d9445 : 0x4f8a3e, T(-len / 2 + (i + 0.5) * (len / n), 0.6, 0, rand(), rand(), rand())));
  }
  return merge(parts);
}

/** Double-headed lamp post, 8 m. Origin at the base. Returns body + emissive heads. */
export function lampGeo() {
  const grey = 0x5b6168;
  const body = merge([
    tint(new THREE.CylinderGeometry(0.25, 0.3, 0.5, 8), 0x9c9a94, T(0, 0.25, 0)),
    tint(new THREE.CylinderGeometry(0.08, 0.12, 8, 8), grey, T(0, 4, 0)),
    tint(new THREE.BoxGeometry(3.2, 0.08, 0.08), grey, T(0, 7.85, 0)),
    tint(new THREE.BoxGeometry(0.7, 0.14, 0.32), grey, T(1.5, 7.8, 0)),
    tint(new THREE.BoxGeometry(0.7, 0.14, 0.32), grey, T(-1.5, 7.8, 0)),
  ]);
  const heads = merge([
    tint(new THREE.BoxGeometry(0.6, 0.03, 0.26), 0xffffff, T(1.5, 7.72, 0)),
    tint(new THREE.BoxGeometry(0.6, 0.03, 0.26), 0xffffff, T(-1.5, 7.72, 0)),
  ]);
  return { body, heads };
}

export function bollardGeo() {
  return merge([
    tint(new THREE.CylinderGeometry(0.11, 0.11, 0.9, 10), 0xe8b822, T(0, 0.45, 0)),
    tint(new THREE.CylinderGeometry(0.112, 0.112, 0.1, 10), 0x222222, T(0, 0.7, 0)),
    tint(new THREE.SphereGeometry(0.11, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2), 0xe8b822, T(0, 0.9, 0)),
  ]);
}

export function benchGeo() {
  return merge([
    tint(new THREE.BoxGeometry(1.8, 0.05, 0.45), 0x9b6b43, T(0, 0.45, 0)),
    tint(new THREE.BoxGeometry(1.8, 0.4, 0.05), 0x9b6b43, T(0, 0.75, -0.22, -0.15)),
    tint(new THREE.BoxGeometry(0.06, 0.45, 0.4), 0x333333, T(-0.8, 0.22, 0)),
    tint(new THREE.BoxGeometry(0.06, 0.45, 0.4), 0x333333, T(0.8, 0.22, 0)),
  ]);
}
