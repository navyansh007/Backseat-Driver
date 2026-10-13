import * as THREE from 'three';
import type { Physics } from '../physics';
import type { StaticBatch } from './batch';
import type { ParkedCars, Props } from './dynamics';
import { CAR_COLORS } from './dynamics';
import { concreteTexture, rng, signTexture } from './textures';

/** Garage centre in world space and level heights. */
export const GARAGE = { x: 0, z: -45, halfX: 30, halfZ: 18, level: 4, slab: 0.3 };

export interface Materials {
  concrete: THREE.MeshStandardMaterial;
  concreteDark: THREE.MeshStandardMaterial;
  paintTeal: THREE.MeshStandardMaterial;
  paintYellow: THREE.MeshStandardMaterial;
  white: THREE.MeshStandardMaterial;
  lightStrip: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
}

export function makeMaterials(): Materials {
  const tex = concreteTexture();
  const texDark = tex.clone();
  return {
    concrete: new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, color: 0xf2efe8 }),
    concreteDark: new THREE.MeshStandardMaterial({ map: texDark, roughness: 0.95, color: 0xb9b6ae }),
    paintTeal: new THREE.MeshStandardMaterial({ color: 0x2f8f8a, roughness: 0.6 }),
    paintYellow: new THREE.MeshStandardMaterial({ color: 0xf2c230, roughness: 0.55 }),
    white: new THREE.MeshStandardMaterial({ color: 0xf4f4f0, roughness: 0.7 }),
    lightStrip: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xf4f8ff, emissiveIntensity: 1.6 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.8 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x9aa1a8, roughness: 0.4, metalness: 0.8 }),
  };
}

type Rect = [x0: number, x1: number, z0: number, z1: number];

