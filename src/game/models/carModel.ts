import * as THREE from 'three';
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { blobShadowTexture, plateTexture } from '../world/textures';

/**
 * Parametric procedural car generator. Every car is built from a side profile
 * that is extruded across the width, then sculpted (tumblehome, rounded corners)
 * and dressed with lamps, grille, mirrors, plates and wheels.
 *
 * Car space: +Z forward, +Y up, ground at y = 0, origin between the axles' midpoint projection.
 */

export type RearStyle = 'notch' | 'hatch' | 'box';

export interface CarSpec {
  name: string;
  L: number; // length
  W: number; // width
  H: number; // roof height
  bottom: number; // body underside height
  hoodH: number; // hood front height
  beltH: number; // beltline height
  trunkH: number; // trunk lid height (notch only)
  wsBaseZ: number; // windshield base
  roofFrontZ: number;
  roofRearZ: number;
  rwBaseZ: number; // rear window base
  wheelR: number;
  wheelW: number;
  frontAxleZ: number;
  rearAxleZ: number;
  track: number; // half distance between wheel centres
  rear: RearStyle;
  grille: 'executive' | 'slim' | 'tall';
  plate?: string;
}

export const SPECS: Record<string, CarSpec> = {
  // The hero: a long, low, late-90s executive saloon.
  executive: {
    name: 'executive', L: 5.12, W: 1.86, H: 1.42, bottom: 0.2, hoodH: 0.8, beltH: 0.95, trunkH: 0.98,
    wsBaseZ: 0.98, roofFrontZ: 0.18, roofRearZ: -1.0, rwBaseZ: -1.62,
    wheelR: 0.345, wheelW: 0.24, frontAxleZ: 1.52, rearAxleZ: -1.55, track: 0.79, rear: 'notch', grille: 'executive',
    plate: 'RC·1997',
  },
  sedan: {
    name: 'sedan', L: 4.55, W: 1.76, H: 1.44, bottom: 0.19, hoodH: 0.78, beltH: 0.93, trunkH: 0.96,
    wsBaseZ: 0.85, roofFrontZ: 0.12, roofRearZ: -0.85, rwBaseZ: -1.38,
    wheelR: 0.32, wheelW: 0.21, frontAxleZ: 1.37, rearAxleZ: -1.33, track: 0.75, rear: 'notch', grille: 'slim',
  },
  hatch: {
    name: 'hatch', L: 4.05, W: 1.74, H: 1.48, bottom: 0.18, hoodH: 0.8, beltH: 0.94, trunkH: 0.94,
    wsBaseZ: 0.92, roofFrontZ: 0.22, roofRearZ: -1.5, rwBaseZ: -1.94,
    wheelR: 0.31, wheelW: 0.2, frontAxleZ: 1.25, rearAxleZ: -1.3, track: 0.74, rear: 'hatch', grille: 'slim',
  },
  suv: {
    name: 'suv', L: 4.75, W: 1.9, H: 1.78, bottom: 0.3, hoodH: 1.02, beltH: 1.15, trunkH: 1.15,
    wsBaseZ: 1.05, roofFrontZ: 0.35, roofRearZ: -1.95, rwBaseZ: -2.25,
    wheelR: 0.38, wheelW: 0.25, frontAxleZ: 1.45, rearAxleZ: -1.4, track: 0.8, rear: 'hatch', grille: 'tall',
  },
  van: {
    name: 'van', L: 4.9, W: 1.9, H: 1.95, bottom: 0.24, hoodH: 0.95, beltH: 1.08, trunkH: 1.08,
    wsBaseZ: 1.55, roofFrontZ: 0.95, roofRearZ: -2.3, rwBaseZ: -2.42,
    wheelR: 0.34, wheelW: 0.22, frontAxleZ: 1.6, rearAxleZ: -1.4, track: 0.8, rear: 'box', grille: 'tall',
  },
};

export type PartKey =
  | 'paint' | 'glass' | 'sideGlass' | 'chrome' | 'trim' | 'rubber' | 'head' | 'tail' | 'amber' | 'plate' | 'under'
  | 'disc' | 'caliper' | 'interior' | 'ao';

export interface CarParts {
  spec: CarSpec;
  /** Merged geometry per material slot (body, excluding wheels when built for the player). */
  parts: Partial<Record<PartKey, THREE.BufferGeometry>>;
  /** Single wheel geometry, centered, axle along X; outer face at +X. The caliper does not spin. */
  wheel: { rubber: THREE.BufferGeometry; chrome: THREE.BufferGeometry; trim: THREE.BufferGeometry; disc: THREE.BufferGeometry; caliper: THREE.BufferGeometry };
  /** Wheel centres in car space (FL, FR, RL, RR). */
  wheelPositions: THREE.Vector3[];
}

