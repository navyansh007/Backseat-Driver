import * as THREE from 'three';
import { RAPIER, type Physics } from '../physics';
import { Streaks, type CombatFx } from '../combat/fx';
import type { Destruction } from '../combat/destruction';
import type { WreckFx } from '../combat/wreck';
import type { CarAudio } from '../audio';
import type { PlayerCar } from '../playerCar';
import type { Breakables } from '../world/breakables';
import type { Mover } from '../world/hedges';
import { SPECS } from '../models/carModel';
import { TRAP_KINDS, type ActionState, type TelemetryMsg, type TrapKind } from '../../shared/protocol';
import { Fleet, type Enemy, type EnemyStats, type FleetContext, type Role } from './enemies';
import { TRAP_SPECS, Traps, type TrapContext } from './traps';

/** Armour of the player's car. A first wave barely scratches it. */
export const MAX_HP = 1000;
const FIRST_BREAK = 4;
const BREAK = 7;
const REPAIR_ON_CLEAR = 0.3;
const KIT_HEAL = 160;
const KIT_LIFE = 25;
const POINTS: Record<Role, number> = { chaser: 100, gunner: 150, heavy: 300 };
const PLAYER_PAINT = new THREE.Color(0x5b636c);

/** Open asphalt inside the car park where a wave can roll in from. */
const SPAWNS: [number, number][] = [
  [-95, 80], [95, 80], [-60, 80], [60, 80], [0, 82], [-95, 36], [95, 36], [-60, 36], [60, 36],
  [-95, 8], [95, 8], [100, -20], [-80, -30], [-61, -85], [-85, -85], [72, -50], [0, -90],
];

export interface ActionUi {
  root: HTMLElement;
  wave: HTMLElement;
  hp: HTMLElement;
  hpText: HTMLElement;
  foes: HTMLElement;
  score: HTMLElement;
  feed: HTMLElement;
  banner: HTMLElement;
  bannerSub: HTMLElement;
  bannerTitle: HTMLElement;
  bannerNote: HTMLElement;
  traps: HTMLElement;
  threats: HTMLElement;
  vignette: HTMLElement;
  over: HTMLElement;
  overStats: HTMLElement;
}

export interface ActionHooks {
  /** the player's car was hit (0–1), for camera shake and phone haptics */
  hurt(power: number): void;
  /** wrecked: the run is over */
  wrecked(): void;
}

interface Kit { obj: THREE.Group; p: THREE.Vector3; born: number; active: boolean }

/**
 * Action mode: waves of black saloons hunt the player's car. Each wave is a little
 * bigger, faster, tougher and better armed than the last. The car has armour, guns,
 * missiles and five trap gadgets; wrecked pursuers sometimes drop a repair kit.
 */
