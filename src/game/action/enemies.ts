import * as THREE from 'three';
import { RAPIER, G, groups, InstancedBodies, type Part, type Physics } from '../physics';
import { TUNING, VehicleSim, type DriveInput } from '../vehiclePhysics';
import { buildCar, makeCarMaterials, SPECS, type PartKey } from '../models/carModel';
import type { Entry } from '../world/dynamics';
import { GARAGE } from '../world/garage';

const ENEMY_GROUPS = groups(G.ENEMY, 0xffff);
const PAINT = new THREE.Color(0x0a0b0d);
/** Shots stop on walls, parked cars and the player; other pursuers and loose props don't block. */
const SHOT_GROUPS = groups(0xffff, G.WORLD | G.CAR | G.PLAYER);
/** What a pursuer has to steer around: walls, ramps' sides, parked cars. */
const OBSTACLE_GROUPS = groups(0xffff, G.WORLD | G.CAR);
const PARK = { x: 0, y: -60, z: 0 };

/** chaser: rams. gunner: hangs back and shoots. heavy: big executive saloon that does both. */
export type Role = 'chaser' | 'gunner' | 'heavy';

export interface EnemyStats {
  hp: number;
  /** throttle cap, 0–1 (the player's car has the same engine) */
  throttle: number;
  /** 0–1, how tight the shots are */
  accuracy: number;
  /** seconds between bursts */
  burstGap: number;
  /** damage per round that hits */
  shot: number;
  /** ram damage multiplier */
  ram: number;
}

export interface Enemy {
  role: Role;
  sim: VehicleSim;
  entry: Entry;
  /** wheel instances start here (4 per enemy) */
  wheelBase: number;
  wheelScale: number;
  active: boolean;
  alive: boolean;
  deadAt: number;
  stats: EnemyStats;
  prevP: THREE.Vector3;
  currP: THREE.Vector3;
  prevQ: THREE.Quaternion;
  currQ: THREE.Quaternion;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  // driving
  stuck: number;
  reverse: number;
  reverseSteer: number;
  /** heading for a clear spot to get round an obstacle */
  detour: number;
  detourGoal: THREE.Vector3;
  probeT: number;
  path: THREE.Vector3[] | null;
  pathKey: string;
  pathIdx: number;
  /** where the player was last seen */
  lastSeen: THREE.Vector3;
  seen: boolean;
  orbit: number;
  flipped: number;
  /** progress watchdog: where it was a few seconds ago, and for how long it has barely moved */
  anchor: THREE.Vector3;
  anchorT: number;
  idle: number;
  // shooting
  fireT: number;
  burst: number;
  shotT: number;
  // status effects (seconds left)
  stun: number;
  puncture: number;
  slick: number;
  blind: number;
  /** what last messed this car up, for trap-kill credit */
  tag: string;
  tagUntil: number;
  ramCd: number;
}

export interface FleetContext {
  time: number;
  player: THREE.Vector3;
  playerVel: THREE.Vector3;
  playerBody: RAPIER.RigidBody;
  /** false once the player is wrecked: circle the wreck, stop shooting */
  playerAlive: boolean;
  /** a smoke cloud sits between a and b */
  smokeBetween(a: THREE.Vector3, b: THREE.Vector3): boolean;
  /** p is inside a smoke cloud */
  inSmoke(p: THREE.Vector3): boolean;
}

export interface FleetHooks {
  /** a round left the muzzle; `hit` is where it stopped, `player` if it struck the player's car */
  shot(from: THREE.Vector3, to: THREE.Vector3, player: boolean, e: Enemy, dist: number): void;
}