class Bag {
  private lists = new Map<PartKey, THREE.BufferGeometry[]>();
  add(key: PartKey, g: THREE.BufferGeometry, m?: THREE.Matrix4) {
    const geo = g.index ? g.toNonIndexed() : g.clone();
    if (m) geo.applyMatrix4(m);
    for (const name of Object.keys(geo.attributes)) {
      if (name !== 'position' && name !== 'normal' && !((key === 'plate' || key === 'ao') && name === 'uv')) geo.deleteAttribute(name);
    }
    if (!geo.attributes.normal) geo.computeVertexNormals();
    const list = this.lists.get(key) ?? [];
    list.push(geo);
    this.lists.set(key, list);
  }
  merge(): Partial<Record<PartKey, THREE.BufferGeometry>> {
    const out: Partial<Record<PartKey, THREE.BufferGeometry>> = {};
    for (const [k, list] of this.lists) {
      const merged = mergeGeometries(list, false);
      if (merged) {
        merged.computeBoundingSphere();
        out[k] = merged;
      }
    }
    return out;
  }
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const ONE = new THREE.Vector3(1, 1, 1);

function at(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, s: THREE.Vector3 = ONE) {
  tmpE.set(rx, ry, rz);
  tmpQ.setFromEuler(tmpE);
  return tmpM.clone().compose(new THREE.Vector3(x, y, z), tmpQ, s);
}

function box(w: number, h: number, d: number) {
  return new THREE.BoxGeometry(w, h, d);
}

function roundedBox(w: number, h: number, d: number, r: number) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  r = Math.min(r, w / 2, h / 2);
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  const g = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false, curveSegments: 4 });
  g.translate(0, 0, -d / 2);
  return g;
}

/** Line through two (z,y) points; returns z at height y. */
function lineZ(a: [number, number], b: [number, number], y: number) {
  const t = (y - a[1]) / (b[1] - a[1]);
  return a[0] + (b[0] - a[0]) * t;
}

