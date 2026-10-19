import * as THREE from 'three';
import type { RAPIER } from '../physics';
import { hedgeGeo, propMaterialFlat } from '../models/props';

const LEN = 6;
const HALF_W = 0.6;
const HEIGHT = 1.2;
/** How hard a hedge drags on a car inside it: a·v + b·v² deceleration (1/s, 1/m). */
const DRAG_LIN = 0.55;
const DRAG_QUAD = 0.022;
const SPRING = 55;
const DAMP = 5.5;
const MAX_LEAN = 0.55;

interface Hedge {
  p: THREE.Vector3;
  yaw: number;
  half: THREE.Vector2; // world-axis half extents (x, z)
  lean: THREE.Vector2; // top offset, m
  leanV: THREE.Vector2;
  phase: number;
}

/** Something that can plough through a hedge. */
export interface Mover {
  body: RAPIER.RigidBody;
  /** half length along the body's forward axis */
  halfLength: number;
  radius: number;
  /** slowed by the foliage (the player); others just disturb it */
  drag: boolean;
}

export interface HedgeHooks {
  onRustle(power: number, entering: boolean, body: RAPIER.RigidBody): void;
}

/**
 * Soft hedges: no collider, so cars push straight through. A car inside one
 * is slowed by speed-dependent drag, bends the hedge on a spring, and shakes
 * leaves loose. All hedges sway a little in the breeze.
 */
export class Hedges {
  hooks: HedgeHooks | null = null;
  readonly leaves: Leaves;
  private list: Hedge[] = [];
  private mesh: THREE.InstancedMesh;
  private inside = new Map<number, number>(); // body handle → time spent inside hedges
  private rustleT = 0;
  private time = 0;
  private m = new THREE.Matrix4();
  private shear = new THREE.Matrix4();
  private rot = new THREE.Matrix4();
  private fwd = new THREE.Vector3();
  private pt = new THREE.Vector3();
  private q = new THREE.Quaternion();

  constructor(scene: THREE.Scene, matrices: THREE.Matrix4[]) {
    this.mesh = new THREE.InstancedMesh(hedgeGeo(LEN), propMaterialFlat, matrices.length);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    for (const mat of matrices) {
      const p = new THREE.Vector3().setFromMatrixPosition(mat);
      const yaw = new THREE.Euler().setFromRotationMatrix(mat, 'YXZ').y;
      const along = Math.abs(Math.cos(yaw)) > 0.5; // long axis on world x
      this.list.push({
        p, yaw,
        half: along ? new THREE.Vector2(LEN / 2, HALF_W) : new THREE.Vector2(HALF_W, LEN / 2),
        lean: new THREE.Vector2(), leanV: new THREE.Vector2(), phase: Math.random() * Math.PI * 2,
      });
    }
    this.list.forEach((_, i) => this.write(i));
    scene.add(this.mesh);
    this.leaves = new Leaves(scene, 700);
  }

