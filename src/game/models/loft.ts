import * as THREE from 'three';

/**
 * Smooth one-piece bodywork for sports cars, lofted through cross-sections instead of extruded
 * from a side profile. Each section is a curve from the middle of the floor, out round a tucked-in
 * sill, up a swelling flank to the shoulder, then in over the glasshouse (or across the bonnet)
 * to the centre line. The curves below say how those sections change from nose to tail.
 *
 * Car space: +Z forward, +Y up, ground at y = 0.
 */
export interface LoftShape {
  /** centre-line height: nose, bonnet, screen, roof, rear glass, deck, tail (z, y), front to back */
  top: [number, number][];
  /** shoulder height along the side; above the bonnet over the front wheels, it makes the wings */
  belt: [number, number][];
  /** half width at the widest point of the flank */
  width: [number, number][];
  /** underside height */
  bottom: [number, number][];
  /** half width of the glasshouse at the roof */
  roofHalf: number;
  /** z where the windscreen starts and ends, the rear glass ends and starts, and the side windows run */
  glass: { wsBase: number; roofFront: number; roofRear: number; rwBase: number; sideFront: number; sideRear: number };
  /** wheel arches cut out of the sides */
  arches: { z: number; y: number; r: number }[];
}

export interface Loft {
  paint: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  sideGlass: THREE.BufferGeometry;
  chrome: THREE.BufferGeometry;
  /** half width of the body side at height y and position z */
  halfW(y: number, z: number): number;
  /** z of the front (or rear) surface at lateral offset x and height y */
  frontZ(x: number, y: number): number;
  rearZ(x: number, y: number): number;
}

