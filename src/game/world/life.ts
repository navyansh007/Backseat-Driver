import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { CAR_COLORS, type ParkedCars } from './dynamics';
import { ROAD } from './lot';
import { rng } from './textures';

/** A closed rounded-rectangle loop, sampled for constant-speed travel. */
class Loop {
  readonly pts: THREE.Vector3[] = [];
  readonly length: number;
  private cum: number[] = [];

  constructor(hx: number, hz: number, r: number, reverse: boolean) {
    const corners = [
      [hx - r, hz - r, 0], [-hx + r, hz - r, Math.PI / 2], [-hx + r, -hz + r, Math.PI], [hx - r, -hz + r, (3 * Math.PI) / 2],
    ] as const;
    for (const [cx, cz, a0] of corners) {
      for (let i = 0; i <= 12; i++) {
        const a = a0 + (i / 12) * (Math.PI / 2);
        this.pts.push(new THREE.Vector3(cx + Math.cos(a) * r, 0, cz + Math.sin(a) * r));
      }
    }
    if (reverse) this.pts.reverse();
    let acc = 0;
    for (let i = 0; i < this.pts.length; i++) {
      this.cum.push(acc);
      acc += this.pts[i].distanceTo(this.pts[(i + 1) % this.pts.length]);
    }
    this.length = acc;
  }

  sample(s: number, out: THREE.Vector3): number {
    s = ((s % this.length) + this.length) % this.length;
    let lo = 0, hi = this.cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cum[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    const a = this.pts[lo], b = this.pts[(lo + 1) % this.pts.length];
    const seg = b.distanceTo(a) || 1;
    out.lerpVectors(a, b, (s - this.cum[lo]) / seg);
    return Math.atan2(b.x - a.x, b.z - a.z);
  }
}

interface TrafficCar { body: RAPIER.RigidBody; lane: Loop; s: number; v: number; vmax: number; dead: boolean }
interface Walker { s: number; dir: number; v: number; phase: number; lane: Loop; offset: number; panic: number }

export class Life {
  private traffic: TrafficCar[] = [];
  private walkers: Walker[] = [];
  private torso: THREE.InstancedMesh;
  private head: THREE.InstancedMesh;
  private legs: THREE.InstancedMesh;
  private birdL: THREE.InstancedMesh;
  private birdR: THREE.InstancedMesh;
  private birds: { a: number; r: number; h: number; speed: number; flap: number }[] = [];
  private clouds: THREE.InstancedMesh;
  private cloudData: { p: THREE.Vector3; s: THREE.Vector3 }[] = [];
  private time = 0;
  private tmp = new THREE.Vector3();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();

  constructor(scene: THREE.Scene, cars: ParkedCars) {
    const rand = rng(31337);

    // --------------------------------------------------------- traffic
    const laneOff = 2.4;
    const lanes = [
      new Loop(ROAD.x + laneOff, ROAD.z + laneOff, 14, false),
      new Loop(ROAD.x - laneOff, ROAD.z - laneOff, 10, true),
    ];
    const kinds = ['sedan', 'hatch', 'suv', 'van', 'sedan', 'executive'];
    lanes.forEach((lane, li) => {
      const n = 11;
      for (let i = 0; i < n; i++) {
        const s = (i / n) * lane.length + rand() * 8;
        const yaw = lane.sample(s, this.tmp);
        const body = cars.place(kinds[(rand() * kinds.length) | 0], this.tmp.x, 0, this.tmp.z, yaw, CAR_COLORS[(rand() * CAR_COLORS.length) | 0], true);
        const vmax = 10 + rand() * 4 + li;
        this.traffic.push({ body, lane, s, v: vmax, vmax, dead: false });
      }
    });

    // --------------------------------------------------------- people
    const walkLane = new Loop(ROAD.x + ROAD.width / 2 + 1.5, ROAD.z + ROAD.width / 2 + 1.5, 4, false);
    const N = 34;
    for (let i = 0; i < N; i++) {
      this.walkers.push({ s: rand() * walkLane.length, dir: rand() < 0.5 ? 1 : -1, v: 1.1 + rand() * 0.5, phase: rand() * 10, lane: walkLane, offset: (rand() - 0.5) * 1.6, panic: 0 });
    }
    const torsoGeo = new THREE.CapsuleGeometry(0.2, 0.42, 4, 8);
    torsoGeo.translate(0, 1.18, 0);
    const armGeoL = new THREE.CapsuleGeometry(0.06, 0.5, 3, 6).translate(0.27, 1.12, 0);
    const armGeoR = new THREE.CapsuleGeometry(0.06, 0.5, 3, 6).translate(-0.27, 1.12, 0);
    const torsoAll = mergeSimple([torsoGeo, armGeoL, armGeoR]);
    const headGeo = new THREE.SphereGeometry(0.13, 10, 8).translate(0, 1.68, 0);
    const legGeo = new THREE.CapsuleGeometry(0.08, 0.66, 3, 6).translate(0, -0.42, 0);
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.8 });
    this.torso = new THREE.InstancedMesh(torsoAll, mat, N);
    this.head = new THREE.InstancedMesh(headGeo, mat, N);
    this.legs = new THREE.InstancedMesh(legGeo, mat, N * 2);
    const shirts = [0xe85d4a, 0x4a7fe8, 0xf2c230, 0x2f8f8a, 0xffffff, 0x8e5bd6, 0x333333, 0xf28ab2];
    const skins = [0xf1c8a5, 0xd9a47e, 0xa8714f, 0x6f4a33, 0xe8b894];
    const pants = [0x2b3a55, 0x3b3b3b, 0x6b5b45, 0x1f2a44, 0x8a8f99];
    const c = new THREE.Color();
    for (let i = 0; i < N; i++) {
      this.torso.setColorAt(i, c.set(shirts[(rand() * shirts.length) | 0]));
      this.head.setColorAt(i, c.set(skins[(rand() * skins.length) | 0]));
      const p = pants[(rand() * pants.length) | 0];
      this.legs.setColorAt(i * 2, c.set(p));
      this.legs.setColorAt(i * 2 + 1, c.set(p));
    }
    for (const im of [this.torso, this.head, this.legs]) {
      im.castShadow = true;
      im.frustumCulled = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(im);
    }