// --------------------------------------------------------------- garage routes
// Waypoints (garage frame, x/z) that climb one deck: ground → L1 → L2 → roof.
// Going down follows the deck above's route backwards.
const { x: GX, z: GZ, level: LV, halfX: GHX, halfZ: GHZ } = GARAGE;
const UP_ROUTES = [
  [[-10, -20], [2, -20], [38, -20]],
  [[43, -19], [43, 0], [42, 20], [34, 20], [1, 20]],
  [[-6, 20], [-6, 0], [-4, -20], [4, -20], [38, -20]],
].map((route, level) => route.map(([x, z]) => new THREE.Vector3(GX + x, level * LV, GZ + z)));
const inGarage = (p: THREE.Vector3) => Math.abs(p.x - GX) < GHX + 0.5 && Math.abs(p.z - GZ) < GHZ + 0.5;
/** 0 = ground (or anywhere outside the car park), 3 = roof. */
export const levelOf = (p: THREE.Vector3) => (inGarage(p) ? THREE.MathUtils.clamp(Math.round((p.y - 0.4) / LV), 0, 3) : 0);

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpM = new THREE.Matrix4();
const flipQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
const Y = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);
const ZERO_SCALE = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * The pursuers: black saloons on the same raycast-vehicle physics as the player, drawn
 * as instances (one set per model, plus instanced spinning wheels) so a whole wave costs
 * a few dozen draw calls. Cars come from a fixed pool and go back to it when wrecked.
 */
export class Fleet {
  readonly list: Enemy[] = [];
  private sets = new Map<string, InstancedBodies>();
  private wheelMeshes: THREE.InstancedMesh[] = [];
  private byHandle = new Map<number, Enemy>();
  private wheelQ = new THREE.Quaternion();

  constructor(scene: THREE.Scene, private phys: Physics, private hooks: FleetHooks) {
    const mats = makeCarMaterials(0xffffff, 'HX·0451');
    // xenon headlamps and lit tails: they should look like they mean it
    mats.head.emissive.set(0xdfe9ff);
    mats.head.emissiveIntensity = 1.6;
    mats.tail.emissiveIntensity = 0.9;
    mats.paint.roughness = 0.2;
    const pool: [string, number][] = [['sedan', 8], ['executive', 4]];
    const offset = new THREE.Matrix4().makeTranslation(0, -TUNING.rideHeight, 0);
    let wheelBase = 0;
    for (const [model, n] of pool) {
      const spec = SPECS[model];
      const built = buildCar(spec, { includeWheels: false });
      const parts: Part[] = (Object.entries(built.parts) as [PartKey, THREE.BufferGeometry][]).map(([k, geo]) => ({
        geometry: geo,
        material: mats[k],
        tinted: k === 'paint',
        castShadow: !['plate', 'head', 'tail', 'amber', 'ao'].includes(k),
        receiveShadow: k === 'paint',
      }));
      const set = new InstancedBodies(parts, n, offset).addTo(scene);
      this.sets.set(model, set);
      for (let i = 0; i < n; i++) {
        const sim = new VehicleSim(
          phys.world,
          { frontAxleZ: spec.frontAxleZ, rearAxleZ: spec.rearAxleZ, track: spec.track, radius: spec.wheelR },
          { ...PARK, yaw: 0 },
          ENEMY_GROUPS,
        );
        sim.assist = 0.65;
        sim.body.setEnabled(false);
        if (model === 'executive') sim.body.setAdditionalMass(700, false);
        const index = set.add(sim.body, PAINT);
        set.setHidden(index, true);
        const entry: Entry = { body: sim.body, set, index, kind: model, color: PAINT.clone(), car: true, kinematic: false };
        const e: Enemy = {
          role: 'chaser', sim, entry, wheelBase, wheelScale: spec.wheelR / SPECS.sedan.wheelR,
          active: false, alive: false, deadAt: 0,
          stats: { hp: 100, throttle: 0.7, accuracy: 0.4, burstGap: 3, shot: 5, ram: 1 },
          prevP: new THREE.Vector3(), currP: new THREE.Vector3(), prevQ: new THREE.Quaternion(), currQ: new THREE.Quaternion(),
          pos: new THREE.Vector3(), quat: new THREE.Quaternion(),
          stuck: 0, reverse: 0, reverseSteer: 1, detour: 0, detourGoal: new THREE.Vector3(), probeT: 0, path: null, pathKey: '', pathIdx: 0,
          lastSeen: new THREE.Vector3(), seen: false, orbit: 1, flipped: 0, anchor: new THREE.Vector3(), anchorT: 0, idle: 0,
          fireT: 0, burst: 0, shotT: 0,
          stun: 0, puncture: 0, slick: 0, blind: 0, tag: '', tagUntil: 0, ramCd: 0,
        };
        for (const c of sim.chassisColliders) this.byHandle.set(c.handle, e);
        this.list.push(e);
        wheelBase += 4;
      }
    }

    // one shared wheel, instanced 4× per car
    const wheel = buildCar(SPECS.sedan, { includeWheels: false }).wheel;
    for (const [geo, mat] of [[wheel.rubber, mats.rubber], [wheel.chrome, mats.chrome], [wheel.trim, mats.trim], [wheel.disc, mats.disc]] as const) {
      const mesh = new THREE.InstancedMesh(geo, mat, wheelBase);
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      for (let i = 0; i < wheelBase; i++) mesh.setMatrixAt(i, ZERO_SCALE);
      mesh.visible = false;
      scene.add(mesh);
      this.wheelMeshes.push(mesh);
    }
    for (const set of this.sets.values()) for (const mesh of set.meshes) mesh.visible = false;
  }

