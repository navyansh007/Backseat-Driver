import * as THREE from 'three';
import { RAPIER, G, groups, type Physics } from './physics';
import type { PlayerCar } from './playerCar';
import type { StuntFeature } from './world/stuntPark';
import { CinematicCamera, type Flight } from './cinematic';
import type { MusicDirector } from './music';
import type { CarAudio } from './audio';

const GROUND_GROUPS = groups(0xffff, G.WORLD | G.CAR);
const UP = new THREE.Vector3(0, 1, 0);

/** Jumps shorter than this (predicted airtime, game seconds) aren't stunts. */
const MIN_AIR = 0.7;
const MIN_AIR_FEATURE = 0.4;
/** Hardest the car may hit the ground (m/s); softened just before touchdown. */
const MAX_LANDING_VY = 7.5;
/** Stunt score timing in real seconds: 3:56→3:58, one repeating bar (128 BPM), 3:58→4:00. */
const HEAD = 2, BAR = 1.875, TAIL = 2;
/** Longest the camera stays in the air before forcing the landing beat (real seconds). */
const MAX_FLIGHT_REAL = 11;

export interface StuntUi {
  letterbox: HTMLElement;
  card: HTMLElement;
  title: HTMLElement;
  tags: HTMLElement;
  stats: HTMLElement;
  points: HTMLElement;
  /** Elements faded out while the cinematic runs. */
  hide: HTMLElement[];
}

interface Air {
  t: number;
  start: THREE.Vector3;
  startY: number;
  maxY: number;
  roll: number;
  pitch: number;
  yaw: number;
  prevQ: THREE.Quaternion;
  feature: StuntFeature | null;
  airtime: number;
  impactVy: number;
  glassAwake: Set<number>;
}

/**
 * Watches the car for jumps. A big enough one becomes a stunt: time slows, the
 * cinematic camera takes over, the sound effects drop out and the stunt score plays,
 * then everything hands back to the driver on the last note.
 */
export class StuntDirector {
  enabled = true;
  /** Game-time multiplier (1 = normal speed). */
  timeScale = 1;
  readonly cine: CinematicCamera;
  total = 0;

  private airSteps = 0;
  private groundSteps = 0;
  private air: Air | null = null;
  /** The cinematic currently running. */
  private show: {
    t: number;
    slow: number;
    landedAt: number | null;
    endAt: number | null;
    music: boolean;
  } | null = null;
  private cooldown = 0;
  private predictT = 0;
  private timeToGround = 9;
  private cardTimer = 0;
  private tmpQ = new THREE.Quaternion();

  constructor(
    private phys: Physics,
    private car: PlayerCar,
    private features: StuntFeature[],
    camera: THREE.PerspectiveCamera,
    private music: MusicDirector,
    private audio: CarAudio,
    private ui: StuntUi,
    private glass: RAPIER.RigidBody[],
  ) {
    this.cine = new CinematicCamera(phys, camera, car.body);
  }

  get active() {
    return this.show !== null;
  }