export function buildCar(spec: CarSpec, opts: { includeWheels: boolean; interior?: boolean }): CarParts {
  const bag = new Bag();
  const { L, W, H, bottom, hoodH, beltH, trunkH } = spec;
  const hz = L / 2;
  const halfW = W / 2;
  const cabinHalf = halfW - 0.13;

  // Plan-view rounding of the nose and tail.
  const plan = (z: number) => {
    const u = Math.abs(z) / hz;
    const f = Math.max(0, (u - 0.78) / 0.22);
    return 1 - 0.11 * f * f;
  };
  const bodyHW = (y: number, z: number) =>
    (halfW - Math.max(0, y - (beltH - 0.28)) * 0.16 - Math.max(0, bottom + 0.15 - y) * 0.25) * plan(z);
  const cabinHW = (y: number, z: number) => (cabinHalf - Math.max(0, y - beltH) * 0.3) * plan(z);

  // ------------------------------------------------------------------ body
  const cowlH = beltH - 0.03;
  const hoodFrontZ = hz - 0.16;
  const top: [number, number][] = [
    [hz - 0.07, bottom],
    [hz, bottom + 0.1],
    [hz + 0.01, hoodH - 0.2],
    [hz - 0.03, hoodH - 0.06],
    [hoodFrontZ, hoodH],
    [(hoodFrontZ + spec.wsBaseZ) / 2, hoodH + (cowlH - hoodH) * 0.7],
    [spec.wsBaseZ, cowlH],
    [spec.rwBaseZ, beltH],
  ];
  if (spec.rear === 'notch') {
    top.push(
      [spec.rwBaseZ - 0.25, trunkH - 0.005],
      [-hz + 0.25, trunkH],
      [-hz + 0.06, trunkH - 0.04],
      [-hz, trunkH - 0.18],
      [-hz - 0.01, bottom + 0.22],
      [-hz + 0.06, bottom],
    );
  } else {
    top.push(
      [-hz + 0.03, beltH - 0.02],
      [-hz, beltH - 0.15],
      [-hz - 0.01, bottom + 0.22],
      [-hz + 0.06, bottom],
    );
  }

  // run the upper profile through a spline so hood, screen base and trunk flow into each other
  const shape = new THREE.Shape();
  shape.moveTo(top[0][0], top[0][1]);
  const smooth = new THREE.SplineCurve(top.slice(1, -1).map(([z, y]) => new THREE.Vector2(z, y))).getPoints(90);
  for (const p of smooth) shape.lineTo(p.x, p.y);
  shape.lineTo(top[top.length - 1][0], top[top.length - 1][1]);
  // underside with wheel arches, rear → front
  for (const az of [spec.rearAxleZ, spec.frontAxleZ]) {
    const cy = spec.wheelR;
    const R = spec.wheelR + 0.065;
    const dy = bottom - cy;
    const dz = Math.sqrt(Math.max(0.0001, R * R - dy * dy));
    shape.lineTo(az - dz, bottom);
    const a0 = Math.atan2(dy, -dz) + Math.PI * 2;
    const a1 = Math.atan2(dy, dz);
    const N = 14;
    for (let i = 1; i <= N; i++) {
      const a = a0 + (a1 - a0) * (i / N);
      shape.lineTo(az + Math.cos(a) * R, cy + Math.sin(a) * R);
    }
  }
  shape.closePath();

  const bevel = 0.05;
  const bodyGeo = new THREE.ExtrudeGeometry(shape, {
    depth: W - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: 0.035,
    bevelOffset: -0.035,
    bevelSegments: 5,
    curveSegments: 6,
  });
  // shape (x=z_car, y) extruded along +Z → rotate so extrusion runs along X
  bodyGeo.rotateY(-Math.PI / 2);
  bodyGeo.translate((W - bevel * 2) / 2, 0, 0);
  sculpt(bodyGeo, (x, y, z) => (x / halfW) * bodyHW(y, z));
  bag.add('paint', toCreasedNormals(bodyGeo, 0.6));

  // ----------------------------------------------------------------- cabin
  const wsA: [number, number] = [spec.wsBaseZ - 0.04, beltH];
  const wsB: [number, number] = [spec.roofFrontZ, H - 0.02];
  const rwA: [number, number] = [spec.roofRearZ, H - 0.03];
  const rwB: [number, number] = [spec.rwBaseZ, beltH];
  const cab = new THREE.Shape();
  cab.moveTo(spec.wsBaseZ, beltH - 0.07);
  cab.lineTo(wsA[0], wsA[1]);
  cab.lineTo(wsB[0], wsB[1]);
  cab.quadraticCurveTo(spec.roofFrontZ - 0.12, H + 0.005, spec.roofFrontZ - 0.3, H);
  cab.lineTo(spec.roofRearZ + 0.25, H);
  cab.quadraticCurveTo(spec.roofRearZ + 0.08, H, rwA[0], rwA[1]);
  cab.lineTo(rwB[0], rwB[1]);
  cab.lineTo(spec.rwBaseZ, beltH - 0.07);
  cab.closePath();
  const cbev = 0.03;
  const cabGeo = new THREE.ExtrudeGeometry(cab, {
    depth: cabinHalf * 2 - cbev * 2,
    bevelEnabled: true,
    bevelThickness: cbev,
    bevelSize: 0.03,
    bevelOffset: -0.03,
    bevelSegments: 2,
    curveSegments: 5,
  });
  cabGeo.rotateY(-Math.PI / 2);
  cabGeo.translate(cabinHalf - cbev, 0, 0);
  sculpt(cabGeo, (x, y, z) => (x / cabinHalf) * cabinHW(y, z));
  const [cabPaint, cabGlass] = splitByNormal(cabGeo, (n) => n.y > 0.72 || Math.abs(n.x) > 0.62);
  bag.add('paint', toCreasedNormals(cabPaint, 0.5));
  bag.add('glass', toCreasedNormals(cabGlass, 0.5));

  // side windows wrapped onto the cabin surface
  const yb = beltH + 0.035;
  const yt = H - 0.085;
  const zB = spec.roofFrontZ + (spec.roofRearZ - spec.roofFrontZ) * (spec.rear === 'box' ? 0.28 : 0.45);
  const frontWin: [number, number][] = [
    [lineZ(wsA, wsB, yb) - 0.1, yb],
    [lineZ(wsA, wsB, yt) - 0.09, yt],
    [zB + 0.045, yt],
    [zB + 0.045, yb],
  ];
  const rearWin: [number, number][] = [
    [zB - 0.045, yb],
    [zB - 0.045, yt],
    [lineZ(rwA, rwB, yt) + 0.09, yt],
    [lineZ(rwA, rwB, yb) + (spec.rear === 'notch' ? 0.22 : 0.1), yb + (spec.rear === 'notch' ? 0.02 : 0)],
  ];
  const pillar: [number, number][] = [
    [zB + 0.045, yb],
    [zB + 0.045, yt],
    [zB - 0.045, yt],
    [zB - 0.045, yb],
  ];
  const surround: [number, number][] = [
    [frontWin[0][0] + 0.03, yb - 0.025],
    [frontWin[1][0] + 0.03, yt + 0.025],
    [rearWin[2][0] - 0.03, yt + 0.025],
    [rearWin[3][0] - 0.03, rearWin[3][1] - 0.025],
  ];
  for (const side of [-1, 1]) {
    bag.add(spec.name === 'executive' ? 'chrome' : 'trim', wrapPanel(surround, side, (y, z) => cabinHW(y, z) + 0.003));
    bag.add('sideGlass', wrapPanel(frontWin, side, (y, z) => cabinHW(y, z) + 0.006));
    bag.add('sideGlass', wrapPanel(rearWin, side, (y, z) => cabinHW(y, z) + 0.006));
    bag.add('trim', wrapPanel(pillar, side, (y, z) => cabinHW(y, z) + 0.007));
  }

  // ---------------------------------------------------------------- details
  const front = hz;
  const lampY = hoodH - 0.13;
  // grille + headlamps
  if (spec.grille === 'executive') {
    // low, wide grille with a chrome frame and fine horizontal slats
    bag.add('chrome', roundedBox(0.62, 0.15, 0.06, 0.03), at(0, lampY - 0.01, front - 0.02));
    bag.add('trim', box(0.56, 0.11, 0.06), at(0, lampY - 0.01, front - 0.005));
    for (let i = 0; i < 4; i++) bag.add('chrome', box(0.54, 0.008, 0.02), at(0, lampY - 0.05 + i * 0.027, front + 0.03));
    for (const s of [-1, 1]) {
      bag.add('trim', roundedBox(0.44, 0.14, 0.08, 0.035), at(s * 0.58, lampY, front - 0.03));
      bag.add('head', new THREE.CylinderGeometry(0.055, 0.055, 0.04, 20), at(s * 0.46, lampY, front + 0.015, Math.PI / 2));
      bag.add('head', new THREE.CylinderGeometry(0.06, 0.06, 0.04, 20), at(s * 0.68, lampY, front + 0.01, Math.PI / 2));
      bag.add('chrome', new THREE.TorusGeometry(0.058, 0.008, 6, 20), at(s * 0.46, lampY, front + 0.035));
      bag.add('chrome', new THREE.TorusGeometry(0.063, 0.008, 6, 20), at(s * 0.68, lampY, front + 0.03));
      bag.add('amber', box(0.12, 0.035, 0.03), at(s * 0.8, lampY - 0.17, front - 0.01));
      // fog lamps in the bumper
      bag.add('head', new THREE.CylinderGeometry(0.04, 0.04, 0.03, 16), at(s * 0.6, bottom + 0.2, front + 0.0, Math.PI / 2));
    }
  } else {
    const gw = spec.grille === 'tall' ? 0.7 : 0.6;
    const gh = spec.grille === 'tall' ? 0.2 : 0.09;
    bag.add('trim', roundedBox(gw, gh, 0.06, 0.03), at(0, lampY - 0.03, front - 0.01));
    bag.add('chrome', box(gw * 0.9, 0.012, 0.02), at(0, lampY - 0.03, front + 0.025));
    for (const s of [-1, 1]) {
      bag.add('trim', roundedBox(0.36, 0.12, 0.07, 0.04), at(s * (gw / 2 + 0.2), lampY + 0.01, front - 0.025));
      bag.add('head', roundedBox(0.3, 0.08, 0.04, 0.03), at(s * (gw / 2 + 0.2), lampY + 0.01, front + 0.005));
    }
  }
  // bumpers
  bag.add('trim', box(W * 0.9, 0.12, 0.12), at(0, bottom + 0.13, front - 0.035));
  bag.add('trim', box(W * 0.9, 0.12, 0.12), at(0, bottom + 0.13, -hz + 0.035));
  // underbody
  bag.add('under', box(W - 0.2, 0.1, L - 0.4), at(0, bottom + 0.06, 0));

  // tail lamps
  if (spec.rear === 'notch') {
    const ty = trunkH - 0.13;
    for (const s of [-1, 1]) {
      bag.add('tail', box(W * 0.3, 0.12, 0.05), at(s * W * 0.31, ty, -hz - 0.0));
      bag.add('amber', box(W * 0.07, 0.12, 0.05), at(s * W * 0.135, ty, -hz + 0.003));
    }
    bag.add('chrome', box(W * 0.12, 0.02, 0.04), at(0, ty + 0.05, -hz + 0.005));
  } else {
    for (const s of [-1, 1]) {
      bag.add('tail', box(0.12, 0.38, 0.05), at(s * (halfW * plan(-hz) - 0.1), beltH - 0.12, -hz - 0.0));
    }
  }
  // plates
  const plateGeo = box(0.52, 0.12, 0.012);
  bag.add('plate', plateGeo, at(0, bottom + 0.27, front + 0.015));
  bag.add('plate', plateGeo, at(0, (spec.rear === 'notch' ? trunkH - 0.34 : beltH - 0.4), -hz - 0.012, 0, Math.PI));

  // mirrors
  for (const s of [-1, 1]) {
    const mx = s * (bodyHW(beltH, spec.wsBaseZ) + 0.08);
    bag.add('paint', roundedBox(0.16, 0.1, 0.07, 0.03), at(mx, beltH + 0.08, spec.wsBaseZ - 0.12, 0, s * 0.15));
    bag.add('trim', box(0.12, 0.04, 0.04), at(mx - s * 0.06, beltH + 0.04, spec.wsBaseZ - 0.1));
    // door handles + rub strip
    for (const hzD of [zB + 0.45, zB - 0.6]) {
      bag.add('chrome', box(0.02, 0.025, 0.16), at(s * (bodyHW(beltH - 0.12, hzD) + 0.008), beltH - 0.12, hzD));
    }
    const ry = bottom + 0.3;
    const len = spec.frontAxleZ - spec.rearAxleZ - 0.95;
    const midZ = (spec.frontAxleZ + spec.rearAxleZ) / 2;
    bag.add('trim', box(0.02, 0.05, len), at(s * (bodyHW(ry, midZ) + 0.005), ry, midZ));
    bag.add('chrome', box(0.01, 0.008, len), at(s * (bodyHW(ry, midZ) + 0.016), ry + 0.012, midZ));
    // belt-line chrome
    bag.add('chrome', box(0.012, 0.012, spec.wsBaseZ - spec.rwBaseZ - 0.2), at(s * (bodyHW(beltH, 0) - 0.005), beltH - 0.005, (spec.wsBaseZ + spec.rwBaseZ) / 2));
  }
  // exhaust
  bag.add('chrome', new THREE.CylinderGeometry(0.035, 0.035, 0.12, 12), at(-W * 0.3, bottom + 0.05, -hz + 0.02, Math.PI / 2));

  // panel gaps: thin dark seams wrapped onto the doors
  const seamTop = beltH - 0.035;
  const seamBottom = bottom + 0.2;
  const doorCuts = [lineZ(wsA, wsB, beltH) - 0.04, zB, spec.rear === 'notch' ? spec.rwBaseZ + 0.12 : spec.rearAxleZ + 0.52];
  for (const side of [-1, 1]) {
    for (const cz of doorCuts) {
      const seam: [number, number][] = [[cz + 0.004, seamBottom], [cz + 0.004, seamTop], [cz - 0.004, seamTop], [cz - 0.004, seamBottom]];
      bag.add('trim', wrapPanel(seam, side, (y, z) => bodyHW(y, z) + 0.0015));
    }
    // side indicator repeater on the front wing
    bag.add('amber', box(0.012, 0.025, 0.07), at(side * (bodyHW(beltH - 0.16, spec.frontAxleZ + 0.55) + 0.004), beltH - 0.16, spec.frontAxleZ + 0.55));
  }

  // dark wheel-arch liners so you can't see through the arches
  for (const az of [spec.frontAxleZ, spec.rearAxleZ]) {
    const liner = new THREE.CylinderGeometry(spec.wheelR + 0.055, spec.wheelR + 0.055, W - 0.22, 20, 1, true, 0, Math.PI);
    liner.rotateZ(Math.PI / 2);
    bag.add('under', liner, at(0, spec.wheelR, az));
  }

  // soft contact shadow under the car
  const ao = new THREE.PlaneGeometry(W + 0.7, L + 0.8);
  ao.rotateX(-Math.PI / 2);
  bag.add('ao', ao, at(0, 0.02, 0));

  // cabin interior (only for the hero car, whose glass is see-through)
  if (opts.interior) {
    const seatY = bottom + 0.42;
    const dashZ = spec.wsBaseZ - 0.3;
    bag.add('interior', box(W - 0.34, 0.2, 0.45), at(0, beltH - 0.06, dashZ));
    bag.add('interior', box(W - 0.4, 0.08, 0.5), at(0, beltH + 0.04, dashZ - 0.05, -0.15));
    const wheelGeo = new THREE.TorusGeometry(0.17, 0.022, 8, 24);
    bag.add('trim', wheelGeo, at(0.38, beltH + 0.07, dashZ - 0.38, -0.45));
    bag.add('trim', new THREE.CylinderGeometry(0.03, 0.03, 0.3, 8), at(0.38, beltH + 0.0, dashZ - 0.22, Math.PI / 2 - 0.45));
    const frontSeatZ = zB + 0.15;
    const rearSeatZ = (zB + spec.roofRearZ) / 2 - 0.15;
    for (const sx of [-0.38, 0.38]) {
      bag.add('interior', box(0.5, 0.14, 0.5), at(sx, seatY, frontSeatZ));
      bag.add('interior', roundedBox(0.48, 0.62, 0.13, 0.06), at(sx, seatY + 0.38, frontSeatZ - 0.27, -0.2));
      bag.add('interior', box(0.26, 0.16, 0.1), at(sx, seatY + 0.76, frontSeatZ - 0.33, -0.2));
    }
    bag.add('interior', box(W - 0.42, 0.14, 0.5), at(0, seatY, rearSeatZ));
    bag.add('interior', box(W - 0.42, 0.55, 0.14), at(0, seatY + 0.34, rearSeatZ - 0.3, -0.25));
    bag.add('interior', box(W - 0.4, 0.04, 0.4), at(0, beltH - 0.02, spec.rwBaseZ + 0.25));
    bag.add('interior', box(W - 0.3, 0.04, spec.wsBaseZ - spec.rwBaseZ), at(0, bottom + 0.3, (spec.wsBaseZ + spec.rwBaseZ) / 2));
  }

  // ----------------------------------------------------------------- wheels
  const wheel = buildWheel(spec.wheelR, spec.wheelW, spec.name === 'executive');
  const wheelPositions = [
    new THREE.Vector3(spec.track, spec.wheelR, spec.frontAxleZ),
    new THREE.Vector3(-spec.track, spec.wheelR, spec.frontAxleZ),
    new THREE.Vector3(spec.track, spec.wheelR, spec.rearAxleZ),
    new THREE.Vector3(-spec.track, spec.wheelR, spec.rearAxleZ),
  ];
  if (opts.includeWheels) {
    for (const p of wheelPositions) {
      const s = p.x > 0 ? 1 : -1;
      const m = at(p.x, p.y, p.z, 0, 0, 0, new THREE.Vector3(s, 1, 1));
      // mirrored geometry has flipped winding; rebuild normals via flip of x scale
      bag.add('rubber', flipIfNeeded(wheel.rubber, m, s));
      bag.add('chrome', flipIfNeeded(wheel.chrome, m, s));
      bag.add('trim', flipIfNeeded(wheel.trim, m, s));
      bag.add('disc', flipIfNeeded(wheel.disc, m, s));
      bag.add('caliper', flipIfNeeded(wheel.caliper, m, s));
    }
  }

  return { spec, parts: bag.merge(), wheel, wheelPositions };
}

