import * as THREE from 'three';
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { blobShadowTexture, plateTexture } from '../world/textures';
import { loftBody, type Loft, type LoftShape } from './loft';

/**
 * Parametric procedural car generator. Every car is built from a side profile
 * that is extruded across the width, then sculpted (tumblehome, rounded corners)
 * and dressed with lamps, grille, mirrors, plates and wheels.
 *
 * Car space: +Z forward, +Y up, ground at y = 0, origin between the axles' midpoint projection.
 */

export type RearStyle = 'notch' | 'hatch' | 'box' | 'fastback';

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
  grille: 'executive' | 'slim' | 'tall' | 'vane' | 'quad' | 'none';
  plate?: string;
  // ---- optional shaping, for cars that aren't three-box saloons
  /** chrome window surrounds (default: executive only) */
  chromeTrim?: boolean;
  /** wheel design (default: classic 5-spoke, 'multi' for the executive) */
  wheels?: 'classic' | 'multi' | 'sport' | 'magnum' | 'terrain';
  /** raised white lettering on the tyre walls */
  letters?: boolean;
  /** how far the glasshouse sits in from the body side, and how hard it leans in (default 0.13, 0.3) */
  cabinInset?: number;
  tumble?: number;
  /** how much the nose and tail narrow in plan (default 0.11) */
  taper?: number;
  /** muscular haunches over the wheels, metres of extra half-width at the arches */
  hips?: number;
  /** where the B-pillar sits between roof front and rear, 0–1 (default 0.45, 0.28 for a box) */
  pillar?: number;
  doors?: 2 | 4;
  bumpers?: 'saloon' | 'sport' | 'chrome' | 'none';
  /** a fastback's tail lamps: one slim blade each side (default), or a three-lens lamp in a chrome bezel */
  tailLamps?: 'blade' | 'triple';
  /** side strake on the front wings */
  strake?: boolean;
  /** smooth one-piece lofted bodywork instead of the extruded saloon body and cabin */
  loft?: LoftShape;
  /**
   * Late-60s muscle car dressing for a lofted fastback: a bonnet scoop (front z, rear z, half width,
   * height), slats over the rear window, a wing on the deck (front and rear z) and a dummy scoop in
   * each rear quarter (its front z). Also brings a wing antenna, fender badges and side markers.
   */
  muscle?: { scoop: [number, number, number, number]; louvers: number; wing: [number, number]; quarterScoop: number; badge: [string, string] };
  /**
   * Off-road truck dressing for a lofted body: a lit nameplate bar across the nose (one lit block per
   * letter), black bumpers, rockers and angular wheel-arch flares, a skid plate, roof marker lamps,
   * a door badge and a spare wheel on the tailgate.
   */
  rig?: { name: string; badge: string; rocker: number; spare: [number, number] };
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
  | 'disc' | 'caliper' | 'interior' | 'ao' | 'letters' | 'rim';

export interface CarParts {
  spec: CarSpec;
  /** Merged geometry per material slot (body, excluding wheels when built for the player). */
  parts: Partial<Record<PartKey, THREE.BufferGeometry>>;
  /** Single wheel geometry, centered, axle along X; outer face at +X. The caliper does not spin. */
  wheel: {
    rubber: THREE.BufferGeometry; chrome: THREE.BufferGeometry; trim: THREE.BufferGeometry; disc: THREE.BufferGeometry; caliper: THREE.BufferGeometry;
    /** raised white letters on the tyre wall, when the spec asks for them */
    letters?: THREE.BufferGeometry;
  };
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
  const hips = spec.hips ?? 0;
  const cabinHalf = halfW - hips - (spec.cabinInset ?? 0.13);
  const tumble = spec.tumble ?? 0.3;
  const taper = spec.taper ?? 0.11;

