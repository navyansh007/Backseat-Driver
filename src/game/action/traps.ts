import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RAPIER, type Physics } from '../physics';
import { Particles, Streaks, type CombatFx } from '../combat/fx';
import type { Destruction } from '../combat/destruction';
import type { CarAudio } from '../audio';
import type { PlayerCar } from '../playerCar';
import { TRAP_KINDS, type TrapKind } from '../../shared/protocol';
import type { Enemy, Fleet } from './enemies';

/** Charges each trap holds and seconds to recharge one. */
export const TRAP_SPECS: Record<TrapKind, { max: number; recharge: number; label: string }> = {
  spikes: { max: 2, recharge: 10, label: 'spike strip' },
  oil: { max: 2, recharge: 12, label: 'oil slick' },
  mine: { max: 3, recharge: 8, label: 'mine' },
  smoke: { max: 1, recharge: 16, label: 'smoke screen' },
  emp: { max: 1, recharge: 30, label: 'emp' },
};

const SPIKE_LIFE = 32;
const OIL_LIFE = 45;
const OIL_R = 3.8;
const OIL_BURN = 8;
const MINE_LIFE = 90;
const MINE_ARM = 1.2;
const MINE_TRIGGER = 3.6;
const SMOKE_EMIT = 4.5;
const SMOKE_CLOUD = 10;
const EMP_RADIUS = 30;
const EMP_STUN = 4.5;

interface Spikes { obj: THREE.Group; p: THREE.Vector3; inv: THREE.Quaternion; born: number; hit: Set<Enemy>; active: boolean }
interface Oil { mesh: THREE.Mesh; mat: THREE.MeshPhysicalMaterial; p: THREE.Vector3; born: number; burnUntil: number; flicker: number; size: number; active: boolean }
interface Mine { obj: THREE.Group; led: THREE.Mesh; p: THREE.Vector3; born: number; armed: boolean; fuse: number; active: boolean }
interface Cloud { p: THREE.Vector3; born: number }

export interface TrapContext {
  time: number;
  car: PlayerCar;
  /** hurt the player (oil fires) */
  hurtPlayer(damage: number): void;
  /** a pursuer was wrecked or hurt by a trap */
  credit(e: Enemy, name: string): void;
}

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
const tmp3 = new THREE.Vector3();
const SMOKE_C = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Gadgets dropped from the boot in action mode:
 *  - spike strip: shreds the tyres of whatever crosses it (they slow, wander and lose grip)
 *  - oil slick: no grip at all; a gunshot, a blast or a mine sets it alight
 *  - proximity mine: arms after a moment, only pursuers set it off, chains with other mines
 *  - smoke screen: a trail of thick smoke; pursuers inside or behind it lose sight of you
 *  - emp: a pulse that kills every engine (and gun) nearby for a few seconds
 */
export class Traps {
  readonly charges = {} as Record<TrapKind, number>;
  /** progress toward the next charge, 0–1 */
  readonly progress = {} as Record<TrapKind, number>;
  /** grip for the player's tyres this frame (oil is slippery for everyone) */
  playerGrip = 1;
  private spikes: Spikes[] = [];
  private oils: Oil[] = [];
  private mines: Mine[] = [];
  private clouds: Cloud[] = [];
  private smokeLeft = 0;
  private cloudT = 0;
  private smoke: Particles;
  private arcs: Streaks;
  private empRings: { m: THREE.Mesh; t: number }[] = [];
  private nextEmpRing = 0;
  private time = 0;

