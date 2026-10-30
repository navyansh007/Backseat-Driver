import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildCar, type CarSpec, type PartKey } from './carModel';
import { blobShadowTexture } from '../world/textures';
import type { Part } from '../physics';

/**
 * Burnt-out shells for destroyed cars, generated from each car's own model: the blast has torn
 * the cabin, roof and doors away down to the sills, the bonnet and boot are dented and sooty,
 * bent pillar stubs and bare seat frames stand in the gutted middle, and embers glow on the floor.
 *
 * Car space, like carModel: +Z forward, +Y up, ground at y = 0.
 */

/** Small seeded random generator, so every shell of a model looks the same. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth-ish noise in −1..1 from a few crossed sines: enough for torn edges, dents and soot. */
const noise = (x: number, y: number, z: number, k: number) =>
  (Math.sin(x * 5.1 * k + z * 1.7) * Math.sin(z * 4.3 * k + y * 2.3 + 1.3) + Math.sin(y * 6.7 * k + x * 3.1 + 0.7) * 0.5) / 1.5;

/** Split triangles until no edge is longer than `max`, so a cut follows a ragged line, not whole panels. */
function tessellate(g: THREE.BufferGeometry, max: number) {
  const src = g.index ? g.toNonIndexed() : g;
  const P = src.getAttribute('position') as THREE.BufferAttribute;
  const N = src.getAttribute('normal') as THREE.BufferAttribute;
  const outP: number[] = [], outN: number[] = [];
  const v = () => new THREE.Vector3();
  const stack: THREE.Vector3[][] = [];
  for (let i = 0; i < P.count; i += 3) {
    stack.push([0, 1, 2].map((k) => v().fromBufferAttribute(P, i + k)).concat([0, 1, 2].map((k) => v().fromBufferAttribute(N, i + k))));
    while (stack.length) {
      const [a, b, c, na, nb, nc] = stack.pop()!;
      const ab = a.distanceTo(b), bc = b.distanceTo(c), ca = c.distanceTo(a);
      const m = Math.max(ab, bc, ca);
      if (m <= max || outP.length > 600000) {
        outP.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
        outN.push(na.x, na.y, na.z, nb.x, nb.y, nb.z, nc.x, nc.y, nc.z);
        continue;
      }
      // split the longest edge at its midpoint
      if (m === ab) {
        const p = a.clone().lerp(b, 0.5), n = na.clone().add(nb).normalize();
        stack.push([a, p, c, na, n, nc], [p, b, c, n, nb, nc]);
      } else if (m === bc) {
        const p = b.clone().lerp(c, 0.5), n = nb.clone().add(nc).normalize();
        stack.push([a, b, p, na, nb, n], [a, p, c, na, n, nc]);
      } else {
        const p = c.clone().lerp(a, 0.5), n = nc.clone().add(na).normalize();
        stack.push([a, b, p, na, nb, n], [p, b, c, n, nb, nc]);
      }
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(outP, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(outN, 3));
  return out;
}

const strip = (g: THREE.BufferGeometry) => {
  const geo = g.index ? g.toNonIndexed() : g;
  for (const name of Object.keys(geo.attributes)) if (name !== 'position' && name !== 'normal') geo.deleteAttribute(name);
  return geo;
};

let mats: Record<'shell' | 'frame' | 'ember' | 'rubber' | 'rim' | 'under' | 'ao', THREE.Material> | null = null;
/** Materials shared by every shell, so they compile once. */
export function wreckMaterials() {
  return (mats ??= {
    // ash-grey paint gone dark with soot (per-vertex), lit from both sides so the torn insides show
    shell: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.93, metalness: 0.15, side: THREE.DoubleSide }),
    frame: new THREE.MeshStandardMaterial({ color: 0x2c2926, roughness: 0.75, metalness: 0.45 }),
    ember: new THREE.MeshStandardMaterial({ color: 0x2a1609, emissive: 0xff5212, emissiveIntensity: 2, roughness: 1 }),
    // double-sided so the mirrored (right-hand) wheels need no winding fix
    rubber: new THREE.MeshStandardMaterial({ color: 0x121212, roughness: 0.95, side: THREE.DoubleSide }),
    rim: new THREE.MeshStandardMaterial({ color: 0x2e2e2e, roughness: 0.5, metalness: 0.7, side: THREE.DoubleSide }),
    under: new THREE.MeshStandardMaterial({ color: 0x0b0a0a, roughness: 1, side: THREE.DoubleSide }),
    ao: new THREE.MeshBasicMaterial({ map: blobShadowTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }),
  });
}

/** Glowing embers breathe a little; one call a frame drives every shell. */
export function flickerEmbers(time: number) {
  const m = wreckMaterials().ember as THREE.MeshStandardMaterial;
  m.emissiveIntensity = 1.7 + Math.sin(time * 7.3) * 0.35 + Math.sin(time * 17.1) * 0.2;
}