function flipIfNeeded(g: THREE.BufferGeometry, m: THREE.Matrix4, s: number) {
  const geo = (g.index ? g.toNonIndexed() : g.clone()).applyMatrix4(m);
  if (s < 0) {
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const nor = geo.attributes.normal as THREE.BufferAttribute | undefined;
    for (let i = 0; i < pos.count; i += 3) {
      // swap vertex 1 and 2 to restore CCW winding
      for (const attr of [pos, nor]) {
        if (!attr) continue;
        const ax = attr.getX(i + 1), ay = attr.getY(i + 1), az = attr.getZ(i + 1);
        attr.setXYZ(i + 1, attr.getX(i + 2), attr.getY(i + 2), attr.getZ(i + 2));
        attr.setXYZ(i + 2, ax, ay, az);
      }
    }
  }
  return geo;
}

/** Remap X of every vertex with fn(x, y, z). */
function sculpt(g: THREE.BufferGeometry, fn: (x: number, y: number, z: number) => number) {
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    pos.setX(i, fn(pos.getX(i), pos.getY(i), pos.getZ(i)));
  }
  pos.needsUpdate = true;
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _n = new THREE.Vector3();
function splitByNormal(g: THREE.BufferGeometry, pickA: (n: THREE.Vector3) => boolean): [THREE.BufferGeometry, THREE.BufferGeometry] {
  const src = g.index ? g.toNonIndexed() : g;
  const pos = src.attributes.position as THREE.BufferAttribute;
  const A: number[] = [], B: number[] = [];
  for (let i = 0; i < pos.count; i += 3) {
    _a.fromBufferAttribute(pos, i);
    _b.fromBufferAttribute(pos, i + 1);
    _c.fromBufferAttribute(pos, i + 2);
    _n.subVectors(_c, _b).cross(_a.clone().sub(_b)).normalize();
    const target = pickA(_n) ? A : B;
    target.push(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z, _c.x, _c.y, _c.z);
  }
  const mk = (arr: number[]) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    geo.computeVertexNormals();
    return geo;
  };
  return [mk(A), mk(B)];
}