  constructor(scene: THREE.Scene, private phys: Physics, private fx: CombatFx, private destruction: Destruction, private fleet: Fleet, private audio: CarAudio) {
    this.refill();
    this.smoke = new Particles(scene, 300, false);
    this.arcs = new Streaks(scene, 160, 0x8fd8ff);

    // spike strip: a hinged rubber mat studded with steel
    const steel = new THREE.MeshStandardMaterial({ color: 0xc9ced4, metalness: 0.9, roughness: 0.25 });
    const mat = new THREE.MeshStandardMaterial({ color: 0x1c1e21, roughness: 0.7 });
    const caps = new THREE.MeshStandardMaterial({ color: 0xf2c230, roughness: 0.5 });
    const spikeGeo = mergeGeometries(Array.from({ length: 24 }, (_, i) => {
      const g = new THREE.ConeGeometry(0.035, 0.15, 5);
      g.translate(0, 0.1, 0);
      g.rotateZ((i % 2 ? 1 : -1) * 0.25);
      return g.translate(-2.05 + (i >> 1) * 0.37, 0, i % 2 ? 0.08 : -0.08);
    }))!;
    for (let i = 0; i < 4; i++) {
      const obj = new THREE.Group();
      const base = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.04, 0.34), mat);
      base.position.y = 0.02;
      const studs = new THREE.Mesh(spikeGeo, steel);
      const endA = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.07, 0.38), caps);
      endA.position.set(-2.24, 0.035, 0);
      const endB = endA.clone();
      endB.position.x = 2.24;
      for (const m of [base, studs, endA, endB]) m.castShadow = m.receiveShadow = true;
      obj.add(base, studs, endA, endB);
      obj.visible = false;
      scene.add(obj);
      this.spikes.push({ obj, p: new THREE.Vector3(), inv: new THREE.Quaternion(), born: 0, hit: new Set(), active: false });
    }

    // oil: an irregular glossy black pool with a rainbow sheen
    for (let i = 0; i < 4; i++) {
      const m = new THREE.MeshPhysicalMaterial({
        color: 0x010101, roughness: 0.22, metalness: 0, specularIntensity: 0.18, envMapIntensity: 0.12,
        iridescence: 0.22, iridescenceIOR: 1.5, iridescenceThicknessRange: [300, 500],
        transparent: true, opacity: 0.95, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
      });
      const mesh = new THREE.Mesh(puddleGeometry(i * 7.3), m);
      mesh.receiveShadow = true;
      mesh.renderOrder = 1;
      mesh.visible = false;
      scene.add(mesh);
      this.oils.push({ mesh, mat: m, p: new THREE.Vector3(), born: 0, burnUntil: 0, flicker: 0, size: 0, active: false });
    }

    // mines: a squat drab disc, hazard ring, blinking red eye
    const shell = new THREE.MeshStandardMaterial({ color: 0x3b4236, metalness: 0.5, roughness: 0.55 });
    const ringGeo = new THREE.TorusGeometry(0.27, 0.025, 6, 24).rotateX(Math.PI / 2);
    const ledMat = new THREE.MeshBasicMaterial({ color: 0xff2a1a, toneMapped: false });
    for (let i = 0; i < 6; i++) {
      const obj = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 0.11, 20), shell);
      body.position.y = 0.055;
      const ring = new THREE.Mesh(ringGeo, caps);
      ring.position.y = 0.11;
      const led = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), ledMat);
      led.position.y = 0.13;
      body.castShadow = true;
      obj.add(body, ring, led);
      obj.visible = false;
      scene.add(obj);
      this.mines.push({ obj, led, p: new THREE.Vector3(), born: 0, armed: false, fuse: 0, active: false });
    }

    // emp shockwave rings
    const ring = new THREE.RingGeometry(0.9, 1, 64).rotateX(-Math.PI / 2);
    for (let i = 0; i < 2; i++) {
      const m = new THREE.Mesh(ring, new THREE.MeshBasicMaterial({
        color: 0x7fd4ff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide,
      }));
      m.visible = false;
      scene.add(m);
      this.empRings.push({ m, t: 1 });
    }
  }

  refill() {
    for (const k of TRAP_KINDS) {
      this.charges[k] = TRAP_SPECS[k].max;
      this.progress[k] = 1;
    }
  }

  /** Remove every trap from the world. */
  clear() {
    for (const s of this.spikes) s.active = s.obj.visible = false;
    for (const o of this.oils) o.active = o.mesh.visible = false;
    for (const m of this.mines) m.active = m.obj.visible = false;
    this.clouds.length = 0;
    this.smokeLeft = 0;
    this.playerGrip = 1;
  }

  /** Drop a trap behind the car. Returns false when it has no charge. */
  deploy(kind: TrapKind, ctx: TrapContext) {
    if (this.charges[kind] <= 0) return false;
    this.charges[kind]--;
    const root = ctx.car.root;
    const fwd = tmp.set(0, 0, 1).applyQuaternion(root.quaternion).setY(0).normalize();
    const behind = root.position.clone().addScaledVector(fwd, -3.4);
    behind.y = this.floorAt(behind, root.position.y);
    const yaw = Math.atan2(fwd.x, fwd.z);
    this.audio.deploy(kind);
    switch (kind) {
      case 'spikes': {
        const s = this.spikes.find((x) => !x.active) ?? this.oldest(this.spikes);
        s.active = true;
        s.born = this.time;
        s.p.copy(behind);
        s.hit.clear();
        s.obj.position.copy(behind);
        // laid across the lane behind the car
        s.obj.quaternion.setFromAxisAngle(UP, yaw);
        s.inv.copy(s.obj.quaternion).invert();
        s.obj.scale.set(0.05, 1, 1);
        s.obj.visible = true;
        break;
      }
      case 'oil': {
        const o = this.oils.find((x) => !x.active) ?? this.oldest(this.oils);
        o.active = true;
        o.born = this.time;
        o.burnUntil = 0;
        o.p.copy(behind).addScaledVector(fwd, -0.6);
        o.mesh.position.copy(o.p).setY(o.p.y + 0.02);
        o.size = 0.2;
        o.mesh.scale.setScalar(o.size * OIL_R);
        o.mat.opacity = 0.94;
        o.mesh.visible = true;
        // a gush from the boot
        for (let i = 0; i < 10; i++) {
          this.fx.debris.burst(o.p.clone().setY(o.p.y + 0.4), 1, new THREE.Color(0x0a0a0a), 0.25, 3, o.p.y);
        }
        break;
      }
      case 'mine': {
        const m = this.mines.find((x) => !x.active) ?? this.oldest(this.mines);
        m.active = true;
        m.born = this.time;
        m.armed = false;
        m.fuse = 0;
        m.p.copy(behind);
        m.obj.position.copy(behind);
        m.obj.rotation.y = Math.random() * Math.PI;
        m.obj.visible = true;
        break;
      }
      case 'smoke':
        this.smokeLeft = SMOKE_EMIT;
        this.cloudT = 0;
        break;
      case 'emp':
        this.emp(root.position.clone(), ctx);
        break;
    }
    return true;
  }

  private oldest<T extends { born: number }>(list: T[]) {
    return list.reduce((a, b) => (a.born <= b.born ? a : b));
  }

  private floorAt(p: THREE.Vector3, from: number) {
    const hit = this.phys.world.castRay(new RAPIER.Ray({ x: p.x, y: from + 0.5, z: p.z }, { x: 0, y: -1, z: 0 }), 12, true, RAPIER.QueryFilterFlags.ONLY_FIXED);
    return hit ? from + 0.5 - hit.timeOfImpact : 0;
  }

  private emp(p: THREE.Vector3, ctx: TrapContext) {
    for (let i = 0; i < this.empRings.length; i++) {
      const r = this.empRings[(this.nextEmpRing + i) % this.empRings.length];
      r.t = -i * 0.12;
      r.m.position.copy(p).setY(p.y + 0.3);
    }
    this.fx.flashes.flash(p.clone().setY(p.y + 2), 1400, 0.6, 60, 0x6fc4ff);
    for (const e of this.fleet.alive) {
      const t = e.sim.body.translation();
      const d = Math.hypot(t.x - p.x, t.y - p.y, t.z - p.z);
      if (d > EMP_RADIUS) continue;
      e.stun = EMP_STUN * (1 - (d / EMP_RADIUS) * 0.4);
      this.fleet.tagged(e, 'EMP', ctx.time, EMP_STUN + 2);
      this.destruction.damage(e.sim.body, 15);
      ctx.credit(e, 'EMP');
    }
  }

  /** Something hot landed at p (gunfire, a blast): light any oil it touches. */
  ignite(p: THREE.Vector3, radius = 0.5) {
    for (const o of this.oils) {
      if (!o.active || o.burnUntil > 0) continue;
      const r = OIL_R * o.size;
      if (Math.hypot(p.x - o.p.x, p.z - o.p.z) < r + radius && Math.abs(p.y - o.p.y) < 2.5) this.burn(o);
    }
  }

  private burn(o: Oil) {
    o.burnUntil = this.time + OIL_BURN;
    this.fx.flashes.flash(o.p.clone().setY(o.p.y + 1), 700, 0.5, 30, 0xff8a2a);
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * Math.PI * 2, rr = Math.random() * OIL_R;
      this.fx.fire.emit(tmp.set(o.p.x + Math.cos(a) * rr, o.p.y + 0.2, o.p.z + Math.sin(a) * rr), tmp2.set(0, 4 + Math.random() * 3, 0), {
        life: 0.7, size: 1.6, grow: 2.4, color: 0xfff0b0, color2: 0xff4a10, gravity: 3, drag: 1.5, alpha: 1,
      });
    }
  }

  /** A blast went off at p: set off armed mines and oil nearby. */
  onExplosion(p: THREE.Vector3, scale: number) {
    this.ignite(p, 3 * scale);
    for (const m of this.mines) {
      if (m.active && m.fuse === 0 && m.p.distanceTo(p) < 5.5 * scale) m.fuse = this.time + 0.12 + Math.random() * 0.1;
    }
  }

  /** Smoke hides the line from a to b. */
  smokeBetween(a: THREE.Vector3, b: THREE.Vector3) {
    for (const c of this.clouds) {
      const r = this.cloudRadius(c) * 0.85;
      if (segmentPointDist(a, b, c.p) < r) return true;
    }
    return false;
  }

  inSmoke(p: THREE.Vector3) {
    for (const c of this.clouds) if (c.p.distanceTo(p) < this.cloudRadius(c)) return true;
    return false;
  }

  private cloudRadius(c: Cloud) {
    const age = this.time - c.born;
    return Math.min(5.5, 1.8 + age * 2) * (age > SMOKE_CLOUD - 2 ? Math.max(0, (SMOKE_CLOUD - age) / 2) : 1);
  }

  update(dt: number, ctx: TrapContext) {
    this.time += dt;
    const t = this.time;

    // recharge
    for (const k of TRAP_KINDS) {
      const spec = TRAP_SPECS[k];
      if (this.charges[k] >= spec.max) {
        this.progress[k] = 1;
        continue;
      }
      this.progress[k] = Math.min(1, (this.progress[k] >= 1 ? 0 : this.progress[k]) + dt / spec.recharge);
      if (this.progress[k] >= 1) {
        this.charges[k]++;
        this.progress[k] = this.charges[k] >= spec.max ? 1 : 0;
      }
    }

    const enemies = this.fleet.alive;
    const epos = (e: Enemy) => {
      const b = e.sim.body.translation();
      return tmp2.set(b.x, b.y, b.z);
    };

    // ---------------------------------------------------------------- spikes
    for (const s of this.spikes) {
      if (!s.active) continue;
      const age = t - s.born;
      s.obj.scale.x = Math.min(1, 0.05 + age * 3);
      if (age > SPIKE_LIFE) {
        s.obj.position.y = s.p.y - Math.min(0.2, (age - SPIKE_LIFE) * 0.2);
        if (age > SPIKE_LIFE + 1) s.active = s.obj.visible = false;
        continue;
      }
      for (const e of enemies) {
        if (s.hit.has(e)) continue;
        const local = epos(e).sub(s.p).applyQuaternion(s.inv);
        if (Math.abs(local.x) < 2.6 && Math.abs(local.z) < 1.4 && Math.abs(local.y) < 1.5) {
          s.hit.add(e);
          e.puncture = 9;
          this.fleet.tagged(e, 'SPIKED', ctx.time, 9);
          this.destruction.damage(e.sim.body, 20);
          this.audio.impact(0.35);
          const p = epos(e);
          for (let i = 0; i < 4; i++) this.fx.impactSparks(p.clone().add(tmp.set((Math.random() - 0.5) * 1.6, -0.5, (Math.random() - 0.5) * 3)), UP, 4);
          ctx.credit(e, 'SPIKED');
        }
      }
    }

    // ------------------------------------------------------------------- oil
    this.playerGrip = 1;
    const cp = ctx.car.position;
    for (const o of this.oils) {
      if (!o.active) continue;
      const age = t - o.born;
      const burning = o.burnUntil > t;
      let scale = Math.min(1, 0.2 + age * 1.6);
      if (o.burnUntil > 0 && !burning) {
        // burnt off
        o.mat.opacity = Math.max(0, o.mat.opacity - dt * 0.8);
        if (o.mat.opacity <= 0) o.active = o.mesh.visible = false;
        continue;
      }
      if (age > OIL_LIFE) {
        scale *= Math.max(0, 1 - (age - OIL_LIFE) / 2);
        if (scale <= 0.01) {
          o.active = o.mesh.visible = false;
          continue;
        }
      }
      o.size = scale;
      o.mesh.scale.setScalar(scale * OIL_R);
      const r = OIL_R * scale;
      const inside = (p: THREE.Vector3) => Math.hypot(p.x - o.p.x, p.z - o.p.z) < r && Math.abs(p.y - o.p.y) < 1.6;
      for (const e of enemies) {
        if (!inside(epos(e))) continue;
        e.slick = 1.3;
        if (burning) {
          this.destruction.damage(e.sim.body, 55 * dt);
          this.fleet.tagged(e, 'TORCHED', ctx.time, 4);
          ctx.credit(e, 'TORCHED');
        } else this.fleet.tagged(e, 'OILED', ctx.time, 4);
      }
      if (inside(cp)) {
        this.playerGrip = 0.45;
        if (burning) ctx.hurtPlayer(14 * dt);
      }
      if (burning) {
        // flames across the pool, a flickering glow, and it spreads to oil next to it
        for (let i = 0; i < Math.ceil(dt * 70); i++) {
          const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * r;
          this.fx.fire.emit(tmp.set(o.p.x + Math.cos(a) * rr, o.p.y + 0.1, o.p.z + Math.sin(a) * rr), tmp2.set((Math.random() - 0.5) * 0.6, 2 + Math.random() * 2.5, (Math.random() - 0.5) * 0.6), {
            life: 0.45 + Math.random() * 0.45, size: 0.9, grow: 2, color: 0xffe08a, color2: 0xff3300, gravity: 3, drag: 1, alpha: 0.9,
          });
        }
        if (Math.random() < dt * 8) {
          this.fx.smoke.emit(tmp.set(o.p.x, o.p.y + 1.5, o.p.z), tmp2.set(0, 2.5, 0), { life: 4, size: 1.4, grow: 5, color: 0x1a1918, color2: 0x67625c, gravity: 0.5, drag: 0.5, alpha: 0.6 });
        }
        o.flicker -= dt;
        if (o.flicker <= 0) {
          o.flicker = 0.18;
          this.fx.flashes.flash(tmp.set(o.p.x, o.p.y + 1.2, o.p.z), 160 + Math.random() * 120, 0.22, 20, 0xff7a2a);
        }
        for (const other of this.oils) {
          if (other !== o && other.active && other.burnUntil === 0 && other.p.distanceTo(o.p) < OIL_R * 2.2) other.burnUntil = -1; // lit next frame
        }
      }
    }
    for (const o of this.oils) if (o.burnUntil === -1) this.burn(o);

    // ----------------------------------------------------------------- mines
    for (const m of this.mines) {
      if (!m.active) continue;
      const age = t - m.born;
      if (!m.armed && age > MINE_ARM) {
        m.armed = true;
        this.audio.beep(false);
      }
      if (m.fuse > 0) {
        m.led.visible = Math.floor(t * 24) % 2 === 0;
        if (t >= m.fuse) this.detonate(m, ctx);
        continue;
      }
      m.led.visible = m.armed ? Math.floor(t * 2) % 2 === 0 : Math.floor(t * 8) % 2 === 0;
      if (age > MINE_LIFE) {
        m.active = m.obj.visible = false;
        continue;
      }
      if (!m.armed) continue;
      for (const e of enemies) {
        const p = epos(e);
        if (Math.hypot(p.x - m.p.x, p.z - m.p.z) < MINE_TRIGGER && Math.abs(p.y - m.p.y) < 1.8) {
          m.fuse = t + 0.15;
          this.audio.beep(true);
          break;
        }
      }
    }

    // ----------------------------------------------------------------- smoke
    if (this.smokeLeft > 0) {
      this.smokeLeft -= dt;
      const root = ctx.car.root;
      const fwd = tmp.set(0, 0, 1).applyQuaternion(root.quaternion);
      const rear = tmp3.copy(root.position).addScaledVector(fwd, -2.6).setY(root.position.y + 0.4);
      // fewer, denser puffs: the screen still blocks sight lines but costs far less to draw
      for (let i = 0; i < Math.ceil(dt * 28); i++) {
        const v = tmp2.set((Math.random() - 0.5) * 3, 0.6 + Math.random() * 0.8, (Math.random() - 0.5) * 3).addScaledVector(fwd, -2.5);
        const shade = 0.82 + Math.random() * 0.1;
        this.smoke.emit(rear, v, {
          life: 7 + Math.random() * 3, size: 1.5 + Math.random() * 0.6, grow: 4.4, color: SMOKE_C.setRGB(shade, shade, shade * 1.02), color2: 0x9aa0a6,
          gravity: 0.22, drag: 0.8, alpha: 0.9,
        });
      }
      this.cloudT -= dt;
      if (this.cloudT <= 0) {
        this.cloudT = 0.25;
        this.clouds.push({ p: rear.clone().setY(rear.y + 0.9), born: t });
      }
    }
    this.clouds = this.clouds.filter((c) => t - c.born < SMOKE_CLOUD);
    for (const e of enemies) {
      if (this.inSmoke(epos(e))) {
        e.blind = Math.max(e.blind, 1.5);
        this.fleet.tagged(e, 'BLINDED', ctx.time, 3);
      }
    }

    // ------------------------------------------------------------------- emp
    for (const r of this.empRings) {
      if (r.t >= 1) continue;
      r.t += dt / 0.6;
      if (r.t < 0) continue;
      const k = Math.min(1, r.t);
      r.m.visible = k < 1;
      r.m.scale.setScalar(1 + k * EMP_RADIUS);
      (r.m.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.9;
    }
    for (const e of enemies) {
      if (e.stun <= 0 || Math.random() > dt * 14) continue;
      const p = epos(e).clone().add(tmp.set((Math.random() - 0.5) * 1.6, 0.6 + Math.random() * 0.8, (Math.random() - 0.5) * 3.6));
      for (let i = 0; i < 3; i++) this.arcs.spark(p, tmp.set((Math.random() - 0.5) * 6, Math.random() * 4, (Math.random() - 0.5) * 6), 0.18);
      if (Math.random() < 0.3) this.audio.crackle();
    }

    this.smoke.update(dt);
    this.arcs.update(dt);
  }

  private detonate(m: Mine, ctx: TrapContext) {
    m.active = m.obj.visible = false;
    for (const e of this.fleet.alive) {
      const b = e.sim.body.translation();
      if (Math.hypot(b.x - m.p.x, b.y - m.p.y, b.z - m.p.z) < 10) {
        this.fleet.tagged(e, 'MINED', ctx.time, 3);
        ctx.credit(e, 'MINED');
      }
    }
    this.destruction.queueBlast(m.p.clone().setY(m.p.y + 0.3), 9, 240, 15, 1.5, 0);
  }

  /** Trap states for the HUD and the phone. */
  snapshot() {
    return TRAP_KINDS.map((k) => ({ kind: k, n: this.charges[k], k: this.progress[k], max: TRAP_SPECS[k].max }));
  }
}

/** A flat blob of radius ~1 with lobed edges, lying in the xz plane. */
function puddleGeometry(seed: number) {
  const shape = new THREE.Shape();
  const n = 56;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = 0.9 + 0.12 * Math.sin(a * 3 + seed) + 0.07 * Math.sin(a * 5 + seed * 2.1) + 0.04 * Math.sin(a * 9 + seed * 0.7);
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  return new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);
}

/** Distance from point p to the segment a–b. */
function segmentPointDist(a: THREE.Vector3, b: THREE.Vector3, p: THREE.Vector3) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const len2 = abx * abx + aby * aby + abz * abz || 1;
  const k = THREE.MathUtils.clamp(((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / len2, 0, 1);
  return Math.hypot(a.x + abx * k - p.x, a.y + aby * k - p.y, a.z + abz * k - p.z);
}