  // Plan-view rounding of the nose and tail.
  const plan = (z: number) => {
    const u = Math.abs(z) / hz;
    const f = Math.max(0, (u - 0.78) / 0.22);
    return 1 - taper * f * f;
  };
  // haunches: the body swells over each axle (more over the rear) and pulls in at the doors
  const haunch = (y: number, z: number) => {
    if (!hips) return 0;
    const along = Math.exp(-(((z - spec.rearAxleZ) / 0.75) ** 2)) + 0.7 * Math.exp(-(((z - spec.frontAxleZ) / 0.65) ** 2));
    const up = Math.max(0, 1 - Math.abs(y - (beltH - 0.22)) / 0.42);
    return hips * Math.min(1, along) * up;
  };
  let bodyHW = (y: number, z: number) =>
    (halfW - hips + haunch(y, z) - Math.max(0, y - (beltH - 0.28)) * 0.16 - Math.max(0, bottom + 0.15 - y) * 0.25) * plan(z);
  const cabinHW = (y: number, z: number) => (cabinHalf - Math.max(0, y - beltH) * tumble) * plan(z);

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
  } else if (spec.rear === 'fastback') {
    // the rear glass runs almost to the tail, which kicks up into a small ducktail
    top.push(
      [-hz + 0.2, trunkH + 0.01],
      [-hz + 0.03, trunkH + 0.035],
      [-hz - 0.005, trunkH - 0.09],
      [-hz - 0.01, bottom + 0.24],
      [-hz + 0.07, bottom],
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
  if (!spec.loft) {
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
  }

  // ----------------------------------------------------------------- cabin
  const wsA: [number, number] = [spec.wsBaseZ - 0.04, beltH];
  const wsB: [number, number] = [spec.roofFrontZ, H - 0.02];
  const rwA: [number, number] = [spec.roofRearZ, H - 0.03];
  const rwB: [number, number] = [spec.rwBaseZ, beltH];
  if (!spec.loft) {
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
  }

  // side windows wrapped onto the cabin surface
  const yb = beltH + 0.035;
  const yt = H - 0.085;
  const zB = spec.roofFrontZ + (spec.roofRearZ - spec.roofFrontZ) * (spec.pillar ?? (spec.rear === 'box' ? 0.28 : 0.45));
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
    [lineZ(rwA, rwB, yb) + (spec.rear === 'notch' ? 0.22 : spec.rear === 'fastback' ? 0.35 : 0.1), yb + (spec.rear === 'notch' ? 0.02 : 0)],
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
  for (const side of spec.loft ? [] : [-1, 1]) {
    bag.add(spec.chromeTrim ?? spec.name === 'executive' ? 'chrome' : 'trim', wrapPanel(surround, side, (y, z) => cabinHW(y, z) + 0.003));
    bag.add('sideGlass', wrapPanel(frontWin, side, (y, z) => cabinHW(y, z) + 0.006));
    bag.add('sideGlass', wrapPanel(rearWin, side, (y, z) => cabinHW(y, z) + 0.006));
    bag.add('trim', wrapPanel(pillar, side, (y, z) => cabinHW(y, z) + 0.007));
  }

  // a lofted sports car: one smooth shell with its glass and window line already in it
  let loft: Loft | null = null;
  if (spec.loft) {
    loft = loftBody(L, spec.loft);
    bag.add('paint', loft.paint);
    bag.add('glass', loft.glass);
    bag.add('sideGlass', loft.sideGlass);
    bag.add('chrome', loft.chrome);
    if (spec.loft.blackRoof) bag.add('trim', loft.trim);
    bodyHW = loft.halfW;
  }
  // where the nose and tail surfaces are, for lamps and grilles
  const noseZ = (x: number, y: number) => (loft ? loft.frontZ(x, y) : hz);
  const tailZ = (x: number, y: number) => (loft ? loft.rearZ(x, y) : -hz);
  /** The same on the tail: the part is built facing forward and turned round to face back. */
  const onTail = (g: THREE.BufferGeometry, cx: number, cy: number, out: number) => {
    const geo = (g.index ? g.toNonIndexed() : g).rotateY(Math.PI);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = cx + pos.getX(i), y = cy + pos.getY(i);
      pos.setXYZ(i, x, y, tailZ(Math.abs(x), y) + pos.getZ(i) - out);
    }
    geo.computeVertexNormals();
    return geo;
  };
  /** Lay a part built round the origin (x, y across the face, z = depth) onto the curved nose at (cx, cy). */
  const onNose = (g: THREE.BufferGeometry, cx: number, cy: number, out: number) => {
    const geo = g.index ? g.toNonIndexed() : g;
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = cx + pos.getX(i), y = cy + pos.getY(i);
      pos.setXYZ(i, x, y, noseZ(Math.abs(x), y) + pos.getZ(i) + out);
    }
    geo.computeVertexNormals();
    return geo;
  };

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
  } else if (spec.grille === 'vane') {
    // a wide, low grille whose top edge dips in the middle, filled with fine horizontal vanes, and
    // slim headlamps along the top corners; every piece is bent round the curve of the nose
    const gy = bottom + 0.26;
    const gs = new THREE.Shape();
    gs.moveTo(-0.42, -0.11);
    gs.lineTo(0.42, -0.11);
    gs.quadraticCurveTo(0.52, -0.09, 0.49, 0.02);
    gs.quadraticCurveTo(0.42, 0.115, 0.2, 0.105);
    gs.quadraticCurveTo(0, 0.085, -0.2, 0.105);
    gs.quadraticCurveTo(-0.42, 0.115, -0.49, 0.02);
    gs.quadraticCurveTo(-0.52, -0.09, -0.42, -0.11);
    const grilleGeo = new THREE.ShapeGeometry(gs, 10);
    bag.add('trim', onNose(grilleGeo, 0, gy, 0.004));
    const rimGeo = new THREE.ExtrudeGeometry(gs, { depth: 0.012, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.012, bevelSegments: 2, curveSegments: 10 });
    bag.add('chrome', onNose(rimGeo, 0, gy, -0.012));
    bag.add('trim', onNose(new THREE.ExtrudeGeometry(gs, { depth: 0.02, bevelEnabled: false, curveSegments: 10 }), 0, gy, -0.006));
    for (let i = 0; i < 7; i++) {
      const vy = -0.08 + i * 0.027;
      const half = 0.44 - Math.abs(vy) * 0.5 - (vy > 0.04 ? (vy - 0.04) * 2.4 : 0);
      bag.add('chrome', onNose(new THREE.BoxGeometry(half * 2, 0.007, 0.012, 16, 1, 1), 0, gy + vy, 0.01));
    }
    const ly = hoodH - 0.1;
    for (const s of [-1, 1]) {
      // lamp: a slim blade, kinked up at its outer end
      const lamp = new THREE.Shape();
      lamp.moveTo(-0.2, -0.02);
      lamp.quadraticCurveTo(0.08, -0.035, 0.2, 0.012);
      lamp.lineTo(0.19, 0.035);
      lamp.quadraticCurveTo(0.02, 0.02, -0.2, 0.02);
      lamp.closePath();
      const flip = (g: THREE.BufferGeometry) => (s < 0 ? flipIfNeeded(g, new THREE.Matrix4().makeScale(-1, 1, 1), -1) : g);
      const housing = flip(new THREE.ExtrudeGeometry(lamp, { depth: 0.02, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.012, bevelSegments: 2, curveSegments: 8 }));
      bag.add('trim', onNose(housing, s * 0.6, ly, -0.012));
      bag.add('head', onNose(flip(new THREE.ShapeGeometry(lamp, 8)), s * 0.6, ly, 0.024));
    }
  } else if (spec.grille === 'quad') {
    // late-60s face: a wide, dark grille recessed under the overhanging brow of the bonnet and wings,
    // the inner pair of headlamps at its ends and the outer pair in pockets in the wing tips
    const gy = 0.6;
    const gs = new THREE.Shape();
    const gw = 0.63, gh = 0.095;
    gs.moveTo(-gw, -gh);
    gs.lineTo(gw, -gh);
    gs.quadraticCurveTo(gw + 0.04, -gh, gw + 0.04, -gh + 0.04);
    gs.lineTo(gw + 0.04, gh - 0.03);
    gs.quadraticCurveTo(gw + 0.04, gh, gw, gh);
    gs.lineTo(-gw, gh);
    gs.quadraticCurveTo(-gw - 0.04, gh, -gw - 0.04, gh - 0.03);
    gs.lineTo(-gw - 0.04, -gh + 0.04);
    gs.quadraticCurveTo(-gw - 0.04, -gh, -gw, -gh);
    bag.add('under', onNose(new THREE.ShapeGeometry(gs, 6), 0, gy, 0.003));
    const rimGeo = new THREE.ExtrudeGeometry(gs, { depth: 0.01, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.01, bevelSegments: 2, curveSegments: 6 });
    bag.add('chrome', onNose(rimGeo, 0, gy, -0.008));
    bag.add('under', onNose(new THREE.ExtrudeGeometry(gs, { depth: 0.016, bevelEnabled: false, curveSegments: 6 }), 0, gy, -0.004));
    // egg-crate mesh: fine bars across and up the opening, standing proud of the dark back
    for (let i = 1; i < 6; i++) bag.add('trim', onNose(new THREE.BoxGeometry(gw * 2, 0.006, 0.012, 24, 1, 1), 0, gy - gh + (i * gh * 2) / 6, 0.008));
    for (let x = -gw + 0.05; x < gw; x += 0.05) bag.add('trim', onNose(new THREE.BoxGeometry(0.006, gh * 2 - 0.01, 0.012), x, gy, 0.008));
    for (const s of [-1, 1]) {
      for (const [x, pocket] of [[0.53, false], [0.77, true]] as const) {
        // the outer lamps sit in a dark round pocket in the wing tip; the inner ones in the grille
        if (pocket) bag.add('under', onNose(new THREE.CylinderGeometry(0.09, 0.09, 0.03, 24).rotateX(Math.PI / 2), s * x, gy, -0.004));
        bag.add('trim', onNose(new THREE.CylinderGeometry(0.078, 0.078, 0.03, 24).rotateX(Math.PI / 2), s * x, gy, 0.004));
        const lens = new THREE.SphereGeometry(0.068, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2);
        lens.scale(1, 0.25, 1).rotateX(Math.PI / 2);
        bag.add('head', onNose(lens, s * x, gy, 0.016));
        bag.add('chrome', onNose(new THREE.TorusGeometry(0.073, 0.009, 6, 24), s * x, gy, 0.02));
      }
      // parking lamps in the valence under the bumper
      bag.add('amber', onNose(roundedBox(0.16, 0.045, 0.02, 0.012), s * 0.5, 0.39, 0.006));
    }
  } else if (spec.grille !== 'none') {
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
  const chromeBumpers = spec.bumpers === 'chrome' && loft;
  if (chromeBumpers) {
    // slim chrome blades that wrap round the nose and tail back towards the wheel arches, a black
    // chin spoiler under the front valence
    const blade: [number, number][] = [[-0.02, -0.04], [0.035, -0.045], [0.062, -0.025], [0.07, 0.01], [0.06, 0.04], [0.03, 0.05], [-0.02, 0.045]];
    const outline = (y: number, nose: boolean, zEnd: number) => {
      // march out from a point inside the body to its surface, sweeping from one side round to the other
      const sgn = nose ? 1 : -1;
      const zc = sgn * (hz - 0.75);
      const surf = nose ? noseZ : tailZ;
      const inside = (x: number, z: number) => Math.abs(x) <= bodyHW(y, z) && sgn * z <= sgn * surf(Math.abs(x), y);
      const end = Math.atan2(bodyHW(y, zEnd), Math.abs(zEnd - zc));
      const path: [number, number][] = [];
      for (let i = 0; i <= 40; i++) {
        const th = sgn * end * (1 - (2 * i) / 40);
        const dx = Math.sin(th), dz = sgn * Math.cos(th);
        let r = 0;
        while (inside(dx * (r + 0.02), zc + dz * (r + 0.02)) && r < 3) r += 0.02;
        let a = r, b = r + 0.02;
        for (let k = 0; k < 10; k++) {
          const mid = (a + b) / 2;
          if (inside(dx * mid, zc + dz * mid)) a = mid;
          else b = mid;
        }
        path.push([dx * a, zc + dz * a]);
      }
      // ease the corners a touch
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 1; i < path.length - 1; i++) {
          path[i] = [(path[i - 1][0] + 2 * path[i][0] + path[i + 1][0]) / 4, (path[i - 1][1] + 2 * path[i][1] + path[i + 1][1]) / 4];
        }
      }
      return path;
    };
    bag.add('chrome', sweep(outline(0.495, true, hz - 0.52), 0.495, blade));
    bag.add('chrome', sweep(outline(0.545, false, -hz + 0.14), 0.545, blade));
    bag.add('trim', roundedBox(1.36, 0.022, 0.18, 0.01), at(0, 0.255, noseZ(0, 0.3) - 0.07, -0.1));
  } else if (spec.bumpers === 'sport') {
    // a splitter under the nose and a finned diffuser under the tail instead of bumpers
    const sz = loft ? noseZ(0, bottom + 0.12) - 0.13 : front - 0.12;
    const dz = loft ? tailZ(0, bottom + 0.2) + 0.16 : -hz + 0.14;
    const dy = loft ? bottom + 0.09 : bottom + 0.04;
    bag.add('trim', box(loft ? 0.95 : W * 0.84, 0.025, 0.22), at(0, loft ? bottom + 0.07 : bottom + 0.02, loft ? sz - 0.04 : sz));
    bag.add('trim', box(loft ? 1.1 : W * 0.8, 0.07, 0.3), at(0, dy, dz, 0.25));
    for (const x of [-0.3, -0.1, 0.1, 0.3]) bag.add('trim', box(0.015, 0.1, 0.28), at(x * (loft ? 1.4 : W), dy + 0.01, dz + 0.02, 0.25));
  } else if (spec.bumpers !== 'none') {
    bag.add('trim', box(W * 0.9, 0.12, 0.12), at(0, bottom + 0.13, front - 0.035));
    bag.add('trim', box(W * 0.9, 0.12, 0.12), at(0, bottom + 0.13, -hz + 0.035));
  }
  // underbody
  bag.add('under', box(loft ? W * 0.72 : W - 0.2, 0.1, L - 0.4), at(0, bottom + 0.06, 0));

  // tail lamps
  if (spec.rear === 'notch') {
    const ty = trunkH - 0.13;
    for (const s of [-1, 1]) {
      bag.add('tail', box(W * 0.3, 0.12, 0.05), at(s * W * 0.31, ty, -hz - 0.0));
      bag.add('amber', box(W * 0.07, 0.12, 0.05), at(s * W * 0.135, ty, -hz + 0.003));
    }
    bag.add('chrome', box(W * 0.12, 0.02, 0.04), at(0, ty + 0.05, -hz + 0.005));
  } else if (spec.rear === 'fastback' && spec.tailLamps === 'triple') {
    // a wide lamp each side split into three lenses by chrome bars, in a chrome bezel; the fuel cap between
    const ty = trunkH - 0.22;
    for (const s of [-1, 1]) {
      bag.add('chrome', onTail(roundedBox(0.42, 0.15, 0.02, 0.025), s * 0.47, ty, 0.004));
      for (const k of [-1, 0, 1]) bag.add('tail', onTail(roundedBox(0.125, 0.115, 0.02, 0.012), s * 0.47 + k * 0.135, ty, 0.012));
    }
    const cap = new THREE.CylinderGeometry(0.075, 0.075, 0.025, 24).rotateX(Math.PI / 2);
    bag.add('chrome', onTail(cap, 0, ty, 0.008));
    bag.add('trim', onTail(new THREE.CylinderGeometry(0.05, 0.05, 0.02, 24).rotateX(Math.PI / 2), 0, ty, 0.016));
  } else if (spec.rear === 'fastback') {
    // one slim blade each side, bent round the tail under the ducktail lip
    const ty = trunkH - 0.11;
    const blade = new THREE.Shape();
    blade.moveTo(0.27, -0.016);
    blade.quadraticCurveTo(-0.1, -0.03, -0.27, 0.0);
    blade.lineTo(-0.26, 0.022);
    blade.quadraticCurveTo(-0.05, 0.02, 0.27, 0.016);
    blade.closePath();
    const housing = new THREE.ExtrudeGeometry(blade, { depth: 0.01, bevelEnabled: true, bevelThickness: 0.005, bevelSize: 0.01, bevelSegments: 1 });
    // built with the kicked-up end on the left; turning it round to face back puts that end outboard on the right
    const mirror = (g: THREE.BufferGeometry, s: number) => (s < 0 ? flipIfNeeded(g, new THREE.Matrix4().makeScale(-1, 1, 1), -1) : g.clone());
    for (const s of [-1, 1]) {
      bag.add('trim', onTail(mirror(housing, s), s * 0.4, ty, -0.012));
      bag.add('tail', onTail(mirror(new THREE.ShapeGeometry(blade, 8), s), s * 0.4, ty, 0.012));
    }
  } else if (!spec.rig) {
    for (const s of [-1, 1]) {
      bag.add('tail', box(0.12, 0.38, 0.05), at(s * (halfW * plan(-hz) - 0.1), beltH - 0.12, -hz - 0.0));
    }
  }
  // plates
  const plateGeo = box(0.52, 0.12, 0.012);
  if (spec.grille !== 'vane' && spec.grille !== 'quad' && !spec.rig) bag.add('plate', plateGeo, at(0, bottom + 0.27, front + 0.015)); // no front plate over that grille
  // under the rear bumper on the muscle car
  const plateY = chromeBumpers ? 0.43 : spec.rear === 'notch' ? trunkH - 0.34 : spec.rear === 'fastback' ? bottom + 0.33 : beltH - 0.4;
  if (!spec.rig) bag.add('plate', plateGeo, at(0, plateY, tailZ(0.26, chromeBumpers ? plateY : bottom + 0.33) - 0.012, 0, Math.PI));

  // mirrors
  for (const s of [-1, 1]) {
    if (spec.rig) {
      // a big square mirror on a heavy arm, at the front of the door glass
      const mz = spec.wsBaseZ - 0.3;
      const mx = s * (bodyHW(beltH, mz) + 0.02);
      bag.add('paint', roundedBox(0.2, 0.17, 0.09, 0.035), at(mx, beltH + 0.14, mz, 0, s * 0.1));
      bag.add('sideGlass', roundedBox(0.165, 0.135, 0.006, 0.02), at(mx, beltH + 0.14, mz - 0.048, 0, s * 0.1));
      bag.add('trim', roundedBox(0.1, 0.14, 0.06, 0.02), at(mx - s * 0.05, beltH + 0.0, mz + 0.01, 0, 0, s * 0.3));
    } else if (loft) {
      // a small mirror on a slim stalk at the front of the side window
      const mz = spec.wsBaseZ - 0.32;
      const my = beltH + 0.04;
      bag.add('paint', roundedBox(0.17, 0.085, 0.07, 0.035), at(s * 0.93, my, mz, 0, s * 0.2));
      bag.add('trim', box(0.2, 0.02, 0.03), at(s * 0.83, my - 0.05, mz + 0.01, 0, 0, s * 0.32));
    } else {
    const mx = s * (bodyHW(beltH, spec.wsBaseZ) + 0.08);
    bag.add('paint', roundedBox(0.16, 0.1, 0.07, 0.03), at(mx, beltH + 0.08, spec.wsBaseZ - 0.12, 0, s * 0.15));
    bag.add('trim', box(0.12, 0.04, 0.04), at(mx - s * 0.06, beltH + 0.04, spec.wsBaseZ - 0.1));
    }
    // door handles + rub strip
    for (const hzD of spec.doors === 2 ? [zB + 0.05] : [zB + 0.45, zB - 0.6]) {
      bag.add('chrome', box(0.02, 0.025, 0.16), at(s * (bodyHW(beltH - 0.12, hzD) + 0.008), beltH - 0.12, hzD));
    }
    const ry = bottom + 0.3;
    if (!loft) {
    const len = spec.frontAxleZ - spec.rearAxleZ - 0.95;
    const midZ = (spec.frontAxleZ + spec.rearAxleZ) / 2;
    bag.add('trim', box(0.02, 0.05, len), at(s * (bodyHW(ry, midZ) + 0.005), ry, midZ));
    bag.add('chrome', box(0.01, 0.008, len), at(s * (bodyHW(ry, midZ) + 0.016), ry + 0.012, midZ));
    }
    if (spec.strake) {
      // a slim chrome strake in the wing behind the front wheel
      const sz = spec.frontAxleZ - 0.62;
      bag.add('trim', box(0.012, 0.035, 0.3), at(s * (bodyHW(beltH - 0.2, sz) + 0.004), beltH - 0.2, sz, 0, 0, s * 0.05));
      bag.add('chrome', box(0.012, 0.012, 0.32), at(s * (bodyHW(beltH - 0.18, sz) + 0.009), beltH - 0.18, sz));
    }
    // belt-line chrome
    if ((spec.bumpers ?? 'saloon') === 'saloon') bag.add('chrome', box(0.012, 0.012, spec.wsBaseZ - spec.rwBaseZ - 0.2), at(s * (bodyHW(beltH, 0) - 0.005), beltH - 0.005, (spec.wsBaseZ + spec.rwBaseZ) / 2));
  }
  // exhaust: one pipe on a saloon, a pair either side of the diffuser on a sports car
  const pipes = spec.rig ? [] : spec.bumpers === 'sport' ? [-W * 0.34, -W * 0.27, W * 0.27, W * 0.34] : chromeBumpers ? [-0.58, 0.58] : [-W * 0.3];
  for (const x of pipes) {
    const py = loft ? bottom + 0.08 : bottom + 0.05;
    bag.add('chrome', new THREE.CylinderGeometry(0.035, 0.035, 0.12, 12), at(x, py, loft ? tailZ(Math.abs(x), py + 0.04) + 0.03 : -hz + 0.02, Math.PI / 2));
  }

  // panel gaps: thin dark seams wrapped onto the doors
  const seamTop = beltH - 0.035;
  const seamBottom = bottom + 0.2;
  const doorCuts = spec.doors === 2
    ? [lineZ(wsA, wsB, beltH) - 0.04, zB - 0.12]
    : [lineZ(wsA, wsB, beltH) - 0.04, zB, spec.rear === 'notch' ? spec.rwBaseZ + 0.12 : spec.rearAxleZ + 0.52];
  for (const side of [-1, 1]) {
    for (const cz of doorCuts) {
      const seam: [number, number][] = [[cz + 0.004, seamBottom], [cz + 0.004, seamTop], [cz - 0.004, seamTop], [cz - 0.004, seamBottom]];
      bag.add('trim', wrapPanel(seam, side, (y, z) => bodyHW(y, z) + (spec.rig ? 0.012 : 0.0015)));
    }
    // side indicator repeater on the front wing
    if (!spec.muscle && !spec.rig) bag.add('amber', box(0.012, 0.025, 0.07), at(side * (bodyHW(beltH - 0.16, spec.frontAxleZ + 0.55) + 0.004), beltH - 0.16, spec.frontAxleZ + 0.55));
  }

  if (spec.muscle && loft) {
    const lf = loft;
    const mu = spec.muscle;
    const shape = spec.loft!;
    // bonnet scoop: a long, low box with an open mouth at the front, its top easing down to the bonnet
    const [sf, sr, sw, sh] = mu.scoop;
    const len = sf - sr;
    const prof = new THREE.Shape();
    prof.moveTo(sr, 0);
    prof.lineTo(sf, 0);
    prof.lineTo(sf + 0.012, sh);
    prof.quadraticCurveTo(sf - 0.03, sh + 0.006, sf - len * 0.35, sh * 0.96);
    prof.quadraticCurveTo(sr + len * 0.12, sh * 0.85, sr, 0);
    const bev = 0.025;
    const scoop = new THREE.ExtrudeGeometry(prof, {
      depth: sw * 2 - bev * 2, bevelEnabled: true, bevelThickness: bev, bevelSize: bev * 0.6, bevelOffset: -bev * 0.6, bevelSegments: 3, curveSegments: 8,
    });
    scoop.rotateY(-Math.PI / 2);
    scoop.translate(sw - bev, 0, 0);
    // sit it on the crown of the bonnet, a little narrower at the back, its sides sloping in to a
    // narrower top so it blends into the bonnet instead of standing on it like a box
    sculpt(scoop, (x, y, z) => x * (1 - 0.14 * Math.min(1, Math.max(0, (sf - z) / len))) * (1 - 0.3 * Math.max(0, y) / sh));
    const sp = scoop.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < sp.count; i++) sp.setY(i, sp.getY(i) + lf.topY(sp.getZ(i)) - 0.025);
    bag.add('paint', toCreasedNormals(scoop, 0.6));
    const mouthY = lf.topY(sf);
    bag.add('under', box(sw * 2 - 0.07, sh - 0.03, 0.01), at(0, mouthY + sh / 2 - 0.01, sf + 0.008));

    // slats over the rear window, standing out from the glass like a flight of steps, on two side rails
    const z0 = shape.glass.roofRear - 0.03, z1 = shape.glass.rwBase + 0.06;
    const slope = (z: number) => Math.atan2(lf.topY(z + 0.02) - lf.topY(z - 0.02), 0.04);
    // height of the rear glass at x across the car: where the glasshouse is that wide
    const glassY = (x: number, z: number) => {
      let lo = beltH, hi = lf.topY(z);
      for (let k = 0; k < 14; k++) {
        const m = (lo + hi) / 2;
        if (lf.cabinW(m, z) > x) lo = m;
        else hi = m;
      }
      return (lo + hi) / 2;
    };
    const step = (z0 - z1) / mu.louvers;
    const spanAt = (z: number) => Math.min(lf.cabinW(lf.topY(z) - 0.06, z) - 0.03, shape.roofHalf - 0.02);
    for (let i = 0; i < mu.louvers; i++) {
      const z = z0 - step * (i + 0.5);
      const half = spanAt(z);
      // each slat lies level, its front edge on the glass, and bends across with the crown of the glass
      const slat = new THREE.BoxGeometry(half * 2, 0.01, step * 1.05, 16, 1, 1);
      slat.rotateX(-slope(z) * 0.3);
      const sp2 = slat.attributes.position as THREE.BufferAttribute;
      for (let k = 0; k < sp2.count; k++) sp2.setY(k, sp2.getY(k) + glassY(Math.abs(sp2.getX(k)), z + step * 0.5) + 0.01);
      slat.computeVertexNormals();
      bag.add('trim', slat, at(0, 0, z));
    }
    for (const s of [-1, 1]) {
      const zm = (z0 + z1) / 2;
      const half = spanAt(zm);
      const rail = Math.hypot(z0 - z1, lf.topY(z0) - lf.topY(z1));
      bag.add('trim', box(0.035, 0.03, rail), at(s * half, (glassY(half, z0) + glassY(half, z1)) / 2 + 0.015, zm, -slope(zm)));
    }

    // wing on the deck: a flat blade between two raked end plates
    const [wf, wr] = mu.wing;
    const df = lf.topY(wf), dr = lf.topY(wr);
    const ws = new THREE.Shape();
    ws.moveTo(wf, df - 0.02);
    ws.lineTo(wf + 0.02, df + 0.06);
    ws.lineTo(wr, dr + 0.05);
    ws.lineTo(wr, dr - 0.02);
    const plate = new THREE.ExtrudeGeometry(ws, { depth: 0.022, bevelEnabled: false });
    plate.rotateY(-Math.PI / 2);
    const wingHalf = 0.66;
    for (const s of [-1, 1]) bag.add('trim', plate.clone(), at(s * wingHalf + 0.011, 0, 0));
    const chord = Math.hypot(wf + 0.02 - wr, df + 0.06 - dr - 0.05);
    bag.add('trim', roundedBox(wingHalf * 2, 0.018, chord, 0.008), at(0, (df + dr + 0.11) / 2 - 0.009, (wf + 0.02 + wr) / 2, -Math.atan2(df + 0.06 - dr - 0.05, wf + 0.02 - wr)));

    for (const s of [-1, 1]) {
      // dummy scoop in the rear quarter, just behind the door: tall at the front, tapering back
      const q = mu.quarterScoop;
      const scoopPoly: [number, number][] = [[q, beltH - 0.17], [q, beltH - 0.02], [q - 0.22, beltH - 0.04], [q - 0.22, beltH - 0.11]];
      bag.add('under', wrapPanel(scoopPoly, s, (y, z) => bodyHW(y, z) + 0.002));
      // a thin chrome bar parting the quarter window from the door glass
      const zq = zB;
      const dy = (H - 0.06 - beltH - 0.04) / 6;
      for (let k = 0; k < 6; k++) {
        const y = beltH + 0.04 + dy * (k + 0.5);
        bag.add('chrome', box(0.01, dy + 0.002, 0.016), at(s * (lf.cabinW(y, zq) + 0.004), y, zq));
      }
      // running-horse roundel on the sail panel, tipped to sit flush with it
      const ey = (beltH + H) / 2 + 0.01, ez = shape.glass.sideRear - 0.09;
      const lean = Math.atan2(lf.cabinW(ey - 0.02, ez) - lf.cabinW(ey + 0.02, ez), 0.04);
      bag.add('chrome', new THREE.CylinderGeometry(0.035, 0.035, 0.01, 18), at(s * (lf.cabinW(ey, ez) + 0.002), ey, ez, 0, 0, Math.PI / 2 + s * lean));
      // side markers: amber at the front of the wings, red at the back of the quarters
      bag.add('amber', roundedBox(0.09, 0.03, 0.014, 0.01).rotateY(Math.PI / 2), at(s * (bodyHW(0.58, hz - 0.3) + 0.004), 0.58, hz - 0.3));
      bag.add('tail', roundedBox(0.09, 0.03, 0.014, 0.01).rotateY(Math.PI / 2), at(s * (bodyHW(0.56, -hz + 0.2) + 0.004), 0.56, -hz + 0.2));
      // two-line chrome badge on the front wings, behind the wheel arch, reading left to right from either side
      const bz = spec.frontAxleZ - 0.55;
      const bpx = 0.0085;
      mu.badge.forEach((line, row) => {
        const by = 0.585 - row * bpx * 6.5;
        for (const [a, u] of pixelText(line)) {
          const y = by + u * bpx, z = bz - s * a * bpx;
          bag.add('chrome', box(0.005, bpx * 0.92, bpx * 0.92), at(s * (bodyHW(y, z) + 0.002), y, z));
        }
      });
    }
    // radio aerial on the left front wing, near the screen
    const az = spec.wsBaseZ + 0.07;
    const ax = bodyHW(beltH - 0.02, az) - 0.07;
    bag.add('chrome', new THREE.CylinderGeometry(0.014, 0.018, 0.03, 10), at(ax, beltH + 0.0, az));
    bag.add('chrome', new THREE.CylinderGeometry(0.0035, 0.005, 0.62, 6), at(ax, beltH + 0.32, az));
  }

  if (spec.rig && loft) {
    const lf = loft;
    const rig = spec.rig;
    const noseY = 1.17;
    /** A side-view outline with eased corners, as a solid `depth` thick with its outer face at `outer`. */
    const slab = (points: [number, number][], side: number, outer: number, depth: number, radius = 0.03, bevel = 0.014) => {
      const geo = new THREE.ExtrudeGeometry(roundShape(points, radius), {
        depth: depth - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelOffset: -bevel, bevelSegments: 2, curveSegments: 5,
      });
      geo.rotateY(-Math.PI / 2);
      geo.translate(side > 0 ? outer - bevel : -outer + depth - bevel, 0, 0);
      return toCreasedNormals(geo, 0.6);
    };
    /** A plan path from one side of the car round a rounded corner, across the end and back down the other side. */
    const wrap = (face: number, half: number, side: number, corner: number, bow: number) => {
      const sgn = Math.sign(face);
      const path: [number, number][] = [];
      const dir = sgn; // +x → −x across the nose, −x → +x across the tail
      const push = (x: number, z: number) => path.push([dir * x, z]);
      push(half, side);
      for (let i = 0; i <= 10; i++) {
        const a = (i / 10) * (Math.PI / 2);
        push(half - corner + Math.cos(a) * corner, face - sgn * bow - sgn * corner + sgn * Math.sin(a) * corner);
      }
      for (let i = 1; i < 16; i++) {
        const x = (half - corner) * (1 - (2 * i) / 16);
        push(x, face - sgn * bow * (x / (half - corner)) ** 2);
      }
      for (let i = 0; i <= 10; i++) {
        const a = (i / 10) * (Math.PI / 2);
        push(-(half - corner) - Math.sin(a) * corner, face - sgn * bow - sgn * corner + sgn * Math.cos(a) * corner);
      }
      push(-half, side);
      return path;
    };

    // ---- nose: a black bar across the raked face holding the lamps and the lit nameplate
    const barW = lf.halfW(noseY, hz - 0.03) - 0.015;
    bag.add('trim', onNose(new THREE.BoxGeometry(barW * 2, 0.17, 0.03, 40, 1, 1), 0, noseY, 0.002));
    const n = rig.name.length;
    const blockW = 0.128, gap = 0.012;
    const px = 0.0135;
    [...rig.name].forEach((ch, i) => {
      const cx = (i - (n - 1) / 2) * (blockW + gap);
      bag.add('under', onNose(roundedBox(blockW, 0.125, 0.02, 0.014), cx, noseY, 0.016));
      for (const [a, u] of pixelText(ch)) bag.add('head', onNose(box(px * 0.92, px * 0.92, 0.006), cx + a * px, noseY + u * px, 0.03));
    });
    for (const s of [-1, 1]) {
      // the headlamp blade outboard of the nameplate, its amber tip wrapping the corner
      const hw = barW - (n * (blockW + gap)) / 2 - 0.05;
      const hx = s * (barW - hw / 2 - 0.045);
      bag.add('chrome', onNose(roundedBox(hw + 0.02, 0.085, 0.012, 0.012), hx, noseY + 0.01, 0.012));
      bag.add('head', onNose(roundedBox(hw, 0.04, 0.012, 0.012), hx, noseY + 0.026, 0.024));
      bag.add('under', onNose(new THREE.BoxGeometry(hw, 0.024, 0.012, 16, 1, 1), hx, noseY - 0.018, 0.022));
      bag.add('amber', onNose(roundedBox(0.05, 0.085, 0.014, 0.012), s * (barW - 0.016), noseY + 0.006, 0.02));
    }
    // a bright strip under the bar, on the painted face, and the hood's front shut line above it
    bag.add('disc', onNose(new THREE.BoxGeometry(1.62, 0.03, 0.012, 24, 1, 1), 0, noseY - 0.14, 0.004));

    // ---- bumpers: swept round the corners, not boxes; the front one has an intake and a skid plate
    const frontSection: [number, number][] = [
      [-0.45, 0], [-0.17, 0], [-0.1, 0.05], [-0.04, 0.14], [-0.01, 0.2], [0, 0.26], [0, 0.34], [-0.015, 0.39], [-0.05, 0.425], [-0.12, 0.44], [-0.45, 0.44],
    ];
    const rearSection: [number, number][] = [
      [-0.4, 0.02], [-0.12, 0.02], [-0.05, 0.09], [-0.01, 0.16], [0, 0.22], [0, 0.32], [-0.02, 0.37], [-0.07, 0.4], [-0.4, 0.4],
    ];
    bag.add('trim', sweep(wrap(2.47, 1.03, 2.24, 0.18, 0.03), 0.5, frontSection));
    bag.add('trim', sweep(wrap(-2.43, 1.03, -2.24, 0.15, 0.02), 0.5, rearSection));
    // the intake: a dark recess with slats, and a thin bright lip along the top of the bumper
    bag.add('under', roundedBox(1.26, 0.12, 0.012, 0.03), at(0, 0.755, 2.471));
    for (let i = 0; i < 4; i++) bag.add('trim', box(1.22, 0.009, 0.016), at(0, 0.71 + i * 0.03, 2.476));
    // silver skid plate on the bumper's chamfer, between the tow hooks
    const skid = new THREE.ExtrudeGeometry(new THREE.Shape([[-0.34, -0.08], [0.34, -0.08], [0.47, 0.09], [-0.47, 0.09]].map(([x, y]) => new THREE.Vector2(x, y))), { depth: 0.014, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 1 });
    bag.add('disc', skid, at(0, 0.6, 2.405, 0.62));
    for (const s of [-1, 1]) {
      bag.add('under', roundedBox(0.11, 0.17, 0.05, 0.02), at(s * 0.66, 0.69, 2.452));
      const hook = new THREE.TorusGeometry(0.04, 0.012, 8, 16, Math.PI * 1.4);
      bag.add('disc', hook, at(s * 0.66, 0.66, 2.49, 0, Math.PI / 2, Math.PI * 0.8));
      // fog lamp at the corner of the bumper
      bag.add('trim', roundedBox(0.16, 0.07, 0.02, 0.02), at(s * 0.84, 0.8, 2.442));
      bag.add('head', roundedBox(0.12, 0.04, 0.012, 0.014), at(s * 0.84, 0.8, 2.452));
    }

    // ---- sides
    const arch = spec.loft!.arches;
    const rocker = rig.rocker;
    for (const s of [-1, 1]) {
      // rocker panel between the arches, and the running board tucked under it
      const zF = arch[0].z - arch[0].r - 0.02, zR = arch[1].z + arch[1].r + 0.02;
      bag.add('trim', slab([[zF, rocker], [zF, 0.74], [zR, 0.74], [zR, rocker]], s, 1.055, 0.3, 0.04), at(0, 0, 0));
      bag.add('trim', roundedBox(0.15, 0.04, zF - zR - 0.06, 0.016), at(s * 1.02, rocker - 0.02, (zF + zR) / 2));
      for (const a of arch) {
        // a black flare round each arch, standing proud of the paint: its top runs level, its legs splay out
        const { r, flat = 0, y, top = y } = a;
        const out = 0.075;
        const inner = 0.02; // lapping over the cut edge of the paint
        const low = rocker + 0.1;
        const leg = 0.07;
        const band: [number, number][] = [
          [a.z + r + out + leg, low], [a.z + r + out, y], [a.z + flat + out, top + out], [a.z - flat - out, top + out], [a.z - r - out, y], [a.z - r - out - leg, low],
          [a.z - r - leg + inner, low], [a.z - r + inner, y], [a.z - flat + inner * 0.5, top - inner], [a.z + flat - inner * 0.5, top - inner], [a.z + r - inner, y], [a.z + r + leg - inner, low],
        ];
        bag.add('trim', slab(band, s, 1.098, 0.47, 0.035), at(0, 0, 0));
        // the inside of the wheel well: a dark wall behind the wheel
        const toEnd = Math.sign(a.z); // the end of the car: this edge stops higher, behind the bumper
        const well: [number, number][] = [[a.z + r, toEnd > 0 ? 0.62 : rocker], [a.z + r, y], [a.z + flat, top], [a.z - flat, top], [a.z - r, y], [a.z - r, toEnd > 0 ? rocker : 0.62]];
        bag.add('under', slab(well, s, 0.63, 0.02, 0.001, 0.002), at(0, 0, 0));
      }
      // door handles: a slim bright pull in a black pocket
      for (const z of [zB + 0.45, zB - 0.6]) bag.add('trim', roundedBox(0.012, 0.06, 0.25, 0.005), at(s * (bodyHW(beltH - 0.12, z) + 0.002), beltH - 0.12, z));
      // the body-colour pillar behind the back door, climbing past the quarter glass to the black roof,
      // then running back under the glass as a raised belt
      const gl = spec.loft!.glass;
      const pz = gl.sideRear + 0.72;
      const yb2 = 1.535;
      const yt2 = H - 0.15;
      const wrapCab = (poly: [number, number][], part: PartKey) => bag.add(part, wrapPanel(poly, s, (y, z) => lf.cabinW(y, z) + 0.016));
      wrapCab([[pz + 0.17, yb2], [pz + 0.1, yb2 + 0.1], [pz + 0.02, yt2], [pz - 0.22, yt2], [pz - 0.22, yb2]], 'paint');
      wrapCab([[pz - 0.2, yb2], [pz - 0.2, yb2 + 0.1], [gl.sideRear - 0.08, yb2 + 0.1], [gl.sideRear - 0.08, yb2]], 'paint');
      wrapCab([[zB + 0.045, beltH + 0.05], [zB + 0.045, H - 0.1], [zB - 0.045, H - 0.1], [zB - 0.045, beltH + 0.05]], 'trim');
      // door badge
      const by = 0.86, bz = spec.frontAxleZ - 0.98, bpx = 0.013;
      for (const [a, u] of pixelText(rig.badge)) {
        const z = bz - s * a * bpx, yy = by + u * bpx;
        bag.add('chrome', box(0.006, bpx * 0.9, bpx * 0.9), at(s * (bodyHW(yy, z) + 0.002), yy, z));
      }
      // the charge-port door on the rear quarter
      const cz = spec.rearAxleZ - 0.5, cy = 1.27;
      const port: [number, number][] = [];
      for (let i = 0; i < 20; i++) port.push([cz + Math.cos((i / 20) * Math.PI * 2) * 0.1, cy + Math.sin((i / 20) * Math.PI * 2) * 0.12]);
      bag.add('trim', wrapPanel(port, s, (y, z) => bodyHW(y, z) + 0.0015));
      const portIn = port.map(([z, y]) => [cz + (z - cz) * 0.96, cy + (y - cy) * 0.96] as [number, number]);
      bag.add('paint', wrapPanel(portIn, s, (y, z) => bodyHW(y, z) + 0.003));
    }
    // three amber marker lamps on the leading edge of the roof
    const rz = spec.roofFrontZ - 0.05;
    for (const x of [-0.3, 0, 0.3]) bag.add('amber', roundedBox(0.09, 0.03, 0.05, 0.012), at(x, lf.topY(rz) - 0.015, rz));
    // a black cowl at the foot of the screen, with the wipers parked on it
    const cowlZ = spec.wsBaseZ + 0.03;
    bag.add('trim', roundedBox(1.74, 0.02, 0.15, 0.008), at(0, lf.topY(cowlZ) + 0.0, cowlZ, 0.08));
    for (const x of [-0.42, 0.28]) bag.add('trim', box(0.62, 0.008, 0.012), at(x, lf.topY(cowlZ) + 0.022, cowlZ - 0.05, 0, 0.05));
    // the bonnet's shut lines, just in from the wings
    const hoodF = hz - 0.1, hoodR = spec.wsBaseZ + 0.1;
    const lift = Math.atan2(lf.topY(hoodR) - lf.topY(hoodF), hoodF - hoodR);
    for (const s of [-1, 1]) {
      const len = Math.hypot(hoodF - hoodR, lf.topY(hoodR) - lf.topY(hoodF));
      bag.add('trim', box(0.006, 0.006, len), at(s * 0.74, (lf.topY(hoodF) + lf.topY(hoodR)) / 2 - 0.018, (hoodF + hoodR) / 2, lift));
    }

    // ---- tail: slim upright lamps at the corners, a roof spoiler and the spare wheel on the tailgate
    for (const s of [-1, 1]) {
      bag.add('trim', onTail(roundedBox(0.115, 0.5, 0.012, 0.018), s * 0.9, 1.17, 0.002));
      bag.add('tail', onTail(roundedBox(0.09, 0.4, 0.016, 0.014), s * 0.9, 1.2, 0.012));
      bag.add('amber', onTail(roundedBox(0.09, 0.055, 0.016, 0.01), s * 0.9, 0.96, 0.012));
    }
    bag.add('sideGlass', onTail(roundedBox(1.36, 0.26, 0.012, 0.04), 0, 1.68, 0.004));
    const lipZ = spec.loft!.glass.roofRear + 0.02;
    bag.add('trim', roundedBox(1.26, 0.035, 0.15, 0.015), at(0, lf.topY(lipZ + 0.06) - 0.012, lipZ, 0.1));
    bag.add('plate', plateGeo, at(0, 0.74, -2.44, 0, Math.PI));
    const [spareY, spareZ] = rig.spare;
    const spareWheel = buildWheel(spec.wheelR, spec.wheelW, 'terrain');
    const spare = at(0, spareY, spareZ, 0, Math.PI / 2);
    bag.add('rubber', spareWheel.rubber, spare);
    bag.add('rim', spareWheel.chrome, spare);
    bag.add('trim', spareWheel.trim, spare);
    bag.add('trim', box(0.34, 0.34, 0.2), at(0, spareY, spareZ + 0.2));
  }

  // dark wheel-arch liners so you can't see through the arches
  for (const az of spec.rig ? [] : [spec.frontAxleZ, spec.rearAxleZ]) {
    if (loft) {
      // under a low bonnet a full-width liner would show through: one short liner per wheel
      for (const s of [-1, 1]) {
        const liner = new THREE.CylinderGeometry(spec.wheelR + 0.04, spec.wheelR + 0.04, spec.wheelW + 0.12, 20, 1, true, 0, Math.PI);
        liner.rotateZ(Math.PI / 2);
        bag.add('under', liner, at(s * spec.track, spec.wheelR, az));
      }
      continue;
    }
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
    // a sports car's cabin is narrower and lower: seats sit nearly on the floor, under the roof
    const iw = loft ? 1.05 : W - 0.34;
    const seatY = loft ? H - 0.97 : bottom + 0.42 + Math.min(0, H - bottom - 1.22);
    const seatX = loft ? 0.32 : 0.38;
    const dashY = loft ? beltH - 0.13 : beltH - 0.06;
    const dashZ = spec.wsBaseZ - (loft ? 0.42 : 0.3);
    bag.add('interior', box(iw, 0.2, 0.45), at(0, dashY, dashZ));
    bag.add('interior', box(iw - 0.06, 0.08, 0.5), at(0, dashY + 0.1, dashZ - 0.05, -0.15));
    const wheelGeo = new THREE.TorusGeometry(0.17, 0.022, 8, 24);
    bag.add('trim', wheelGeo, at(seatX, dashY + 0.13, dashZ - 0.38, -0.45));
    bag.add('trim', new THREE.CylinderGeometry(0.03, 0.03, 0.3, 8), at(seatX, dashY + 0.06, dashZ - 0.22, Math.PI / 2 - 0.45));
    const frontSeatZ = zB + 0.15;
    const rearSeatZ = (zB + spec.roofRearZ) / 2 - 0.15;
    for (const sx of [-seatX, seatX]) {
      bag.add('interior', box(0.5, 0.14, 0.5), at(sx, seatY, frontSeatZ));
      bag.add('interior', roundedBox(0.48, 0.62, 0.13, 0.06), at(sx, seatY + 0.38, frontSeatZ - 0.27, -0.2));
      bag.add('interior', box(0.26, 0.16, 0.1), at(sx, seatY + 0.76, frontSeatZ - 0.33, -0.2));
    }
    if (spec.doors !== 2) {
      bag.add('interior', box(W - 0.42, 0.14, 0.5), at(0, seatY, rearSeatZ));
      bag.add('interior', box(W - 0.42, 0.55, 0.14), at(0, seatY + 0.34, rearSeatZ - 0.3, -0.25));
    }
    bag.add('interior', box(loft ? iw : W - 0.4, 0.04, 0.4), at(0, beltH - 0.02, spec.rwBaseZ + 0.25));
    bag.add('interior', box(loft ? iw : W - 0.3, 0.04, spec.wsBaseZ - spec.rwBaseZ), at(0, loft ? seatY - 0.09 : bottom + 0.3, (spec.wsBaseZ + spec.rwBaseZ) / 2));
  }

  // ----------------------------------------------------------------- wheels
  const wheel = buildWheel(spec.wheelR, spec.wheelW, spec.wheels ?? (spec.name === 'executive' ? 'multi' : 'classic'), spec.letters);
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
      if (wheel.letters) bag.add('letters', flipIfNeeded(wheel.letters, m, s));
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

