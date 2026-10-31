import * as THREE from 'three';
import { RAPIER, type Physics } from '../physics';
import type { PlayerCar } from '../playerCar';
import type { CombatFx } from '../combat/fx';
import type { WreckFx } from '../combat/wreck';
import type { CarAudio } from '../audio';
import type { Destruction } from '../combat/destruction';
import { LOT } from '../world/lot';
import { carInfo } from '../../shared/cars';
import type { TelemetryMsg } from '../../shared/protocol';
import {
  ARENA_HP, MATCH_MINUTES, RESPAWN_MS, SHIELD_MS, rank, type PlayerInfo, type ServerMsg,
} from '../../shared/arena';
import { ArenaClient, type ArenaError } from './client';
import { Rivals } from './rivals';

export interface ArenaUi {
  /** title screen: the join form and the lobby */
  join: HTMLElement;
  lobby: HTMLElement;
  code: HTMLInputElement;
  note: HTMLElement;
  room: HTMLElement;
  players: HTMLElement;
  host: HTMLElement;
  minutes: HTMLElement;
  wait: HTMLElement;
  /** in the arena */
  clock: HTMLElement;
  hp: HTMLElement;
  hpText: HTMLElement;
  place: HTMLElement;
  points: HTMLElement;
  board: HTMLElement;
  feed: HTMLElement;
  banner: HTMLElement;
  bannerSub: HTMLElement;
  bannerTitle: HTMLElement;
  bannerNote: HTMLElement;
  vignette: HTMLElement;
  results: HTMLElement;
  resultsTitle: HTMLElement;
  resultsTable: HTMLElement;
  resultsHost: HTMLElement;
  resultsWait: HTMLElement;
}

export interface ArenaHooks {
  /** the match is on: leave the title screen and drive */
  enter(): void;
  /** back to the title screen (the lobby, or the join form after leaving) */
  exit(): void;
  hurt(power: number): void;
  wrecked(): void;
  toast(text: string, ms?: number): void;
  /** new cars joined: warm up their shaders before they're needed */
  compile(): void;
}

type Spawn = { x: number; y: number; z: number; yaw: number };
const POSE_EVERY = 1 / 20;
const HITS_EVERY = 0.1;
const SPAWN_RETRY_MS = 1000;
const ERRORS: Record<ArenaError, string> = {
  full: 'that arena is full (8 drivers)',
  name: 'pick a name of 2–16 letters or numbers first',
  version: 'that arena is running a newer version: reload the page',
  bad: 'could not join that arena',
  lost: 'lost the connection to the arena',
};

/**
 * Online arena: every player drives their own car in the same car park, wrecking each other for
 * points until the clock runs out. The arena server keeps the score; this side drives our car,
 * streams its pose, shows everyone else's, reports our hits and handles our wreck and respawn.
 */
export class ArenaMode {
  client: ArenaClient | null = null;
  readonly rivals: Rivals;
  hp = ARENA_HP;
  /** driving in a match (the title screen is gone) */
  inMatch = false;
  private alive = false;
  private wreckedAt = 0;
  private wreckedBy = '';
  private spawnAskedAt = 0;
  private shieldUntil = 0;
  private poseT = 0;
  private hitsT = 0;
  private hits = new Map<string, number>();
  private spawns: Spawn[] | null = null;
  private vignette = 0;
  private minutes: number = MATCH_MINUTES[1];
  private boardKey = '';
  private lobbyKey = '';
  private results: { winner: string | null; players: PlayerInfo[] } | null = null;

  constructor(
    scene: THREE.Scene,
    private phys: Physics,
    private car: PlayerCar,
    private fx: CombatFx,
    private wreck: WreckFx,
    private audio: CarAudio,
    private destruction: Destruction,
    private ui: ArenaUi,
    private hooks: ArenaHooks,
  ) {
    this.rivals = new Rivals(phys, scene, fx, destruction, wreck);
    ui.minutes.innerHTML = MATCH_MINUTES.map((m) => `<button data-min="${m}">${m} min</button>`).join('');
    for (const b of Array.from(ui.minutes.children) as HTMLElement[]) {
      b.addEventListener('click', () => {
        this.minutes = Number(b.dataset.min);
        this.renderLobby(true);
      });
    }
  }

