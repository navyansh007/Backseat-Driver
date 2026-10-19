import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RAPIER, G, groups, InstancedBodies, staticInstances, type Physics } from '../physics';
import { BREAK, Breakables } from './breakables';
import { Hedges } from './hedges';
import { StaticBatch } from './batch';
import { CAR_COLORS, ParkedCars, Props } from './dynamics';
import { buildGarage, makeMaterials } from './garage';
import { buildStuntYard, type StuntFeature } from './stuntPark';
import { arrowTexture, asphaltTexture, fenceTexture, rng, signTexture } from './textures';
import {
  benchGeo, bollardGeo, lampGeo, propMaterial, propMaterialFlat, treeGeo,
} from '../models/props';

export const LOT = { x0: -110, x1: 110, z0: -100, z1: 100, gateHalf: 7 };
export const ROAD = { x: 140, z: 135, width: 10 };

export interface LotWorld {
  update(dt: number, playerPos: THREE.Vector3): void;
  parked: ParkedCars;
  props: Props;
  /** Fences, lamp posts, flag poles and bollards that snap when hit hard. */
  breakables: Breakables;
  /** Soft hedges along the fence. */
  hedges: Hedges;
  /** Named stunt launch spots. */
  features: StuntFeature[];
  /** Safe spawn point (y = ground) and heading. */
  spawn: { x: number; y: number; z: number; yaw: number };
}