// a 3×5 pixel font, rows top to bottom, for raised tyre lettering and badges
const GLYPHS: Record<string, string> = {
  A: '010101111101101', B: '110101110101110', D: '110101101101110', E: '111100110100111', G: '111100101101111',
  L: '100100100100111', O: '111101101101111', P: '111101111100100', R: '110101110101101', S: '111100111001111',
  T: '111010010010010', Y: '101101010010010', H: '101101111101101', M: '101111111101101', V: '101101101101010', '2': '111001111100111', '4': '101101111001001', '9': '111101111001111',
};

/** The lit pixels of a line of text as (across, up) offsets in pixels, centred on the line's middle. */
function pixelText(text: string): [number, number][] {
  const out: [number, number][] = [];
  const width = text.length * 4 - 1;
  [...text].forEach((ch, k) => {
    const g = GLYPHS[ch];
    if (!g) return;
    for (let i = 0; i < 15; i++) if (g[i] === '1') out.push([k * 4 + (i % 3) - (width - 1) / 2, 2 - Math.floor(i / 3)]);
  });
  return out;
}

/** A closed outline with its corners eased off by `radius`. */
function roundShape(points: [number, number][], radius: number) {
  const n = points.length;
  const shape = new THREE.Shape();
  const toward = (a: [number, number], b: [number, number]) => {
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const t = Math.min(radius, d / 2) / d;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] as const;
  };
  points.forEach((p, i) => {
    const [ax, ay] = toward(p, points[(i + n - 1) % n]);
    const [bx, by] = toward(p, points[(i + 1) % n]);
    if (i === 0) shape.moveTo(ax, ay);
    else shape.lineTo(ax, ay);
    shape.quadraticCurveTo(p[0], p[1], bx, by);
  });
  shape.closePath();
  return shape;
}