  update(dt: number, movers: Mover[]) {
    if (dt <= 0) return;
    this.time += dt;
    this.rustleT -= dt;
    for (const mv of movers) this.push(mv, dt);

    // springs + breeze
    const gust = 0.5 + 0.5 * Math.sin(this.time * 0.37);
    for (let i = 0; i < this.list.length; i++) {
      const h = this.list[i];
      const bx = Math.sin(this.time * 1.3 + h.phase) * 0.025 * gust;
      const bz = Math.sin(this.time * 1.7 + h.phase * 1.4) * 0.018 * gust;
      h.leanV.x += (-SPRING * (h.lean.x - bx) - DAMP * h.leanV.x) * dt;
      h.leanV.y += (-SPRING * (h.lean.y - bz) - DAMP * h.leanV.y) * dt;
      h.lean.addScaledVector(h.leanV, dt);
      if (h.lean.length() > MAX_LEAN) h.lean.setLength(MAX_LEAN);
      this.write(i);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.leaves.update(dt);
  }

  private push(mv: Mover, dt: number) {
    const body = mv.body;
    if (!body.isEnabled() || body.isSleeping()) return;
    const t = body.translation();
    if (t.y > HEIGHT + 1.2) return; // flying over
    const lv = body.linvel();
    const speed = Math.hypot(lv.x, lv.z);
    const r = body.rotation();
    this.fwd.set(0, 0, 1).applyQuaternion(this.q.set(r.x, r.y, r.z, r.w));

    let hit: Hedge | null = null;
    let depth = 0;
    for (const h of this.list) {
      // cheap reject on distance
      if (Math.abs(t.x - h.p.x) > h.half.x + mv.halfLength + mv.radius || Math.abs(t.z - h.p.z) > h.half.y + mv.halfLength + mv.radius) continue;
      for (const k of [-1, 0, 1]) {
        const px = t.x + this.fwd.x * mv.halfLength * k;
        const pz = t.z + this.fwd.z * mv.halfLength * k;
        const ox = h.half.x + mv.radius - Math.abs(px - h.p.x);
        const oz = h.half.y + mv.radius - Math.abs(pz - h.p.z);
        if (ox <= 0 || oz <= 0) continue;
        const d = Math.min(ox, oz, mv.radius * 2);
        if (d > depth) {
          depth = d;
          hit = h;
          this.pt.set(THREE.MathUtils.clamp(px, h.p.x - h.half.x, h.p.x + h.half.x), 0, THREE.MathUtils.clamp(pz, h.p.z - h.half.y, h.p.z + h.half.y));
        }
      }
    }

    const was = this.inside.get(body.handle);
    if (!hit) {
      if (was !== undefined) this.inside.delete(body.handle);
      return;
    }
    const entering = was === undefined;
    this.inside.set(body.handle, (was ?? 0) + dt);
    const fill = Math.min(1, depth / (mv.radius * 1.5)); // how much of the car is buried in it

    // the hedge bends away in the direction of travel, more the faster you go
    const k = Math.min(1, speed / 14) * fill;
    hit.leanV.x += lv.x * 0.9 * k * dt * 8;
    hit.leanV.y += lv.z * 0.9 * k * dt * 8;
    if (entering) {
      hit.leanV.x += lv.x * 0.06;
      hit.leanV.y += lv.z * 0.06;
    }

    // foliage drag (only on cars that should feel it)
    if (mv.drag && speed > 0.3) {
      const decel = (DRAG_LIN * speed + DRAG_QUAD * speed * speed) * fill;
      const dv = Math.min(speed, decel * dt);
      const m = body.mass();
      body.applyImpulse({ x: (-lv.x / speed) * dv * m, y: 0, z: (-lv.z / speed) * dv * m }, true);
    }

    // leaves: a burst on the way in, then a steady trickle while moving
    if (speed > 0.8) {
      const vel = new THREE.Vector3(lv.x, 0, lv.z);
      const rate = speed * 4.5 * fill; // leaves per second
      let n = Math.floor(rate * dt + Math.random());
      if (entering) n += 6 + Math.round(speed * 1.2);
      if (n > 0) this.leaves.emit(hit, this.pt, vel, n);
      if (this.hooks && (entering || this.rustleT <= 0)) {
        this.hooks.onRustle(Math.min(1, speed / 20) * (0.5 + 0.5 * fill), entering, body);
        this.rustleT = 0.09 + Math.random() * 0.08;
      }
    }
  }

  private write(i: number) {
    const h = this.list[i];
    // shear so the base stays rooted and the crown follows the lean; squash a touch as it bends
    const l = h.lean.length();
    const sy = 1 - Math.min(0.25, l * 0.35);
    this.shear.set(
      1, h.lean.x / HEIGHT, 0, 0,
      0, sy, 0, 0,
      0, h.lean.y / HEIGHT, 1, 0,
      0, 0, 0, 1,
    );
    this.rot.makeRotationY(h.yaw);
    this.m.makeTranslation(h.p.x, h.p.y, h.p.z).multiply(this.shear).multiply(this.rot);
    this.mesh.setMatrixAt(i, this.m);
  }
}

const LEAF_COLORS = [0x5d9445, 0x4f8a3e, 0x6ea94f, 0x3f7533, 0x8aa84a, 0xa39a4a, 0x7a6a3a];

/** Small flat leaves that flutter down, settle on the ground and fade. */
export class Leaves {
  private mesh: THREE.InstancedMesh;
  private d: { p: THREE.Vector3; v: THREE.Vector3; q: THREE.Quaternion; w: THREE.Vector3; s: number; t: number; life: number; phase: number; landed: boolean }[] = [];
  private next = 0;
  private m = new THREE.Matrix4();
  private dq = new THREE.Quaternion();
  private tv = new THREE.Vector3();
  private sv = new THREE.Vector3();
  private live = 0;

