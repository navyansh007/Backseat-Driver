import * as THREE from 'three';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import type { Physics } from '../physics';
import type { StaticBatch } from './batch';
import type { Materials } from './garage';
import { CAR_COLORS, type ParkedCars } from './dynamics';

/** A named launch spot. A jump whose takeoff falls inside the box is credited to it. */
export interface StuntFeature {
  id: string;
  name: string;
  min: THREE.Vector3;
  max: THREE.Vector3;
  /** Corkscrew: roll the car through a full turn in the air (+1 = to the right). */
  roll?: 1 | -1;
}

export const feature = (id: string, name: string, min: [number, number, number], max: [number, number, number], extra: Partial<StuntFeature> = {}): StuntFeature => ({
  id, name, min: new THREE.Vector3(...min), max: new THREE.Vector3(...max), ...extra,
});

/** A static convex solid (visual + collider) through world-space points. */
export function solidHull(batch: StaticBatch, phys: Physics, pts: THREE.Vector3[], mat: THREE.Material, shadow = true) {
  batch.add(new ConvexGeometry(pts), mat, new THREE.Matrix4(), shadow);
  phys.staticHull(pts);
}

/**
 * A solid wedge rising from `low` to `high` (world x/z), `width` across.
 * `rise` may differ per side ([left, right] as seen driving up it) for a twisted corkscrew lip.
 */
export function wedge(
  batch: StaticBatch, phys: Physics, mat: THREE.Material,
  low: { x: number; z: number }, high: { x: number; z: number }, width: number, rise: number | [number, number], base = 0,
) {
  const dx = high.x - low.x, dz = high.z - low.z;
  const len = Math.hypot(dx, dz);
  const lx = (dz / len) * (width / 2), lz = (-dx / len) * (width / 2); // half-width toward the driver's left
  const [rl, rr] = typeof rise === 'number' ? [rise, rise] : rise;
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  solidHull(batch, phys, [
    v(low.x + lx, base, low.z + lz), v(low.x - lx, base, low.z - lz),
    v(high.x + lx, base + rl, high.z + lz), v(high.x - lx, base + rr, high.z - lz),
    v(high.x + lx, base, high.z + lz), v(high.x - lx, base, high.z - lz),
  ], mat);
}

let hazard: THREE.MeshStandardMaterial | null = null;
/** Yellow/black diagonal stripes; StaticBatch maps UVs in world space so stripes run across every face. */
export function hazardMaterial() {
  if (hazard) return hazard;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#f2c230';
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = '#26282c';
  for (let i = -256; i < 512; i += 64) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + 32, 0);
    ctx.lineTo(i + 32 + 256, 256);
    ctx.lineTo(i + 256, 256);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  hazard = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 });
  return hazard;
}

/**
 * The stunt yard in front of the car park: a car hop over parked cars (west),
 * a corkscrew barrel-roll ramp (east) and the gatecrasher tabletop on the boulevard.
 */
export function buildStuntYard(phys: Physics, batch: StaticBatch, mats: Materials, parked: ParkedCars): StuntFeature[] {
  const hz = hazardMaterial();
  const yardZ = -7;

  // ---------------------------------------------------------------- car hop
  // kicker (driving west) → three parked cars broadside → landing ramp
  wedge(batch, phys, hz, { x: -25, z: yardZ }, { x: -33.5, z: yardZ }, 9, 1.8);
  wedge(batch, phys, mats.concreteDark, { x: -58, z: yardZ }, { x: -43.5, z: yardZ }, 9, 1.8);
  const hopKinds = ['sedan', 'hatch', 'executive'];
  [-36.2, -38.4, -40.6].forEach((x, i) => parked.place(hopKinds[i], x, 0, yardZ + (i - 1) * 0.3, (i % 2) * Math.PI, CAR_COLORS[(i * 5 + 3) % CAR_COLORS.length]));

  // ------------------------------------------------------------- corkscrew
  // left edge rises higher than the right, so the car leaves rolling to the right
  wedge(batch, phys, hz, { x: 25, z: yardZ }, { x: 33.5, z: yardZ }, 7, [2.4, 0.7]);

  // ------------------------------------------------------------ gatecrasher
  // tabletop across the boulevard: up, flat, down
  const top = 1.3;
  wedge(batch, phys, hz, { x: 0, z: 49 }, { x: 0, z: 55.5 }, 8, top);
  wedge(batch, phys, hz, { x: 0, z: 64.5 }, { x: 0, z: 58 }, 8, top);
  batch.box({ x: 0, y: top / 2, z: 56.75 }, { x: 8, y: top, z: 2.5 }, mats.concreteDark);
  phys.staticBox({ x: 0, y: top / 2, z: 56.75 }, { x: 4, y: top / 2, z: 1.25 });

  return [
    feature('carhop', 'CAR HOP', [-38, 1.2, yardZ - 5.5], [-31, 6, yardZ + 5.5]),
    feature('carhop-back', 'CAR HOP', [-46, 1.2, yardZ - 5.5], [-40.5, 6, yardZ + 5.5]),
    feature('corkscrew', 'CORKSCREW', [31, 0.4, yardZ - 5.5], [39, 6, yardZ + 5.5], { roll: 1 }),
    feature('gatecrasher', 'GATECRASHER', [-5, 0.8, 57.5], [5, 5, 64]),
    feature('tabletop', 'TABLETOP', [-5, 0.8, 50], [5, 5, 56.5]),
  ];
}