/**
 * A bar swept along a path in plan (x, z) at height y. The cross-section is (outward, up) pairs, where
 * outward is the path's right-hand side; ends are capped.
 */
function sweep(path: [number, number][], y: number, section: [number, number][]) {
  const n = path.length;
  const rings: THREE.Vector3[][] = [];
  const centres: THREE.Vector3[] = [];
  const tangents: THREE.Vector3[] = [];
  const oc = section.reduce((a, p) => a + p[0], 0) / section.length;
  const uc = section.reduce((a, p) => a + p[1], 0) / section.length;
  for (let i = 0; i < n; i++) {
    const [xa, za] = path[Math.max(0, i - 1)], [xb, zb] = path[Math.min(n - 1, i + 1)];
    const t = new THREE.Vector3(xb - xa, 0, zb - za).normalize();
    const nx = t.z, nz = -t.x;
    const [x, z] = path[i];
    rings.push(section.map(([o, u]) => new THREE.Vector3(x + nx * o, y + u, z + nz * o)));
    centres.push(new THREE.Vector3(x + nx * oc, y + uc, z + nz * oc));
    tangents.push(t);
  }
  const pos: number[] = [];
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), c = new THREE.Vector3();
  // each triangle wound to face away from `from` (or along `dir` for the caps)
  const tri = (a: THREE.Vector3, b: THREE.Vector3, d: THREE.Vector3, out: THREE.Vector3) => {
    e1.subVectors(b, a);
    e2.subVectors(d, a);
    const flip = e1.cross(e2).dot(out) < 0;
    for (const p of flip ? [a, d, b] : [a, b, d]) pos.push(p.x, p.y, p.z);
  };
  const m = section.length;
  for (let i = 0; i < n - 1; i++) {
    const mid = centres[i].clone().add(centres[i + 1]).multiplyScalar(0.5);
    for (let k = 0; k < m; k++) {
      const a = rings[i][k], b = rings[i][(k + 1) % m], d = rings[i + 1][k], f = rings[i + 1][(k + 1) % m];
      c.copy(a).add(b).add(d).add(f).multiplyScalar(0.25).sub(mid);
      tri(a, b, d, c);
      tri(b, f, d, c);
    }
  }
  for (const [i, sgn] of [[0, -1], [n - 1, 1]] as const) {
    const out = tangents[i].clone().multiplyScalar(sgn);
    for (let k = 0; k < m; k++) tri(centres[i], rings[i][k], rings[i][(k + 1) % m], out);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return toCreasedNormals(geo, 0.7);
}