  constructor(scene: THREE.Scene, private max: number) {
    // a pointed oval leaf in the XZ plane with a slight fold along its spine
    const shape = new THREE.Shape();
    shape.moveTo(0, -0.5);
    shape.quadraticCurveTo(0.42, -0.1, 0, 0.5);
    shape.quadraticCurveTo(-0.42, -0.1, 0, -0.5);
    const geo = new THREE.ShapeGeometry(shape, 3);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) pos.setZ(i, Math.abs(pos.getX(i)) * 0.35);
    geo.rotateX(-Math.PI / 2);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.75 });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3).fill(1), 3);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    for (let i = 0; i < max; i++) {
      this.d.push({ p: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(), w: new THREE.Vector3(), s: 0, t: 0, life: 0, phase: 0, landed: false });
      this.mesh.setMatrixAt(i, this.m.makeScale(0, 0, 0));
    }
    scene.add(this.mesh);
  }

  emit(h: { p: THREE.Vector3; half: THREE.Vector2 }, at: THREE.Vector3, carVel: THREE.Vector3, count: number) {
    const c = new THREE.Color();
    const speed = carVel.length();
    for (let k = 0; k < count; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.max;
      const d = this.d[i];
      if (d.life === 0) this.live++;
      // somewhere in the foliage around the contact
      d.p.set(
        THREE.MathUtils.clamp(at.x + (Math.random() - 0.5) * 1.6, h.p.x - h.half.x, h.p.x + h.half.x),
        0.3 + Math.random() * (HEIGHT - 0.1),
        THREE.MathUtils.clamp(at.z + (Math.random() - 0.5) * 1.6, h.p.z - h.half.y, h.p.z + h.half.y),
      );
      // dragged along by the car, flicked up and out
      d.v.copy(carVel).multiplyScalar(0.25 + Math.random() * 0.45)
        .add(this.tv.set((Math.random() - 0.5) * 3.5, 1.2 + Math.random() * (2 + speed * 0.18), (Math.random() - 0.5) * 3.5));
      d.q.setFromEuler(new THREE.Euler(Math.random() * 6.3, Math.random() * 6.3, Math.random() * 6.3));
      d.w.set((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 14);
      d.s = 0.07 + Math.random() * 0.07;
      d.t = 0;
      d.life = 4 + Math.random() * 4;
      d.phase = Math.random() * Math.PI * 2;
      d.landed = false;
      c.setHex(LEAF_COLORS[(Math.random() * LEAF_COLORS.length) | 0]).multiplyScalar(0.8 + Math.random() * 0.35);
      this.mesh.setColorAt(i, c);
    }
    this.mesh.instanceColor!.needsUpdate = true;
  }

  update(dt: number) {
    if (!this.live) return;
    for (let i = 0; i < this.max; i++) {
      const d = this.d[i];
      if (d.life === 0) continue;
      d.t += dt;
      if (d.t >= d.life) {
        d.life = 0;
        this.live--;
        this.mesh.setMatrixAt(i, this.m.makeScale(0, 0, 0));
        continue;
      }
      if (!d.landed) {
        // light and draggy: terminal velocity of ~1 m/s, side-to-side flutter while falling
        d.v.y -= 9.81 * 0.6 * dt;
        d.v.multiplyScalar(Math.exp(-dt * 3.2));
        const f = Math.sin(d.t * 5.5 + d.phase);
        d.p.x += (d.v.x + f * 0.6 * Math.cos(d.phase)) * dt;
        d.p.y += d.v.y * dt;
        d.p.z += (d.v.z + f * 0.6 * Math.sin(d.phase)) * dt;
        const wl = d.w.length();
        if (wl > 0.01) {
          this.dq.setFromAxisAngle(this.tv.copy(d.w).divideScalar(wl), wl * dt);
          d.q.premultiply(this.dq);
        }
        if (d.p.y <= 0.012) {
          // settle flat on the ground
          d.p.y = 0.012 + Math.random() * 0.004;
          d.landed = true;
          d.q.setFromAxisAngle(this.tv.set(0, 1, 0), Math.random() * Math.PI * 2);
        }
      }
      const fade = Math.min(1, (d.life - d.t) / 0.8);
      this.mesh.setMatrixAt(i, this.m.compose(d.p, d.q, this.sv.setScalar(d.s * fade)));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
