import * as THREE from 'three';
import { RAPIER, type Physics } from '../physics';
import type { Entry } from '../world/dynamics';
import type { CombatFx } from './fx';
import type { WreckFx } from './wreck';
import { SPECS } from '../models/carModel';

const HP: Record<string, number> = {
  cone: 6, barrel: 22, barrelBlue: 40, box: 8, boxBig: 12, trolley: 30, bin: 22, binBlue: 22,
  barrier: 55, barrierWhite: 55, pallet: 18, glass: 10,
};
const CAR_HP = 110;
const CHARRED = new THREE.Color(0x181614);

interface Destructible extends Entry {
  hp: number;
  max: number;
  homeP: THREE.Vector3;
  homeQ: THREE.Quaternion;
  dead: boolean;
  deadAt: number;
  burnUntil: number;
  disturbedAt: number;
  explosive: boolean;
  size: number;
  /** added at runtime (action-mode enemies): never respawned, removed by its owner */
  transient?: boolean;
  /** taken out of the world for now (traffic in action mode) */
  suspended?: boolean;
  onDestroyed?: () => void;
}

interface PendingBlast {
  p: THREE.Vector3;
  radius: number;
  damage: number;
  impulse: number;
  scale: number;
  at: number;
}

export interface DestructionHooks {
  onExplosion(p: THREE.Vector3, scale: number): void;
  onTrafficDestroyed(body: RAPIER.RigidBody): void;
  onTrafficRespawn(body: RAPIER.RigidBody): void;
  /** A blast reached the player's car; `damage` is already scaled by distance. */
  onPlayerBlast?(damage: number, p: THREE.Vector3): void;
}

/**
 * Health, breaking, burning and respawning for every dynamic object in the world.
 * Destroyed or displaced objects quietly return to where they started once
 * they (and their home spot) are outside the camera frustum and away from the player.
 */
export class Destruction {
  private list: Destructible[] = [];
  private byHandle = new Map<number, Destructible>();
  private blasts: PendingBlast[] = [];
  private burning = new Set<Destructible>();
  private time = 0;
  private scanT = 0;
  private frustum = new THREE.Frustum();
  private pm = new THREE.Matrix4();
  private sphere = new THREE.Sphere();
  destroyedCount = 0;
  /** What missiles may lock on to: every car, or only the transient ones (action-mode enemies). */
  targets: 'all' | 'transient' = 'all';

  constructor(
    entries: Entry[],
    private phys: Physics,
    private fx: CombatFx,
    private player: RAPIER.RigidBody,
    private hooks: DestructionHooks,
    private wreck: WreckFx,
  ) {
    for (const e of entries) {
      const t = e.body.translation();
      const r = e.body.rotation();
      const max = e.car ? CAR_HP : HP[e.kind] ?? 20;
      const d: Destructible = {
        ...e,
        hp: max,
        max,
        homeP: new THREE.Vector3(t.x, t.y, t.z),
        homeQ: new THREE.Quaternion(r.x, r.y, r.z, r.w),
        dead: false,
        deadAt: 0,
        burnUntil: 0,
        disturbedAt: 0,
        explosive: e.kind === 'barrel',
        size: e.car ? 2.6 : e.kind === 'glass' ? 2.5 : 0.8,
      };
      this.list.push(d);
      this.byHandle.set(e.body.handle, d);
    }
  }

  isTarget(body: RAPIER.RigidBody) {
    const d = this.byHandle.get(body.handle);
    return !!d && !d.dead && !d.suspended;
  }

  /** Live destructible cars, for missile lock-on. */
  *cars() {
    for (const d of this.list) {
      if (d.car && !d.dead && !d.suspended && (this.targets === 'all' || d.transient)) yield d.body;
    }
  }

  /** Health left, 0–1 (1 for anything unknown). */
  health(body: RAPIER.RigidBody) {
    const d = this.byHandle.get(body.handle);
    return d ? Math.max(0, d.hp / d.max) : 1;
  }

  /** Add a car that only lives until it is destroyed (an action-mode enemy). */
  addTransient(e: Entry, hp: number, onDestroyed: () => void) {
    const t = e.body.translation();
    const r = e.body.rotation();
    const d: Destructible = {
      ...e, hp, max: hp, homeP: new THREE.Vector3(t.x, t.y, t.z), homeQ: new THREE.Quaternion(r.x, r.y, r.z, r.w),
      dead: false, deadAt: 0, burnUntil: 0, disturbedAt: 0, explosive: false, size: 2.6, transient: true, onDestroyed,
    };
    this.list.push(d);
    this.byHandle.set(e.body.handle, d);
  }

  /** Forget a transient car (its owner hides and parks the body). */
  remove(body: RAPIER.RigidBody) {
    const d = this.byHandle.get(body.handle);
    if (!d) return;
    this.byHandle.delete(body.handle);
    this.list.splice(this.list.indexOf(d), 1);
    this.burning.delete(d);
  }