  /** Connected to an arena (in its lobby or its match). */
  get active() {
    return this.client !== null;
  }

  /** In a match but not allowed to drive: the countdown, wrecked, or the match is over. */
  get frozen() {
    const room = this.client?.room;
    if (!this.inMatch || !room) return false;
    return room.phase !== 'play' || this.client!.now() < room.startsAt || !this.alive;
  }

  get wrecked() {
    return this.inMatch && !this.alive;
  }

  // ------------------------------------------------------------------ joining
  /** Join the arena with this code (or open a new one) as `name`, driving `car`. */
  join(code: string | null, name: string, car: string) {
    this.leave(false);
    const client = new ArenaClient(code ?? ArenaClient.newCode(), { name, car });
    this.client = client;
    this.ui.note.textContent = 'joining…';
    client.onMessage = (msg) => this.onMessage(msg);
    client.onError = (reason) => {
      this.hooks.toast(ERRORS[reason], 4000);
      this.ui.note.textContent = ERRORS[reason];
      this.leave();
    };
    client.onStatus = (online) => {
      if (!online) this.hooks.toast('connection lost · reconnecting…', 3000);
    };
    this.renderLobby(true);
  }

  /** Leave the arena (and go back to the join form). */
  leave(notify = true) {
    if (!this.client) return;
    this.client.leave();
    this.client = null;
    this.rivals.clear();
    this.destruction.targets = 'all';
    const was = this.inMatch;
    this.inMatch = false;
    this.alive = false;
    this.results = null;
    this.ui.results.classList.remove('show');
    this.ui.banner.classList.remove('show');
    this.car.setWrecked(false);
    this.renderLobby(true);
    if (notify || was) this.hooks.exit();
  }

  /** The car we'll drive (only taken outside a match). */
  setCar(id: string) {
    this.client?.setCar(id);
  }

  start() {
    if (this.client?.isHost) this.client.send({ t: 'start', minutes: this.minutes });
  }

  backToLobby() {
    if (this.client?.isHost) this.client.send({ t: 'lobby' });
  }

  /** A share link that opens the game straight into this arena. */
  shareLink() {
    return this.client ? `${location.origin}${location.pathname}?arena=${this.client.code}` : '';
  }

  // ------------------------------------------------------------------ messages
  private name(id: string | null) {
    if (!id) return 'the car park';
    if (id === this.client?.id) return 'you';
    return this.client?.room?.players.find((p) => p.id === id)?.name ?? 'someone';
  }

