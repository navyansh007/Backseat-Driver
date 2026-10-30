import * as THREE from 'three';
import { RAPIER, G, groups, type Physics } from '../physics';
import type { PlayerCar } from '../playerCar';
import { TUNING } from '../vehiclePhysics';
import type { CombatFx } from './fx';
import type { Destruction } from './destruction';

export interface WeaponInput {
  gun: boolean;
  missileSeq: number;
}

export interface WeaponEvents {
  gunshot(): void;
  launch(): void;
  /** a round struck something at p */
  hit?(p: THREE.Vector3): void;
}

const FIRE_INTERVAL = 1 / 13;
const HEAT_PER_SHOT = 0.03;
const COOL_RATE = 0.38;
const RANGE = 170;
const MAX_MISSILES = 4;
const RELOAD = 5;
const LOCK_RANGE = 150;
const LOCK_ANGLE = 0.32;
/** Line-of-sight rays stop on world geometry (walls, fences, pillars) and other cars; loose props don't block. */
const SIGHT_GROUPS = groups(0xffff, G.WORLD | G.CAR);

interface Missile {
  obj: THREE.Group;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  target: RAPIER.RigidBody | null;
  age: number;
  active: boolean;
}

/** Twin bumper guns + roof missile launcher fitted to the player's car. */
export class Weapons {
  heat = 0;
  overheated = false;
  missiles = MAX_MISSILES;
  lock: RAPIER.RigidBody | null = null;
  private reload = 0;
  private cooldown = 0;
  private side = 0;
  private lastSeq = -1;
  private gunsOut = 0;
  private launcherUp = 0;
  private launcherTimer = 0;
  private guns: THREE.Group[] = [];
  private launcher: THREE.Group;
  private muzzleLight: THREE.PointLight;
  private pool: Missile[] = [];
  private tmp = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    private car: PlayerCar,
    private phys: Physics,
    private fx: CombatFx,
    private destruction: Destruction,
    private events: WeaponEvents,
  ) {
    const metal = new THREE.MeshStandardMaterial({ color: 0x2b2e33, metalness: 0.85, roughness: 0.35 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x0d0e10, roughness: 0.6 });
    const bodyY = (y: number) => y - TUNING.rideHeight; // car space → body space

    // guns hide behind the lower grille and slide forward when firing
    for (const s of [-1, 1]) {
      const g = new THREE.Group();
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.42, 10), metal);
      barrel.rotation.x = Math.PI / 2;
      const shroud = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.18, 10), dark);
      shroud.rotation.x = Math.PI / 2;
      shroud.position.z = -0.14;
      g.add(barrel, shroud);
      g.position.set(s * 0.42, bodyY(0.34), 2.36);
      this.guns.push(g);
      car.root.add(g);
    }
    this.muzzleLight = new THREE.PointLight(0xffc070, 0, 14, 2);
    this.muzzleLight.position.set(0, bodyY(0.4), 3.0);
    car.root.add(this.muzzleLight);

    // roof launcher: four tubes on a lifting rail, hidden in the roof when stowed
    this.launcher = new THREE.Group();
    const pod = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.2, 0.86), metal);
    pod.castShadow = true;
    this.launcher.add(pod);
    for (let i = 0; i < 4; i++) {
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.04, 12), dark);
      tube.rotation.x = Math.PI / 2;
      tube.position.set((i % 2 ? 0.14 : -0.14), i < 2 ? 0.045 : -0.045, 0.44);
      this.launcher.add(tube);
    }
    this.launcher.position.set(0, bodyY(1.3), -0.45);
    car.root.add(this.launcher);

    // missile pool
    const mBody = new THREE.MeshStandardMaterial({ color: 0xe9ecef, roughness: 0.4, metalness: 0.3 });
    const mNose = new THREE.MeshStandardMaterial({ color: 0xb3261e, roughness: 0.5 });
    for (let i = 0; i < 8; i++) {
      const obj = new THREE.Group();
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.75, 10), mBody);
      b.rotation.x = Math.PI / 2;
      const n = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.18, 10), mNose);
      n.rotation.x = Math.PI / 2;
      n.position.z = 0.46;
      obj.add(b, n);
      for (let k = 0; k < 4; k++) {
        const fin = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.16, 0.14), mBody);
        fin.position.z = -0.3;
        fin.rotation.z = (k * Math.PI) / 2;
        fin.translateY(0.08);
        obj.add(fin);
      }
      obj.visible = false;
      scene.add(obj);
      this.pool.push({ obj, pos: new THREE.Vector3(), vel: new THREE.Vector3(), target: null, age: 0, active: false });
    }
  }

  private forward() {
    return new THREE.Vector3(0, 0, 1).applyQuaternion(this.car.root.quaternion);
  }

  update(dt: number, input: WeaponInput, active: boolean) {
    // ------------------------------------------------------------ lock-on
    this.lock = null;
    if (active) {
      const fwd = this.forward();
      const p = this.car.position;
      const candidates: { body: RAPIER.RigidBody; score: number }[] = [];
      for (const body of this.destruction.cars()) {
        const t = body.translation();
        this.tmp.set(t.x - p.x, t.y - p.y, t.z - p.z);
        const d = this.tmp.length();
        if (d < 6 || d > LOCK_RANGE) continue;
        const ang = this.tmp.divideScalar(d).angleTo(fwd);
        if (ang > LOCK_ANGLE) continue;
        candidates.push({ body, score: ang * 40 + d * 0.15 });
      }
      // best-scoring car the launcher can actually see
      candidates.sort((a, b) => a.score - b.score);
      for (const c of candidates) {
        if (this.inSight(c.body)) {
          this.lock = c.body;
          break;
        }
      }
    }

    // ------------------------------------------------------------ guns
    this.heat = Math.max(0, this.heat - COOL_RATE * dt);
    if (this.overheated && this.heat < 0.35) this.overheated = false;
    const wantGun = active && input.gun && !this.overheated;
    this.gunsOut += ((wantGun ? 1 : 0) - this.gunsOut) * Math.min(1, dt * (wantGun ? 18 : 3));
    this.guns.forEach((g) => (g.position.z = 2.36 + this.gunsOut * 0.3));
    this.cooldown -= dt;
    this.muzzleLight.intensity *= Math.exp(-dt * 40);
    if (wantGun && this.gunsOut > 0.6 && this.cooldown <= 0) {
      this.cooldown = FIRE_INTERVAL;
      this.fireGun();
      this.heat += HEAT_PER_SHOT;
      if (this.heat >= 1) {
        this.heat = 1;
        this.overheated = true;
      }
    }

    // ------------------------------------------------------------ missiles
    if (this.missiles < MAX_MISSILES) {
      this.reload += dt;
      if (this.reload >= RELOAD) {
        this.reload = 0;
        this.missiles++;
      }
    }
    if (this.lastSeq < 0) this.lastSeq = input.missileSeq;
    if (input.missileSeq !== this.lastSeq) {
      const pressed = input.missileSeq > this.lastSeq; // a reconnecting phone restarts its counter
      this.lastSeq = input.missileSeq;
      if (pressed && active && this.missiles > 0) {
        this.launcherTimer = 3.2;
        this.fireMissile();
      }
    }
    this.launcherTimer -= dt;
    const up = this.launcherTimer > 0 ? 1 : 0;
    this.launcherUp += (up - this.launcherUp) * Math.min(1, dt * 7);
    this.launcher.position.y = 1.3 - TUNING.rideHeight + this.launcherUp * 0.3;
    this.launcher.rotation.x = -this.launcherUp * 0.12;
    this.launcher.visible = this.launcherUp > 0.02;

    for (const m of this.pool) if (m.active) this.stepMissile(m, dt);
  }

  /** True when nothing solid sits between the roof launcher and the target's body. */
  private inSight(target: RAPIER.RigidBody) {
    const root = this.car.root;
    const from = new THREE.Vector3(0, 1.3 - TUNING.rideHeight + 0.3, 0).applyQuaternion(root.quaternion).add(root.position);
    const t = target.translation();
    const dir = new THREE.Vector3(t.x, t.y + 0.7, t.z).sub(from);
    const len = dir.length();
    dir.divideScalar(len);
    const hit = this.phys.world.castRay(new RAPIER.Ray(from, dir), len, true, undefined, SIGHT_GROUPS, undefined, this.car.body);
    return !hit || hit.collider.parent()?.handle === target.handle;
  }

  private fireGun() {
    const root = this.car.root;
    const gun = this.guns[this.side];
    this.side = 1 - this.side;
    const muzzle = gun.localToWorld(new THREE.Vector3(0, 0, 0.24));
    // converge slightly toward a point ahead, then add spread
    const aim = new THREE.Vector3(0, 0.25, 45).applyQuaternion(root.quaternion).add(root.position);
    if (this.lock) {
      const t = this.lock.translation();
      aim.set(t.x, t.y + 0.5, t.z);
    }
    const dir = aim.sub(muzzle).normalize();
    dir.x += (Math.random() - 0.5) * 0.022;
    dir.y += (Math.random() - 0.5) * 0.012;
    dir.z += (Math.random() - 0.5) * 0.022;
    dir.normalize();

    const hit = this.phys.world.castRayAndGetNormal(new RAPIER.Ray(muzzle, dir), RANGE, true, undefined, undefined, undefined, this.car.body);
    const end = muzzle.clone().addScaledVector(dir, hit ? hit.timeOfImpact : RANGE);
    if (hit) {
      const n = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
      this.fx.impactSparks(end, n, 5);
      this.events.hit?.(end);
      const body = hit.collider.parent();
      if (body) {
        if (body.isDynamic()) body.applyImpulseAtPoint({ x: dir.x * 40, y: dir.y * 40, z: dir.z * 40 }, end, true);
        this.destruction.damage(body, 9, end);
      }
    }
    // tracer from just ahead of the muzzle; flash
    this.fx.tracers.tracer(muzzle.clone().addScaledVector(dir, 1.2), end, 0.045, 0.05);
    const lv = this.car.body.linvel();
    this.fx.fire.emit(muzzle, new THREE.Vector3(lv.x, lv.y, lv.z), { life: 0.05, size: 0.45, grow: 1.4, color: 0xfff2c4, color2: 0xff8a2a, alpha: 1 });
    this.muzzleLight.intensity = 25;
    this.events.gunshot();
  }

  private fireMissile() {
    const m = this.pool.find((x) => !x.active);
    if (!m) return;
    this.missiles--;
    const root = this.car.root;
    const tube = (MAX_MISSILES - this.missiles - 1) % 4;
    const local = new THREE.Vector3(tube % 2 ? 0.14 : -0.14, 1.3 - TUNING.rideHeight + 0.35, 0.1);
    m.pos.copy(local).applyQuaternion(root.quaternion).add(root.position);
    const lv = this.car.body.linvel();
    m.vel.set(0, 0.2, 1).normalize().multiplyScalar(24).applyQuaternion(root.quaternion).add(new THREE.Vector3(lv.x, 0, lv.z));
    m.target = this.lock;
    m.age = 0;
    m.active = true;
    m.obj.visible = true;
    m.obj.position.copy(m.pos);
    this.fx.smoke.emit(m.pos, new THREE.Vector3(0, 1, 0), { life: 1.2, size: 0.8, grow: 3, color: 0xe6e6e6, alpha: 0.6, drag: 2 });
    this.events.launch();
  }

  private stepMissile(m: Missile, dt: number) {
    m.age += dt;
    const speed = Math.min(78, m.vel.length() + 70 * dt);
    let dir = m.vel.clone().normalize();
    if (m.target && m.age > 0.2) {
      if (!this.destruction.isTarget(m.target)) m.target = null;
      else {
        const t = m.target.translation();
        const want = new THREE.Vector3(t.x, t.y + 0.6, t.z).sub(m.pos).normalize();
        const ang = dir.angleTo(want);
        const maxTurn = 3.2 * dt;
        if (ang > 1e-4) dir = ang <= maxTurn ? want : dir.lerp(want, maxTurn / ang).normalize();
      }
    } else if (m.age > 0.25) {
      // unguided: settle into level flight
      dir.y += (-0.02 - dir.y) * Math.min(1, dt * 2);
      dir.normalize();
    }
    m.vel.copy(dir).multiplyScalar(speed);
    const step = speed * dt;
    const hit = this.phys.world.castRay(new RAPIER.Ray(m.pos, dir), step + 0.4, true, undefined, undefined, undefined, this.car.body);
    if (hit || m.age > 5 || m.pos.y < -2) {
      const p = hit ? m.pos.clone().addScaledVector(dir, hit.timeOfImpact) : m.pos.clone();
      if (hit) {
        const body = hit.collider.parent();
        if (body) this.destruction.damage(body, 70, p);
      }
      this.destruction.queueBlast(p, 7.5, 150, 12, 1.3, 0);
      m.active = false;
      m.obj.visible = false;
      return;
    }
    m.pos.addScaledVector(dir, step);
    m.obj.position.copy(m.pos);
    m.obj.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    // exhaust + trail
    const tail = m.pos.clone().addScaledVector(dir, -0.45);
    this.fx.fire.emit(tail, dir.clone().multiplyScalar(-6), { life: 0.08, size: 0.35, grow: 1.6, color: 0xfff1b0, color2: 0xff6a1a, alpha: 1 });
    this.fx.smoke.emit(tail, new THREE.Vector3((Math.random() - 0.5) * 0.4, 0.3, (Math.random() - 0.5) * 0.4), {
      life: 2.2 + Math.random(), size: 0.35, grow: 4.5, color: 0xf2f2f2, color2: 0xb9b9b9, gravity: 0.3, drag: 1.5, alpha: 0.55,
    });
  }
}