  /** Each pursuer model and the set that draws it (for their wreck shells). */
  models() {
    return [...this.sets].map(([model, set]) => ({ set, spec: SPECS[model] }));
  }

  /** Hide every pursuer mesh (action mode ended). */
  hideAll() {
    for (const set of this.sets.values()) for (const mesh of set.meshes) mesh.visible = false;
    for (const mesh of this.wheelMeshes) mesh.visible = false;
  }

  /** The pursuer whose chassis this collider belongs to. */
  byCollider(handle: number) {
    return this.byHandle.get(handle);
  }

  get alive() {
    return this.list.filter((e) => e.alive);
  }

  /** Bring a pooled car into the world. Returns null when none of that model is free. */
  spawn(role: Role, stats: EnemyStats, x: number, y: number, z: number, yaw: number) {
    const model = role === 'heavy' ? 'executive' : 'sedan';
    const e = this.list.find((c) => !c.active && c.entry.kind === model);
    if (!e) return null;
    Object.assign(e, {
      role, stats, active: true, alive: true, deadAt: 0, stuck: 0, reverse: 0, detour: 0, probeT: 0, path: null, pathKey: '', seen: false,
      orbit: Math.random() < 0.5 ? -1 : 1, flipped: 0, anchorT: 0, idle: 0, fireT: 1 + Math.random() * stats.burstGap, burst: 0, shotT: 0,
      stun: 0, puncture: 0, slick: 0, blind: 0, tag: '', tagUntil: 0, ramCd: 0,
    });
    e.sim.body.setEnabled(true);
    // a wreck was made light; put the real weight back
    e.sim.applyMass();
    if (model === 'executive') e.sim.body.setAdditionalMass(700, false);
    e.sim.reset(x, y, z, yaw);
    e.anchor.set(x, y, z);
    e.sim.grip = 1;
    e.entry.set.setColor(e.entry.index, PAINT);
    e.entry.set.setHidden(e.entry.index, false);
    this.capture(e);
    this.capture(e);
    return e;
  }