  private onMessage(msg: ServerMsg) {
    const client = this.client!;
    switch (msg.t) {
      case 'welcome':
        this.ui.note.textContent = '';
        break;
      case 'room': {
        if (msg.phase === 'play' && !this.inMatch) this.enterMatch();
        else if (msg.phase === 'lobby' && this.inMatch) this.exitMatch();
        const others = msg.players.filter((p) => p.id !== client.id);
        const before = this.rivals.list.size;
        this.rivals.sync(others, this.inMatch, (id, amount) => this.queueHit(id, amount));
        if (this.rivals.list.size > before) this.hooks.compile();
        this.renderLobby();
        this.renderBoard();
        break;
      }
      case 'st':
        this.rivals.list.get(msg.from)?.push(msg);
        break;
      case 'fx': {
        const v = (a: number[]) => new THREE.Vector3(a[0], a[1], a[2]);
        const ok = (a: unknown) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
        if (msg.k === 'shot' ? !ok(msg.a) || !ok(msg.b) : msg.k === 'msl' ? !ok(msg.p) || !ok(msg.v) : !ok(msg.p)) break;
        const from = this.rivals.list.get(msg.from);
        const d = from ? from.position.distanceTo(this.car.position) : 50;
        if (msg.k === 'shot') {
          this.rivals.shot(v(msg.a), v(msg.b), msg.hit);
          this.audio.gunshot(Math.min(1, 1.4 / (1 + d / 12)));
        } else if (msg.k === 'msl') {
          const tgt = msg.tgt === client.id ? () => this.car.position : msg.tgt ? () => {
            const r = this.rivals.list.get(msg.tgt!);
            return r?.present ? r.position : null;
          } : null;
          this.rivals.launch(msg.from, v(msg.p), v(msg.v), tgt);
          this.audio.launch(Math.min(1, 1.4 / (1 + d / 15)));
        } else if (msg.k === 'boom') {
          this.rivals.boom(msg.from, v(msg.p));
        }
        break;
      }
      case 'dmg':
        if (msg.id === client.id) {
          const lost = this.hp - msg.hp;
          this.hp = msg.hp;
          if (lost > 0) {
            this.vignette = Math.min(1, this.vignette + 0.15 + lost / 60);
            this.hooks.hurt(Math.min(1, lost / 80));
          }
        }
        break;
      case 'wreck':
        if (msg.id === client.id) this.selfWrecked(msg.by);
        else {
          this.rivals.wreck(msg.id);
          const r = this.rivals.list.get(msg.id);
          if (r) this.audio.explosion(r.position.distanceTo(this.car.position), 1.4);
        }
        if (msg.by === client.id) {
          this.feed(`you wrecked ${this.name(msg.id)} +100`, 'mine');
          this.audio.chime();
        } else if (msg.id !== client.id) this.feed(`${this.name(msg.by)} wrecked ${this.name(msg.id)}`, '');
        break;
      case 'spawn':
        if (msg.id === client.id) this.respawn(msg.shieldUntil);
        else this.rivals.list.get(msg.id)?.spawn();
        break;
      case 'end':
        this.results = { winner: msg.winner, players: msg.players };
        this.showResults();
        break;
    }
  }

  private enterMatch() {
    this.inMatch = true;
    this.results = null;
    this.ui.results.classList.remove('show');
    this.destruction.targets = 'external';
    const me = this.client!.me();
    this.hp = ARENA_HP;
    this.shieldUntil = this.client!.room!.startsAt + SHIELD_MS;
    if (me?.alive) {
      // a fresh match: everyone starts alive, each at a spawn point of their own choosing
      this.alive = true;
      this.placeCar();
      this.car.setWrecked(false);
    } else {
      // joining a match already under way: ask for a car straight away
      this.alive = false;
      this.wreckedAt = 0;
      this.wreckedBy = '';
      this.spawnAskedAt = 0;
      this.car.setShown(false);
    }
    this.hooks.enter();
  }

  private exitMatch() {
    this.inMatch = false;
    this.alive = false;
    this.results = null;
    this.ui.results.classList.remove('show');
    this.ui.banner.classList.remove('show');
    this.car.setWrecked(false);
    this.destruction.targets = 'all';
    this.hooks.exit();
  }

  private selfWrecked(by: string | null) {
    if (!this.alive) return;
    this.alive = false;
    this.hp = 0;
    this.wreckedAt = performance.now();
    this.wreckedBy = this.name(by);
    this.spawnAskedAt = 0;
    const body = this.car.body;
    const t = body.translation();
    const r = body.rotation();
    const v = body.linvel();
    const spec = this.car.def.spec;
    const pos = new THREE.Vector3(t.x, t.y - 0.6, t.z);
    // the same blast as the solo game; the arena's wreck lives on in the shell until we respawn
    this.wreck.carExplode(
      pos, new THREE.Quaternion(r.x, r.y, r.z, r.w), new THREE.Vector3(v.x, v.y, v.z), new THREE.Vector3(spec.W, spec.H, spec.L), new THREE.Color(this.car.def.paint), pos.y,
    );
    this.fx.explosion(pos.clone().setY(pos.y + 0.8), 1.4);
    this.audio.explosion(0, 1.4);
    this.car.setWrecked(true);
    this.feed(`wrecked by ${this.wreckedBy}`, 'bad');
    this.hooks.wrecked();
  }