  /** Called after every physics step (game time). */
  postStep(dt: number, playing: boolean) {
    const body = this.car.body;
    const vc = this.car.sim.controller;
    let contacts = 0;
    for (let i = 0; i < 4; i++) if (vc.wheelIsInContact(i)) contacts++;
    this.airSteps = contacts === 0 ? this.airSteps + 1 : 0;
    this.groundSteps = contacts >= 2 ? this.groundSteps + 1 : 0;
    this.cooldown = Math.max(0, this.cooldown - dt);
    const t = body.translation();
    const v = body.linvel();
    const pos = new THREE.Vector3(t.x, t.y, t.z);

    this.softenLanding(pos, v, dt);

    // ------------------------------------------------------------ takeoff
    if (!this.air && this.airSteps === 3 && this.cooldown <= 0 && !this.show) {
      const speed = Math.hypot(v.x, v.y, v.z);
      if (speed > 6) {
        const feature = this.features.find((f) => pos.x >= f.min.x && pos.x <= f.max.x && pos.y >= f.min.y && pos.y <= f.max.y && pos.z >= f.min.z && pos.z <= f.max.z) ?? null;
        if (feature?.roll) this.corkscrew(feature.roll);
        const vel = body.linvel();
        const flight = this.predict(pos, new THREE.Vector3(vel.x, vel.y, vel.z));
        const minAir = feature ? MIN_AIR_FEATURE : MIN_AIR;
        if (flight && flight.airtime >= minAir) {
          const r = body.rotation();
          this.air = {
            t: 3 * dt, start: pos.clone(), startY: pos.y, maxY: pos.y, roll: 0, pitch: 0, yaw: 0,
            prevQ: new THREE.Quaternion(r.x, r.y, r.z, r.w), feature, airtime: flight.airtime, impactVy: 0,
            glassAwake: new Set(this.glass.filter((g) => !g.isSleeping()).map((g) => g.handle)),
          };
          flight.feature = feature?.id ?? null;
          if (this.enabled && playing) this.begin(flight);
        }
      }
    }

    // ------------------------------------------------------------- flight
    const air = this.air;
    if (!air) return;
    air.t += dt;
    air.maxY = Math.max(air.maxY, pos.y);
    air.impactVy = Math.min(air.impactVy, v.y);
    // accumulate rotation in the car's own frame
    const r = body.rotation();
    const q = this.tmpQ.set(r.x, r.y, r.z, r.w);
    const dq = air.prevQ.clone().invert().multiply(q);
    const angle = 2 * Math.acos(THREE.MathUtils.clamp(dq.w, -1, 1));
    if (angle > 1e-5) {
      const s = Math.sqrt(1 - dq.w * dq.w) || 1;
      const a = angle > Math.PI ? angle - 2 * Math.PI : angle;
      air.pitch += (dq.x / s) * a;
      air.yaw += (dq.y / s) * a;
      air.roll += (dq.z / s) * a;
    }
    air.prevQ.copy(q);

    // re-predict now and then to time the touchdown
    this.predictT -= dt;
    if (this.predictT <= 0) {
      this.predictT = 4 * dt;
      const f = this.predict(pos, new THREE.Vector3(v.x, v.y, v.z), 1.2);
      this.timeToGround = f ? f.airtime : 9;
    } else this.timeToGround -= dt;
    if (this.show && this.show.landedAt === null) this.steadyForLanding();

    const rest = this.groundBelow(pos, 1.3) !== null && Math.abs(v.y) < 1.2;
    const forced = this.show && this.show.landedAt === null && this.show.t > MAX_FLIGHT_REAL;
    if (this.groundSteps >= 2 || (rest && this.airSteps === 0) || (rest && air.t > air.airtime + 0.4) || forced || air.t > 8) this.land();
  }

  /** Called once per rendered frame with real (unscaled) time. */
  update(dt: number, carRoot: THREE.Object3D) {
    this.cardTimer -= dt;
    if (this.cardTimer <= 0) this.ui.card.classList.remove('show');
    const s = this.show;
    if (!s) {
      this.timeScale += (1 - this.timeScale) * (1 - Math.exp(-dt * 8));
      return;
    }
    s.t += dt;
    // speed ramp: ease into slow motion, hold it, ease out over the final note
    let target = s.slow;
    if (s.endAt !== null) {
      const k = THREE.MathUtils.smoothstep(s.t, s.endAt - 1.2, s.endAt);
      target = s.slow + (1 - s.slow) * k;
    }
    const ease = s.t < 0.35 ? 1 - Math.exp(-dt * 10) : 1;
    this.timeScale += (target - this.timeScale) * ease;

    const air = this.air;
    const progress = air ? air.t / Math.max(0.05, air.airtime) : 1.4;
    this.cine.update(dt, s.landedAt !== null ? Math.max(progress, 1.01) : Math.min(progress, 0.999), carRoot);

    if (s.endAt !== null && s.t >= s.endAt) this.end();
  }

  /** Stop any stunt immediately (reset, menu). */
  cancel() {
    if (!this.show) return;
    if (this.show.music) {
      if (this.show.endAt === null) this.music.stuntCancel();
      this.audio.silenceSfx(false);
    }
    this.show = null;
    this.air = null;
    this.timeScale = 1;
    this.cardTimer = 0;
    this.cine.release();
    this.setChrome(false);
  }