export function buildLot(scene: THREE.Scene, phys: Physics): LotWorld {
  const rand = rng(2024);
  const batch = new StaticBatch(0.25);
  const mats = makeMaterials();
  const dynRoot = new THREE.Group();
  scene.add(dynRoot);
  const parked = new ParkedCars(phys, dynRoot);
  const props = new Props(phys, dynRoot);
  const breakables = new Breakables(phys);
  const Y_AXIS = new THREE.Vector3(0, 1, 0);

  // --------------------------------------------------------- asphalt + paint
  const asphalt = asphaltTexture();
  const asphaltMat = new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.93, color: 0xe4e4e4 });
  const plane = (x0: number, x1: number, z0: number, z1: number, y: number, mat: THREE.Material, tile = 0.12) => {
    const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
    g.rotateX(-Math.PI / 2);
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (x1 - x0) * tile, uv.getY(i) * (z1 - z0) * tile);
    const m = new THREE.Mesh(g, mat);
    m.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
    m.receiveShadow = true;
    scene.add(m);
    return m;
  };
  plane(LOT.x0, LOT.x1, LOT.z0, LOT.z1, 0.0, asphaltMat);

  // painted lines: one instanced quad
  const lineMats: THREE.Matrix4[] = [];
  const yellowMats: THREE.Matrix4[] = [];
  const paintLine = (x: number, y: number, z: number, w: number, l: number, yaw = 0, yellow = false) => {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, yaw, 0, 'YXZ')),
      new THREE.Vector3(w, l, 1),
    );
    (yellow ? yellowMats : lineMats).push(m);
  };

  // ---------------------------------------------------------- stall blocks
  const lamp = lampGeo();
  const lampMats: THREE.Matrix4[] = [];
  const trees: { x: number; z: number; kind: number; s: number; r: number }[] = [];
  // two wide-spaced blocks: ~17 m driving aisle between them; the stunt yard sits in front of the car park
  const blocksZ = [22, 50];
  const stallW = 2.6;
  const depth = 5.5;
  const kinds = ['sedan', 'sedan', 'sedan', 'hatch', 'hatch', 'suv', 'suv', 'van', 'executive'];
  const grassMat = new THREE.MeshStandardMaterial({ color: 0x79a85a, roughness: 1 });
  for (const zc of blocksZ) {
    for (const [xa, xb] of [[-100, -15], [15, 100]] as const) {
      const n = Math.floor((xb - xa) / stallW);
      const islands = new Set([0, Math.floor(n / 2), n - 1]);
      for (let i = 0; i < n; i++) {
        const x = xa + (i + 0.5) * stallW;
        if (islands.has(i)) {
          // planted island with curb, a tree each side and a lamp in the middle
          const q = new THREE.Quaternion();
          batch.box({ x, y: 0.08, z: zc }, { x: stallW - 0.3, y: 0.16, z: depth * 2 - 0.4 }, mats.concrete, q);
          batch.box({ x, y: 0.165, z: zc }, { x: stallW - 0.55, y: 0.01, z: depth * 2 - 0.65 }, grassMat, q, false);
          phys.staticBox({ x, y: 0.08, z: zc }, { x: (stallW - 0.3) / 2, y: 0.08, z: depth - 0.2 });
          lampMats.push(new THREE.Matrix4().compose(new THREE.Vector3(x, 0.16, zc), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2), new THREE.Vector3(1, 1, 1)));
          for (const s of [-1, 1]) trees.push({ x, z: zc + s * 3.4, kind: (rand() * 3) | 0, s: 0.8 + rand() * 0.35, r: rand() * 6 });
          continue;
        }
        for (const side of [-1, 1]) {
          const z = zc + side * depth / 2;
          paintLine(x - stallW / 2, 0.012, z, 0.12, depth - 0.2);
          if (i === n - 2 || islands.has(i + 1)) paintLine(x + stallW / 2, 0.012, z, 0.12, depth - 0.2);
          if (rand() < 0.32) {
            const kind = kinds[(rand() * kinds.length) | 0];
            const reversed = rand() < 0.12;
            const yaw = (side === 1 ? Math.PI : 0) + (reversed ? Math.PI : 0) + (rand() - 0.5) * 0.08;
            parked.place(kind, x + (rand() - 0.5) * 0.25, 0, zc + side * 2.85, yaw, CAR_COLORS[(rand() * CAR_COLORS.length) | 0]);
          }
        }
      }
      paintLine((xa + xb) / 2, 0.012, zc, xb - xa - 2 * stallW, 0.12);
    }
  }

  // central boulevard: dashed centre line, arrows, speed bumps
  for (let z = 12; z < 98; z += 6) paintLine(0, 0.012, z, 0.15, 3, 0, true);
  const arrowMat = new THREE.MeshStandardMaterial({ map: arrowTexture(), transparent: true, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, depthWrite: false });
  for (const [z, dir] of [[8, 1], [40, 1], [78, 1], [22, -1], [62, -1]] as const) {
    const a = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 2.8), arrowMat);
    a.rotation.set(-Math.PI / 2, 0, dir === 1 ? Math.PI : 0);
    a.position.set(dir === 1 ? 6 : -6, 0.014, z);
    scene.add(a);
  }
  const bumpStripe = (x: number, z: number) => {
    phys.world.createCollider(
      RAPIER.ColliderDesc.capsule(14.5, 0.16).setRotation({ x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 }).setTranslation(x, -0.06, z)
        .setCollisionGroups(groups(G.WORLD, 0xffff)),
    );
    for (let i = -14; i < 14; i++) {
      const g = new THREE.CylinderGeometry(0.16, 0.16, 1, 10, 1, false, 0, Math.PI);
      batch.add(g, i % 2 ? mats.paintYellow : mats.dark, new THREE.Matrix4().compose(
        new THREE.Vector3(x + i + 0.5, -0.06, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 2)), new THREE.Vector3(1, 1, 1)), false);
    }
  };
  bumpStripe(0, 36);
  bumpStripe(0, 70);

  // ------------------------------------------------------- garage + shop
  const features = buildGarage(scene, phys, batch, mats, parked, props, (x, y, z, w, l, yaw) => paintLine(x, y, z, w, l, yaw));
  features.push(...buildStuntYard(phys, batch, mats, parked));

  // the street between the car park's roof gap and the rental showroom
  for (let z = -97; z < -16; z += 1) {
    paintLine(-61.15, 0.012, z + 0.5, 0.12, 1, 0, true);
    paintLine(-60.85, 0.012, z + 0.5, 0.12, 1, 0, true);
  }
  for (let z = -96; z < -16; z += 5) for (const x of [-71, -51]) paintLine(x, 0.012, z, 0.14, 3);
  for (let i = 0; i < 14; i++) paintLine(-68 + i * 1.1, 0.013, -21, 0.55, 4); // zebra crossing

  // ------------------------------------------------------------- fence
  const fenceTex = fenceTexture();
  const fenceMat = new THREE.MeshStandardMaterial({ map: fenceTex, alphaTest: 0.5, side: THREE.DoubleSide, metalness: 0.6, roughness: 0.5, color: 0xdfe3e6 });
  const fenceH = 2.0;
  // each run is split into post-to-post panels; every panel is its own breakable body
  const fenceSets = new Map<string, InstancedBodies>();
  const fencePanels: { len: number; pos: THREE.Vector3; rot: THREE.Quaternion }[] = [];
  const fenceRun = (x0: number, z0: number, x1: number, z1: number) => {
    const runLen = Math.hypot(x1 - x0, z1 - z0);
    const yaw = Math.atan2(x1 - x0, z1 - z0);
    // body space: x along the run, z across it (the panel's face normal)
    const rot = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, yaw + Math.PI / 2);
    const n = Math.ceil(runLen / 3);
    const len = runLen / n;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      fencePanels.push({ len, pos: new THREE.Vector3(x0 + (x1 - x0) * t, 0, z0 + (z1 - z0) * t), rot });
    }
    // closing post at the far end of the run
    batch.add(new THREE.CylinderGeometry(0.04, 0.04, fenceH + 0.1, 6), mats.metal, new THREE.Matrix4().makeTranslation(x1, (fenceH + 0.1) / 2, z1), false);
  };
  const fencePanelParts = (len: number) => {
    const mesh = new THREE.PlaneGeometry(len, fenceH);
    const uv = mesh.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * len * 6, uv.getY(i) * fenceH * 6);
    mesh.translate(0, fenceH / 2, 0);
    // the post at the panel's run-start end (body +x) and the top rail
    const frame = mergeGeometries([
      new THREE.CylinderGeometry(0.04, 0.04, fenceH + 0.1, 6).translate(len / 2, (fenceH + 0.1) / 2, 0),
      new THREE.BoxGeometry(len, 0.05, 0.05).translate(0, fenceH, 0),
    ])!;
    return [
      { geometry: mesh, material: fenceMat, receiveShadow: false },
      { geometry: frame, material: mats.metal },
    ];
  };
  const { x0, x1, z0, z1, gateHalf } = LOT;
  fenceRun(x0, z0, x1, z0);
  fenceRun(x0, z0, x0, z1);
  fenceRun(x1, z0, x1, z1);
  fenceRun(x0, z1, -gateHalf - 1.5, z1);
  fenceRun(gateHalf + 1.5, z1, x1, z1);
  for (const panel of fencePanels) {
    const key = panel.len.toFixed(3);
    let set = fenceSets.get(key);
    if (!set) {
      set = new InstancedBodies(fencePanelParts(panel.len), fencePanels.filter((p) => p.len.toFixed(3) === key).length).addTo(scene);
      fenceSets.set(key, set);
    }
    const s = set;
    breakables.add(BREAK.fence, panel.pos, panel.rot,
      { kind: 'box', center: new THREE.Vector3(0, 1.2, 0), half: new THREE.Vector3(panel.len / 2, 1.2, 0.08) },
      (body) => ({ set: s, index: s.add(body) }));
  }

  // hedges just inside the fence
  const hedgeMats: THREE.Matrix4[] = [];
  for (let x = x0 + 4; x < x1 - 4; x += 6.2) {
    if (Math.abs(x) < 14) continue;
    hedgeMats.push(new THREE.Matrix4().makeTranslation(x, 0, z1 - 1.6));
  }
  for (let z = z0 + 6; z < z1 - 6; z += 6.2) {
    for (const x of [x0 + 1.6, x1 - 1.6]) hedgeMats.push(new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2), new THREE.Vector3(1, 1, 1)));
  }
  // soft: no collider, cars plough through and shake leaves out (see hedges.ts)
  const hedges = new Hedges(scene, hedgeMats);

  // ------------------------------------------------- entrance gate + plaza
  const arms: { body: RAPIER.RigidBody; mesh: THREE.Object3D; pivot: THREE.Vector3; dir: number; angle: number }[] = [];
  const armMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 });
  const armStripeTex = signTexture('', { bg: '#ffffff', fg: '#000', w: 512, h: 32 });
  {
    const c = armStripeTex.image as HTMLCanvasElement;
    const ctx = c.getContext('2d')!;
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = i % 2 ? '#ffffff' : '#d32f2f';
      ctx.fillRect(i * 64, 0, 64, 32);
    }
    armStripeTex.needsUpdate = true;
    armMat.map = armStripeTex;
  }
  for (const side of [-1, 1]) {
    const pivot = new THREE.Vector3(side * 6.6, 1.05, z1 - 0.8);
    batch.box({ x: pivot.x, y: 0.55, z: pivot.z }, { x: 0.45, y: 1.1, z: 0.45 }, mats.paintYellow);
    phys.staticBox({ x: pivot.x, y: 0.55, z: pivot.z }, { x: 0.225, y: 0.55, z: 0.225 });
    const len = 6.2;
    const mesh = new THREE.Group();
    const bar = new THREE.Mesh(new THREE.BoxGeometry(len, 0.12, 0.08), armMat);
    bar.position.x = -side * len / 2;
    bar.castShadow = true;
    mesh.add(bar);
    mesh.position.copy(pivot);
    scene.add(mesh);
    const body = phys.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(pivot.x, pivot.y, pivot.z));
    phys.world.createCollider(RAPIER.ColliderDesc.cuboid(len / 2, 0.06, 0.04).setTranslation(-side * len / 2, 0, 0).setCollisionGroups(groups(G.WORLD, 0xffff)), body);
    arms.push({ body, mesh, pivot, dir: side, angle: 0 });
  }
  // booth
  batch.box({ x: -10.5, y: 1.4, z: z1 + 2.5 }, { x: 2.4, y: 2.8, z: 2.4 }, mats.white);
  batch.box({ x: -10.5, y: 2.95, z: z1 + 2.5 }, { x: 3, y: 0.3, z: 3 }, mats.paintTeal);
  phys.staticBox({ x: -10.5, y: 1.4, z: z1 + 2.5 }, { x: 1.2, y: 1.4, z: 1.2 });
  // exit road to the perimeter road
  plane(-7, 7, z1, ROAD.z - ROAD.width / 2, 0.003, asphaltMat);
  // welcome sign + flags
  const welcome = new THREE.Mesh(new THREE.PlaneGeometry(8, 1.6), new THREE.MeshStandardMaterial({
    map: signTexture('CENTRAL PARK & RIDE', { sub: 'welcome · 2h free', bg: '#1d4f91', fg: '#ffffff', w: 1024, h: 205 }), roughness: 0.5,
  }));
  welcome.position.set(0, 4.6, z1 + 0.6);
  welcome.rotation.y = Math.PI;
  scene.add(welcome);
  for (const x of [-4.3, 4.3]) {
    batch.add(new THREE.CylinderGeometry(0.12, 0.12, 5.4, 8), mats.metal, new THREE.Matrix4().makeTranslation(x, 2.7, z1 + 0.62));
    phys.staticCylinder({ x, y: 2.7, z: z1 + 0.62 }, 2.7, 0.12);
  }
  batch.box({ x: 0, y: 4.6, z: z1 + 0.64 }, { x: 8.3, y: 1.8, z: 0.06 }, mats.dark);

  const flags: { geo: THREE.PlaneGeometry; base: Float32Array; phase: number }[] = [];
  const flagColors = ['#1d4f91', '#2f8f8a', '#f2c230'];
  flagColors.forEach((col, i) => {
    const x = -24 + i * 5;
    const z = z1 - 8;
    // pole + flag move together, origin at the foot of the pole
    const pole = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 9, 8), mats.metal);
    shaft.position.y = 4.5;
    shaft.castShadow = true;
    const geo = new THREE.PlaneGeometry(2.4, 1.4, 12, 4);
    geo.translate(1.2, 0, 0);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: col, side: THREE.DoubleSide, roughness: 0.8 }));
    mesh.position.set(0, 8.2, 0);
    mesh.rotation.y = 0.6;
    mesh.castShadow = true;
    pole.add(shaft, mesh);
    scene.add(pole);
    breakables.add(BREAK.flagPole, new THREE.Vector3(x, 0, z), new THREE.Quaternion(),
      { kind: 'cylinder', center: new THREE.Vector3(0, 4.5, 0), halfHeight: 4.5, radius: 0.08 }, () => ({ obj: pole }));
    flags.push({ geo, base: (geo.attributes.position.array as Float32Array).slice(), phase: i * 1.3 });
  });

  // plaza furniture
  const bollardXs: number[] = [];
  for (let x = -36; x <= 36; x += 3) if (Math.abs(x) > 16) bollardXs.push(x);
  const bollardSet = new InstancedBodies([{ geometry: bollardGeo(), material: propMaterial }], bollardXs.length).addTo(scene);
  for (const x of bollardXs) {
    breakables.add(BREAK.bollard, new THREE.Vector3(x, 0, z1 - 14), new THREE.Quaternion(),
      { kind: 'cylinder', center: new THREE.Vector3(0, 0.45, 0), halfHeight: 0.45, radius: 0.11 },
      (body) => ({ set: bollardSet, index: bollardSet.add(body) }));
  }
  const benches = [-40, -34, 34, 40].map((x) => new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z1 - 4), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI), new THREE.Vector3(1, 1, 1)));
  scene.add(staticInstances([{ geometry: benchGeo(), material: propMaterial }], benches));

  // --------------------------------------------------------------- trees
  // plaza & perimeter trees
  for (let x = -100; x <= 100; x += 9) if (Math.abs(x) > 14) trees.push({ x, z: z1 - 6 + (rand() - 0.5), kind: (rand() * 3) | 0, s: 0.9 + rand() * 0.4, r: rand() * 6 });
  for (let z = -95; z <= 95; z += 11) {
    trees.push({ x: x0 - 6, z, kind: (rand() * 3) | 0, s: 1 + rand() * 0.5, r: rand() * 6 });
    trees.push({ x: x1 + 6, z, kind: (rand() * 3) | 0, s: 1 + rand() * 0.5, r: rand() * 6 });
  }
  for (let x = -100; x <= 100; x += 11) trees.push({ x, z: z0 - 6, kind: (rand() * 3) | 0, s: 1 + rand() * 0.5, r: rand() * 6 });
  const treeKinds = [treeGeo(1, 'round'), treeGeo(2, 'pine'), treeGeo(3, 'tall')];
  treeKinds.forEach((geo, k) => {
    const list = trees.filter((t) => t.kind === k);
    const ms = list.map((t) => new THREE.Matrix4().compose(new THREE.Vector3(t.x, t.kind === 0 && Math.abs(t.z) < 90 ? 0.16 : 0, t.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.r), new THREE.Vector3(t.s, t.s, t.s)));
    scene.add(staticInstances([{ geometry: geo, material: propMaterialFlat }], ms));
  });
  for (const t of trees) phys.staticCylinder({ x: t.x, y: 1.5, z: t.z }, 1.5, 0.2 * t.s);

  // lamps
  const lampSet = new InstancedBodies([
    { geometry: lamp.body, material: propMaterial },
    { geometry: lamp.heads, material: new THREE.MeshStandardMaterial({ vertexColors: true, emissive: 0xfff4e0, emissiveIntensity: 0.6 }), castShadow: false },
  ], lampMats.length).addTo(scene);
  for (const m of lampMats) {
    const pos = new THREE.Vector3();
    const rot = new THREE.Quaternion();
    m.decompose(pos, rot, new THREE.Vector3());
    breakables.add(BREAK.lamp, pos, rot,
      { kind: 'cylinder', center: new THREE.Vector3(0, 4, 0), halfHeight: 4, radius: 0.2 },
      (body) => ({ set: lampSet, index: lampSet.add(body) }));
  }

  // ------------------------------------------------------- perimeter road
  const roadMat = new THREE.MeshStandardMaterial({ map: asphalt.clone(), roughness: 0.9, color: 0xc8c8c8 });
  roadMat.map!.needsUpdate = true;
  const R = ROAD;
  const hw = R.width / 2;
  plane(-R.x - hw, R.x + hw, -R.z - hw, -R.z + hw, 0.004, roadMat);
  plane(-R.x - hw, R.x + hw, R.z - hw, R.z + hw, 0.004, roadMat);
  plane(-R.x - hw, -R.x + hw, -R.z + hw, R.z - hw, 0.004, roadMat);
  plane(R.x - hw, R.x + hw, -R.z + hw, R.z - hw, 0.004, roadMat);
  for (let x = -R.x; x < R.x; x += 7) {
    paintLine(x, 0.014, -R.z, 0.14, 3.5, Math.PI / 2);
    paintLine(x, 0.014, R.z, 0.14, 3.5, Math.PI / 2);
  }
  for (let z = -R.z; z < R.z; z += 7) {
    paintLine(-R.x, 0.014, z, 0.14, 3.5);
    paintLine(R.x, 0.014, z, 0.14, 3.5);
  }
  // sidewalks on the outside of the loop
  const walk = 3;
  const sw = (x0s: number, x1s: number, z0s: number, z1s: number) => {
    batch.box({ x: (x0s + x1s) / 2, y: 0.06, z: (z0s + z1s) / 2 }, { x: x1s - x0s, y: 0.12, z: z1s - z0s }, mats.concrete, undefined, false);
    phys.staticBox({ x: (x0s + x1s) / 2, y: 0.06, z: (z0s + z1s) / 2 }, { x: (x1s - x0s) / 2, y: 0.06, z: (z1s - z0s) / 2 });
  };
  const o = R.x + hw, oz = R.z + hw;
  sw(-o - walk, o + walk, -oz - walk, -oz);
  sw(-o - walk, o + walk, oz, oz + walk);
  sw(-o - walk, -o, -oz, oz);
  sw(o, o + walk, -oz, oz);

  // world bounds (invisible)
  for (const [cx, cz, hx, hz] of [[0, -215, 230, 2], [0, 215, 230, 2], [-215, 0, 2, 230], [215, 0, 2, 230]] as const) {
    phys.staticBox({ x: cx, y: 10, z: cz }, { x: hx, y: 10, z: hz });
  }

  // ------------------------------------------------------------- props
  // cone slalom east of the car park
  for (let i = 0; i < 8; i++) props.add('cone', 90 + (i % 2 ? 1.2 : -1.2), 0, -64 + i * 5);
  // construction corner (north-east)
  for (let i = 0; i < 10; i++) props.add(i % 2 ? 'barrier' : 'barrierWhite', 78 + i * 1.6, 0, -82);
  for (let i = 0; i < 6; i++) props.add(i % 2 ? 'barrier' : 'barrierWhite', 77, 0, -83.5 - i * 1.6, Math.PI / 2);
  for (let i = 0; i < 9; i++) props.add(rand() > 0.5 ? 'barrel' : 'barrelBlue', 82 + (i % 3) * 0.7, 0, -90 + Math.floor(i / 3) * 0.7);
  for (let i = 0; i < 5; i++) for (let k = 0; k < 3; k++) props.add('pallet', 88 + i * 1.4, k * 0.15, -92);
  for (let i = 0; i < 12; i++) props.add('boxBig', 97 + (i % 4) * 1, Math.floor(i / 4) * 0.72, -94);
  batch.box({ x: 104, y: 0.9, z: -96 }, { x: 4, y: 1.8, z: 2 }, mats.paintTeal);
  phys.staticBox({ x: 104, y: 0.9, z: -96 }, { x: 2, y: 0.9, z: 1 });
  // trolley corral by the entrance
  for (let i = 0; i < 7; i++) props.add('trolley', -60 + i * 0.35, 0, 88, Math.PI / 2);
  // bins along the plaza
  for (let i = 0; i < 6; i++) props.add(i % 2 ? 'bin' : 'binBlue', 50 + i * 0.75, 0, 96);
  // loose barrels beside the showroom
  for (let i = 0; i < 6; i++) props.add('barrel', -104 + (i % 3) * 0.8, 0, -34 - Math.floor(i / 3) * 0.8);

  // ------------------------------------------------------------- finish
  const lines = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({
    color: 0xf4f4ef, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }), lineMats.length);
  lineMats.forEach((m, i) => lines.setMatrixAt(i, m));
  lines.receiveShadow = true;
  lines.computeBoundingSphere();
  scene.add(lines);
  const ylines = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({
    color: 0xf2c230, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }), yellowMats.length);
  yellowMats.forEach((m, i) => ylines.setMatrixAt(i, m));
  ylines.receiveShadow = true;
  ylines.computeBoundingSphere();
  scene.add(ylines);
  batch.build(scene);
  phys.sync(true);

  let time = 0;
  return {
    parked,
    props,
    breakables,
    hedges,
    features,
    spawn: { x: 6, y: 0, z: 46, yaw: Math.PI },
    update(dt, p) {
      time += dt;
      // gate arms lift when the car approaches
      for (const a of arms) {
        const near = Math.hypot(p.x - a.pivot.x * 0.5, p.z - a.pivot.z) < 16;
        const target = near ? 1.45 : 0;
        a.angle += (target - a.angle) * Math.min(1, dt * 2.5);
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -a.dir * a.angle);
        a.body.setNextKinematicRotation(q);
        a.mesh.quaternion.copy(q);
      }
      // flags
      for (const f of flags) {
        const pos = f.geo.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < pos.count; i++) {
          const bx = f.base[i * 3], by = f.base[i * 3 + 1];
          const k = bx / 2.4;
          pos.setZ(i, Math.sin(bx * 2.2 - time * 5 + f.phase) * 0.22 * k + Math.sin(by * 3 + time * 3) * 0.04 * k);
          pos.setY(i, by - k * k * 0.1);
        }
        pos.needsUpdate = true;
        f.geo.computeVertexNormals();
      }
    },
  };
}

