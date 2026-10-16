import * as THREE from 'three';
import { RAPIER, G, groups, type Physics } from './physics';
import { SHOWROOM } from './world/garage';

const LOS_GROUPS = groups(0xffff, G.WORLD | G.CAR);
const UP = new THREE.Vector3(0, 1, 0);

/** What the stunt director knows about a jump at takeoff. */
export interface Flight {
  /** Predicted path of the car's origin, sampled every `dt` seconds of game time. */
  path: THREE.Vector3[];
  dt: number;
  /** Predicted airtime from now (game seconds). */
  airtime: number;
  landing: THREE.Vector3;
  velocity: THREE.Vector3;
  feature: string | null;
}

type ShotKind = 'crane' | 'launchLow' | 'profile' | 'landingLow' | 'under' | 'showroom' | 'orbit' | 'tele';

interface Shot {
  kind: ShotKind;
  /** Flight progress (0 = takeoff, 1 = predicted touchdown) at which this shot cuts in. */
  from: number;
  anchor: THREE.Vector3;
  fov: number;
  dutch: number;
  /** Per-shot side (+1/-1 of the flight's right vector). */
  side: number;
}

/**
 * Directs the slow-motion stunt camera: plans a short sequence of shots from the
 * predicted flight path (checking each one has a clear view), then cuts between
 * them as the car flies, lands and rolls away.
 */
export class CinematicCamera {
  private shots: Shot[] = [];
  private current = -1;
  private flight!: Flight;
  private fwd = new THREE.Vector3();
  private right = new THREE.Vector3();
  private look = new THREE.Vector3();
  private pos = new THREE.Vector3();
  private shake = 0;
  private shotTime = 0;
  private orbitAngle = 0;
  private blockedFor = 0;

  constructor(private phys: Physics, private camera: THREE.PerspectiveCamera, private exclude: RAPIER.RigidBody) {}

  plan(flight: Flight) {
    this.flight = flight;
    const v = flight.velocity;
    this.fwd.set(v.x, 0, v.z);
    if (this.fwd.lengthSq() < 1e-4) this.fwd.set(0, 0, 1);
    this.fwd.normalize();
    this.right.set(-this.fwd.z, 0, this.fwd.x);
    const T = flight.airtime;
    const crossesShowroom = flight.path.some((p) => p.x < SHOWROOM.x1 + 6 && p.z > SHOWROOM.z0 + 1 && p.z < SHOWROOM.z1 - 1 && p.y < SHOWROOM.h + 1);

    let seq: [ShotKind, number][];
    switch (flight.feature) {
      case 'roofleap':
        seq = [['crane', 0], ['under', 0.3], [crossesShowroom ? 'showroom' : 'landingLow', 0.66]];
        break;
      case 'deckdive':
        seq = [['under', 0], ['landingLow', 0.55]];
        break;
      case 'corkscrew':
        seq = [['launchLow', 0], ['orbit', 0.3], ['landingLow', 0.8]];
        break;
      case 'carhop':
      case 'carhop-back':
        seq = [['launchLow', 0], ['profile', 0.35], ['landingLow', 0.72]];
        break;
      case 'gatecrasher':
      case 'tabletop':
        seq = [['launchLow', 0], ['tele', 0.42]];
        break;
      default:
        seq = T > 1.1 ? [['launchLow', 0], ['profile', 0.33], ['landingLow', 0.7]] : [['profile', 0], ['landingLow', 0.55]];
    }
    const side = this.pickSide();
    this.shots = seq.map(([kind, from], i) => this.makeShot(kind, from, i % 2 === 0 ? side : -side, seq[i + 1]?.[1] ?? 1.3));
    this.current = -1;
    this.shake = 0;
    this.blockedFor = 0;
  }

  /** Landing jolt for the camera. */
  impact(power: number) {
    this.shake = Math.min(1, this.shake + power);
  }

