import * as THREE from 'three';
import type { Physics } from '../physics';
import type { StaticBatch } from './batch';
import type { ParkedCars, Props } from './dynamics';
import { CAR_COLORS } from './dynamics';
import { feature, hazardMaterial, solidHull, wedge, type StuntFeature } from './stuntPark';
import { concreteTexture, rng, signTexture } from './textures';

/**
 * The multi-storey car park, in its own frame: x ∈ [-48, 48], z ∈ [-26, 26],
 * ground + two covered decks + an open roof, 5.5 m apart.
 *
 * Each deck is three bays: back (z < -14), a 28 m wide pillar-free centre, and front (z > 14).
 * Three solid 11 m wide ramps scissor up the east half of the side bays:
 *   R1 ground → L1 (back bay, rising east), R2 L1 → L2 (front bay, rising west),
 *   R3 L2 → roof (back bay, rising east).
 */
export const GARAGE = { x: 18, z: -52, halfX: 48, halfZ: 26, level: 5.5, slab: 0.35 };

/** The rental showroom across the street from the roof gap (world space). */
export const SHOWROOM = { x0: -106, x1: -92, z0: -63, z1: -41, h: 6.6 };

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
type Bay = 'back' | 'front';

const HX = GARAGE.halfX, HZ = GARAGE.halfZ;
const BAY = 14; // |z| where the side bays begin
const RAMP_X: [number, number] = [4, 34];
const RAMP_W = 11.2;