/** A flat polygon given in (z,y), wrapped onto a side surface whose |x| is xAt(y,z). */
function wrapPanel(poly: [number, number][], side: number, xAt: (y: number, z: number) => number) {
  const s = new THREE.Shape(poly.map(([z, y]) => new THREE.Vector2(z, y)));
  const g = new THREE.ShapeGeometry(s, 1);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getX(i), y = pos.getY(i);
    out[i * 3] = side * xAt(y, z);
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(out, 3));
  geo.setIndex(g.index);
  const idx = geo.toNonIndexed();
  // ensure outward-facing winding
  idx.computeVertexNormals();
  const n = idx.attributes.normal as THREE.BufferAttribute;
  if (Math.sign(n.getX(0)) !== side) {
    const p = idx.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i += 3) {
      const x = p.getX(i + 1), y = p.getY(i + 1), z = p.getZ(i + 1);
      p.setXYZ(i + 1, p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2));
      p.setXYZ(i + 2, x, y, z);
    }
    idx.computeVertexNormals();
  }
  return idx;
}

/** Wheel: lathe-turned tyre, dished rim with spokes. Axle along X, outer face at +X. */
function buildWheel(r: number, w: number, multiSpoke: boolean) {
  const rimR = r * 0.66;
  const pts = [
    new THREE.Vector2(rimR * 0.98, -w / 2),
    new THREE.Vector2(r - 0.045, -w / 2),
    new THREE.Vector2(r - 0.012, -w / 2 + 0.02),
    new THREE.Vector2(r, -w / 2 + 0.05),
    new THREE.Vector2(r, w / 2 - 0.05),
    new THREE.Vector2(r - 0.012, w / 2 - 0.02),
    new THREE.Vector2(r - 0.045, w / 2),
    new THREE.Vector2(rimR * 0.98, w / 2),
  ];
  const tyre = new THREE.LatheGeometry(pts, 40);
  tyre.rotateZ(-Math.PI / 2);
  tyre.computeVertexNormals();

  const chromeParts: THREE.BufferGeometry[] = [];
  const lip = new THREE.TorusGeometry(rimR, 0.012, 6, 28);
  lip.rotateY(Math.PI / 2);
  lip.translate(w / 2 - 0.01, 0, 0);
  chromeParts.push(lip.toNonIndexed());
  const hub = new THREE.CylinderGeometry(rimR * 0.22, rimR * 0.26, 0.04, 16);
  hub.rotateZ(Math.PI / 2);
  hub.translate(w / 2 - 0.02, 0, 0);
  chromeParts.push(hub.toNonIndexed());
  const spokes = multiSpoke ? 10 : 5;
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2;
    const sp = new THREE.BoxGeometry(0.025, rimR * 0.82, multiSpoke ? 0.028 : 0.05);
    sp.translate(0, rimR * 0.5, 0);
    sp.rotateX(a);
    sp.translate(w / 2 - 0.035, 0, 0);
    chromeParts.push(sp.toNonIndexed());
  }
  for (const p of chromeParts) {
    for (const name of Object.keys(p.attributes)) if (name !== 'position' && name !== 'normal') p.deleteAttribute(name);
  }
  const chrome = mergeGeometries(chromeParts)!;

  const barrel = new THREE.CylinderGeometry(rimR * 0.97, rimR * 0.97, w * 0.9, 24, 1, true);
  barrel.rotateZ(Math.PI / 2);
  const back = new THREE.CircleGeometry(rimR * 0.97, 24);
  back.rotateY(Math.PI / 2);
  back.translate(w * 0.1, 0, 0);
  const trimParts = [barrel.toNonIndexed(), back.toNonIndexed()];
  for (const p of trimParts) {
    for (const name of Object.keys(p.attributes)) if (name !== 'position' && name !== 'normal') p.deleteAttribute(name);
  }
  const trim = mergeGeometries(trimParts)!;
  for (const name of Object.keys(tyre.attributes)) if (name !== 'position' && name !== 'normal') tyre.deleteAttribute(name);

  // vented brake disc behind the spokes, caliper clamping it near the top-rear
  const discGeo = new THREE.CylinderGeometry(rimR * 0.8, rimR * 0.8, 0.028, 28);
  discGeo.rotateZ(Math.PI / 2);
  discGeo.translate(w / 2 - 0.1, 0, 0);
  const hat = new THREE.CylinderGeometry(rimR * 0.34, rimR * 0.34, 0.05, 16);
  hat.rotateZ(Math.PI / 2);
  hat.translate(w / 2 - 0.08, 0, 0);
  const discParts = [discGeo.toNonIndexed(), hat.toNonIndexed()];
  for (const p of discParts) for (const name of Object.keys(p.attributes)) if (name !== 'position' && name !== 'normal') p.deleteAttribute(name);
  const disc = mergeGeometries(discParts)!;
  const cal = roundedBox(0.16, 0.08, 0.07, 0.025);
  cal.rotateY(Math.PI / 2);
  cal.rotateX(-0.6);
  cal.translate(w / 2 - 0.1, rimR * 0.55, -rimR * 0.38);
  for (const name of Object.keys(cal.attributes)) if (name !== 'position' && name !== 'normal') cal.deleteAttribute(name);
  return { rubber: tyre.toNonIndexed(), chrome, trim, disc, caliper: cal.index ? cal.toNonIndexed() : cal };
}