export class ActionMode {
  readonly fleet: Fleet;
  readonly traps: Traps;
  state: ActionState | 'idle' = 'idle';
  wave = 0;
  hp = MAX_HP;
  score = 0;
  kills = 0;
  private time = 0;
  private breakLeft = 0;
  private queue: { role: Role; stats: EnemyStats; x: number; z: number; yaw: number }[] = [];
  private spawnT = 0;
  private tracers: Streaks;
  private kits: Kit[] = [];
  private feedLines: { el: HTMLElement; until: number }[] = [];
  private creditAt = new Map<string, number>();
  private vignette = 0;
  private bannerUntil = 0;
  private ricochetT = 0;
  private slots: { el: HTMLElement; pips: HTMLElement; kind: TrapKind }[] = [];
  private markers: HTMLElement[] = [];
  private playerVel = new THREE.Vector3();
  private fctx: FleetContext;
  private tctx: TrapContext;
  private best = 0;
  private frustum = new THREE.Frustum();
  private pm = new THREE.Matrix4();
  private v = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    private phys: Physics,
    private car: PlayerCar,
    private fx: CombatFx,
    private destruction: Destruction,
    private wreck: WreckFx,
    private audio: CarAudio,
    private ui: ActionUi,
    private hooks: ActionHooks,
  ) {
    this.tracers = new Streaks(scene, 80, 0xff7048);
    this.fleet = new Fleet(scene, phys, { shot: (from, to, player, e, dist) => this.onShot(from, to, player, e, dist) });
    this.traps = new Traps(scene, phys, fx, destruction, this.fleet, audio);
    this.fctx = {
      time: 0, player: car.position, playerVel: this.playerVel, playerBody: car.body, playerAlive: true,
      smokeBetween: (a, b) => this.traps.smokeBetween(a, b),
      inSmoke: (p) => this.traps.inSmoke(p),
    };
    this.tctx = {
      time: 0, car,
      hurtPlayer: (d) => this.damagePlayer(d, 0.05),
      credit: (_e, name) => this.credit(name),
    };
    try { this.best = Number(localStorage.getItem('tnd-best')) || 0; } catch { /* storage unavailable */ }

    // repair kits: a red toolbox on a glowing pad
    const red = new THREE.MeshStandardMaterial({ color: 0xd8342a, roughness: 0.4, metalness: 0.3 });
    const steel = new THREE.MeshStandardMaterial({ color: 0xd9dde1, roughness: 0.3, metalness: 0.9 });
    const glow = new THREE.MeshBasicMaterial({ color: 0x6dffa8, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const cross = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    for (let i = 0; i < 4; i++) {
      const obj = new THREE.Group();
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.36, 0.38), red);
      const handle = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.025, 6, 16, Math.PI), steel);
      handle.position.y = 0.18;
      const c1 = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.06, 0.002), cross);
      const c2 = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.22, 0.002), cross);
      c1.position.z = c2.position.z = 0.191;
      const back = c1.clone(), back2 = c2.clone();
      back.position.z = back2.position.z = -0.191;
      const spinner = new THREE.Group();
      spinner.add(box, handle, c1, c2, back, back2);
      spinner.position.y = 1;
      box.castShadow = true;
      const pad = new THREE.Mesh(new THREE.RingGeometry(0.6, 1.1, 32).rotateX(-Math.PI / 2), glow);
      pad.position.y = 0.04;
      obj.add(spinner, pad);
      obj.visible = false;
      scene.add(obj);
      this.kits.push({ obj, p: new THREE.Vector3(), born: 0, active: false });
    }

    // HUD trap tray and threat markers
    TRAP_KINDS.forEach((kind, i) => {
      const el = document.createElement('div');
      el.className = 'slot';
      el.innerHTML = `<kbd>${i + 1}</kbd><b>${TRAP_SPECS[kind].label}</b><span class="tp"></span><i class="cd"></i>`;
      ui.traps.append(el);
      this.slots.push({ el, pips: el.querySelector('.tp')!, kind });
    });
    for (let i = 0; i < this.fleet.list.length; i++) {
      const m = document.createElement('i');
      ui.threats.append(m);
      this.markers.push(m);
    }
  }

  get running() {
    return this.state !== 'idle';
  }

  get over() {
    return this.state === 'over';
  }

  // ------------------------------------------------------------------ session
  /** Start a fresh run: full armour, wave 1 after a short countdown. */
  begin() {
    this.clearWorld();
    this.state = 'break';
    this.wave = 0;
    this.hp = MAX_HP;
    this.score = 0;
    this.kills = 0;
    this.breakLeft = FIRST_BREAK;
    this.destruction.targets = 'transient';
    this.car.setShown(true);
    this.ui.over.classList.remove('show');
    this.banner('get ready', 'black saloons inbound', 'guns · missiles · traps (1–5)', FIRST_BREAK);
  }

  /** Leave action mode: every pursuer and trap goes away. */
  end() {
    this.clearWorld();
    this.fleet.hideAll();
    this.state = 'idle';
    this.destruction.targets = 'all';
    this.car.setShown(true);
    this.car.sim.grip = 1;
    this.ui.over.classList.remove('show');
    this.ui.banner.classList.remove('show');
  }

  /** After being wrecked: back to the start and go again. */
  restart(spawn: { x: number; y: number; z: number; yaw: number }) {
    this.car.reset(spawn.x, spawn.y, spawn.z, spawn.yaw);
    this.begin();
  }

  private clearWorld() {
    for (const e of this.fleet.list) {
      if (!e.active) continue;
      this.destruction.remove(e.sim.body);
      this.fleet.release(e);
    }
    this.queue.length = 0;
    this.traps.clear();
    this.traps.refill();
    for (const k of this.kits) k.active = k.obj.visible = false;
    for (const f of this.feedLines) f.el.remove();
    this.feedLines.length = 0;
    this.vignette = 0;
    for (const m of this.markers) m.className = '';
  }

  // ------------------------------------------------------------------ waves
  private startWave() {
    this.wave++;
    this.state = 'fight';
    const n = this.wave;
    const count = Math.min(10, 2 + n);
    const heavies = n >= 4 ? Math.min(4, Math.floor((n - 2) / 2)) : 0;
    const gunners = n >= 2 ? Math.min(count - heavies - 1, Math.ceil((n - 1) / 2)) : 0;
    const roles: Role[] = [
      ...Array<Role>(heavies).fill('heavy'),
      ...Array<Role>(gunners).fill('gunner'),
      ...Array<Role>(count - heavies - gunners).fill('chaser'),
    ];
    // roll in from the two or three entry points furthest from the player, in a staggered column
    const p = this.car.position;
    const spots = SPAWNS.map(([x, z]) => ({ x, z, d: Math.hypot(x - p.x, z - p.z) }))
      .filter((s) => s.d > 50)
      .sort((a, b) => b.d - a.d)
      .slice(0, count > 6 ? 3 : 2);
    if (!spots.length) spots.push({ x: SPAWNS[0][0], z: SPAWNS[0][1], d: 0 });
    this.queue = roles.map((role, i) => {
      const s = spots[i % spots.length];
      const k = Math.floor(i / spots.length);
      const yaw = Math.atan2(p.x - s.x, p.z - s.z);
      // each later car starts a little further back along the line of approach
      const bx = -Math.sin(yaw) * k * 7.5, bz = -Math.cos(yaw) * k * 7.5;
      return { role, stats: this.stats(n, role), x: s.x + bx, z: s.z + bz, yaw };
    });
    this.spawnT = 0;
    this.audio.siren();
    this.banner(`wave ${n}`, `${count} black saloon${count > 1 ? 's' : ''}`, describe(heavies, gunners), 3);
  }

  /** How tough each pursuer is on wave n. */
  private stats(n: number, role: Role): EnemyStats {
    const k = n - 1;
    return {
      hp: role === 'heavy' ? 240 + 25 * k : role === 'gunner' ? 80 + 10 * k : 90 + 12 * k,
      throttle: Math.min(0.95, 0.68 + 0.035 * k) - (role === 'heavy' ? 0.05 : 0),
      accuracy: Math.min(0.85, 0.35 + 0.05 * k),
      burstGap: Math.max(1.3, 3.2 - 0.17 * k),
      shot: 4 + 0.5 * k,
      ram: (1 + 0.07 * k) * (role === 'heavy' ? 1.5 : 1),
    };
  }

  private waveCleared() {
    this.state = 'break';
    this.breakLeft = BREAK;
    const bonus = 500 * this.wave;
    this.score += bonus;
    const before = this.hp;
    this.hp = Math.min(MAX_HP, this.hp + MAX_HP * REPAIR_ON_CLEAR);
    this.traps.refill();
    this.audio.chime(true);
    this.banner(`wave ${this.wave} cleared`, `+${bonus} · armour +${Math.round(((this.hp - before) / MAX_HP) * 100)}%`, 'traps restocked', BREAK - 1);
  }

  private banner(title: string, sub: string, note: string, seconds: number) {
    this.ui.bannerTitle.textContent = title;
    this.ui.bannerSub.textContent = sub;
    this.ui.bannerNote.textContent = note;
    this.ui.banner.classList.add('show');
    this.bannerUntil = this.time + seconds;
  }

  // ------------------------------------------------------------------ physics
  /** Before each physics step: drive the pursuers; let them smash through fences like the player does. */
  preStep(dt: number, breakables: Breakables) {
    if (!this.running) return;
    this.fctx.time = this.time;
    this.fctx.playerAlive = this.state !== 'over';
    const lv = this.car.body.linvel();
    this.playerVel.set(lv.x, lv.y, lv.z);
    this.fleet.step(dt, this.fctx);
    for (const e of this.fleet.list) if (e.alive) breakables.preStep(e.sim.body, e.sim.chassisColliders[0]);
  }

  postStep() {
    if (this.running) this.fleet.captureAll();
  }

  /** A contact-force event; true if it was the player and a pursuer trading paint. */
  onContact(ev: RAPIER.TempContactForceEvent, playerHandles: Set<number>) {
    if (!this.running) return false;
    const a = ev.collider1(), b = ev.collider2();
    const other = playerHandles.has(a) ? b : playerHandles.has(b) ? a : -1;
    if (other < 0) return false;
    const e = this.fleet.byCollider(other);
    if (!e || !e.alive) return false;
    if (e.ramCd > 0) return true;
    const base = THREE.MathUtils.clamp((ev.totalForceMagnitude() - 25000) / 9000, 0, 60);
    if (base < 2) return true;
    e.ramCd = 0.35;
    // whoever is moving faster deals more of the damage
    const ps = Math.abs(this.car.sim.forwardSpeed()), es = Math.abs(e.sim.forwardSpeed());
    const share = es / (ps + es + 0.1);
    // rams hurt only the player: pursuers go down to weapons and traps alone
    if (this.state !== 'over') this.damagePlayer(base * (0.3 + 0.6 * share) * e.stats.ram, base / 60);
    this.audio.impact(Math.min(1, base / 40));
    return true;
  }

  /** Any blast: traps react (oil catches, mines chain). */
  onExplosion(p: THREE.Vector3, scale: number) {
    if (this.running) this.traps.onExplosion(p, scale);
  }

  /** A blast reached the player's car. Your own missiles hurt less. */
  onPlayerBlast(damage: number) {
    if (this.running) this.damagePlayer(damage * 0.25, Math.min(1, damage / 120));
  }

  /** A player round hit something at p (it can light oil). */
  onGunHit(p: THREE.Vector3) {
    if (this.running) this.traps.ignite(p, 0.4);
  }

  trap(kind: TrapKind) {
    if (!this.running || this.state === 'over') return false;
    this.tctx.time = this.time;
    return this.traps.deploy(kind, this.tctx);
  }

  /** Pursuers ploughing through hedges. */
  movers(): Mover[] {
    return this.fleet.alive.map((e) => ({ body: e.sim.body, halfLength: 1.6, radius: 0.85, drag: false }));
  }

  // ------------------------------------------------------------------ damage
  private damagePlayer(amount: number, power: number) {
    if (this.state === 'idle' || this.state === 'over' || amount <= 0) return;
    this.hp -= amount;
    this.vignette = Math.min(1, this.vignette + 0.15 + amount / 60);
    if (power > 0.04) this.hooks.hurt(Math.min(1, power));
    if (this.hp <= 0) this.wrecked();
  }

  private wrecked() {
    this.hp = 0;
    this.state = 'over';
    const body = this.car.body;
    const t = body.translation();
    const r = body.rotation();
    const v = body.linvel();
    const spec = SPECS.executive;
    const pos = new THREE.Vector3(t.x, t.y - 0.6, t.z);
    this.wreck.carExplode(pos, new THREE.Quaternion(r.x, r.y, r.z, r.w), new THREE.Vector3(v.x, v.y, v.z), new THREE.Vector3(spec.W, spec.H, spec.L), PLAYER_PAINT, pos.y);
    this.fx.explosion(pos.clone().setY(pos.y + 0.8), 1.4);
    this.audio.explosion(0, 1.4);
    this.car.setShown(false);
    if (this.score > this.best) {
      this.best = this.score;
      try { localStorage.setItem('tnd-best', String(this.best)); } catch { /* ignore */ }
    }
    this.ui.overStats.innerHTML = `reached wave <b>${this.wave}</b> · <b>${this.kills}</b> wrecked · score <b>${this.score}</b><br><small>best ${this.best}</small>`;
    this.ui.over.classList.add('show');
    this.ui.banner.classList.remove('show');
    this.hooks.wrecked();
  }

  private killed(e: Enemy) {
    e.alive = false;
    e.deadAt = this.time;
    this.kills++;
    const trapped = e.tagUntil > this.time && e.tag;
    const pts = Math.round(POINTS[e.role] * (1 + 0.1 * (this.wave - 1)) * (trapped ? 1.5 : 1));
    this.score += pts;
    this.feed(`${trapped ? e.tag : e.role === 'heavy' ? 'heavy down' : 'wrecked'} +${pts}`, trapped ? 'trap' : '');
    // sometimes they leave something useful behind
    if (Math.random() < (e.role === 'heavy' ? 0.7 : 0.28)) this.dropKit(e.pos.clone());
  }

  /** A trap just got someone: a small line in the feed (at most every 1.5 s per trap). */
  private credit(name: string) {
    if ((this.creditAt.get(name) ?? -9) > this.time - 1.5) return;
    this.creditAt.set(name, this.time);
    this.feed(name.toLowerCase(), 'hit');
  }

  private feed(text: string, kind: string) {
    const el = document.createElement('div');
    el.className = `line ${kind}`;
    el.textContent = text;
    this.ui.feed.prepend(el);
    this.feedLines.unshift({ el, until: this.time + 2.4 });
    while (this.feedLines.length > 4) this.feedLines.pop()!.el.remove();
  }

  private onShot(from: THREE.Vector3, to: THREE.Vector3, player: boolean, e: Enemy, dist: number) {
    const dir = to.clone().sub(from).normalize();
    this.tracers.tracer(from.clone().addScaledVector(dir, 0.8), to, 0.04, 0.07);
    this.fx.fire.emit(from, dir.clone().multiplyScalar(3), { life: 0.05, size: 0.35, grow: 1.3, color: 0xfff0c0, color2: 0xff7a2a, alpha: 1 });
    this.audio.enemyShot(dist);
    if (player) {
      this.fx.impactSparks(to, dir.clone().negate(), 3);
      this.damagePlayer(e.stats.shot, 0.06);
      if (this.time > this.ricochetT) {
        this.ricochetT = this.time + 0.12;
        this.audio.ricochet();
      }
    } else if (Math.random() < 0.4) this.fx.impactSparks(to, dir.clone().negate(), 2);
  }

  private tow(e: Enemy, camera: THREE.Camera) {
    camera.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(this.pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const p = this.car.position;
    const spot = SPAWNS
      .map(([x, z]) => ({ x, z, d: Math.hypot(x - p.x, z - p.z) }))
      .filter((s) => s.d > 40 && !this.frustum.containsPoint(this.v.set(s.x, 1, s.z)))
      .sort((a, b) => a.d - b.d)[0];
    if (!spot) return;
    this.fleet.relocate(e, spot.x, spot.z, Math.atan2(p.x - spot.x, p.z - spot.z));
  }

  private dropKit(p: THREE.Vector3) {
    const k = this.kits.find((x) => !x.active) ?? this.kits.reduce((a, b) => (a.born <= b.born ? a : b));
    k.active = true;
    k.born = this.time;
    k.p.copy(p);
    const hit = this.phys.world.castRay(new RAPIER.Ray({ x: p.x, y: p.y + 1, z: p.z }, { x: 0, y: -1, z: 0 }), 12, true, RAPIER.QueryFilterFlags.ONLY_FIXED);
    k.p.y = hit ? p.y + 1 - hit.timeOfImpact : 0;
    k.obj.position.copy(k.p);
    k.obj.visible = true;
  }

  // ------------------------------------------------------------------ frame
  /** dt: game time (slows during stunts); real: wall-clock time, for the HUD. */
  update(dt: number, real: number, camera: THREE.Camera) {
    if (!this.running) return;
    this.time += dt;
    this.tctx.time = this.time;
    this.traps.update(dt, this.tctx);
    this.car.sim.grip = this.state === 'over' ? 1 : this.traps.playerGrip;

    // pursuers that fell out of the world, or have been wedged somewhere for ages,
    // are towed to an entry point out of sight
    const lost: Enemy[] = [];
    this.fleet.update(dt, this.fctx, lost);
    for (const e of lost) this.tow(e, camera);
    // wrecks are towed away a while later
    for (const e of this.fleet.list) {
      if (e.active && !e.alive && this.time - e.deadAt > 9) {
        this.destruction.remove(e.sim.body);
        this.fleet.release(e);
      }
    }

    // spawning, wave end, the break between waves
    if (this.state === 'fight') {
      this.spawnT -= dt;
      while (this.queue.length && this.spawnT <= 0) {
        const q = this.queue.shift()!;
        const e = this.fleet.spawn(q.role, q.stats, q.x, 0, q.z, q.yaw);
        if (e) this.destruction.addTransient(e.entry, q.stats.hp, () => this.killed(e));
        this.spawnT = 0.45;
      }
      if (!this.queue.length && !this.fleet.list.some((e) => e.alive)) this.waveCleared();
    } else if (this.state === 'break') {
      this.breakLeft -= dt;
      if (this.breakLeft <= 0) this.startWave();
    }

    // repair kits
    const cp = this.car.position;
    for (const k of this.kits) {
      if (!k.active) continue;
      const age = this.time - k.born;
      const spinner = k.obj.children[0];
      spinner.rotation.y += real * 2;
      spinner.position.y = 1 + Math.sin(age * 3) * 0.15;
      k.obj.visible = age < KIT_LIFE - 5 || Math.floor(age * 6) % 2 === 0;
      if (age > KIT_LIFE) k.active = k.obj.visible = false;
      else if (this.state !== 'over' && k.p.distanceTo(cp) < 3.2) {
        k.active = k.obj.visible = false;
        const heal = Math.min(KIT_HEAL, MAX_HP - this.hp);
        this.hp += heal;
        this.audio.chime();
        this.feed(`repair +${Math.round((heal / MAX_HP) * 100)}%`, 'heal');
      }
    }

    this.hud(real, camera);
  }

  /** Interpolated pursuer poses (call after the physics steps). */
  render(alpha: number) {
    if (this.running) this.fleet.render(alpha);
  }

  // ------------------------------------------------------------------ hud
  private hud(real: number, camera: THREE.Camera) {
    const ui = this.ui;
    const alive = this.fleet.list.filter((e) => e.alive).length + this.queue.length;
    ui.wave.textContent = this.wave ? `wave ${this.wave}` : 'wave —';
    const hpK = Math.max(0, this.hp / MAX_HP);
    ui.hp.style.width = `${hpK * 100}%`;
    ui.hp.parentElement!.classList.toggle('low', hpK < 0.3);
    ui.hpText.textContent = `${Math.ceil(hpK * 100)}%`;
    ui.foes.textContent = this.state === 'break' ? `next wave ${Math.ceil(Math.max(0, this.breakLeft))}` : `${alive} hostile`;
    ui.score.textContent = String(this.score);
    if (this.time > this.bannerUntil) ui.banner.classList.remove('show');
    this.vignette = Math.max(0, this.vignette - real * 1.6);
    ui.vignette.style.opacity = String(Math.max(this.vignette, hpK < 0.25 && this.state !== 'over' ? 0.25 + Math.sin(this.time * 6) * 0.12 : 0));
    for (let i = this.feedLines.length - 1; i >= 0; i--) {
      if (this.feedLines[i].until < this.time) {
        this.feedLines[i].el.remove();
        this.feedLines.splice(i, 1);
      }
    }
    for (const s of this.slots) {
      const n = this.traps.charges[s.kind];
      const max = TRAP_SPECS[s.kind].max;
      s.el.classList.toggle('empty', n === 0);
      s.el.style.setProperty('--k', String(n >= max ? 1 : this.traps.progress[s.kind]));
      const pips = '<i class="on"></i>'.repeat(n) + '<i></i>'.repeat(max - n);
      if (s.pips.innerHTML !== pips) s.pips.innerHTML = pips;
    }

    // threat markers: a bracket over each pursuer, or an arrow at the screen edge
    const w = innerWidth, h = innerHeight;
    camera.updateMatrixWorld();
    const camFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    let mi = 0;
    for (const e of this.fleet.list) {
      if (!e.alive) continue;
      const m = this.markers[mi++];
      const p = e.pos.clone().setY(e.pos.y + 1.4);
      const behind = p.clone().sub(camera.position).dot(camFwd) < 0;
      const ndc = p.project(camera);
      let x = ndc.x, y = ndc.y;
      if (behind) {
        x = -x;
        y = -y;
      }
      const on = !behind && Math.abs(x) < 0.95 && Math.abs(y) < 0.95;
      const kind = e.role === 'heavy' ? ' heavy' : '';
      if (on) {
        m.className = `mark${kind}${e.stun > 0 ? ' stun' : ''}`;
        m.style.transform = `translate(${((x + 1) / 2) * w}px, ${((1 - y) / 2) * h}px) translate(-50%, -100%)`;
      } else {
        const a = Math.atan2(y, x);
        const ex = Math.cos(a), ey = Math.sin(a);
        const k = Math.min(0.92 / Math.abs(ex || 1e-6), 0.86 / Math.abs(ey || 1e-6));
        m.className = `edge${kind}`;
        m.style.transform = `translate(${((ex * k + 1) / 2) * w}px, ${((1 - ey * k) / 2) * h}px) translate(-50%, -50%) rotate(${-a}rad)`;
      }
    }
    for (; mi < this.markers.length; mi++) this.markers[mi].className = '';
  }

  /** Action-mode fields for the phone's telemetry. */
  telemetry(): Partial<TelemetryMsg> {
    const p = this.car.position;
    const yaw = this.car.sim.yaw();
    const rad: number[] = [];
    for (const e of this.fleet.list) {
      if (!e.alive) continue;
      const dx = e.pos.x - p.x, dz = e.pos.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > 140) continue;
      let a = -(Math.atan2(dx, dz) - yaw); // + = to the right
      a = Math.atan2(Math.sin(a), Math.cos(a));
      rad.push(Math.round(THREE.MathUtils.radToDeg(a)), Math.round(d));
    }
    const snap = this.traps.snapshot();
    return {
      hp: +(Math.max(0, this.hp) / MAX_HP).toFixed(3),
      wave: this.wave,
      foes: this.fleet.list.filter((e) => e.alive).length + this.queue.length,
      st: this.state === 'idle' ? 'break' : this.state,
      next: this.state === 'break' ? Math.ceil(Math.max(0, this.breakLeft)) : undefined,
      score: this.score,
      tc: snap.map((s) => s.n),
      tk: snap.map((s) => +s.k.toFixed(2)),
      rad,
    };
  }
}

function describe(heavies: number, gunners: number) {
  const bits: string[] = [];
  if (gunners) bits.push(`${gunners} with gunmen`);
  if (heavies) bits.push(`${heavies} armoured`);
  return bits.length ? bits.join(' · ') : 'rammers · stay moving';
}