/** Smooth curve through (z, value) keys (Catmull-Rom), constant beyond the ends. */
function curve(keys: [number, number][]) {
  const k = [...keys].sort((a, b) => a[0] - b[0]);
  return (z: number) => {
    if (z <= k[0][0]) return k[0][1];
    if (z >= k[k.length - 1][0]) return k[k.length - 1][1];
    let i = 0;
    while (z > k[i + 1][0]) i++;
    const p0 = k[Math.max(0, i - 1)], p1 = k[i], p2 = k[i + 1], p3 = k[Math.min(k.length - 1, i + 2)];
    const t = (z - p1[0]) / (p2[0] - p1[0]);
    // tangents scaled to the actual key spacing so uneven keys don't overshoot
    const m1 = ((p2[1] - p0[1]) / (p2[0] - p0[0] || 1)) * (p2[0] - p1[0]);
    const m2 = ((p3[1] - p1[1]) / (p3[0] - p1[0] || 1)) * (p2[0] - p1[0]);
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * p1[1] + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2[1] + (t3 - t2) * m2;
  };
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// samples per section segment, and where the control points land in the half-section
const SEG = 6;
const CTRL = 8;
const HALF = (CTRL - 1) * SEG + 1; // points from floor centre to top centre
const IDX = (k: number) => k * SEG;
const SECTIONS = 150;

export function loftBody(L: number, shape: LoftShape): Loft {
  const hz = L / 2;
  const top = curve(shape.top), belt = curve(shape.belt), width = curve(shape.width), bottom = curve(shape.bottom);
  const g = shape.glass;

  // one half-section (x ≥ 0), floor centre → top centre
  const section = (z: number) => {
    const t = top(z), s = belt(z), w = width(z), b = bottom(z);
    // how much glasshouse there is here: none over the bonnet and deck, all of it under the roof
    const cab = smooth(0.06, 0.3, t - s);
    const lerp = (a: number, c: number) => a + (c - a) * cab;
    const pts: [number, number][] = [
      [0, b],
      [0.8 * w, b],
      [0.975 * w, b + 0.26 * (s - b)],
      [w, b + 0.5 * (s - b)],
      [0.93 * w, s],
      [lerp(0.8 * w, w - 0.17), lerp((s + t) / 2, s + 0.05)],
      [lerp(0.42 * w, shape.roofHalf), lerp(t + (s - t) * 0.15, t - 0.035)],
      [0, t],
    ];
    // Catmull-Rom through the control points; the ends mirror across the centre line so both halves meet smoothly
    const P = (i: number): [number, number] =>
      i < 0 ? [-pts[-i][0], pts[-i][1]] : i >= CTRL ? [-pts[2 * (CTRL - 1) - i][0], pts[2 * (CTRL - 1) - i][1]] : pts[i];
    const out: [number, number][] = [];
    for (let i = 0; i < CTRL - 1; i++) {
      const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
      for (let k = 0; k < SEG; k++) {
        const u = k / SEG, u2 = u * u, u3 = u2 * u;
        const f = (a: number, b1: number, c: number, d: number) =>
          0.5 * (2 * b1 + (-a + c) * u + (2 * a - 5 * b1 + 4 * c - d) * u2 + (-a + 3 * b1 - 3 * c + d) * u3);
        out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
      }
    }
    out.push(pts[CTRL - 1]);
    // cut the wheel arches: anything low enough inside an arch is pulled up onto its edge
    for (let i = 0; i < IDX(4); i++) {
      for (const a of shape.arches) {
        const dz = z - a.z;
        if (Math.abs(dz) >= a.r) continue;
        const ya = a.y + Math.sqrt(a.r * a.r - dz * dz);
        if (out[i][1] < ya) out[i][1] = ya;
      }
    }
    return out;
  };

  // sections, nose to tail; the ring goes round the right half then back along the left
  const RING = 2 * (HALF - 1);
  const zs: number[] = [];
  const halves: [number, number][][] = [];
  for (let j = 0; j <= SECTIONS; j++) {
    // a little denser at the ends, where the nose and tail curve in
    const u = j / SECTIONS;
    const z = hz - L * (u - Math.sin(u * Math.PI * 2) * 0.03);
    zs.push(z);
    halves.push(section(z));
  }
  const pos: number[] = [];
  const ringHalf: number[] = []; // half-section index of each ring vertex
  for (let j = 0; j <= SECTIONS; j++) {
    const h = halves[j];
    for (let i = 0; i < RING; i++) {
      const hi = i < HALF ? i : RING - i;
      const [x, y] = h[hi];
      pos.push(i < HALF ? x : -x, y, zs[j]);
      if (j === 0) ringHalf.push(hi);
    }
  }
  // end caps, domed a touch out from the last section
  const capCentre = (j: number, out: number) => {
    const h = halves[j];
    let y = 0;
    for (const p of h) y += p[1];
    pos.push(0, y / h.length, zs[j] + out);
    return pos.length / 3 - 1;
  };
  const noseC = capCentre(0, 0); // flat: grilles and lamps are laid on the nose surface
  const tailC = capCentre(SECTIONS, -0.04);

  // faces, sorted into paint, glass and the chrome window line
  const idx: Record<'paint' | 'glass' | 'sideGlass' | 'chrome', number[]> = { paint: [], glass: [], sideGlass: [], chrome: [] };
  const v = (j: number, i: number) => j * RING + (i % RING);
  for (let j = 0; j < SECTIONS; j++) {
    const zc = (zs[j] + zs[j + 1]) / 2;
    // glass only where the glasshouse really stands above the shoulder, never on the bonnet or deck
    const rise = top(zc) - belt(zc);
    const glassy = rise > 0.2;
    for (let i = 0; i < RING; i++) {
      const h = Math.min(ringHalf[i], ringHalf[(i + 1) % RING]);
      let slot: keyof typeof idx = 'paint';
      if (h >= IDX(6) && rise > 0.17 && ((zc < g.wsBase && zc > g.roofFront) || (zc < g.roofRear && zc > g.rwBase))) slot = 'glass';
      else if (glassy && zc < g.sideFront && zc > g.sideRear) {
        if (h > IDX(5) && h < IDX(6) - 1) slot = 'sideGlass';
        else if (h === IDX(5) || h === IDX(6) - 1) slot = 'chrome';
      }
      const a = v(j, i), b = v(j, i + 1), c = v(j + 1, i), d = v(j + 1, i + 1);
      idx[slot].push(a, c, b, b, c, d);
    }
  }
  for (let i = 0; i < RING; i++) {
    idx.paint.push(noseC, v(0, i), v(0, i + 1));
    idx.paint.push(tailC, v(SECTIONS, i + 1), v(SECTIONS, i));
  }

  // smooth normals over the whole shell, so panels of different materials still meet without a crease
  const all = new THREE.BufferGeometry();
  all.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  all.setIndex([...idx.paint, ...idx.glass, ...idx.sideGlass, ...idx.chrome]);
  all.computeVertexNormals();
  const normals = all.getAttribute('normal');
  const part = (list: number[]) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', all.getAttribute('position'));
    geo.setAttribute('normal', normals);
    geo.setIndex(list);
    return geo.toNonIndexed();
  };

  const at = (z: number) => {
    const j = zs.findIndex((zz) => zz <= z);
    return halves[j < 0 ? SECTIONS : j];
  };
  const halfW = (y: number, z: number) => {
    const h = at(z);
    // walk up the side (floor → shoulder) to the point at height y
    for (let i = 1; i <= IDX(4); i++) {
      const [x0, y0] = h[i - 1], [x1, y1] = h[i];
      if ((y0 <= y && y <= y1) || (y1 <= y && y <= y0)) return y1 === y0 ? x1 : x0 + ((y - y0) / (y1 - y0)) * (x1 - x0);
    }
    return h[IDX(4)][0];
  };
  const inside = (x: number, y: number, z: number) => halfW(y, z) >= Math.abs(x) && y >= bottom(z) && y <= Math.max(top(z), belt(z));
  const surfaceZ = (x: number, y: number, from: number, step: number) => {
    for (let z = from; Math.abs(z) <= hz + 0.001; z += step) {
      if (!inside(x, y, z)) continue;
      // narrow it down between the last point outside and this one
      let a = z - step, b = z;
      for (let k = 0; k < 8; k++) {
        const m = (a + b) / 2;
        if (inside(x, y, m)) b = m;
        else a = m;
      }
      return b;
    }
    return from;
  };

  return {
    paint: part(idx.paint),
    glass: part(idx.glass),
    sideGlass: part(idx.sideGlass),
    chrome: part(idx.chrome),
    halfW,
    frontZ: (x, y) => surfaceZ(x, y, hz, -0.01),
    rearZ: (x, y) => surfaceZ(x, y, -hz, 0.01),
  };
}