// ------------------------------------------------------------------ materials

export interface CarMaterials {
  paint: THREE.MeshPhysicalMaterial;
  glass: THREE.MeshPhysicalMaterial;
  sideGlass: THREE.MeshPhysicalMaterial;
  disc: THREE.MeshStandardMaterial;
  caliper: THREE.MeshStandardMaterial;
  interior: THREE.MeshStandardMaterial;
  ao: THREE.MeshBasicMaterial;
  chrome: THREE.MeshStandardMaterial;
  trim: THREE.MeshStandardMaterial;
  rubber: THREE.MeshStandardMaterial;
  head: THREE.MeshStandardMaterial;
  tail: THREE.MeshStandardMaterial;
  amber: THREE.MeshStandardMaterial;
  plate: THREE.MeshStandardMaterial;
  under: THREE.MeshStandardMaterial;
}

export function makeCarMaterials(paintColor: THREE.ColorRepresentation, plateText = 'PK·2048', opts: { seeThrough?: boolean } = {}): CarMaterials {
  const sideGlass = new THREE.MeshPhysicalMaterial({ color: 0x0e1418, metalness: 0.1, roughness: 0.04, clearcoat: 1, envMapIntensity: 1.6 });
  return {
    paint: new THREE.MeshPhysicalMaterial({
      color: paintColor, metalness: 0.6, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 1.25,
    }),
    // the hero's screens are tinted but see-through so the cabin shows
    glass: opts.seeThrough
      ? new THREE.MeshPhysicalMaterial({ color: 0x1b262c, metalness: 0.2, roughness: 0.02, envMapIntensity: 1.8, transparent: true, opacity: 0.42, depthWrite: false })
      : sideGlass,
    sideGlass,
    disc: new THREE.MeshStandardMaterial({ color: 0x8a8d91, metalness: 0.85, roughness: 0.45 }),
    caliper: new THREE.MeshStandardMaterial({ color: 0xb3261e, metalness: 0.3, roughness: 0.45 }),
    interior: new THREE.MeshStandardMaterial({ color: 0x3a342e, roughness: 0.85 }),
    ao: new THREE.MeshBasicMaterial({ map: blobShadowTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xe6e9ee, metalness: 1, roughness: 0.16 }),
    trim: new THREE.MeshStandardMaterial({ color: 0x17191c, metalness: 0.2, roughness: 0.55 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x141414, metalness: 0, roughness: 0.92 }),
    head: new THREE.MeshStandardMaterial({ color: 0xf2f4f8, emissive: 0xfff3dc, emissiveIntensity: 0.4, metalness: 0.4, roughness: 0.1 }),
    tail: new THREE.MeshStandardMaterial({ color: 0x8a0d10, emissive: 0xff1a1a, emissiveIntensity: 0.35, roughness: 0.25 }),
    amber: new THREE.MeshStandardMaterial({ color: 0xc9780e, emissive: 0xff8c00, emissiveIntensity: 0.15, roughness: 0.3 }),
    plate: new THREE.MeshStandardMaterial({ map: plateTexture(plateText), roughness: 0.5 }),
    under: new THREE.MeshStandardMaterial({ color: 0x0c0c0d, roughness: 1, side: THREE.DoubleSide }),
  };
}

