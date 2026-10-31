/**
 * One multiplayer arena, shared by the Vite server (Node) and the Cloudflare Durable Object.
 * It owns the match: the players and their names, cars, armour, points and deaths, respawns and
 * the clock. Poses and effects from one player are passed on to the rest as they are; hits are
 * checked and applied here, so every screen agrees on who wrecked whom.
 */
import {
  ARENA_HP, ARENA_VERSION, COUNTDOWN_MS, DAMAGE_PER_POINT, KILL_POINTS, MATCH_MINUTES, MAX_HIT, MAX_PLAYERS, RESPAWN_MS, SHIELD_MS,
  cleanName, rank, type ClientMsg, type Phase, type PlayerInfo, type RoomMsg, type ServerMsg,
} from '../src/shared/arena';
import { CAR_IDS, DEFAULT_CAR } from '../src/shared/cars';
import { MAX_FRAME } from '../src/shared/protocol';
import { ROOM_RE } from './relayCore';

export interface Conn {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

interface Player extends PlayerInfo {
  conn: Conn | null;
  /** when the car was wrecked, when its spawn shield runs out, when the connection dropped */
  deadAt: number;
  shieldUntil: number;
  leftAt: number;
  /** damage dealt that hasn't made a whole point yet */
  carry: number;
}

/** How long a dropped player's place (and points) are kept for them to reconnect. */
const GRACE_MS = 15000;
/** Score changes are sent to everyone at most this often. */
const ROOM_EVERY_MS = 250;
const PEER_ID_RE = /^[0-9a-f]{8}$/;

export function parseArenaParams(rawUrl: string) {
  const url = new URL(rawUrl, 'http://local');
  const room = (url.searchParams.get('room') ?? '').toUpperCase();
  const id = url.searchParams.get('id') ?? '';
  if (!ROOM_RE.test(room) || !PEER_ID_RE.test(id)) return null;
  return { room, id };
}

export class ArenaRoom {
  private players = new Map<string, Player>();
  /** connections that haven't said hello yet, with the id they asked for */
  private pending = new Map<Conn, string>();
  private phase: Phase = 'lobby';
  private host = '';
  private minutes: number = MATCH_MINUTES[1];
  private startsAt = 0;
  private endsAt = 0;
  private dirty = false;
  private roomSentAt = 0;

  constructor(readonly code: string, private now: () => number = Date.now) {}

  /** Nobody connected, and nobody's place is being kept. */
  get empty() {
    return this.pending.size === 0 && this.players.size === 0;
  }

  join(conn: Conn, id: string) {
    this.pending.set(conn, id);
  }

  leave(conn: Conn) {
    if (this.pending.delete(conn)) return;
    const p = this.byConn(conn);
    if (!p) return;
    p.conn = null;
    // in a match, keep the car's place for a moment; in the lobby, just go
    if (this.phase === 'play') p.leftAt = this.now();
    else this.drop(p);
    this.tick();
  }

  message(conn: Conn, text: string) {
    if (text.length > MAX_FRAME) return;
    let msg: ClientMsg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'hello') this.hello(conn, msg);
    else {
      const p = this.byConn(conn);
      if (p) this.handle(p, msg);
    }
    this.tick();
  }

  /** Housekeeping: end the match on time, forget players who didn't come back, send score changes. Call often. */
  tick() {
    const now = this.now();
    if (this.phase === 'play' && now >= this.endsAt) this.finish();
    for (const p of this.players.values()) if (!p.conn && now - p.leftAt > GRACE_MS) this.drop(p);
    if (this.dirty && now - this.roomSentAt >= ROOM_EVERY_MS) this.sendRoom();
  }

  // ------------------------------------------------------------------ joining
  private hello(conn: Conn, msg: Extract<ClientMsg, { t: 'hello' }>) {
    const id = this.pending.get(conn);
    if (id === undefined) return;
    if (msg.v !== ARENA_VERSION) return this.refuse(conn, 'version');
    const name = cleanName(msg.name);
    if (!name) return this.refuse(conn, 'name');
    const car = CAR_IDS.includes(msg.car) ? msg.car : DEFAULT_CAR;
    this.pending.delete(conn);

    let p = this.players.get(id);
    if (p) {
      // the same tab coming back: take over its place, points and all
      p.conn?.close(4000, 'replaced');
      p.conn = conn;
      p.leftAt = 0;
    } else {
      if (this.players.size >= MAX_PLAYERS) return this.refuse(conn, 'full');
      p = {
        id, name: this.uniqueName(name), car, score: 0, kills: 0, deaths: 0, alive: false, hp: ARENA_HP, at: this.now(),
        conn, deadAt: 0, shieldUntil: 0, leftAt: 0, carry: 0,
      };
      this.players.set(id, p);
      if (!this.host) this.host = id;
    }
    this.send(p, { t: 'welcome', id, name: p.name, now: this.now(), room: this.code });
    this.sendRoom();
  }

  private refuse(conn: Conn, reason: Extract<ServerMsg, { t: 'error' }>['reason']) {
    this.pending.delete(conn);
    conn.send(JSON.stringify({ t: 'error', reason } satisfies ServerMsg));
    conn.close(4001, reason);
  }