/** The parts of one model's wreck, ready for an InstancedBodies or plain meshes. */
export function buildWreck(spec: CarSpec, opts: { wheels: boolean; seed?: number }): Part[] {
  const r = rng(opts.seed ?? spec.name.length * 977 + Math.round(spec.L * 100));
  const built = buildCar(spec, { includeWheels: false });
  const p = built.parts;
  const { W, L, bottom, beltH } = spec;
  const hz = L / 2;

  // the gutted middle: from just behind the screen base to the rear window base, above the sills
  const zFront = spec.wsBaseZ + 0.1;
  const zRear = Math.max(spec.rwBaseZ - 0.05, -hz + 0.55);
  const sill = bottom + 0.22;
  const ragged = (x: number, y: number, z: number) => noise(x, y, z, 1.6) * 0.14 + (noise(x, y, z, 5) * 0.05);
  const gone = (x: number, y: number, z: number) => {
    const j = ragged(x, y, z);
    if (z < zFront + j && z > zRear - j && y > sill + j * 0.6) return true;
    // the roof line above the bonnet and boot goes too, and the glass with it
    if (y > beltH + 0.06 + j * 0.5 && z < zFront + 0.35 + j && z > zRear - 0.3 - j) return true;
    return false;
  };

  // bodywork: paint, trim, chrome and lamps all burnt to one sooty surface
  const keys: PartKey[] = ['paint', 'trim', 'chrome', 'head', 'tail', 'amber', 'plate'];
  const whole = mergeGeometries(keys.filter((k) => p[k]).map((k) => strip(p[k]!.clone())), false)!;
  const fine = tessellate(whole, 0.14);
  const P = fine.getAttribute('position') as THREE.BufferAttribute;
  const Nn = fine.getAttribute('normal') as THREE.BufferAttribute;
  const keepP: number[] = [], keepN: number[] = [], col: number[] = [];
  const ash = new THREE.Color(0x8d877f), soot = new THREE.Color(0x141110), c = new THREE.Color();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < P.count; i += 3) {
    a.fromBufferAttribute(P, i);
    b.fromBufferAttribute(P, i + 1);
    d.fromBufferAttribute(P, i + 2);
    const cx = (a.x + b.x + d.x) / 3, cy = (a.y + b.y + d.y) / 3, cz = (a.z + b.z + d.z) / 3;
    if (gone(cx, cy, cz)) continue;
    // a few holes burnt through near the tear
    const edge = Math.min(Math.abs(cz - zFront), Math.abs(cz - zRear));
    if (edge < 0.35 && r() < 0.18 * (1 - edge / 0.35)) continue;
    for (let k = 0; k < 3; k++) {
      const v = k === 0 ? a : k === 1 ? b : d;
      n.fromBufferAttribute(Nn, i + k);
      // dents: pushed in along the normal, worse towards the blast
      const near = Math.max(0, 1 - Math.min(Math.abs(v.z - zFront), Math.abs(v.z - zRear), v.z < zFront && v.z > zRear ? 0 : 9) / 0.9);
      const dent = (noise(v.x, v.y, v.z, 2.2) * 0.5 + 0.5) * (0.012 + near * 0.05);
      keepP.push(v.x - n.x * dent, v.y - n.y * dent - near * 0.02, v.z - n.z * dent);
      keepN.push(n.x, n.y, n.z);
      // soot: darkest round the torn middle and low down, in blotches
      const s = THREE.MathUtils.clamp(near * 0.85 + (noise(v.x, v.y, v.z, 3.1) * 0.5 + 0.5) * 0.45 + (v.y < bottom + 0.3 ? 0.2 : 0) - 0.15, 0, 1);
      c.copy(ash).lerp(soot, s);
      col.push(c.r, c.g, c.b);
    }
  }
  const shell = new THREE.BufferGeometry();
  shell.setAttribute('position', new THREE.Float32BufferAttribute(keepP, 3));
  shell.setAttribute('normal', new THREE.Float32BufferAttribute(keepN, 3));
  shell.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  shell.computeBoundingSphere();

  // ---- what's left standing in the middle: floor pan, seat frames, pillar stubs, a twisted strut or two
  const frame: THREE.BufferGeometry[] = [];
  const embers: THREE.BufferGeometry[] = [];
  const put = (list: THREE.BufferGeometry[], g: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
    g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1)));
    list.push(strip(g));
  };
  const midZ = (zFront + zRear) / 2, span = zFront - zRear;
  const inner = W / 2 - 0.16;
  const floorY = bottom + 0.16;
  put(frame, new THREE.BoxGeometry(W - 0.26, 0.04, span + 0.2), 0, floorY, midZ);
  // sill beams down both sides
  for (const s of [-1, 1]) put(frame, new THREE.BoxGeometry(0.08, 0.12, span + 0.3), s * (W / 2 - 0.09), sill - 0.04, midZ);
  // bare seat frames: a base rectangle and a backrest bent back by the heat
  const seatZ = zFront - span * 0.38;
  const seatRows = spec.doors === 2 || span < 1.6 ? [seatZ] : [seatZ, seatZ - span * 0.38];
  for (const z of seatRows) {
    for (const s of [-1, 1]) {
      const x = s * 0.36;
      const by = floorY + 0.26;
      for (const dz of [-0.2, 0.2]) put(frame, new THREE.BoxGeometry(0.42, 0.025, 0.025), x, by, z + dz);
      for (const dx of [-0.2, 0.2]) put(frame, new THREE.BoxGeometry(0.025, 0.025, 0.42), x + dx, by, z);
      for (const dx of [-0.2, 0.2]) put(frame, new THREE.BoxGeometry(0.025, 0.24, 0.025), x + dx, by - 0.12, z);
      const lean = -0.35 - r() * 0.5;
      for (const dx of [-0.19, 0.19]) put(frame, new THREE.BoxGeometry(0.025, 0.55, 0.025), x + dx, by + 0.26, z - 0.24 - Math.sin(-lean) * 0.27, lean, 0, (r() - 0.5) * 0.3);
      put(frame, new THREE.BoxGeometry(0.4, 0.025, 0.025), x, by + 0.5, z - 0.24 - Math.sin(-lean) * 0.52, lean);
    }
  }
  // pillar stubs, torn off and bent outwards and back
  for (const [z, tilt] of [[zFront + 0.02, -0.5], [zRear + 0.05, 0.45]] as const) {
    for (const s of [-1, 1]) {
      const h = 0.18 + r() * 0.26;
      put(frame, new THREE.BoxGeometry(0.05, h, 0.07), s * (inner + 0.04), beltH - 0.05 + h / 2, z, tilt * (0.6 + r() * 0.6), 0, s * (0.15 + r() * 0.5));
    }
  }
  // what's left of the roof frame: two bent struts crossing the gap, and the dash bulkhead
  for (let k = 0; k < 2; k++) {
    const len = span * (0.55 + r() * 0.3);
    put(frame, new THREE.BoxGeometry(0.03, 0.03, len), (r() - 0.5) * 0.8, sill + 0.25 + r() * 0.3, midZ + (r() - 0.5) * 0.3, (r() - 0.5) * 0.7, (r() - 0.5) * 0.8, (r() - 0.5) * 0.6);
  }
  put(frame, new THREE.BoxGeometry(W - 0.4, 0.22, 0.1), 0, beltH - 0.12, zFront - 0.05, 0.3);
  put(frame, new THREE.TorusGeometry(0.16, 0.02, 6, 16), 0.36, beltH - 0.02, zFront - 0.3, -0.6 - r() * 0.4, r() * 0.4);
  // charred rubble and glowing embers on the floor
  for (let k = 0; k < 40; k++) {
    const g = k % 3 === 0 ? new THREE.DodecahedronGeometry(0.05 + r() * 0.05, 0) : new THREE.BoxGeometry(0.05 + r() * 0.2, 0.02 + r() * 0.04, 0.04 + r() * 0.12);
    put(k % 2 ? embers : frame, g, (r() - 0.5) * (W - 0.5), floorY + 0.04 + r() * 0.08, zRear + 0.15 + r() * (span - 0.3), r() * 3, r() * 3, r() * 3);
  }
  for (let k = 0; k < 16; k++) {
    put(embers, new THREE.BoxGeometry(0.03 + r() * 0.06, 0.02, 0.03 + r() * 0.06), (r() - 0.5) * 0.8, floorY + 0.29, seatZ + (r() - 0.5) * 0.4, r(), r() * 3, r());
  }

  const m = wreckMaterials();
  const parts: Part[] = [
    { geometry: shell, material: m.shell, tinted: true, castShadow: true, receiveShadow: true },
    { geometry: mergeGeometries(frame, false)!, material: m.frame, castShadow: true, receiveShadow: false },
    { geometry: mergeGeometries(embers, false)!, material: m.ember, castShadow: false, receiveShadow: false },
  ];
  if (p.under) parts.push({ geometry: p.under, material: m.under, castShadow: false, receiveShadow: false });
  if (p.ao) parts.push({ geometry: p.ao, material: m.ao, castShadow: false, receiveShadow: false });
  if (opts.wheels) {
    // the tyres and rims survive, scorched, on all four corners
    const tyres: THREE.BufferGeometry[] = [], rims: THREE.BufferGeometry[] = [];
    for (const w of built.wheelPositions) {
      const mtx = new THREE.Matrix4().compose(w, new THREE.Quaternion(), new THREE.Vector3(w.x > 0 ? 1 : -1, 1, 1));
      tyres.push(built.wheel.rubber.clone().applyMatrix4(mtx));
      for (const g of [built.wheel.chrome, built.wheel.trim, built.wheel.disc]) rims.push(strip(g.clone()).applyMatrix4(mtx));
    }
    parts.push({ geometry: mergeGeometries(tyres.map(strip), false)!, material: m.rubber });
    parts.push({ geometry: mergeGeometries(rims, false)!, material: m.rim });
  }
  return parts;
}