  /**
   * Take a car out of the world (hidden, no collisions, not a target) or put it back.
   * A wreck is restored first, so it comes back whole.
   */
  setSuspended(body: RAPIER.RigidBody, on: boolean) {
    const d = this.byHandle.get(body.handle);
    if (!d || !!d.suspended === on) return;
    if (on) {
      if (d.dead) this.respawn(d);
      d.suspended = true;
      d.body.setEnabled(false);
      d.set.setHidden(d.index, true);
    } else {
      d.suspended = false;
      d.body.setEnabled(true);
      d.set.setHidden(d.index, false);
      d.set.refresh(d.index);
    }
  }

  damage(body: RAPIER.RigidBody, amount: number, point?: THREE.Vector3) {
    const d = this.byHandle.get(body.handle);
    if (!d || d.dead || d.suspended) return;
    d.hp -= amount;
    if (d.car && d.hp < d.max * 0.45) d.burnUntil = Math.max(d.burnUntil, this.time + 0.5); // smoking when badly hurt
    if (d.hp <= 0) this.destroy(d, point);
  }

  private destroy(d: Destructible, point?: THREE.Vector3) {
    d.dead = true;
    d.deadAt = this.time;
    this.destroyedCount++;
    const t = d.body.translation();
    const c = new THREE.Vector3(t.x, t.y, t.z);
    if (d.car) {
      // break it apart before the blast impulse so the pieces inherit the car's own motion
      const spec = SPECS[d.kind];
      const r = d.body.rotation();
      const v = d.body.linvel();
      this.wreck.carExplode(
        c, new THREE.Quaternion(r.x, r.y, r.z, r.w), new THREE.Vector3(v.x, v.y, v.z),
        new THREE.Vector3(spec?.W ?? 1.8, spec?.H ?? 1.45, spec?.L ?? 4.5), d.color, this.floorAt(c),
      );
      if (d.kinematic) {
        d.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
        this.hooks.onTrafficDestroyed(d.body);
      }
      d.set.setColor(d.index, CHARRED);
      const mass = d.body.mass();
      d.body.applyImpulse({ x: (Math.random() - 0.5) * mass * 2, y: mass * 7, z: (Math.random() - 0.5) * mass * 2 }, true);
      d.body.applyTorqueImpulse({ x: (Math.random() - 0.5) * mass * 6, y: (Math.random() - 0.5) * mass * 2, z: (Math.random() - 0.5) * mass * 6 }, true);
      d.burnUntil = this.time + 16;
      this.burning.add(d);
      this.queueBlast(c.setY(c.y + 0.8), 7, 32, 8, 1.1, 0); // weak damage so wrecks rarely chain through a whole row
      d.onDestroyed?.();
    } else {
      // props break apart: hide the instance, park the body, throw debris
      d.set.setHidden(d.index, true);
      d.body.setEnabled(false);
      const at = point ?? c;
      if (d.kind === 'glass') {
        this.fx.debris.burst(c, 40, d.color, 2.4, 6, this.floorAt(c));
      } else {
        this.fx.debris.burst(at, d.kind === 'boxBig' || d.kind === 'barrier' ? 12 : 8, d.color, d.kind === 'cone' ? 0.6 : 1.1, 7, this.floorAt(c));
        this.fx.smoke.emit(c, new THREE.Vector3(0, 0.6, 0), { life: 1.2, size: 0.8, grow: 3, color: 0xc9c2b4, alpha: 0.5, drag: 2 });
      }
      if (d.explosive) this.queueBlast(c, 6.5, 85, 6, 0.8, 0.08);
    }
  }

  /** Missile/barrel/car explosion: damage + impulse in a radius, with optional delay for chains. */
  queueBlast(p: THREE.Vector3, radius: number, damage: number, impulse: number, scale: number, delay: number) {
    this.blasts.push({ p: p.clone(), radius, damage, impulse, scale, at: this.time + delay });
  }

  private blast(b: PendingBlast) {
    this.fx.explosion(b.p, b.scale);
    this.hooks.onExplosion(b.p, b.scale);
    const r2 = b.radius * b.radius;
    const push = (body: RAPIER.RigidBody, mass: number, k: number) => {
      const t = body.translation();
      const dir = new THREE.Vector3(t.x - b.p.x, t.y - b.p.y + 0.6, t.z - b.p.z).normalize();
      const j = mass * b.impulse * k;
      body.applyImpulse({ x: dir.x * j, y: Math.max(0.35, dir.y) * j, z: dir.z * j }, true);
      body.applyTorqueImpulse({ x: (Math.random() - 0.5) * j * 0.5, y: (Math.random() - 0.5) * j * 0.3, z: (Math.random() - 0.5) * j * 0.5 }, true);
    };
    for (const d of this.list) {
      if ((d.dead && !d.car) || d.suspended) continue;
      const t = d.body.translation();
      const dx = t.x - b.p.x, dy = t.y - b.p.y, dz = t.z - b.p.z;
      const dist2 = dx * dx + dy * dy + dz * dz;
      if (dist2 > r2) continue;
      const k = 1 - Math.sqrt(dist2) / b.radius;
      if (d.body.isDynamic()) push(d.body, d.body.mass(), k);
      this.damage(d.body, b.damage * k);
    }
    // the player's car gets thrown around too (and, in action mode, hurt)
    const pt = this.player.translation();
    const pd2 = (pt.x - b.p.x) ** 2 + (pt.y - b.p.y) ** 2 + (pt.z - b.p.z) ** 2;
    if (pd2 < r2) {
      const k = 1 - Math.sqrt(pd2) / b.radius;
      push(this.player, this.player.mass(), k * 0.45);
      this.hooks.onPlayerBlast?.(b.damage * k, b.p);
    }
  }