export function buildGarage(
  scene: THREE.Scene,
  phys: Physics,
  batch: StaticBatch,
  mats: Materials,
  parked: ParkedCars,
  props: Props,
  paintLine: (x: number, y: number, z: number, w: number, l: number, yaw?: number) => void,
) {
  const { x: GX, z: GZ, level: LV, slab } = GARAGE;
  const rand = rng(404);
  const W = (x: number) => GX + x;
  const Z = (z: number) => GZ + z;

  // solid = visual + collider
  const solid = (cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, mat: THREE.Material, rot?: THREE.Quaternion, shadow = true) => {
    batch.box({ x: W(cx), y: cy, z: Z(cz) }, { x: sx, y: sy, z: sz }, mat, rot, shadow);
    phys.staticBox({ x: W(cx), y: cy, z: Z(cz) }, { x: sx / 2, y: sy / 2, z: sz / 2 }, rot);
  };
  const slabRect = (r: Rect, top: number) =>
    solid((r[0] + r[1]) / 2, top - slab / 2, (r[2] + r[3]) / 2, r[1] - r[0], slab, r[3] - r[2], mats.concrete);

  // ----------------------------------------------------------- floor slabs
  const l1: Rect[] = [[-30, 21.5, -18, 18], [21.5, 30, -18, -2], [21.5, 30, 10, 18]];
  const roof: Rect[] = [[-21.5, 30, -18, 18], [-30, -21.5, 2, 18], [-30, -21.5, -18, -10]];
  l1.forEach((r) => slabRect(r, LV));
  roof.forEach((r) => slabRect(r, LV * 2));

  // ----------------------------------------------------------------- ramps
  const rampLen = 20;
  const theta = Math.atan2(LV, rampLen);
  const slope = Math.hypot(LV, rampLen);
  const ramp = (cx: number, baseY: number, dir: 1 | -1) => {
    const a = -dir * theta;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), a);
    const n = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const midY = baseY + LV / 2;
    const c = new THREE.Vector3(cx, midY, 0).addScaledVector(n, -slab / 2);
    solid(c.x, c.y, c.z, 7, slab, slope, mats.concreteDark, q);
    // side curbs on the ramp
    for (const s of [-1, 1]) {
      const cc = new THREE.Vector3(cx + s * 3.6, midY, 0).addScaledVector(n, 0.25);
      solid(cc.x, cc.y, cc.z, 0.25, 0.5, slope, mats.paintYellow, q);
    }
    // painted chevrons up the ramp
    for (let i = -8; i <= 8; i += 4) {
      const y = midY + (i / rampLen) * LV * dir + 0.02;
      paintLine(W(cx), y, Z(i), 0.25, 2.2, 0.6);
      paintLine(W(cx), y, Z(i), 0.25, 2.2, -0.6);
    }
  };
  ramp(25.5, 0, 1); // ground → L1, rising toward +z
  ramp(-25.5, LV, -1); // L1 → roof, rising toward −z

  // safety walls next to the ramps/openings
  const wall = (x0: number, z0: number, x1: number, z1: number, y: number, h = 1.0, mat: THREE.Material = mats.concrete) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const yaw = Math.atan2(x1 - x0, z1 - z0);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    solid((x0 + x1) / 2, y + h / 2, (z0 + z1) / 2, 0.25, h, len, mat, q);
  };
  wall(21.5, -2, 21.5, 10, LV); // L1 opening, west side
  wall(21.5, -2, 30, -2, LV); // L1 opening, south side
  wall(21.4, -8, 21.4, 10, 0, 0.9, mats.paintYellow); // ground beside ramp
  wall(-21.5, -10, -21.5, 2, LV * 2); // roof opening
  wall(-30, 2, -21.5, 2, LV * 2);
  wall(-21.4, -10, -21.4, 8, LV, 0.9, mats.paintYellow); // L1 beside ramp

  // --------------------------------------------------------------- parapets
  for (const y of [LV, LV * 2]) {
    // north & south
    wall(-30, -18, 30, -18, y, 1.05, mats.concrete);
    wall(-30, 18, 30, 18, y, 1.05, mats.concrete);
    // east
    wall(30, -18, 30, 18, y, 1.05, mats.concrete);
    // west — the roof has a gap (z 8..15) facing the showroom
    if (y === LV) wall(-30, -18, -30, 18, y, 1.05, mats.concrete);
    else {
      wall(-30, -18, -30, 8, y, 1.05, mats.concrete);
      wall(-30, 15, -30, 18, y, 1.05, mats.concrete);
    }
    // teal band along the facade
    for (const [x0, z0, x1, z1] of [[-30, -18.14, 30, -18.14], [-30, 18.14, 30, 18.14], [30.14, -18, 30.14, 18]] as const) {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const yaw = Math.atan2(x1 - x0, z1 - z0);
      batch.box({ x: W((x0 + x1) / 2), y: y + 0.75, z: Z((z0 + z1) / 2) }, { x: 0.04, y: 0.22, z: len }, mats.paintTeal,
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), false);
    }
  }
  // hazard stripes around the roof gap
  for (let i = 0; i < 7; i++) {
    batch.box({ x: W(-29.6), y: LV * 2 + 0.01, z: Z(8.5 + i) }, { x: 0.8, y: 0.02, z: 0.5 }, i % 2 ? mats.dark : mats.paintYellow, undefined, false);
  }

  // ---------------------------------------------------------------- pillars
  const pillarXs = [-20, -10, 0, 10, 20];
  for (const px of pillarXs) {
    for (const pz of [-12.2, 0, 12.2]) {
      solid(px, LV, pz, 0.6, LV * 2, 0.6, mats.concrete);
      // yellow/black guard at the bottom of each level
      for (const y of [0, LV]) batch.box({ x: W(px), y: y + 0.4, z: Z(pz) }, { x: 0.64, y: 0.8, z: 0.64 }, mats.paintYellow, undefined, false);
    }
  }
  // perimeter columns
  for (let x = -30; x <= 30; x += 10) {
    for (const z of [-17.8, 17.8]) solid(x === -30 ? -29.8 : x === 30 ? 29.8 : x, LV - 0.15, z, 0.5, LV * 2 - 0.3, 0.5, mats.concrete);
  }
  for (const z of [-8, 8]) solid(29.8, LV - 0.15, z, 0.5, LV * 2 - 0.3, 0.5, mats.concrete);
  for (const z of [-8, 8]) if (z !== 8) solid(-29.8, LV - 0.15, z, 0.5, LV * 2 - 0.3, 0.5, mats.concrete);
  solid(-29.8, LV / 2, 8, 0.5, LV, 0.5, mats.concrete);

  // stair tower
  solid(-33, 6, 15, 6, 12, 6, mats.concreteDark);
  batch.box({ x: W(-33), y: 12.1, z: Z(15) }, { x: 6.4, y: 0.25, z: 6.4 }, mats.paintTeal);

  // ----------------------------------------------------------- ceiling lights
  for (const y of [LV - slab - 0.06, LV * 2 - slab - 0.06]) {
    for (const z of [-9, 9]) {
      for (let x = -25; x <= 15; x += 6) {
        if (y > LV && x < -20) continue;
        batch.box({ x: W(x), y, z: Z(z) }, { x: 1.6, y: 0.06, z: 0.18 }, mats.lightStrip, undefined, false);
      }
    }
  }

  // ------------------------------------------------------- stalls + parked
  const stallW = 2.6;
  const levels = [0, LV, LV * 2];
  for (const y of levels) {
    const rows: { z0: number; dir: 1 | -1 }[] = [
      { z0: -18, dir: 1 }, { z0: 18, dir: -1 }, { z0: 0, dir: 1 }, { z0: 0, dir: -1 },
    ];
    for (const row of rows) {
      for (let x = -20 + stallW / 2; x < 20; x += stallW) {
        const depth = 5.0;
        const zc = row.z0 + row.dir * depth / 2;
        paintLine(W(x - stallW / 2), y + 0.012, Z(zc), 0.1, depth);
        const nearPillar = pillarXs.some((px) => Math.abs(px - x) < 1.45);
        if (!nearPillar && rand() < (y === 0 ? 0.55 : y === LV ? 0.45 : 0.3)) {
          const kinds = ['sedan', 'sedan', 'hatch', 'suv', 'executive', 'van'];
          const kind = kinds[(rand() * kinds.length) | 0];
          const yaw = row.dir === 1 ? Math.PI : 0;
          // nose in (cars face the wall)
          parked.place(kind, W(x), y, Z(row.z0 + row.dir * 2.78), yaw + (rand() - 0.5) * 0.06, CAR_COLORS[(rand() * CAR_COLORS.length) | 0]);
        }
      }
      paintLine(W(20), y + 0.012, Z(row.z0 + row.dir * 2.5), 0.1, 5);
    }
  }

  // cones lining the gap and some bins
  for (let i = 0; i < 4; i++) props.add('cone', W(-27 + i * 0.1), LV * 2, Z(7.5 + i * 2.6));
  props.add('barrel', W(-26), LV * 2, Z(16.5));
  props.add('barrelBlue', W(-25.2), LV * 2, Z(16.8));
  props.add('bin', W(25), 0, Z(-16.8));
  props.add('binBlue', W(26), 0, Z(-16.8));

  // --------------------------------------------------------------- signage
  const sign = (text: string, sub: string | undefined, x: number, y: number, z: number, w: number, h: number, yaw: number, bg = '#2f8f8a', fg = '#ffffff') => {
    const tex = signTexture(text, { bg, fg, sub, w: 1024, h: Math.round(1024 * (h / w)) });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5 }));
    m.position.set(W(x), y, Z(z));
    m.rotation.y = yaw;
    scene.add(m);
  };
  sign('P', undefined, 0, 9.6, 18.3, 2.4, 2.4, 0, '#1d4f91');
  sign('CENTRAL CAR PARK', 'open 24 hours', 0, 7.0, 18.31, 9, 1.6, 0);
  sign('LEVEL 1', undefined, -10, LV + 2.6, 0.32, 3, 0.6, 0, '#f2c230', '#1a1a1a');
  sign('ROOF', undefined, -10, LV * 2 + 2.6, 0.32, 3, 0.6, 0, '#f2c230', '#1a1a1a');
  sign('UP ▲', undefined, 25.5, 3.0, -12.5, 3, 0.7, Math.PI, '#f2c230', '#1a1a1a');
  // roof sign post
  const postGeo = new THREE.CylinderGeometry(0.06, 0.06, 2.4, 8);
  batch.add(postGeo, mats.metal, new THREE.Matrix4().makeTranslation(W(-10), LV * 2 + 1.2, Z(0.3)));

  buildShowroom(scene, phys, batch, mats, parked, props);
}