  // ------------------------------------------------------------------ show
  private begin(flight: Flight) {
    // slower for shorter jumps so every stunt gets a few seconds on screen
    const T = flight.airtime;
    const realAir = THREE.MathUtils.clamp(2.2 + T * 2.6, 3, 7.5);
    const slow = THREE.MathUtils.clamp(T / realAir, 0.16, 0.45);
    const music = this.music.stuntStart();
    if (music) this.audio.silenceSfx(true);
    this.show = { t: 0, slow, landedAt: null, endAt: null, music };
    this.cine.plan(flight);
    this.setChrome(true);
    this.ui.card.classList.remove('show');
  }

  private land() {
    const air = this.air!;
    this.air = null;
    this.cooldown = 0.6;
    const s = this.show;
    if (!s) return;
    if (s.landedAt !== null) return;
    s.landedAt = s.t;
    // with the music off, keep the same shape: finish the bar, then the two-second ending
    const tailAt = HEAD + Math.max(0, Math.ceil((s.t - HEAD) / BAR)) * BAR;
    const remaining = s.music ? this.music.stuntFinish() : tailAt + TAIL - s.t;
    s.endAt = s.t + remaining;
    this.cine.impact(Math.min(1, -air.impactVy / 14));
    this.showCard(air);
  }

  private end() {
    const s = this.show!;
    if (s.music) this.audio.silenceSfx(false);
    this.show = null;
    this.cine.release();
    this.setChrome(false);
    this.cardTimer = 1.8;
  }

  private setChrome(on: boolean) {
    this.ui.letterbox.classList.toggle('on', on);
    document.body.classList.toggle('cine', on);
    for (const el of this.ui.hide) el.classList.toggle('cine-hide', on);
  }

  private showCard(air: Air) {
    const b = this.car.body.translation();
    const dist = Math.hypot(b.x - air.start.x, b.z - air.start.z);
    const drop = air.startY - b.y;
    const height = air.maxY - air.startY;
    const turns = (a: number) => Math.round(Math.abs(a) / (2 * Math.PI) - 0.15);
    const rolls = turns(air.roll), flips = turns(air.pitch), spins = turns(air.yaw);
    const smashed = this.glass.some((g) => !air.glassAwake.has(g.handle) && !g.isSleeping() && Math.hypot(g.linvel().x, g.linvel().z) > 0.6);
    const upright = this.car.sim.upright();
    const tags: string[] = [];
    if (rolls) tags.push(rolls > 1 ? `${rolls}× barrel roll` : 'barrel roll');
    if (flips) tags.push(flips > 1 ? `${flips}× flip` : 'flip');
    if (spins) tags.push(spins > 1 ? `${spins * 360}° spin` : '360 spin');
    if (smashed) tags.push('showroom smash');
    tags.push(upright > 0.75 ? 'clean landing' : upright < 0.3 ? 'wrecked' : 'rough landing');

    let pts = 300 * air.t + 14 * dist + 25 * Math.max(0, drop) + 40 * Math.max(0, height);
    pts += rolls * 1000 + flips * 1200 + spins * 600 + (smashed ? 1500 : 0);
    if (air.feature) pts += 500;
    if (upright > 0.75) pts *= 1.5;
    pts = Math.round(pts / 10) * 10;
    this.total += pts;

    const title = air.feature?.name ?? (air.t > 1.6 ? 'MEGA AIR' : 'BIG AIR');
    this.ui.title.textContent = title;
    this.ui.tags.textContent = tags.join('  ·  ');
    const bits = [`${air.t.toFixed(1)} s air`, `${Math.round(dist)} m`];
    if (drop > 2) bits.push(`${Math.round(drop)} m drop`);
    else if (height > 1) bits.push(`${height.toFixed(1)} m high`);
    this.ui.stats.textContent = bits.join('  ·  ');
    this.ui.points.textContent = `+${pts.toLocaleString()}  ·  total ${this.total.toLocaleString()}`;
    this.ui.card.classList.add('show');
    this.cardTimer = 99;
  }