  /** Ground height under p (floors of the car park or the lot). */
  private floorAt(p: THREE.Vector3) {
    const hit = this.phys.world.castRay(new RAPIER.Ray({ x: p.x, y: p.y + 0.5, z: p.z }, { x: 0, y: -1, z: 0 }), 20, true, RAPIER.QueryFilterFlags.ONLY_FIXED);
    return hit ? p.y + 0.5 - hit.timeOfImpact : 0;
  }

  update(dt: number, camera: THREE.Camera, playerPos: THREE.Vector3) {
    this.time += dt;

    // delayed (chained) blasts
    if (this.blasts.length) {
      const due = this.blasts.filter((b) => b.at <= this.time);
      this.blasts = this.blasts.filter((b) => b.at > this.time);
      for (const b of due) this.blast(b);
    }

    // burning wrecks and damaged cars
    for (const d of this.burning) {
      if (this.time > d.burnUntil) {
        this.burning.delete(d);
        continue;
      }
      const t = d.body.translation();
      const p = new THREE.Vector3(t.x, t.y + 0.6, t.z);
      if (p.distanceToSquared(playerPos) < 160 * 160) this.fx.burn(p, dt, Math.min(1, (d.burnUntil - this.time) / 4));
    }
    for (const d of this.list) {
      if (d.car && !d.dead && !d.suspended && d.hp < d.max * 0.45 && Math.random() < dt * 5) {
        const t = d.body.translation();
        this.fx.smoke.emit(new THREE.Vector3(t.x, t.y + 1.0, t.z), new THREE.Vector3(0, 1.5, 0), { life: 2.5, size: 0.6, grow: 4, color: 0x3a3634, color2: 0x8a857e, gravity: 0.5, drag: 0.6, alpha: 0.55 });
      }
    }

    // respawn scan, a few times a second
    this.scanT -= dt;
    if (this.scanT > 0) return;
    this.scanT = 0.25;
    camera.updateMatrixWorld();
    this.pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pm);
    const visible = (p: THREE.Vector3, r: number) => this.frustum.intersectsSphere(this.sphere.set(p, r));
    const cur = new THREE.Vector3();

    for (const d of this.list) {
      if (d.transient || d.suspended) continue;
      const t = d.body.translation();
      cur.set(t.x, t.y, t.z);
      let wants = false;
      if (d.dead) {
        wants = this.time - d.deadAt > 4;
      } else if (!d.kinematic) {
        const r = d.body.rotation();
        const upY = 1 - 2 * (r.x * r.x + r.z * r.z);
        const moved = cur.distanceToSquared(d.homeP) > 1.0 || upY < 0.9;
        if (!moved) {
          d.disturbedAt = 0;
          continue;
        }
        if (!d.disturbedAt) d.disturbedAt = this.time;
        wants = this.time - d.disturbedAt > 14 && (d.body.isSleeping() || !d.body.isEnabled());
      }
      if (!wants) continue;
      if (cur.distanceToSquared(playerPos) < 14 * 14 || d.homeP.distanceToSquared(playerPos) < 16 * 16) continue;
      if (visible(d.homeP, d.size + 1) || (d.body.isEnabled() && visible(cur, d.size + 1))) continue;
      if (d.car && !d.kinematic && this.homeBlocked(d)) continue;
      this.respawn(d);
    }
  }

  private homeBlocked(d: Destructible) {
    for (const o of this.list) {
      if (o === d || !o.car || o.kinematic || o.suspended) continue;
      const t = o.body.translation();
      const dx = t.x - d.homeP.x, dz = t.z - d.homeP.z;
      if (Math.abs(t.y - d.homeP.y) < 2 && dx * dx + dz * dz < 2.8 * 2.8) return true;
    }
    return false;
  }

  private respawn(d: Destructible) {
    const wasDead = d.dead;
    d.dead = false;
    d.hp = d.max;
    d.disturbedAt = 0;
    d.burnUntil = 0;
    this.burning.delete(d);
    if (!d.body.isEnabled()) d.body.setEnabled(true);
    d.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    d.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    if (d.kinematic) {
      if (wasDead) {
        d.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
        this.hooks.onTrafficRespawn(d.body);
      }
    } else {
      d.body.setTranslation(d.homeP, false);
      d.body.setRotation(d.homeQ, false);
      d.body.sleep();
    }
    if (d.car) d.set.setColor(d.index, d.color);
    d.set.setHidden(d.index, false);
    d.set.refresh(d.index);
  }
}