  private respawn(shieldUntil: number) {
    this.alive = true;
    this.hp = ARENA_HP;
    this.shieldUntil = shieldUntil;
    this.vignette = 0;
    this.placeCar();
    this.car.setWrecked(false);
    this.ui.banner.classList.remove('show');
  }

  private placeCar() {
    const s = this.spawnPoint();
    this.car.reset(s.x, s.y, s.z, s.yaw);
  }

  // ------------------------------------------------------------------ spawning
  /** Open ground spots in the lot, worked out once: clear of walls, ramps, roofs and parked cars. */
  private spawnSpots() {
    if (this.spawns) return this.spawns;
    const world = this.phys.world;
    const shape = new RAPIER.Cuboid(1.4, 0.8, 2.9);
    const rot = { x: 0, y: 0, z: 0, w: 1 };
    const out: Spawn[] = [];
    for (let x = LOT.x0 + 14; x <= LOT.x1 - 14; x += 9) {
      for (let z = LOT.z0 + 14; z <= LOT.z1 - 14; z += 9) {
        const hit = world.castRay(new RAPIER.Ray({ x, y: 40, z }, { x: 0, y: -1, z: 0 }), 60, true, RAPIER.QueryFilterFlags.ONLY_FIXED);
        if (!hit) continue;
        const y = 40 - hit.timeOfImpact;
        // open-air ground only: not on a roof, a ramp or inside the building
        if (y > 0.6) continue;
        if (world.intersectionWithShape({ x, y: y + 1, z }, rot, shape, undefined, undefined, undefined, this.car.body)) continue;
        out.push({ x, y, z, yaw: Math.atan2(-x, -z) });
      }
    }
    if (!out.length) out.push({ x: 6, y: 0, z: 46, yaw: Math.PI });
    return (this.spawns = out);
  }