  /**
   * @param progress flight progress (game time since takeoff / predicted airtime; > 1 after landing)
   */
  update(dt: number, progress: number, car: THREE.Object3D) {
    const cam = this.camera;
    let idx = 0;
    for (let i = 0; i < this.shots.length; i++) if (progress >= this.shots[i].from) idx = i;
    const target = car.position;
    if (idx !== this.current) {
      this.current = idx;
      this.shotTime = 0;
      this.look.copy(target);
      const shot = this.shots[idx];
      if (shot.kind === 'orbit') this.orbitAngle = Math.atan2(shot.side * this.right.x, shot.side * this.right.z);
      this.placeDynamic(shot, target, 1, 0);
    }
    const shot = this.shots[this.current];
    this.shotTime += dt;

    // dynamic shots move with the car; fixed ones hold their anchor with a slow creep
    if (shot.kind === 'crane' || shot.kind === 'orbit') this.placeDynamic(shot, target, 1 - Math.exp(-dt * 5), dt);
    else {
      this.pos.copy(shot.anchor);
      if (shot.kind === 'profile') this.pos.addScaledVector(this.fwd, Math.min(progress, 1.2) * 3);
      if (shot.kind === 'launchLow') this.pos.addScaledVector(this.right, -shot.side * this.shotTime * 0.5);
    }

    // after touchdown: if the car has driven out of a fixed shot, swing round to an orbit
    if (progress > 1 && shot.kind !== 'orbit') {
      const far = this.pos.distanceTo(target) > 30;
      const blocked = !this.clear(this.pos, target);
      this.blockedFor = far || blocked ? this.blockedFor + dt : 0;
      if (this.blockedFor > 0.35) {
        this.shots.push({ kind: 'orbit', from: progress, anchor: target.clone(), fov: 50, dutch: 0, side: shot.side });
        this.blockedFor = 0;
      }
    }

    const lookTarget = target.clone();
    if (shot.kind === 'crane') lookTarget.addScaledVector(this.fwd, 4).y -= 1.2;
    this.look.lerp(lookTarget, 1 - Math.exp(-dt * 9));
    cam.position.copy(this.pos);
    if (this.shake > 0.001) {
      const s = this.shake * 0.3;
      cam.position.add(new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s));
      this.shake *= Math.exp(-dt * 5);
    }
    // dutch angle: roll the camera's up vector about the view direction
    const view = this.look.clone().sub(cam.position).normalize();
    cam.up.copy(UP).applyAxisAngle(view, shot.dutch);
    cam.lookAt(this.look);
    const creep = 1 - Math.min(0.08, this.shotTime * 0.02);
    cam.fov += (shot.fov * creep - cam.fov) * (this.shotTime < 0.02 ? 1 : 1 - Math.exp(-dt * 6));
    cam.updateProjectionMatrix();
  }

  /** Reset camera state the chase camera relies on. */
  release() {
    this.camera.up.copy(UP);
  }

  // ------------------------------------------------------------- planning
  private pathAt(u: number) {
    const { path, dt, airtime } = this.flight;
    const i = Math.min(path.length - 1, Math.max(0, (u * airtime) / dt));
    const a = path[Math.floor(i)], b = path[Math.min(path.length - 1, Math.ceil(i))];
    return a.clone().lerp(b, i - Math.floor(i));
  }

  /** Height of the surface below p (world or cars), or null if nothing within `depth`. */
  private groundBelow(p: THREE.Vector3, depth = 40) {
    const hit = this.phys.world.castRay(new RAPIER.Ray({ x: p.x, y: p.y, z: p.z }, { x: 0, y: -1, z: 0 }), depth, true, undefined, LOS_GROUPS, undefined, this.exclude);
    return hit ? p.y - hit.timeOfImpact : null;
  }

  private clear(from: THREE.Vector3, to: THREE.Vector3) {
    const d = to.clone().sub(from);
    const len = d.length();
    if (len < 0.01) return true;
    d.divideScalar(len);
    const hit = this.phys.world.castRay(new RAPIER.Ray(from, d), len - 1.2, true, undefined, LOS_GROUPS, undefined, this.exclude);
    return !hit;
  }

  /** Does `anchor` see the car over flight progress [u0, u1]? */
  private sees(anchor: THREE.Vector3, u0: number, u1: number) {
    for (let k = 0; k <= 3; k++) if (!this.clear(anchor, this.pathAt(u0 + ((u1 - u0) * k) / 3))) return false;
    return true;
  }

  private pickSide() {
    const mid = this.pathAt(0.5);
    const score = (s: number) => {
      let n = 0;
      for (const d of [6, 14, 24]) if (this.clear(mid.clone().addScaledVector(this.right, s * d).setY(mid.y + 1), mid)) n++;
      return n;
    };
    return score(1) >= score(-1) ? 1 : -1;
  }

  private makeShot(kind: ShotKind, from: number, side: number, until: number): Shot {
    const f = this.flight;
    const speed = Math.hypot(f.velocity.x, f.velocity.z);
    const start = f.path[0];
    const range = start.distanceTo(f.landing);
    const shot: Shot = { kind, from, anchor: new THREE.Vector3(), fov: 50, dutch: 0, side };
    const onGround = (p: THREE.Vector3, lift: number, fallbackY: number) => {
      const g = this.groundBelow(p.clone().setY(p.y + 2), 60);
      p.y = g !== null ? g + lift : fallbackY;
      return p;
    };
    const candidates: (() => void)[] = [];
    const build = (s: number) => {
      const r = this.right.clone().multiplyScalar(s);
      switch (kind) {
        case 'launchLow': {
          const a = start.clone().addScaledVector(this.fwd, 5 + speed * 0.3).addScaledVector(r, 3.6);
          const g = this.groundBelow(a.clone().setY(start.y + 1), 3);
          a.y = g !== null ? g + 0.45 : start.y - 0.4; // past an edge: hang just below the lip like a crane
          shot.anchor.copy(a);
          shot.fov = 50;
          shot.dutch = 0.07 * s;
          break;
        }
        case 'profile': {
          const mid = this.pathAt(0.5);
          const d = THREE.MathUtils.clamp(range * 0.7, 12, 36);
          const a = mid.clone().addScaledVector(r, d).addScaledVector(this.fwd, -3);
          onGround(a, 1.1, mid.y);
          shot.anchor.copy(a);
          shot.fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan((range * 0.55 + 4) / d)), 22, 55);
          break;
        }
        case 'landingLow': {
          const a = f.landing.clone().addScaledVector(this.fwd, 7 + speed * 0.22).addScaledVector(r, 4.5);
          onGround(a, 0.4, f.landing.y);
          shot.anchor.copy(a);
          shot.fov = 52;
          shot.dutch = -0.04 * s;
          break;
        }
        case 'under': {
          const p = this.pathAt(0.55);
          const a = p.clone().addScaledVector(this.fwd, 6).addScaledVector(r, 5);
          onGround(a, 0.35, p.y - 6);
          shot.anchor.copy(a);
          shot.fov = 64;
          shot.dutch = 0.05 * s;
          break;
        }
        case 'showroom': {
          // inside the showroom, looking out through the glass at the car coming in
          const z = THREE.MathUtils.clamp(f.landing.z, SHOWROOM.z0 + 3, SHOWROOM.z1 - 3) + s * 3;
          shot.anchor.set(SHOWROOM.x0 + 2.6, 1.3, z);
          shot.fov = 56;
          break;
        }
        case 'tele': {
          const a = f.landing.clone().addScaledVector(this.fwd, 30 + speed * 0.6).addScaledVector(r, 2.5);
          onGround(a, 1.6, f.landing.y + 1.6);
          shot.anchor.copy(a);
          shot.fov = 20;
          break;
        }
        case 'crane':
        case 'orbit':
          shot.fov = kind === 'crane' ? 62 : 50;
          break;
      }
    };
    candidates.push(() => build(side), () => build(-side), () => { build(side); shot.anchor.y += 2.5; });
    if (kind === 'crane' || kind === 'orbit') {
      build(side);
      return shot;
    }
    for (const c of candidates) {
      c();
      if (this.sees(shot.anchor, from, Math.min(1, until))) return shot;
    }
    // nothing clear: follow the car instead
    return { kind: 'crane', from, anchor: new THREE.Vector3(), fov: 60, dutch: 0, side };
  }

  /** Crane and orbit shots ride with the car; pulled in if something is in the way. */
  private placeDynamic(shot: Shot, target: THREE.Vector3, k: number, dt: number) {
    const want = new THREE.Vector3();
    if (shot.kind === 'crane') {
      want.copy(target).addScaledVector(this.fwd, -8).addScaledVector(this.right, shot.side * 2.5);
      want.y += 4.5;
    } else if (shot.kind === 'orbit') {
      this.orbitAngle += dt * 0.9;
      want.set(target.x + Math.sin(this.orbitAngle) * 7.5, target.y + 1.6, target.z + Math.cos(this.orbitAngle) * 7.5);
    } else {
      this.pos.copy(shot.anchor);
      return;
    }
    const from = target.clone().add(new THREE.Vector3(0, 0.8, 0));
    const d = want.clone().sub(from);
    const len = d.length();
    d.divideScalar(len);
    const hit = this.phys.world.castRay(new RAPIER.Ray(from, d), len, true, undefined, LOS_GROUPS, undefined, this.exclude);
    if (hit) want.copy(from).addScaledVector(d, Math.max(1.5, hit.timeOfImpact - 0.4));
    this.pos.lerp(want, k);
  }
}