export function buildGarage(
  scene: THREE.Scene,
  phys: Physics,
  batch: StaticBatch,
  mats: Materials,
  parked: ParkedCars,
  props: Props,
  paintLine: (x: number, y: number, z: number, w: number, l: number, yaw?: number) => void,
): StuntFeature[] {
  const { x: GX, z: GZ, level: LV, slab } = GARAGE;
  const rand = rng(404);
  const W = (x: number) => GX + x;
  const Z = (z: number) => GZ + z;
  const V = (x: number, y: number, z: number) => new THREE.Vector3(W(x), y, Z(z));
  const decks = [LV, LV * 2, LV * 3];
  const ROOF = LV * 3;

  // solid = visual + collider
  const solid = (cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, mat: THREE.Material, rot?: THREE.Quaternion, shadow = true) => {
    batch.box({ x: W(cx), y: cy, z: Z(cz) }, { x: sx, y: sy, z: sz }, mat, rot, shadow);
    phys.staticBox({ x: W(cx), y: cy, z: Z(cz) }, { x: sx / 2, y: sy / 2, z: sz / 2 }, rot);
  };
  const slabRect = (r: Rect, top: number) =>
    solid((r[0] + r[1]) / 2, top - slab / 2, (r[2] + r[3]) / 2, r[1] - r[0], slab, r[3] - r[2], mats.concrete);
  const wall = (x0: number, z0: number, x1: number, z1: number, y: number, h = 1.05, mat: THREE.Material = mats.concrete, t = 0.25) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const yaw = Math.atan2(x1 - x0, z1 - z0);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    solid((x0 + x1) / 2, y + h / 2, (z0 + z1) / 2, t, h, len, mat, q);
  };
  const bayZ = (bay: Bay): [number, number] => (bay === 'back' ? [-HZ, -BAY] : [BAY, HZ]);

  // ----------------------------------------------------------- floor slabs
  // each deck has one hole over the ramp that climbs up to it
  const holes: Bay[] = ['back', 'front', 'back'];
  decks.forEach((y, i) => {
    const [hz0, hz1] = bayZ(holes[i]);
    slabRect([-HX, RAMP_X[0], -HZ, HZ], y);
    slabRect([RAMP_X[1], HX, -HZ, HZ], y);
    slabRect(holes[i] === 'back' ? [RAMP_X[0], RAMP_X[1], hz1, HZ] : [RAMP_X[0], RAMP_X[1], -HZ, hz0], y);
  });

  // ----------------------------------------------------------------- ramps
  const rampLen = RAMP_X[1] - RAMP_X[0];
  const theta = Math.atan2(LV, rampLen);
  const ramp = (bay: Bay, base: number, dir: 1 | -1) => {
    const zc = bay === 'back' ? -20 : 20;
    const [lowX, highX] = dir === 1 ? RAMP_X : [RAMP_X[1], RAMP_X[0]];
    wedge(batch, phys, mats.concreteDark, { x: W(lowX), z: Z(zc) }, { x: W(highX), z: Z(zc) }, RAMP_W, LV, base);
    // parapets either side, following the slope
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), dir * theta);
    const slope = Math.hypot(LV, rampLen);
    const midX = (RAMP_X[0] + RAMP_X[1]) / 2;
    for (const s of [-1, 1]) solid(midX, base + LV / 2 + 0.5, zc + s * (RAMP_W / 2 + 0.15), slope, 1.0, 0.3, mats.concrete, q);
    // yellow chevrons pointing uphill
    for (let k = 0.15; k < 0.95; k += 0.16) {
      const x = lowX + (highX - lowX) * k;
      const y = base + LV * k + 0.04;
      for (const s of [-1, 1]) {
        const qc = q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -s * dir * 0.6));
        batch.box({ x: W(x), y, z: Z(zc + s * 1.25) }, { x: 0.3, y: 0.03, z: 2.9 }, mats.paintYellow, qc, false);
      }
    }
    // edges of the deck hole above the ramp's low end
    const deck = base + LV;
    const [z0, z1] = bayZ(bay);
    const inner = bay === 'back' ? -BAY + 0.12 : BAY - 0.12;
    wall(lowX, z0, lowX, z1, deck);
    wall(Math.min(lowX, highX) + (dir === 1 ? 0 : 1.5), inner, Math.max(lowX, highX) - (dir === 1 ? 1.5 : 0), inner, deck);
  };
  ramp('back', 0, 1);
  ramp('front', LV, -1);
  ramp('back', LV * 2, 1);

  // --------------------------------------------------------------- parapets
  // perimeter walls on every deck, open over each ramp hole, plus the two stunt gaps
  const DIVE: [number, number] = [-30, -18]; // L1 front: the deck dive
  const LEAP: [number, number] = [-6, 6]; // roof west: the leap
  decks.forEach((y, i) => {
    const hole = holes[i];
    const runX = (z: number, gaps: [number, number][]) => {
      const cuts = [...gaps].sort((a, b) => a[0] - b[0]);
      let x = -HX;
      for (const [a, b] of cuts) {
        if (a > x) wall(x, z, a, z, y);
        x = b;
      }
      if (x < HX) wall(x, z, HX, z, y);
    };
    runX(-HZ, hole === 'back' ? [RAMP_X] : []);
    runX(HZ, [...(hole === 'front' ? [RAMP_X] : []), ...(y === LV ? [DIVE] : [])]);
    wall(HX, -HZ, HX, HZ, y);
    if (y === ROOF) {
      wall(-HX, -HZ, -HX, LEAP[0], y);
      wall(-HX, LEAP[1], -HX, HZ, y);
    } else wall(-HX, -HZ, -HX, HZ, y);
    // teal band along the facades
    for (const [x0, z0, x1, z1] of [[-HX, -HZ - 0.14, HX, -HZ - 0.14], [-HX, HZ + 0.14, HX, HZ + 0.14], [HX + 0.14, -HZ, HX + 0.14, HZ], [-HX - 0.14, -HZ, -HX - 0.14, HZ]] as const) {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const yaw = Math.atan2(x1 - x0, z1 - z0);
      batch.box({ x: W((x0 + x1) / 2), y: y - 0.55, z: Z((z0 + z1) / 2) }, { x: 0.04, y: 0.3, z: len }, mats.paintTeal,
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), false);
    }
  });

  // ---------------------------------------------------------------- pillars
  const pillarXs = [-40, -24, -8, 8, 24, 40];
  for (const px of pillarXs) {
    for (const pz of [-BAY, BAY]) {
      solid(px, ROOF / 2, pz, 0.7, ROOF, 0.7, mats.concrete);
      for (const y of [0, LV, LV * 2]) batch.box({ x: W(px), y: y + 0.45, z: Z(pz) }, { x: 0.74, y: 0.9, z: 0.74 }, mats.paintYellow, undefined, false);
    }
  }
  // perimeter columns: 16 m apart, so the open ground floor can be driven into from anywhere
  for (let x = -HX; x <= HX; x += 16) {
    const cx = Math.max(-HX + 0.2, Math.min(HX - 0.2, x));
    for (const z of [-HZ + 0.2, HZ - 0.2]) solid(cx, ROOF / 2 - slab / 2, z, 0.4, ROOF - slab, 0.4, mats.concrete);
  }
  for (const z of [-10, 10]) for (const x of [-HX + 0.2, HX - 0.2]) solid(x, ROOF / 2 - slab / 2, z, 0.4, ROOF - slab, 0.4, mats.concrete);

  // stair tower outside the east facade
  solid(53, ROOF / 2 + 1.2, -18, 6, ROOF + 2.4, 6, mats.concreteDark);
  batch.box({ x: W(53), y: ROOF + 2.5, z: Z(-18) }, { x: 6.4, y: 0.25, z: 6.4 }, mats.paintTeal);

  // ----------------------------------------------------------- ceiling lights
  for (const y of [LV, LV * 2, ROOF]) {
    for (const z of [-7, 0, 7]) {
      for (let x = -42; x <= 42; x += 7) batch.box({ x: W(x), y: y - slab - 0.04, z: Z(z) }, { x: 1.8, y: 0.06, z: 0.2 }, mats.lightStrip, undefined, false);
    }
  }

  // ------------------------------------------------------- stalls + parked
  // rows against the outer walls only, kept clear of ramp mouths and the stunt run-ups
  const stalls: { y: number; bay: Bay; ranges: [number, number][] }[] = [
    { y: 0, bay: 'back', ranges: [[-46, -10], [36, 46]] },
    { y: 0, bay: 'front', ranges: [[-46, -34], [36, 46]] },
    { y: LV, bay: 'back', ranges: [[-46, 0]] },
    { y: LV, bay: 'front', ranges: [[-46, -32], [-16, 0]] },
    { y: LV * 2, bay: 'back', ranges: [[-46, -10], [36, 46]] },
    { y: LV * 2, bay: 'front', ranges: [[-46, -10], [36, 46]] },
    { y: ROOF, bay: 'back', ranges: [[-36, 0]] },
    { y: ROOF, bay: 'front', ranges: [[-36, 46]] },
  ];
  const stallW = 2.7, depth = 5;
  const kinds = ['sedan', 'sedan', 'hatch', 'suv', 'executive', 'van'];
  for (const { y, bay, ranges } of stalls) {
    const wallZ = bay === 'back' ? -HZ + 0.4 : HZ - 0.4;
    const dir = bay === 'back' ? 1 : -1;
    for (const [a, b] of ranges) {
      const n = Math.floor((b - a) / stallW);
      for (let i = 0; i <= n; i++) paintLine(W(a + i * stallW), y + 0.012, Z(wallZ + dir * depth / 2), 0.1, depth);
      for (let i = 0; i < n; i++) {
        const x = a + (i + 0.5) * stallW;
        if (pillarXs.some((px) => Math.abs(px - x) < 1.2) || rand() > (y === 0 ? 0.42 : 0.3)) continue;
        // nose in (cars face the wall)
        parked.place(kinds[(rand() * kinds.length) | 0], W(x), y, Z(wallZ + dir * 2.7), (dir === 1 ? Math.PI : 0) + (rand() - 0.5) * 0.06, CAR_COLORS[(rand() * CAR_COLORS.length) | 0]);
      }
    }
  }
  // dashed lane guides down the centre of every deck
  for (const y of [0, ...decks]) for (let x = -42; x < 42; x += 6) paintLine(W(x), y + 0.012, Z(0), 3, 0.14, 0);

  // ------------------------------------------------------------ stunt gaps
  const hz = hazardMaterial();
  // ROOF LEAP: a low kicker at the west gap, pointed at the showroom across the street
  wedge(batch, phys, hz, { x: W(-40.5), z: Z(0) }, { x: W(-47.9), z: Z(0) }, LEAP[1] - LEAP[0] - 1, 0.8, ROOF);
  for (const z of [LEAP[0] - 0.6, LEAP[1] + 0.6]) {
    props.add('cone', W(-44), ROOF, Z(z));
    props.add('cone', W(-46.6), ROOF, Z(z));
  }
  // DECK DIVE: a kicker out through the L1 front wall, into the stunt yard
  wedge(batch, phys, hz, { x: W((DIVE[0] + DIVE[1]) / 2), z: Z(18.5) }, { x: W((DIVE[0] + DIVE[1]) / 2), z: Z(HZ - 0.1) }, DIVE[1] - DIVE[0] - 1, 0.7, LV);
  // hazard frames around both openings
  solidHull(batch, phys, [V(-HX - 0.15, ROOF, LEAP[0] - 0.4), V(-HX + 0.15, ROOF, LEAP[0] - 0.4), V(-HX - 0.15, ROOF + 1.3, LEAP[0] - 0.4), V(-HX + 0.15, ROOF + 1.3, LEAP[0] - 0.4),
    V(-HX - 0.15, ROOF, LEAP[0]), V(-HX + 0.15, ROOF, LEAP[0]), V(-HX - 0.15, ROOF + 1.3, LEAP[0]), V(-HX + 0.15, ROOF + 1.3, LEAP[0])], hz);
  solidHull(batch, phys, [V(-HX - 0.15, ROOF, LEAP[1]), V(-HX + 0.15, ROOF, LEAP[1]), V(-HX - 0.15, ROOF + 1.3, LEAP[1]), V(-HX + 0.15, ROOF + 1.3, LEAP[1]),
    V(-HX - 0.15, ROOF, LEAP[1] + 0.4), V(-HX + 0.15, ROOF, LEAP[1] + 0.4), V(-HX - 0.15, ROOF + 1.3, LEAP[1] + 0.4), V(-HX + 0.15, ROOF + 1.3, LEAP[1] + 0.4)], hz);
  for (const x of DIVE) solid(x, LV + 0.65, HZ, 0.4, 1.3, 0.3, hz);

  // --------------------------------------------------------------- signage
  const sign = (text: string, sub: string | undefined, x: number, y: number, z: number, w: number, h: number, yaw: number, bg = '#2f8f8a', fg = '#ffffff') => {
    const tex = signTexture(text, { bg, fg, sub, w: 1024, h: Math.round(1024 * (h / w)) });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5 }));
    m.position.set(W(x), y, Z(z));
    m.rotation.y = yaw;
    scene.add(m);
  };
  sign('P', undefined, 24, ROOF + 2.0, HZ + 0.3, 3, 3, 0, '#1d4f91');
  batch.add(new THREE.CylinderGeometry(0.08, 0.08, 3.6, 8), mats.metal, new THREE.Matrix4().makeTranslation(W(24), ROOF + 1.8, Z(HZ + 0.2)));
  sign('CENTRAL CAR PARK', 'open 24 hours · 4 levels', -4, LV * 2 - 1.6, HZ + 0.31, 12, 2, 0);
  sign('LEVEL 1', undefined, -8, LV + 3.0, -BAY + 0.36, 3, 0.6, 0, '#f2c230', '#1a1a1a');
  sign('LEVEL 2', undefined, -8, LV * 2 + 3.0, -BAY + 0.36, 3, 0.6, 0, '#f2c230', '#1a1a1a');
  // hanging signs over each ramp entrance, facing the approaching driver
  sign('LEVEL 1 ▲', undefined, 2.5, LV - slab - 0.9, -20, 3.4, 0.7, -Math.PI / 2, '#f2c230', '#1a1a1a');
  sign('LEVEL 2 ▲', undefined, 35.5, LV * 2 - slab - 0.9, 20, 3.4, 0.7, Math.PI / 2, '#f2c230', '#1a1a1a');
  sign('ROOF ▲', undefined, 2.5, ROOF - slab - 0.9, -20, 3.4, 0.7, -Math.PI / 2, '#f2c230', '#1a1a1a');
  sign('NO EXIT', 'seriously', -HX + 3, ROOF + 2.2, LEAP[1] + 1.5, 2.4, 1.0, Math.PI / 2, '#c62828', '#ffffff');
  batch.add(new THREE.CylinderGeometry(0.06, 0.06, 2.2, 8), mats.metal, new THREE.Matrix4().makeTranslation(W(-HX + 3), ROOF + 1.1, Z(LEAP[1] + 1.48)));

  buildShowroom(scene, phys, batch, mats, parked, props);

  return [
    // takeoff registers a few steps after the wheels leave the lip, so the boxes reach past the edge
    feature('roofleap', 'ROOF LEAP', [W(-57), ROOF - 2, Z(LEAP[0] - 1)], [W(-41), ROOF + 5, Z(LEAP[1] + 1)]),
    feature('deckdive', 'DECK DIVE', [W(DIVE[0] - 1), LV - 2, Z(HZ - 7)], [W(DIVE[1] + 1), LV + 4, Z(HZ + 6)]),
  ];
}

