import * as THREE from 'three';
import { RAPIER, G, groups, type Physics } from '../physics';
import { TUNING } from '../vehiclePhysics';
import { buildCar, carMeshes, makeCarMaterials, wheelMesh, type CarMaterials } from '../models/carModel';
import { buildWreck } from '../models/wreckModel';
import { carDef, type CarDef } from '../cars/roster';
import type { CombatFx } from '../combat/fx';
import type { Destruction } from '../combat/destruction';
import type { WreckFx } from '../combat/wreck';
import type { PoseMsg } from '../../shared/arena';

/** Poses are drawn this far in the past, so there are usually two to blend between. */
const DELAY_MS = 110;
/** Past the newest pose, keep moving on its velocity for at most this long. */
const MAX_EXTRAPOLATE_MS = 250;

interface Snap {
  at: number;
  p: THREE.Vector3;
  q: THREE.Quaternion;
  v: THREE.Vector3;
  w: number;
  s: number;
  b: boolean;
}

/**
 * Another player's car: their model on a kinematic body that follows the poses they stream, so
 * it can be rammed, shot and locked on to like any car. Nothing is drawn but the car itself
 * (and its burnt-out shell once wrecked).
 */
export class Rival {
  readonly root = new THREE.Group();
  readonly body: RAPIER.RigidBody;
  readonly def: CarDef;
  alive = false;
  private model = new THREE.Group();
  private shell = new THREE.Group();
  private mats: CarMaterials;
  private wheels: THREE.Group[] = [];
  private wheelPos: THREE.Vector3[] = [];
  private snaps: Snap[] = [];
  private spin = 0;
  private glow = 0;
  private pose = { p: new THREE.Vector3(), q: new THREE.Quaternion(), v: new THREE.Vector3(), w: 0, s: 0, b: false };