  /** Back to the pool: hidden, parked out of the world. */
  release(e: Enemy) {
    e.active = false;
    e.alive = false;
    e.sim.reset(PARK.x, PARK.y, PARK.z, 0);
    e.sim.body.setEnabled(false);
    e.entry.set.setHidden(e.entry.index, true);
    for (const mesh of this.wheelMeshes) {
      for (let k = 0; k < 4; k++) mesh.setMatrixAt(e.wheelBase + k, ZERO_SCALE);
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** Mark a car as messed up by a trap, so a kill in the next few seconds is credited to it. */
  tagged(e: Enemy, name: string, time: number, hold = 5) {
    e.tag = name;
    e.tagUntil = time + hold;
  }

  // ------------------------------------------------------------- per physics step
  step(dt: number, ctx: FleetContext) {
    for (const e of this.list) {
      if (!e.active) continue;
      if (!e.alive) {
        // a wreck rolls to a stop on its own suspension
        e.sim.drive(dt, { steer: 0, throttle: 0, handbrake: true });
        continue;
      }
      e.stun = Math.max(0, e.stun - dt);
      e.puncture = Math.max(0, e.puncture - dt);
      e.slick = Math.max(0, e.slick - dt);
      e.blind = Math.max(0, e.blind - dt);
      e.ramCd = Math.max(0, e.ramCd - dt);
      e.sim.grip = e.slick > 0 ? 0.14 : e.puncture > 0 ? 0.5 : 1;
      e.sim.drive(dt, e.stun > 0 ? { steer: 0, throttle: 0, handbrake: false } : this.think(e, dt, ctx));
    }
  }

  /** Save post-step poses for interpolation. */
  captureAll() {
    for (const e of this.list) if (e.active) this.capture(e);
  }

  private capture(e: Enemy) {
    e.prevP.copy(e.currP);
    e.prevQ.copy(e.currQ);
    const t = e.sim.body.translation();
    const r = e.sim.body.rotation();
    e.currP.set(t.x, t.y, t.z);
    e.currQ.set(r.x, r.y, r.z, r.w);
  }

  /** Where to drive and how hard. */
  private think(e: Enemy, dt: number, ctx: FleetContext): DriveInput {
    const body = e.sim.body;
    const t = body.translation();
    const me = tmpV.set(t.x, t.y, t.z);
    const speed = e.sim.forwardSpeed();

    // can we see the player? (smoke hides them; the last sighting is chased instead)
    const blind = e.blind > 0 || ctx.inSmoke(me);
    const visible = ctx.playerAlive && !blind && !ctx.smokeBetween(me, ctx.player);
    if (visible || !e.seen) {
      e.lastSeen.copy(ctx.player);
      e.seen = true;
    }
    const goal = tmpV2.copy(visible ? ctx.player : e.lastSeen);
    const dist = goal.distanceTo(me);

    // different decks of the car park: follow the ramps instead
    const myLevel = levelOf(me);
    const want = levelOf(goal);
    let routed = false;
    if (myLevel !== want) {
      const key = `${myLevel}>${want}`;
      if (e.pathKey !== key || !e.path) {
        e.pathKey = key;
        e.path = myLevel < want ? UP_ROUTES[myLevel] : [...UP_ROUTES[myLevel - 1]].reverse();
        e.pathIdx = nearestStart(e.path, me);
      }
      while (e.pathIdx < e.path.length && flatDist(e.path[e.pathIdx], me) < 4.5) e.pathIdx++;
      if (e.pathIdx < e.path.length) {
        goal.copy(e.path[e.pathIdx]);
        routed = true;
      }
    } else e.path = null;

    // getting round something: head for the clear spot first
    if (e.detour > 0) {
      e.detour -= dt;
      if (flatDist(e.detourGoal, me) < 4) e.detour = 0;
      else {
        goal.copy(e.detourGoal);
        routed = true;
      }
    }

    if (!routed) {
      if (!ctx.playerAlive) {
        // circle the wreck like vultures
        const a = ctx.time * 0.4 * e.orbit + e.wheelBase;
        goal.set(ctx.player.x + Math.cos(a) * 14, goal.y, ctx.player.z + Math.sin(a) * 14);
      } else if (visible) {
        // lead the target; gunners hold off to one side instead of ramming
        const lead = Math.min(1.1, dist / 28);
        goal.addScaledVector(ctx.playerVel, lead);
        if (e.role === 'gunner' && dist < 30) {
          const side = tmpQ.setFromAxisAngle(Y, (e.orbit * Math.PI) / 2);
          const away = me.clone().sub(ctx.player).setY(0).normalize().applyQuaternion(side);
          goal.copy(ctx.player).addScaledVector(away, 16);
        }
      }
    }

    // a wall, ramp side or parked car dead ahead (and the goal beyond it): plan a way round
    e.probeT -= dt;
    if (e.probeT <= 0 && e.detour <= 0 && e.reverse <= 0) {
      e.probeT = 0.25;
      const toGoal = goal.clone().sub(me).setY(0);
      const goalDist = toGoal.length();
      const q = body.rotation();
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w)).setY(0).normalize();
      const probe = Math.min(goalDist - 2, 6 + Math.abs(speed) * 0.6);
      if (probe > 2 && toGoal.normalize().dot(fwd) > 0.5 && this.clearance(me, fwd, probe, body) < probe) this.planDetour(e, me, toGoal);
    }

    // goal in car space (+x = the car's left)
    const r = body.rotation();
    tmpQ.set(-r.x, -r.y, -r.z, r.w);
    const local = goal.sub(me).applyQuaternion(tmpQ);
    const angle = Math.atan2(local.x, local.z);
    let steer = THREE.MathUtils.clamp(-angle * 2.1, -1, 1);
    let throttle = e.stats.throttle;
    // catch up from far away; slow down for hairpins
    if (dist > 70 && !routed) throttle = 1;
    if (Math.abs(angle) > 1.0 && speed > 13) throttle = 0.15;
    if (routed && Math.abs(angle) > 0.6 && speed > 9) throttle = 0.2;
    if (e.role === 'gunner' && visible && dist < 13) throttle = Math.min(throttle, 0.35);
    // turn around on the spot when the target is close behind
    if (!routed && Math.abs(angle) > 2.3 && dist < 14 && speed < 6) {
      throttle = -0.8;
      steer = angle > 0 ? 1 : -1;
    }
    // lost in smoke: swerving about
    if (blind) {
      steer = THREE.MathUtils.clamp(steer + Math.sin(ctx.time * 3.1 + e.wheelBase) * 0.8, -1, 1);
      throttle *= 0.75;
    }
    // shredded tyres: the steering wanders
    if (e.puncture > 0) {
      steer = THREE.MathUtils.clamp(steer + Math.sin(ctx.time * 13 + e.wheelBase) * 0.35, -1, 1);
      throttle = Math.min(throttle, 0.45);
    }

    // stuck against something: back off with the wheels turned the other way
    if (e.reverse > 0) {
      e.reverse -= dt;
      return { steer: e.reverseSteer, throttle: -0.85, handbrake: false };
    }
    if (throttle > 0.3 && Math.abs(speed) < 1.2) e.stuck += dt;
    else e.stuck = Math.max(0, e.stuck - dt * 2);
    if (e.stuck > 1.3) {
      e.stuck = 0;
      e.reverse = 1.1 + Math.random() * 0.5;
      e.reverseSteer = steer >= 0 ? -1 : 1;
      // and once backed off, go round rather than straight back into it
      this.planDetour(e, me, ctx.player.clone().sub(me).setY(0).normalize(), 1.2);
    }
    return { steer, throttle, handbrake: false };
  }

