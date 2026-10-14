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

export class Life {
  private traffic: TrafficCar[] = [];
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
const IDQ = new THREE.Quaternion();
const BIRD_SCALE = new THREE.Vector3(1.4, 1.4, 1.4);