/** A two-storey glass-fronted rental showroom across the street from the roof gap. */
function buildShowroom(scene: THREE.Scene, phys: Physics, batch: StaticBatch, mats: Materials, parked: ParkedCars, props: Props) {
  const { x0, x1, z0, z1, h } = SHOWROOM;
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
  // interior lights
  for (let z = z0 + 3; z < z1 - 2; z += 4) batch.box({ x: cx, y: h - 0.05, z }, { x: 6, y: 0.06, z: 0.3 }, mats.lightStrip, undefined, false);
  // mullions + transom
  const paneW = 5.1;
  const centres = [cz - 7.95, cz - 2.65, cz + 2.65, cz + 7.95];
  for (const z of [z0 + 0.3, cz - 5.3, cz, cz + 5.3, z1 - 0.3]) solid(x1, (h - 0.7) / 2, z, 0.18, h - 0.7, 0.18, mats.metal);
  // glass panes (dynamic, they topple when hit) in two tiers
  const lowH = 3.2;
  for (const z of centres) {
    props.pane(x1, 0.04, z, paneW, lowH - 0.08, Math.PI / 2);
    props.pane(x1, lowH + 0.02, z, paneW, h - 0.7 - lowH - 0.1, Math.PI / 2);
  }
  // sign
  const tex = signTexture('CAR RENTAL', { sub: 'drive away today', bg: '#ffffff', fg: '#c62828', w: 1024, h: 256 });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(10, 2.4), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.4, emissive: 0xffffff, emissiveIntensity: 0.15, emissiveMap: tex }));
  sign.position.set(x1 + 0.32, h + 1.2, cz);
  sign.rotation.y = Math.PI / 2;
  scene.add(sign);
  solid(x1 + 0.1, h + 1.2, cz, 0.2, 2.4, 10.2, mats.white);
  // counter + showroom cars
  solid(x0 + 3, 0.55, cz, 1.2, 1.1, 5, mats.dark);
  parked.place('executive', -98, 0.04, cz - 5.5, Math.PI / 2 + 0.3, 0xb01e23);
  parked.place('suv', -98, 0.04, cz + 5.5, Math.PI / 2 - 0.3, 0xf2f2ef);
}