  /** Two drivers can't share a name: the second one gets a number. */
  private uniqueName(name: string) {
    const taken = new Set([...this.players.values()].map((p) => p.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let n = 2; ; n++) {
      const tag = ` ${n}`;
      const s = name.slice(0, 16 - tag.length) + tag;
      if (!taken.has(s.toLowerCase())) return s;
    }
  }

  private drop(p: Player) {
    this.players.delete(p.id);
    if (this.host === p.id) this.host = this.players.keys().next().value ?? '';
    // who's here (and who hosts) goes out at once, not with the throttled score updates
    this.dirty = true;
    this.roomSentAt = 0;
  }

  // ------------------------------------------------------------------ messages
  private handle(p: Player, msg: ClientMsg) {
    const now = this.now();
    const live = this.phase === 'play' && now >= this.startsAt && now < this.endsAt;
    switch (msg.t) {
      case 'car':
        // cars are chosen before the match: once it starts, they're locked
        if (this.phase !== 'play' && CAR_IDS.includes(msg.car)) {
          p.car = msg.car;
          this.sendRoom();
        }
        break;
      case 'start':
        if (p.id === this.host && this.phase !== 'play') this.start(MATCH_MINUTES.includes(msg.minutes as never) ? msg.minutes : this.minutes);
        break;
      case 'lobby':
        if (p.id === this.host && this.phase === 'results') {
          this.phase = 'lobby';
          this.sendRoom();
        }
        break;
      case 'st':
      case 'fx':
        if (this.phase === 'play') this.toOthers(p, { ...msg, from: p.id } as ServerMsg);
        break;
      case 'hit':
        if (live) this.hit(p, msg.to, msg.dmg);
        break;
      case 'spawn':
        if (live && !p.alive && now >= p.deadAt + RESPAWN_MS) {
          p.alive = true;
          p.hp = ARENA_HP;
          p.shieldUntil = now + SHIELD_MS;
          this.all({ t: 'spawn', id: p.id, shieldUntil: p.shieldUntil });
          this.dirty = true;
        }
        break;
    }
  }

  private start(minutes: number) {
    const now = this.now();
    this.minutes = minutes;
    this.phase = 'play';
    this.startsAt = now + COUNTDOWN_MS;
    this.endsAt = this.startsAt + minutes * 60000;
    for (const p of this.players.values()) {
      Object.assign(p, { score: 0, kills: 0, deaths: 0, alive: true, hp: ARENA_HP, at: now, deadAt: 0, carry: 0 });
      p.shieldUntil = this.startsAt + SHIELD_MS;
    }
    this.sendRoom();
  }

  private hit(from: Player, to: string, dmg: unknown) {
    const target = this.players.get(to);
    if (!target || target === from || !target.alive || typeof dmg !== 'number' || !Number.isFinite(dmg) || dmg <= 0) return;
    const now = this.now();
    if (now < target.shieldUntil) return;
    const dealt = Math.min(Math.min(dmg, MAX_HIT), target.hp);
    target.hp -= dealt;
    from.carry += dealt;
    const pts = Math.floor(from.carry / DAMAGE_PER_POINT);
    if (pts > 0) {
      from.carry -= pts * DAMAGE_PER_POINT;
      from.score += pts;
      from.at = now;
    }
    this.all({ t: 'dmg', id: target.id, hp: target.hp, by: from.id });
    if (target.hp <= 0) {
      target.alive = false;
      target.hp = 0;
      target.deaths++;
      target.deadAt = now;
      from.kills++;
      from.score += KILL_POINTS;
      from.at = now;
      this.all({ t: 'wreck', id: target.id, by: from.id });
    }
    this.dirty = true;
  }

  private finish() {
    this.phase = 'results';
    const players = rank([...this.players.values()].map(info));
    this.all({ t: 'end', winner: players[0]?.id ?? null, players });
    this.sendRoom();
  }

  // ------------------------------------------------------------------ sending
  private byConn(conn: Conn) {
    for (const p of this.players.values()) if (p.conn === conn) return p;
    return undefined;
  }

  private send(p: Player, msg: ServerMsg) {
    p.conn?.send(JSON.stringify(msg));
  }

  private all(msg: ServerMsg) {
    const text = JSON.stringify(msg);
    for (const p of this.players.values()) p.conn?.send(text);
  }

  private toOthers(from: Player, msg: ServerMsg) {
    const text = JSON.stringify(msg);
    for (const p of this.players.values()) if (p !== from) p.conn?.send(text);
  }

  private sendRoom() {
    this.dirty = false;
    this.roomSentAt = this.now();
    const msg: RoomMsg = {
      t: 'room', now: this.roomSentAt, host: this.host, phase: this.phase, minutes: this.minutes,
      startsAt: this.phase === 'play' ? this.startsAt : 0, endsAt: this.phase === 'play' ? this.endsAt : 0,
      players: [...this.players.values()].map(info),
    };
    this.all(msg);
  }
}

const info = (p: Player): PlayerInfo => ({
  id: p.id, name: p.name, car: p.car, score: p.score, kills: p.kills, deaths: p.deaths, alive: p.alive, hp: p.hp, at: p.at,
});