/** Build a ready-to-add Group from parts (static mesh per material). */
export function carMeshes(parts: CarParts, mats: CarMaterials) {
  const g = new THREE.Group();
  for (const [k, geo] of Object.entries(parts.parts) as [PartKey, THREE.BufferGeometry][]) {
    const mesh = new THREE.Mesh(geo, mats[k]);
    mesh.castShadow = !['plate', 'head', 'tail', 'amber', 'ao', 'glass'].includes(k);
    mesh.receiveShadow = k === 'paint' || k === 'under' || k === 'interior';
    if (k === 'ao') mesh.renderOrder = -1;
    if (k === 'glass') mesh.renderOrder = 2;
    g.add(mesh);
  }
  return g;
}

/** A wheel object for the player car: rotate the group for steering, `userData.spin` for rolling. */
export function wheelMesh(parts: CarParts, mats: CarMaterials, side: 1 | -1) {
  const g = new THREE.Group();
  const inner = new THREE.Group();
  inner.scale.x = side;
  const spin = new THREE.Group();
  for (const [geo, mat] of [
    [parts.wheel.rubber, mats.rubber],
    [parts.wheel.chrome, mats.chrome],
    [parts.wheel.trim, mats.trim],
    [parts.wheel.disc, mats.disc],
  ] as const) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    spin.add(m);
  }
  const caliper = new THREE.Mesh(parts.wheel.caliper, mats.caliper);
  inner.add(spin, caliper);
  g.add(inner);
  g.userData.spin = spin;
  return g;
}