  /** A spot to drop our car: well away from everyone else, with a little chance in it. */
  spawnPoint(): Spawn {
    const spots = this.spawnSpots();
    const others = [...this.rivals.list.values()].filter((r) => r.present).map((r) => r.position);
    let best = spots[0];
    let bestScore = -Infinity;
    for (const s of spots) {
      let near = 200;
      for (const o of others) near = Math.min(near, Math.hypot(o.x - s.x, o.z - s.z));
      const score = near + Math.random() * 25;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ our weapons
  private queueHit(id: string, amount: number) {
    if (!this.inMatch || !this.alive || amount <= 0) return;
    this.hits.set(id, (this.hits.get(id) ?? 0) + amount);
  }

  onShot(from: THREE.Vector3, to: THREE.Vector3, hit: boolean) {
    if (this.inMatch) this.client?.send({ t: 'fx', k: 'shot', a: vec(from), b: vec(to), hit });
  }

  onMissile(pos: THREE.Vector3, vel: THREE.Vector3, target: RAPIER.RigidBody | null) {
    if (this.inMatch) this.client?.send({ t: 'fx', k: 'msl', p: vec(pos), v: vec(vel), tgt: this.rivals.byBody(target)?.id ?? null });
  }

  onBoom(p: THREE.Vector3) {
    if (this.inMatch) this.client?.send({ t: 'fx', k: 'boom', p: vec(p) });
  }

  // ------------------------------------------------------------------ per frame
  preStep() {
    if (this.client) this.rivals.preStep();
  }

  update(dt: number) {
    const client = this.client;
    if (!client) return;
    this.rivals.update(dt);
    if (!this.inMatch) return;
    const room = client.room;
    const now = client.now();

    // stream our pose
    this.poseT += dt;
    if (this.poseT >= POSE_EVERY && this.alive) {
      this.poseT = 0;
      const b = this.car.body;
      const t = b.translation(), r = b.rotation(), v = b.linvel();
      client.send({
        t: 'st', p: [r3(t.x), r3(t.y), r3(t.z)], q: [r3(r.x), r3(r.y), r3(r.z), r3(r.w)], v: [r3(v.x), r3(v.y), r3(v.z)],
        w: r3(this.car.sim.forwardSpeed()), s: r3(this.car.sim.controller.wheelSteering(0) ?? 0), b: this.car.sim.braking,
      });
    }
    // report hits in small batches
    this.hitsT += dt;
    if (this.hitsT >= HITS_EVERY && this.hits.size) {
      this.hitsT = 0;
      for (const [to, dmg] of this.hits) client.send({ t: 'hit', to, dmg: Math.round(dmg * 10) / 10 });
      this.hits.clear();
    }
    // back in after the cooldown (the server checks the time too; keep asking until it agrees)
    if (!this.alive && room?.phase === 'play' && now >= room.startsAt) {
      const ready = this.wreckedAt === 0 || performance.now() - this.wreckedAt >= RESPAWN_MS;
      if (ready && performance.now() - this.spawnAskedAt > SPAWN_RETRY_MS) {
        this.spawnAskedAt = performance.now();
        client.send({ t: 'spawn' });
      }
    }
    this.hud(dt, now);
  }

  // ------------------------------------------------------------------ hud
  private hud(dt: number, now: number) {
    const ui = this.ui;
    const room = this.client!.room;
    if (!room) return;
    const left = room.phase === 'play' ? Math.max(0, room.endsAt - now) : 0;
    const secs = Math.ceil(left / 1000);
    ui.clock.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    ui.clock.classList.toggle('low', room.phase === 'play' && secs <= 30);
    const k = Math.max(0, this.hp / ARENA_HP);
    ui.hp.style.width = `${k * 100}%`;
    ui.hpText.textContent = this.alive && now < this.shieldUntil ? 'shielded' : `${Math.round(k * 100)}%`;
    ui.hp.parentElement!.classList.toggle('low', k < 0.3);
    const standings = rank(room.players);
    const mine = standings.findIndex((p) => p.id === this.client!.id);
    ui.place.textContent = mine >= 0 ? `${ordinal(mine + 1)} of ${standings.length}` : '—';
    ui.points.textContent = `${standings[mine]?.score ?? 0} pts`;

    // countdown, then respawn timer
    if (room.phase === 'play' && now < room.startsAt) {
      this.banner('get ready', String(Math.ceil((room.startsAt - now) / 1000)), `${room.minutes} minutes · most destruction points wins`);
    } else if (room.phase === 'play' && !this.alive) {
      const wait = this.wreckedAt ? Math.max(0, RESPAWN_MS - (performance.now() - this.wreckedAt)) : 0;
      this.banner(this.wreckedAt ? `wrecked by ${this.wreckedBy}` : 'joining the match', wait > 0 ? String(Math.ceil(wait / 1000)) : '…', 'back in the car park in a moment');
    } else ui.banner.classList.remove('show');

    this.vignette = Math.max(0, this.vignette - dt * 0.8);
    ui.vignette.style.opacity = String(this.vignette);
  }

  private banner(sub: string, title: string, note: string) {
    const ui = this.ui;
    if (ui.bannerTitle.textContent !== title) ui.bannerTitle.textContent = title;
    ui.bannerSub.textContent = sub;
    ui.bannerNote.textContent = note;
    ui.banner.classList.add('show');
  }

  private feed(text: string, kind: string) {
    const el = document.createElement('div');
    el.className = `line ${kind}`;
    el.textContent = text;
    this.ui.feed.prepend(el);
    while (this.ui.feed.children.length > 5) this.ui.feed.lastElementChild!.remove();
    setTimeout(() => el.remove(), 5000);
  }

  private renderBoard() {
    const room = this.client?.room;
    if (!room) return;
    const standings = rank(room.players);
    const key = standings.map((p) => `${p.id}${p.score}${p.alive}`).join();
    if (key === this.boardKey) return;
    this.boardKey = key;
    this.ui.board.innerHTML = standings
      .map((p, i) => `<li class="${p.id === this.client!.id ? 'me' : ''}${p.alive ? '' : ' down'}"><i>${i + 1}</i><span>${esc(p.name)}</span><b>${p.score}</b></li>`)
      .join('');
  }

  /** The title-screen side: the join form, or the lobby with its players and the host's start button. */
  renderLobby(force = false) {
    const ui = this.ui;
    const client = this.client;
    const room = client?.room;
    const inLobby = !!client && !!room;
    ui.join.classList.toggle('gone', inLobby);
    ui.lobby.classList.toggle('gone', !inLobby);
    if (!client || !room) return;
    const key = JSON.stringify([room.host, room.phase, this.minutes, room.players.map((p) => [p.id, p.name, p.car])]);
    if (key === this.lobbyKey && !force) return;
    this.lobbyKey = key;
    ui.room.textContent = client.code;
    ui.players.innerHTML = room.players
      .map((p) => {
        const car = carInfo(p.car);
        const tags = [p.id === room.host ? 'host' : '', p.id === client.id ? 'you' : ''].filter(Boolean).join(' · ');
        return `<li><span>${esc(p.name)}${tags ? ` <small>${tags}</small>` : ''}</span><em>${esc(car.maker)} ${esc(car.model)}</em></li>`;
      })
      .join('');
    const host = client.isHost;
    ui.host.classList.toggle('gone', !host);
    ui.wait.classList.toggle('gone', host);
    ui.wait.textContent = room.phase === 'play' ? 'a match is on · you will join it' : `waiting for ${this.name(room.host)} to start the match`;
    for (const b of Array.from(ui.minutes.children) as HTMLElement[]) b.classList.toggle('on', Number(b.dataset.min) === this.minutes);
  }

  private showResults() {
    const r = this.results;
    if (!r) return;
    const ui = this.ui;
    const me = this.client?.id;
    ui.resultsTitle.textContent = !r.winner ? 'no winner' : r.winner === me ? 'you win' : `${this.name(r.winner)} wins`;
    ui.resultsTable.innerHTML =
      '<tr><th></th><th>driver</th><th>car</th><th>wrecks</th><th>wrecked</th><th>points</th></tr>' +
      r.players
        .map((p, i) => `<tr class="${p.id === me ? 'me' : ''}"><td>${i + 1}</td><td>${esc(p.name)}</td><td>${esc(carInfo(p.car).short)}</td><td>${p.kills}</td><td>${p.deaths}</td><td><b>${p.score}</b></td></tr>`)
        .join('');
    const host = !!this.client?.isHost;
    ui.resultsHost.classList.toggle('gone', !host);
    ui.resultsWait.classList.toggle('gone', host);
    ui.results.classList.add('show');
    ui.banner.classList.remove('show');
  }

  /** What the phone shows in the arena. */
  telemetry(): Partial<TelemetryMsg> {
    const room = this.client?.room;
    if (!room || !this.inMatch) return {};
    const standings = rank(room.players);
    const back = this.alive ? 0 : this.wreckedAt ? Math.max(0, Math.ceil((RESPAWN_MS - (performance.now() - this.wreckedAt)) / 1000)) : 0;
    return {
      hp: +(Math.max(0, this.hp) / ARENA_HP).toFixed(3),
      place: standings.findIndex((p) => p.id === this.client!.id) + 1,
      of: standings.length,
      pts: standings.find((p) => p.id === this.client!.id)?.score ?? 0,
      back: this.alive ? undefined : back,
      left: room.phase === 'play' ? Math.max(0, Math.ceil((room.endsAt - this.client!.now()) / 1000)) : 0,
    };
  }
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const vec = (v: THREE.Vector3): [number, number, number] => [r3(v.x), r3(v.y), r3(v.z)];
const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