/** A glass-fronted rental showroom across from the roof gap, plus the soft landing. */
function buildShowroom(scene: THREE.Scene, phys: Physics, batch: StaticBatch, mats: Materials, parked: ParkedCars, props: Props) {
  const x0 = -64, x1 = -50, z0 = -46, z1 = -24, h = 4.6;
  const solid = (cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, mat: THREE.Material) => {
    batch.box({ x: cx, y: cy, z: cz }, { x: sx, y: sy, z: sz }, mat);
    phys.staticBox({ x: cx, y: cy, z: cz }, { x: sx / 2, y: sy / 2, z: sz / 2 });
  };
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xe9e2d6, roughness: 0.85 });
  const floorMat = new THREE.MeshStandardMaterial({ color: 0xd8d5ce, roughness: 0.3, metalness: 0.05 });
  batch.box({ x: cx, y: 0.02, z: cz }, { x: x1 - x0, y: 0.04, z: z1 - z0 }, floorMat, undefined, false);
  solid(x0 + 0.2, h / 2, cz, 0.4, h, z1 - z0, wallMat); // back
  solid(cx, h / 2, z0 + 0.2, x1 - x0, h, 0.4, wallMat); // sides
  solid(cx, h / 2, z1 - 0.2, x1 - x0, h, 0.4, wallMat);
  solid(cx, h + 0.25, cz, x1 - x0 + 0.6, 0.5, z1 - z0 + 0.6, mats.paintTeal); // roof
  solid(x1, h - 0.35, cz, 0.5, 0.7, z1 - z0, mats.paintTeal); // fascia above glass
  // mullions
  for (const z of [z0 + 0.3, cz - 5.3, cz, cz + 5.3, z1 - 0.3]) solid(x1, (h - 0.7) / 2, z, 0.18, h - 0.7, 0.18, mats.metal);
  // glass panes (dynamic, they topple when hit)
  const paneW = 5.1;
  for (const z of [cz - 7.95, cz - 2.65, cz + 2.65, cz + 7.95]) props.pane(x1, 0.04, z, paneW, h - 0.78, Math.PI / 2);
  // sign
  const tex = signTexture('CAR RENTAL', { sub: 'drive away today', bg: '#ffffff', fg: '#c62828', w: 1024, h: 256 });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(9, 2.2), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.4, emissive: 0xffffff, emissiveIntensity: 0.15, emissiveMap: tex }));
  sign.position.set(x1 + 0.32, h + 0.9, cz);
  sign.rotation.y = Math.PI / 2;
  scene.add(sign);
  solid(x1 + 0.1, h + 0.9, cz, 0.2, 2.2, 9.2, mats.white);
  // counter + showroom cars
  solid(x0 + 3, 0.55, cz, 1.2, 1.1, 5, mats.dark);
  parked.place('executive', -57, 0.04, cz - 5.5, Math.PI / 2 + 0.3, 0xb01e23);
  parked.place('suv', -57, 0.04, cz + 5.5, Math.PI / 2 - 0.3, 0xf2f2ef);

  // landing pile of boxes below the roof gap
  const rand = rng(9);
  for (let layer = 0; layer < 3; layer++) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 5; j++) {
        if (layer === 2 && rand() < 0.5) continue;
        props.add(rand() < 0.5 ? 'boxBig' : 'box', -43 + i * 1.0 + (rand() - 0.5) * 0.1, layer * 0.72, -36 + j * 1.0, (rand() - 0.5) * 0.3);
      }
    }
  }
  for (let i = 0; i < 4; i++) props.add('pallet', -38.5, i * 0.15, -32 + (i % 2) * 0.05);
}