  /** Free distance from p along dir (ignores floors and ramp surfaces). */
  private clearance(p: THREE.Vector3, dir: THREE.Vector3, range: number, self: RAPIER.RigidBody) {
    const hit = this.phys.world.castRayAndGetNormal(
      new RAPIER.Ray({ x: p.x, y: p.y + 0.1, z: p.z }, { x: dir.x, y: 0, z: dir.z }), range, true, undefined, OBSTACLE_GROUPS, undefined, self,
    );
    return !hit || hit.normal.y > 0.5 ? range : hit.timeOfImpact;
  }

  /** Pick the open direction that best keeps heading toward the goal, and drive to a point along it. */
  private planDetour(e: Enemy, me: THREE.Vector3, goalDir: THREE.Vector3, delay = 0) {
    let best = -Infinity;
    const dir = new THREE.Vector3();
    const pick = new THREE.Vector3();
    let reach = 0;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      dir.set(Math.sin(a), 0, Math.cos(a));
      const free = this.clearance(me, dir, 22, e.sim.body);
      const score = Math.min(free, 18) + dir.dot(goalDir) * 9;
      if (free > 6 && score > best) {
        best = score;
        pick.copy(dir);
        reach = free;
      }
    }
    if (best === -Infinity) return;
    e.detourGoal.copy(me).addScaledVector(pick, Math.min(reach - 3, 14));
    e.detour = 3 + delay;
  }

  // ------------------------------------------------------------- per frame
  /** Put a live pursuer somewhere else (it got itself wedged in): it rejoins the chase from there. */
  relocate(e: Enemy, x: number, z: number, yaw: number, y = 0) {
    e.sim.reset(x, y, z, yaw);
    e.anchor.set(x, y, z);
    e.anchorT = e.idle = e.stuck = e.reverse = e.detour = 0;
    e.path = null;
    this.capture(e);
    this.capture(e);
  }

  /**
   * Guns, flip checks. Only the player's weapons and traps destroy a pursuer: one that rolls over
   * is put back on its wheels where it lies, and `lost` collects ones that fell out of the world
   * or have been wedged somewhere for a long time.
   */
  update(dt: number, ctx: FleetContext, lost: Enemy[]) {
    for (const e of this.list) {
      if (!e.alive) continue;
      const t = e.sim.body.translation();
      e.anchorT += dt;
      if (e.anchorT > 4) {
        const moved = Math.hypot(t.x - e.anchor.x, t.z - e.anchor.z);
        e.idle = moved < 5 && e.stun <= 0 ? e.idle + e.anchorT : 0;
        e.anchorT = 0;
        e.anchor.set(t.x, t.y, t.z);
        // (a gunner holding position near the player is busy, not lost)
        if (e.idle >= 12 && Math.hypot(t.x - ctx.player.x, t.z - ctx.player.z) > 30) lost.push(e);
      }
      if (t.y < -10) {
        lost.push(e);
        continue;
      }
      if (e.sim.upright() < 0.3) {
        e.flipped += dt;
        if (e.flipped > 2.5) {
          e.flipped = 0;
          this.relocate(e, t.x, t.z, e.sim.yaw(), t.y - 0.4);
        }
      } else e.flipped = 0;
      if (e.role !== 'chaser' && ctx.playerAlive) this.gun(e, dt, ctx);
    }
  }

  private gun(e: Enemy, dt: number, ctx: FleetContext) {
    e.fireT -= dt;
    if (e.burst <= 0) {
      if (e.fireT > 0) return;
      e.fireT = e.stats.burstGap * (0.8 + Math.random() * 0.4);
      e.burst = e.role === 'heavy' ? 7 : 5;
      e.shotT = 0;
    }
    e.shotT -= dt;
    if (e.shotT > 0) return;
    e.shotT = 0.09;
    e.burst--;
    if (e.stun > 0 || e.blind > 0) return;
    const body = e.sim.body;
    const t = body.translation();
    // a gunman leaning out of the window, on the side facing the player
    const from = new THREE.Vector3(t.x, t.y, t.z);
    const toPlayer = ctx.player.clone().sub(from);
    const dist = toPlayer.length();
    if (dist > 60 || ctx.inSmoke(from) || ctx.smokeBetween(from, ctx.player)) return;
    const r = body.rotation();
    const q = tmpQ.set(r.x, r.y, r.z, r.w);
    const localTo = toPlayer.clone().applyQuaternion(q.clone().invert());
    if (localTo.z < -2) return; // can't shoot straight backwards
    from.add(new THREE.Vector3(localTo.x > 0 ? 0.8 : -0.8, 0.75, 0.3).applyQuaternion(q));
    const aim = ctx.player.clone().add(new THREE.Vector3(0, 0.2, 0)).addScaledVector(ctx.playerVel, dist / 300);
    const dir = aim.sub(from).normalize();
    // spread: worse at range, against a fast target, or from a moving car
    const spread = (1 - e.stats.accuracy) * 0.09 + ctx.playerVel.length() * 0.0016 + Math.abs(e.sim.forwardSpeed()) * 0.0012;
    dir.x += (Math.random() - 0.5) * spread * 2;
    dir.y += (Math.random() - 0.5) * spread;
    dir.z += (Math.random() - 0.5) * spread * 2;
    dir.normalize();
    const hit = this.phys.world.castRay(new RAPIER.Ray(from, dir), 80, true, undefined, SHOT_GROUPS, undefined, body);
    const end = from.clone().addScaledVector(dir, hit ? hit.timeOfImpact : 80);
    const struck = !!hit && hit.collider.parent()?.handle === ctx.playerBody.handle;
    this.hooks.shot(from, end, struck, e, dist);
  }

  /** Interpolated poses into the instanced meshes. */
  render(alpha: number) {
    // nothing of a model on the road: skip its draw calls (and shadow passes) entirely
    let any = false;
    for (const [model, set] of this.sets) {
      const on = this.list.some((e) => e.active && e.entry.kind === model);
      for (const mesh of set.meshes) mesh.visible = on;
      any ||= on;
    }
    for (const mesh of this.wheelMeshes) mesh.visible = any;
    for (const e of this.list) {
      if (!e.active) continue;
      e.pos.lerpVectors(e.prevP, e.currP, alpha);
      e.quat.slerpQuaternions(e.prevQ, e.currQ, alpha);
      e.entry.set.setPose(e.entry.index, e.pos, e.quat);
      const vc = e.sim.controller;
      for (let i = 0; i < 4; i++) {
        const c = vc.wheelChassisConnectionPointCs(i)!;
        const len = vc.wheelSuspensionLength(i) ?? TUNING.suspensionRest;
        const left = i % 2 === 0;
        const spin = vc.wheelRotation(i) ?? 0;
        this.wheelQ.copy(e.quat).multiply(tmpQ.setFromAxisAngle(Y, vc.wheelSteering(i) ?? 0));
        if (!left) this.wheelQ.multiply(flipQ);
        this.wheelQ.multiply(tmpQ.setFromAxisAngle(X, left ? spin : -spin));
        const p = tmpV.set(c.x, c.y - len, c.z).applyQuaternion(e.quat).add(e.pos);
        tmpM.compose(p, this.wheelQ, tmpV2.setScalar(e.wheelScale));
        for (const mesh of this.wheelMeshes) mesh.setMatrixAt(e.wheelBase + i, tmpM);
      }
    }
    for (const mesh of this.wheelMeshes) mesh.instanceMatrix.needsUpdate = true;
  }
}

const flatDist = (a: THREE.Vector3, b: THREE.Vector3) => Math.hypot(a.x - b.x, a.z - b.z);

/** Index to join a route at: the waypoint that minimises (distance to it + route left after it). */
function nearestStart(route: THREE.Vector3[], p: THREE.Vector3) {
  let best = 0;
  let bestCost = Infinity;
  for (let i = 0; i < route.length; i++) {
    let rest = 0;
    for (let k = i; k < route.length - 1; k++) rest += flatDist(route[k], route[k + 1]);
    const cost = flatDist(route[i], p) + rest;
    if (cost < bestCost) {
      bestCost = cost;
      best = i;
    }
  }
  return best;
}