    // --------------------------------------------------------- birds
    const wing = new THREE.BufferGeometry();
    wing.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.18, 0, 0, -0.12, 0.55, 0, -0.05], 3));
    wing.computeVertexNormals();
    const wingR = wing.clone().scale(-1, 1, 1);
    const birdMat = new THREE.MeshBasicMaterial({ color: 0x2c3036, side: THREE.DoubleSide, fog: true });
    const NB = 26;
    this.birdL = new THREE.InstancedMesh(wing, birdMat, NB);
    this.birdR = new THREE.InstancedMesh(wingR, birdMat, NB);
    for (let i = 0; i < NB; i++) this.birds.push({ a: rand() * Math.PI * 2, r: 30 + rand() * 25, h: 28 + rand() * 14, speed: 0.12 + rand() * 0.05, flap: rand() * 10 });
    for (const im of [this.birdL, this.birdR]) {
      im.frustumCulled = false;
      scene.add(im);
    }

    // --------------------------------------------------------- clouds
    const puff = new THREE.IcosahedronGeometry(1, 1);
    const cloudMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true, emissive: 0xdde6ee, emissiveIntensity: 0.35, fog: false });
    const NC = 30;
    const per = 6;
    this.clouds = new THREE.InstancedMesh(puff, cloudMat, NC * per);
    for (let i = 0; i < NC; i++) {
      const base = new THREE.Vector3((rand() - 0.5) * 1800, 170 + rand() * 90, (rand() - 0.5) * 1800);
      const size = 22 + rand() * 30;
      for (let k = 0; k < per; k++) {
        const p = base.clone().add(new THREE.Vector3((rand() - 0.5) * size * 2.2, (rand() - 0.3) * size * 0.4, (rand() - 0.5) * size));
        const s = size * (0.45 + rand() * 0.5);
        this.cloudData.push({ p, s: new THREE.Vector3(s, s * 0.55, s * 0.8) });
      }
    }
    this.clouds.frustumCulled = false;
    scene.add(this.clouds);
  }

  /** A traffic car was destroyed: stop driving it (physics takes over). */
  trafficDestroyed(body: RAPIER.RigidBody) {
    const car = this.traffic.find((c) => c.body === body);
    if (car) {
      car.dead = true;
      car.v = 0;
    }
  }

  /** A destroyed traffic car is back (body already kinematic again): resume on its lane. */
  trafficRespawn(body: RAPIER.RigidBody) {
    const car = this.traffic.find((c) => c.body === body);
    if (!car) return;
    car.dead = false;
    car.v = 0;
    const yaw = car.lane.sample(car.s, this.tmp);
    body.setTranslation({ x: this.tmp.x, y: 0, z: this.tmp.z }, true);
    body.setRotation(this.q.setFromAxisAngle(UP, yaw), true);
  }

  /** People near an explosion run away from it for a while. */
  panic(p: THREE.Vector3, radius: number) {
    for (const w of this.walkers) {
      const yaw = w.lane.sample(w.s, this.tmp);
      if (this.tmp.distanceTo(p) > radius) continue;
      // run along the sidewalk, away from the blast
      const ahead = (p.x - this.tmp.x) * Math.sin(yaw) + (p.z - this.tmp.z) * Math.cos(yaw);
      w.dir = ahead > 0 ? -1 : 1;
      w.panic = 6;
    }
  }

  update(dt: number, player: THREE.Vector3) {
    this.time += dt;
    const t = this.time;

    // traffic: simple car-following + yield to the player
    for (const car of this.traffic) {
      if (car.dead) continue;
      let target = car.vmax;
      const yaw = car.lane.sample(car.s, this.tmp);
      const fx = Math.sin(yaw), fz = Math.cos(yaw);
      const check = (px: number, pz: number, gap: number) => {
        const dx = px - this.tmp.x, dz = pz - this.tmp.z;
        const ahead = dx * fx + dz * fz;
        const side = Math.abs(dx * fz - dz * fx);
        if (ahead > 0 && ahead < gap && side < 2.6) target = Math.min(target, Math.max(0, (ahead - 6) * 0.9));
      };
      check(player.x, player.z, 22);
      for (const o of this.traffic) {
        if (o === car || o.lane !== car.lane) continue;
        if (o.dead) {
          // treat a wreck on the road as an obstacle
          const t = o.body.translation();
          check(t.x, t.z, 22);
          continue;
        }
        const d = (o.s - car.s + car.lane.length) % car.lane.length;
        if (d < 18) target = Math.min(target, Math.max(0, (d - 7) * 1.1));
      }
      car.v += THREE.MathUtils.clamp(target - car.v, -9 * dt, 3 * dt);
      car.s += car.v * dt;
      const y2 = car.lane.sample(car.s, this.tmp);
      car.body.setNextKinematicTranslation({ x: this.tmp.x, y: 0, z: this.tmp.z });
      this.q.setFromAxisAngle(UP, y2);
      car.body.setNextKinematicRotation(this.q);
    }

    // pedestrians
    this.walkers.forEach((w, i) => {
      w.panic = Math.max(0, w.panic - dt);
      const speed = w.panic > 0 ? 4.2 : w.v;
      w.s += speed * w.dir * dt;
      const yaw = w.lane.sample(w.s, this.tmp) + (w.dir < 0 ? Math.PI : 0);
      // sideways offset across the sidewalk
      this.tmp.x += Math.cos(yaw) * w.offset;
      this.tmp.z -= Math.sin(yaw) * w.offset;
      // step aside if the car comes close
      const dx = this.tmp.x - player.x, dz = this.tmp.z - player.z;
      const d = Math.hypot(dx, dz);
      if (d < 4) {
        this.tmp.x += (dx / d) * (4 - d);
        this.tmp.z += (dz / d) * (4 - d);
      }
      const cyc = t * speed * (w.panic > 0 ? 2.2 : 3.2) + w.phase;
      const bob = Math.abs(Math.sin(cyc)) * 0.05;
      this.q.setFromAxisAngle(UP, yaw);
      this.m.compose(this.tmp.clone().setY(0.12 + bob), this.q, ONE);
      this.torso.setMatrixAt(i, this.m);
      this.head.setMatrixAt(i, this.m);
      for (const side of [0, 1]) {
        const swing = Math.sin(cyc + side * Math.PI) * 0.5;
        const leg = new THREE.Matrix4().compose(
          new THREE.Vector3((side ? -0.1 : 0.1), 0.94, 0),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), swing),
          ONE,
        );
        this.legs.setMatrixAt(i * 2 + side, leg.premultiply(this.m));
      }
    });
    this.torso.instanceMatrix.needsUpdate = true;
    this.head.instanceMatrix.needsUpdate = true;
    this.legs.instanceMatrix.needsUpdate = true;

    // birds circling over the car park
    const cx = Math.sin(t * 0.03) * 40, cz = -10 + Math.cos(t * 0.025) * 40;
    this.birds.forEach((b, i) => {
      b.a += b.speed * dt;
      const x = cx + Math.cos(b.a) * b.r;
      const z = cz + Math.sin(b.a) * b.r;
      const y = b.h + Math.sin(t * 0.7 + i) * 2;
      const heading = Math.atan2(-Math.sin(b.a), Math.cos(b.a));
      const flap = Math.sin(t * 9 + b.flap) * 0.7;
      for (const [im, s] of [[this.birdL, 1], [this.birdR, -1]] as const) {
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, heading, s * flap + s * 0.1, 'YXZ'));
        this.m.compose(new THREE.Vector3(x, y, z), q, BIRD_SCALE);
        im.setMatrixAt(i, this.m);
      }
    });
    this.birdL.instanceMatrix.needsUpdate = true;
    this.birdR.instanceMatrix.needsUpdate = true;

    // clouds drift and wrap
    this.cloudData.forEach((c, i) => {
      c.p.x += dt * 2.2;
      if (c.p.x > 950) c.p.x -= 1900;
      this.m.compose(c.p, IDQ, c.s);
      this.clouds.setMatrixAt(i, this.m);
    });
    this.clouds.instanceMatrix.needsUpdate = true;
  }
}

const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);
const IDQ = new THREE.Quaternion();
const BIRD_SCALE = new THREE.Vector3(1.4, 1.4, 1.4);

function mergeSimple(list: THREE.BufferGeometry[]) {
  const pos: number[] = [], nor: number[] = [];
  for (const g of list) {
    const ng = g.index ? g.toNonIndexed() : g;
    pos.push(...(ng.attributes.position.array as Float32Array));
    nor.push(...(ng.attributes.normal.array as Float32Array));
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return out;
}