  constructor(readonly id: string, carId: string, private phys: Physics, scene: THREE.Scene) {
    this.def = carDef(carId);
    const spec = this.def.spec;
    this.mats = makeCarMaterials(this.def.paint, spec.plate, { seeThrough: !this.def.blackout, rim: this.def.rim, solid: this.def.solid, interior: this.def.interior });
    const parts = buildCar(spec, { includeWheels: false, interior: !this.def.blackout });
    const bodyMesh = carMeshes(parts, this.mats);
    bodyMesh.position.y = -TUNING.rideHeight;
    this.model.add(bodyMesh);
    parts.wheelPositions.forEach((p, i) => {
      const w = wheelMesh(parts, this.mats, i % 2 === 0 ? 1 : -1);
      w.rotation.order = 'YXZ';
      this.wheels.push(w);
      this.wheelPos.push(new THREE.Vector3(p.x, p.y - TUNING.rideHeight, p.z));
      this.model.add(w);
    });
    this.root.add(this.model);

    // the shell shown once wrecked, tinted a little towards the paint like the player's own
    const tint = new THREE.Color(1, 1, 1).lerp(new THREE.Color(this.def.paint), 0.18);
    for (const part of buildWreck(spec, { wheels: true })) {
      let geo = part.geometry;
      if (part.tinted) {
        geo = geo.clone();
        const col = geo.getAttribute('color') as THREE.BufferAttribute;
        for (let i = 0; i < col.count; i++) col.setXYZ(i, col.getX(i) * tint.r, col.getY(i) * tint.g, col.getZ(i) * tint.b);
      }
      const mesh = new THREE.Mesh(geo, part.material);
      mesh.castShadow = part.castShadow ?? true;
      mesh.receiveShadow = part.receiveShadow ?? true;
      this.shell.add(mesh);
    }
    this.shell.position.y = -TUNING.rideHeight;
    this.shell.visible = false;
    this.root.add(this.shell);
    this.root.visible = false;
    scene.add(this.root);

    // collision boxes like the player's car (car space → body space), moved by its poses
    this.body = phys.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -50, 0));
    const box = (b: { half: number[]; at: number[] }) =>
      RAPIER.ColliderDesc.cuboid(b.half[0], b.half[1], b.half[2])
        .setTranslation(b.at[0], b.at[1] - TUNING.rideHeight, b.at[2])
        .setCollisionGroups(groups(G.RIVAL, 0xffff))
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS);
    phys.world.createCollider(box(this.def.chassis.body), this.body);
    phys.world.createCollider(box(this.def.chassis.cabin), this.body);
    this.body.setEnabled(false);
  }

  get position() {
    return this.root.position;
  }

  /** Has a pose to draw: alive and heard from. */
  get present() {
    return this.alive && this.snaps.length > 0;
  }

  push(msg: PoseMsg) {
    if (!this.alive) return;
    const now = performance.now();
    const ok = (a: number[]) => a.every(Number.isFinite);
    if (!ok(msg.p) || !ok(msg.q) || !ok(msg.v)) return;
    this.snaps.push({
      at: now, p: new THREE.Vector3(...msg.p), q: new THREE.Quaternion(...msg.q).normalize(), v: new THREE.Vector3(...msg.v),
      w: Number(msg.w) || 0, s: Number(msg.s) || 0, b: !!msg.b,
    });
    if (this.snaps.length > 30) this.snaps.shift();
    if (this.snaps.length === 1) {
      // first pose since (re)spawning: appear there, solid
      this.body.setEnabled(true);
      this.body.setTranslation(this.snaps[0].p, true);
      this.body.setRotation(this.snaps[0].q, true);
    }
  }

  /** Respawned: forget the old poses and wait for the first new one. */
  spawn() {
    this.alive = true;
    this.snaps.length = 0;
    this.shell.visible = false;
    this.model.visible = true;
    this.root.visible = false;
  }

  /** Out of play (between matches): nothing shown, nothing to hit. */
  retire() {
    this.alive = false;
    this.snaps.length = 0;
    this.body.setEnabled(false);
    this.root.visible = false;
  }

  /** Wrecked: explode, leave the shell where it was, stop colliding. */
  wreck(wreckFx: WreckFx, fx: CombatFx) {
    if (!this.alive) return;
    this.alive = false;
    this.snaps.length = 0;
    this.body.setEnabled(false);
    if (!this.root.visible) return;
    const spec = this.def.spec;
    const p = this.root.position.clone();
    p.y -= 0.6;
    wreckFx.carExplode(p, this.root.quaternion.clone(), this.pose.v.clone(), new THREE.Vector3(spec.W, spec.H, spec.L), new THREE.Color(this.def.paint), p.y);
    fx.explosion(p.clone().setY(p.y + 0.8), 1.4);
    this.model.visible = false;
    this.shell.visible = true;
  }

  /** Sample the pose to show now; false if there is nothing to show. */
  private sample(now: number) {
    const s = this.snaps;
    if (!s.length) return false;
    const t = now - DELAY_MS;
    const out = this.pose;
    let i = s.length - 1;
    while (i > 0 && s[i - 1].at > t) i--;
    const b = s[i];
    const a = i > 0 ? s[i - 1] : null;
    if (a && t <= b.at) {
      const k = THREE.MathUtils.clamp((t - a.at) / Math.max(1, b.at - a.at), 0, 1);
      out.p.lerpVectors(a.p, b.p, k);
      out.q.slerpQuaternions(a.q, b.q, k);
      out.v.lerpVectors(a.v, b.v, k);
      out.w = a.w + (b.w - a.w) * k;
      out.s = a.s + (b.s - a.s) * k;
      out.b = b.b;
    } else {
      // ahead of the newest pose: carry on along its velocity for a moment
      const ahead = Math.min(MAX_EXTRAPOLATE_MS, Math.max(0, t - b.at)) / 1000;
      out.p.copy(b.p).addScaledVector(b.v, ahead);
      out.q.copy(b.q);
      out.v.copy(b.v);
      out.w = b.w;
      out.s = b.s;
      out.b = b.b;
    }
    return true;
  }

  /** Before a physics step: move the body to where the car is shown, so contacts happen there. */
  preStep(now: number) {
    if (!this.alive || !this.sample(now)) return;
    this.body.setNextKinematicTranslation(this.pose.p);
    this.body.setNextKinematicRotation(this.pose.q);
  }

  render(now: number, dt: number) {
    if (!this.alive) return;
    if (!this.sample(now)) {
      this.root.visible = false;
      return;
    }
    this.root.visible = true;
    this.root.position.copy(this.pose.p);
    this.root.quaternion.copy(this.pose.q);
    this.spin += (this.pose.w * dt) / this.def.spec.wheelR;
    this.wheels.forEach((w, i) => {
      w.position.copy(this.wheelPos[i]);
      w.rotation.y = i < 2 ? this.pose.s : 0;
      (w.userData.spin as THREE.Object3D).rotation.x = this.spin;
    });
    this.glow += ((this.pose.b ? 1 : 0) - this.glow) * Math.min(1, dt * 14);
    this.mats.tail.emissiveIntensity = 0.35 + this.glow * 2.6;
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.root);
    this.phys.world.removeRigidBody(this.body);
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    this.mats.plate.map?.dispose();
    for (const m of new Set(Object.values(this.mats))) m.dispose();
  }
}