  // ------------------------------------------------------------- physics
  /** Corkscrew: guarantee enough air and spin the car through one full roll. */
  private corkscrew(dir: 1 | -1) {
    const body = this.car.body;
    const v = body.linvel();
    body.setLinvel({ x: v.x, y: Math.max(v.y, 6.2), z: v.z }, true);
    const t = body.translation();
    const f = this.predict(new THREE.Vector3(t.x, t.y, t.z), new THREE.Vector3(v.x, Math.max(v.y, 6.2), v.z));
    const T = f ? f.airtime : 1.3;
    const r = body.rotation();
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
    const w = (dir * 2 * Math.PI) / Math.max(0.6, T * 0.9);
    body.setAngvel({ x: fwd.x * w, y: fwd.y * w, z: fwd.z * w }, true);
  }

  /** In the last moments before touchdown, bring the car level so it lands on its wheels. */
  private steadyForLanding() {
    const tl = this.timeToGround;
    if (tl > 0.45) return;
    const body = this.car.body;
    const r = body.rotation();
    const up = UP.clone().applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
    const axis = up.clone().cross(UP);
    const sin = axis.length();
    const angle = Math.atan2(sin, up.dot(UP));
    if (angle < 0.02 || angle > 2.0) return;
    axis.divideScalar(sin || 1);
    const want = axis.multiplyScalar(angle / Math.max(0.12, tl));
    const w = body.angvel();
    const yaw = w.y; // keep any flat spin
    const k = 0.25;
    body.setAngvel({ x: w.x + (want.x - w.x) * k, y: yaw, z: w.z + (want.z - w.z) * k }, true);
  }

  /** Cap the downward speed in the step before touchdown so big drops are survivable. */
  private softenLanding(pos: THREE.Vector3, v: RAPIER.Vector, dt: number) {
    if (v.y > -MAX_LANDING_VY) return;
    // the tyres reach ~0.72 m below the body origin: only act on the step before they touch
    const g = this.groundBelow(pos, 0.75 + -v.y * dt);
    if (g === null) return;
    if (this.air) this.air.impactVy = Math.min(this.air.impactVy, v.y);
    this.car.body.setLinvel({ x: v.x, y: -MAX_LANDING_VY, z: v.z }, true);
  }

  private groundBelow(p: THREE.Vector3, depth: number) {
    const hit = this.phys.world.castRay(new RAPIER.Ray({ x: p.x, y: p.y, z: p.z }, { x: 0, y: -1, z: 0 }), depth, true, undefined, GROUND_GROUPS, undefined, this.car.body);
    return hit ? hit.timeOfImpact : null;
  }

  /** Ballistic path of the car's origin until its wheels would touch something. */
  private predict(p0: THREE.Vector3, v0: THREE.Vector3, horizon = 6): Flight | null {
    const dt = 1 / 30;
    const p = p0.clone(), v = v0.clone();
    const path = [p.clone()];
    const off = 0.45; // origin → roughly the bottom of the tyres
    const world = this.phys.world;
    for (let t = 0; t < horizon; t += dt) {
      const np = p.clone().addScaledVector(v, dt);
      np.y -= 0.5 * 9.81 * dt * dt;
      v.y -= 9.81 * dt;
      const a = { x: p.x, y: p.y - off, z: p.z };
      const d = new THREE.Vector3(np.x - p.x, np.y - p.y, np.z - p.z);
      const len = d.length();
      d.divideScalar(len);
      const hit = world.castRay(new RAPIER.Ray(a, d), len, true, undefined, GROUND_GROUPS, undefined, this.car.body);
      if (hit && !(t < 0.1 && hit.timeOfImpact < 0.01)) {
        const k = hit.timeOfImpact / len;
        const landing = p.clone().lerp(np, k);
        path.push(landing.clone());
        return { path, dt, airtime: t + k * dt, landing, velocity: v0.clone(), feature: null };
      }
      p.copy(np);
      path.push(p.clone());
    }
    return null;
  }
}