/** Wheel: lathe-turned tyre, dished rim with spokes. Axle along X, outer face at +X. */
function buildWheel(r: number, w: number, style: 'classic' | 'multi' | 'sport' | 'magnum' | 'terrain', letters = false) {
  const multiSpoke = style === 'multi';
  // big rims on thin sidewalls for the sports wheel, small rims on tall sidewalls for the old muscle car
  const rimR = r * (style === 'sport' ? 0.76 : style === 'magnum' ? 0.6 : style === 'terrain' ? 0.69 : 0.66);
  const pts = [
    new THREE.Vector2(rimR * 0.98, -w / 2),
    new THREE.Vector2(r - 0.045, -w / 2),
    new THREE.Vector2(r - 0.012, -w / 2 + 0.02),
    new THREE.Vector2(r, -w / 2 + 0.05),
    new THREE.Vector2(r, w / 2 - 0.05),
    new THREE.Vector2(r - 0.012, w / 2 - 0.02),
    new THREE.Vector2(r - 0.045, w / 2),
    // a tall tyre's sidewall bulges out past the wheel
    ...(style === 'terrain' ? [new THREE.Vector2((r + rimR) / 2, w / 2 + 0.012)] : []),
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
  const spokes = style === 'sport' || style === 'magnum' || style === 'terrain' ? 0 : multiSpoke ? 10 : 5;
  const treadParts: THREE.BufferGeometry[] = [];
  if (style === 'terrain') {
    // a broad star: six forked spokes running out to a machined outer ring, round a deep hub with its lug bolts
    const star = (i: number) => {
      const a0 = (i / 6) * Math.PI * 2;
      const spoke = new THREE.Shape();
      const R = rimR * 0.97;
      spoke.moveTo(-rimR * 0.1, rimR * 0.36);
      spoke.lineTo(rimR * 0.1, rimR * 0.36);
      spoke.lineTo(rimR * 0.34, R * 0.92);
      spoke.lineTo(rimR * 0.2, R * 0.97);
      spoke.lineTo(rimR * 0.05, rimR * 0.62);
      spoke.lineTo(-rimR * 0.05, rimR * 0.62);
      spoke.lineTo(-rimR * 0.2, R * 0.97);
      spoke.lineTo(-rimR * 0.34, R * 0.92);
      const g = new THREE.ExtrudeGeometry(spoke, { depth: 0.035, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.006, bevelSegments: 1 });
      g.rotateY(Math.PI / 2);
      g.rotateX(a0);
      g.translate(w / 2 - 0.05, 0, 0);
      return toCreasedNormals(g, 0.5);
    };
    for (let i = 0; i < 6; i++) chromeParts.push(star(i));
    const ring = new THREE.RingGeometry(rimR * 0.88, rimR, 36, 1);
    ring.rotateY(Math.PI / 2);
    ring.translate(w / 2 - 0.008, 0, 0);
    chromeParts.push(ring.toNonIndexed());
    const hubRing = new THREE.CylinderGeometry(rimR * 0.4, rimR * 0.44, 0.05, 28);
    hubRing.rotateZ(Math.PI / 2);
    hubRing.translate(w / 2 - 0.035, 0, 0);
    chromeParts.push(hubRing.toNonIndexed());
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const lug = new THREE.CylinderGeometry(0.014, 0.014, 0.016, 6);
      lug.rotateZ(Math.PI / 2);
      lug.translate(w / 2 - 0.004, Math.cos(a) * rimR * 0.31, Math.sin(a) * rimR * 0.31);
      chromeParts.push(lug.toNonIndexed());
    }
    // chunky all-terrain tread: two staggered rows of blocks and lugs stepping over the shoulders
    const N = 58;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      for (const [x, wide, deep] of [[(i % 2 ? 1 : -1) * w * 0.13, w * 0.28, 0.006], [(i % 2 ? -1 : 1) * w * 0.36, w * 0.2, 0.005]] as const) {
        const block = new THREE.BoxGeometry(wide, deep * 2, (Math.PI * 2 * r) / N * 0.72);
        block.translate(x, r, 0);
        block.rotateX(a);
        treadParts.push(block.toNonIndexed());
      }
    }
  }
  if (style === 'magnum') {
    // a broad polished trim ring, and five flat spokes widening from the hub out to it over a dark centre
    const ring = new THREE.RingGeometry(rimR * 0.7, rimR, 32, 1);
    ring.rotateY(Math.PI / 2);
    ring.translate(w / 2 - 0.006, 0, 0);
    chromeParts.push(ring.toNonIndexed());
    const inner = new THREE.TorusGeometry(rimR * 0.7, 0.007, 5, 32);
    inner.rotateY(Math.PI / 2);
    inner.translate(w / 2 - 0.01, 0, 0);
    chromeParts.push(inner.toNonIndexed());
    for (let i = 0; i < 5; i++) {
      const sp = new THREE.BoxGeometry(0.016, rimR * 0.5, 0.05);
      const p = sp.attributes.position as THREE.BufferAttribute;
      // narrow at the hub, wide where it meets the ring
      for (let k = 0; k < p.count; k++) p.setZ(k, p.getZ(k) * (p.getY(k) > 0 ? 1.15 : 0.55));
      sp.computeVertexNormals();
      sp.translate(0, rimR * 0.46, 0);
      sp.rotateX((i / 5) * Math.PI * 2);
      sp.translate(w / 2 - 0.022, 0, 0);
      chromeParts.push(sp.toNonIndexed());
    }
    const cap = new THREE.SphereGeometry(rimR * 0.2, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    cap.scale(1, 0.4, 1);
    cap.rotateZ(-Math.PI / 2);
    cap.translate(w / 2 - 0.004, 0, 0);
    chromeParts.push(cap.toNonIndexed());
  }
  if (style === 'sport') {
    // ten thin split spokes in pairs, each swept slightly so the wheel looks like it's turning
    for (let i = 0; i < 5; i++) {
      for (const k of [-1, 1]) {
        const a = (i / 5) * Math.PI * 2 + k * 0.13;
        const sp = new THREE.BoxGeometry(0.02, rimR * 0.86, 0.022);
        sp.translate(0, rimR * 0.5, 0);
        sp.rotateX(a);
        sp.translate(w / 2 - 0.03, 0, 0);
        chromeParts.push(sp.toNonIndexed());
      }
    }
  }
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
  // the dark centre: deep in the barrel, or just behind the spokes on the muscle car's wheel
  const back = new THREE.CircleGeometry(rimR * 0.97, 24);
  back.rotateY(Math.PI / 2);
  back.translate(style === 'magnum' ? w / 2 - 0.04 : style === 'terrain' ? w / 2 - 0.07 : w * 0.1, 0, 0);
  const trimParts = [barrel.toNonIndexed(), back.toNonIndexed()];
  for (const p of trimParts) {
    for (const name of Object.keys(p.attributes)) if (name !== 'position' && name !== 'normal') p.deleteAttribute(name);
  }
  const trim = mergeGeometries(trimParts)!;
  for (const name of Object.keys(tyre.attributes)) if (name !== 'position' && name !== 'normal') tyre.deleteAttribute(name);
  for (const p of treadParts) for (const name of Object.keys(p.attributes)) if (name !== 'position' && name !== 'normal') p.deleteAttribute(name);

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

  // raised white letters round the tyre wall, each line reading clockwise with its letters' tops outward
  let letterGeo: THREE.BufferGeometry | undefined;
  if (letters) {
    const px = 0.0068;
    const rl = (rimR + r - 0.045) / 2;
    const dots: THREE.BufferGeometry[] = [];
    const lines: [string, number][] = [['GOODYEAR', 90], ['POLYGLAS GT', 0], ['GOODYEAR', -90], ['POLYGLAS GT', 180]];
    for (const [text, deg] of lines) {
      for (const [a, u] of pixelText(text)) {
        // across the line is clockwise round the wheel (seen from outside, where +u is −z), up is outward
        const phi = (deg * Math.PI) / 180 - (a * px) / rl;
        const rad = rl + u * px;
        const dot = new THREE.BoxGeometry(0.003, px * 0.9, px * 0.9);
        dot.rotateX(phi - Math.PI / 2);
        dot.translate(w / 2 + 0.0015, Math.sin(phi) * rad, -Math.cos(phi) * rad);
        for (const name of Object.keys(dot.attributes)) if (name !== 'position' && name !== 'normal') dot.deleteAttribute(name);
        dots.push(dot.toNonIndexed());
      }
    }
    letterGeo = mergeGeometries(dots)!;
  }
  return { rubber: mergeGeometries([tyre.toNonIndexed(), ...treadParts])!, chrome, trim, disc, caliper: cal.index ? cal.toNonIndexed() : cal, letters: letterGeo };
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
  /** the player car's wheel rims (chrome, or a darker finish) */
  rim: THREE.MeshStandardMaterial;
  trim: THREE.MeshStandardMaterial;
  rubber: THREE.MeshStandardMaterial;
  head: THREE.MeshStandardMaterial;
  tail: THREE.MeshStandardMaterial;
  amber: THREE.MeshStandardMaterial;
  plate: THREE.MeshStandardMaterial;
  under: THREE.MeshStandardMaterial;
  letters: THREE.MeshStandardMaterial;
}