/** A missile someone else fired: only for show (its damage was dealt by the shooter's game). */
interface ShowMissile {
  from: string;
  obj: THREE.Group;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  target: (() => THREE.Vector3 | null) | null;
  age: number;
  active: boolean;
}

/** Every other player's car, and what their weapons look like from here. */
export class Rivals {
  readonly list = new Map<string, Rival>();
  private missiles: ShowMissile[] = [];

  constructor(private phys: Physics, private scene: THREE.Scene, private fx: CombatFx, private destruction: Destruction, private wreckFx: WreckFx) {
    const body = new THREE.MeshStandardMaterial({ color: 0xe9ecef, roughness: 0.4, metalness: 0.3 });
    const nose = new THREE.MeshStandardMaterial({ color: 0xb3261e, roughness: 0.5 });
    for (let i = 0; i < 12; i++) {
      const obj = new THREE.Group();
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.75, 10), body);
      b.rotation.x = Math.PI / 2;
      const n = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.18, 10), nose);
      n.rotation.x = Math.PI / 2;
      n.position.z = 0.46;
      obj.add(b, n);
      obj.visible = false;
      scene.add(obj);
      this.missiles.push({ from: '', obj, pos: new THREE.Vector3(), vel: new THREE.Vector3(), target: null, age: 0, active: false });
    }
  }

  /**
   * Make the list match the arena's players (other than us): add newcomers, drop leavers, rebuild a
   * changed car, and bring cars in or out of play (outside a match, nobody is in play).
   */
  sync(players: { id: string; car: string; alive: boolean }[], inMatch: boolean, hit: (id: string, amount: number) => void) {
    const seen = new Set<string>();
    for (const p of players) {
      seen.add(p.id);
      let r = this.list.get(p.id);
      if (r && r.def.info.id !== p.car) {
        this.remove(p.id);
        r = undefined;
      }
      if (!r) {
        const rival = new Rival(p.id, p.car, this.phys, this.scene);
        r = rival;
        this.list.set(p.id, rival);
        this.destruction.addExternal({ body: rival.body, alive: () => rival.present, hit: (amount) => hit(rival.id, amount) });
      }
      // a wreck arrives as its own message (with the explosion); this only catches up on spawns and the lobby
      const inPlay = inMatch && p.alive;
      if (inPlay && !r.alive) r.spawn();
      else if (!inMatch) r.retire();
    }
    for (const id of [...this.list.keys()]) if (!seen.has(id)) this.remove(id);
  }

  remove(id: string) {
    const r = this.list.get(id);
    if (!r) return;
    this.destruction.removeExternal(r.body);
    r.dispose(this.scene);
    this.list.delete(id);
  }

  clear() {
    for (const id of [...this.list.keys()]) this.remove(id);
    for (const m of this.missiles) {
      m.active = false;
      m.obj.visible = false;
    }
  }

  byBody(body: RAPIER.RigidBody | null) {
    if (!body) return null;
    for (const r of this.list.values()) if (r.body.handle === body.handle) return r;
    return null;
  }

  /** Someone's gun burst: tracer, muzzle flash, sparks where it struck. */
  shot(from: THREE.Vector3, to: THREE.Vector3, hit: boolean) {
    const dir = to.clone().sub(from).normalize();
    this.fx.tracers.tracer(from.clone().addScaledVector(dir, 1.2), to, 0.045, 0.05);
    this.fx.fire.emit(from, new THREE.Vector3(), { life: 0.05, size: 0.45, grow: 1.4, color: 0xfff2c4, color2: 0xff8a2a, alpha: 1 });
    if (hit) this.fx.impactSparks(to, dir.negate(), 5);
  }

  /** Someone's missile left the launcher; it homes on `target` (a position getter) if it has one. */
  launch(from: string, pos: THREE.Vector3, vel: THREE.Vector3, target: (() => THREE.Vector3 | null) | null) {
    const m = this.missiles.find((x) => !x.active);
    if (!m) return;
    Object.assign(m, { from, target, age: 0, active: true });
    m.pos.copy(pos);
    m.vel.copy(vel);
    m.obj.visible = true;
    m.obj.position.copy(pos);
    this.fx.smoke.emit(pos, new THREE.Vector3(0, 1, 0), { life: 1.2, size: 0.8, grow: 3, color: 0xe6e6e6, alpha: 0.6, drag: 2 });
  }

  /** Someone's missile went off at p: retire the nearest of theirs, and show the blast (it shoves, but hurts nothing here). */
  boom(from: string, p: THREE.Vector3) {
    let best: ShowMissile | null = null;
    let bestD = Infinity;
    for (const m of this.missiles) {
      if (!m.active || m.from !== from) continue;
      const d = m.pos.distanceToSquared(p);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    if (best) {
      best.active = false;
      best.obj.visible = false;
    }
    this.destruction.queueBlast(p, 7.5, 0, 12, 1.3, 0);
  }

  wreck(id: string) {
    this.list.get(id)?.wreck(this.wreckFx, this.fx);
  }

  preStep() {
    const now = performance.now();
    for (const r of this.list.values()) r.preStep(now);
  }

  update(dt: number) {
    const now = performance.now();
    for (const r of this.list.values()) r.render(now, dt);
    for (const m of this.missiles) if (m.active) this.stepMissile(m, dt);
  }

  private stepMissile(m: ShowMissile, dt: number) {
    m.age += dt;
    const speed = Math.min(78, m.vel.length() + 70 * dt);
    let dir = m.vel.clone().normalize();
    const t = m.age > 0.2 ? m.target?.() : null;
    if (t) {
      const want = t.clone().setY(t.y + 0.6).sub(m.pos).normalize();
      const ang = dir.angleTo(want);
      const maxTurn = 3.2 * dt;
      if (ang > 1e-4) dir = ang <= maxTurn ? want : dir.lerp(want, maxTurn / ang).normalize();
    } else if (m.age > 0.25) {
      dir.y += (-0.02 - dir.y) * Math.min(1, dt * 2);
      dir.normalize();
    }
    m.vel.copy(dir).multiplyScalar(speed);
    // its own boom message normally retires it; this is the fallback if that never arrives
    if (m.age > 6 || m.pos.y < -2) {
      m.active = false;
      m.obj.visible = false;
      return;
    }
    m.pos.addScaledVector(dir, speed * dt);
    m.obj.position.copy(m.pos);
    m.obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    const tail = m.pos.clone().addScaledVector(dir, -0.45);
    this.fx.fire.emit(tail, dir.clone().multiplyScalar(-6), { life: 0.08, size: 0.35, grow: 1.6, color: 0xfff1b0, color2: 0xff6a1a, alpha: 1 });
    this.fx.smoke.emit(tail, new THREE.Vector3((Math.random() - 0.5) * 0.4, 0.3, (Math.random() - 0.5) * 0.4), {
      life: 2.2 + Math.random(), size: 0.35, grow: 4.5, color: 0xf2f2f2, color2: 0xb9b9b9, gravity: 0.3, drag: 1.5, alpha: 0.55,
    });
  }
}