export function makeCarMaterials(
  paintColor: THREE.ColorRepresentation,
  plateText = 'PK·2048',
  opts: { seeThrough?: boolean; rim?: THREE.ColorRepresentation; solid?: boolean; interior?: THREE.ColorRepresentation; caliper?: THREE.ColorRepresentation } = {},
): CarMaterials {
  const chrome = new THREE.MeshStandardMaterial({ color: 0xe6e9ee, metalness: 1, roughness: 0.16 });
  const sideGlass = new THREE.MeshPhysicalMaterial({ color: 0x0e1418, metalness: 0.1, roughness: 0.04, clearcoat: 1, envMapIntensity: 1.6 });
  return {
    // metallic by default; a solid colour gets a soft sheen: a hard clearcoat turns black paint sky-white in the open
    paint: new THREE.MeshPhysicalMaterial(opts.solid
      ? { color: paintColor, metalness: 0.05, roughness: 0.42, clearcoat: 0.3, clearcoatRoughness: 0.22, envMapIntensity: 0.5 }
      : { color: paintColor, metalness: 0.6, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 1.25 }),
    // the hero's screens are tinted but see-through so the cabin shows
    glass: opts.seeThrough
      ? new THREE.MeshPhysicalMaterial({ color: 0x1b262c, metalness: 0.2, roughness: 0.02, envMapIntensity: 1.8, transparent: true, opacity: 0.42, depthWrite: false })
      : sideGlass,
    sideGlass,
    disc: new THREE.MeshStandardMaterial({ color: 0x8a8d91, metalness: 0.85, roughness: 0.45 }),
    caliper: new THREE.MeshStandardMaterial({ color: opts.caliper ?? 0xb3261e, metalness: 0.3, roughness: 0.45 }),
    interior: new THREE.MeshStandardMaterial({ color: opts.interior ?? 0x3a342e, roughness: 0.85 }),
    ao: new THREE.MeshBasicMaterial({ map: blobShadowTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
    chrome,
    rim: opts.rim === undefined ? chrome : new THREE.MeshStandardMaterial({ color: opts.rim, metalness: 0.9, roughness: 0.3 }),
    trim: new THREE.MeshStandardMaterial({ color: 0x17191c, metalness: 0.2, roughness: 0.55 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x141414, metalness: 0, roughness: 0.92 }),
    head: new THREE.MeshStandardMaterial({ color: 0xf2f4f8, emissive: 0xfff3dc, emissiveIntensity: 0.4, metalness: 0.4, roughness: 0.1 }),
    tail: new THREE.MeshStandardMaterial({ color: 0x8a0d10, emissive: 0xff1a1a, emissiveIntensity: 0.35, roughness: 0.25 }),
    amber: new THREE.MeshStandardMaterial({ color: 0xc9780e, emissive: 0xff8c00, emissiveIntensity: 0.15, roughness: 0.3 }),
    plate: new THREE.MeshStandardMaterial({ map: plateTexture(plateText), roughness: 0.5 }),
    under: new THREE.MeshStandardMaterial({ color: 0x0c0c0d, roughness: 1, side: THREE.DoubleSide }),
    letters: new THREE.MeshStandardMaterial({ color: 0xe9e6dc, roughness: 0.75 }),
  };
}

/** Build a ready-to-add Group from parts (static mesh per material). */
export function carMeshes(parts: CarParts, mats: CarMaterials) {
  const g = new THREE.Group();
  for (const [k, geo] of Object.entries(parts.parts) as [PartKey, THREE.BufferGeometry][]) {
    const mesh = new THREE.Mesh(geo, mats[k]);
    mesh.castShadow = !['plate', 'head', 'tail', 'amber', 'ao', 'glass', 'letters'].includes(k);
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
    [parts.wheel.chrome, mats.rim],
    [parts.wheel.trim, mats.trim],
    [parts.wheel.disc, mats.disc],
  ] as const) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    spin.add(m);
  }
  if (parts.wheel.letters) spin.add(new THREE.Mesh(parts.wheel.letters, mats.letters));
  const caliper = new THREE.Mesh(parts.wheel.caliper, mats.caliper);
  inner.add(spin, caliper);
  g.add(inner);
  g.userData.spin = spin;
  return g;
}
