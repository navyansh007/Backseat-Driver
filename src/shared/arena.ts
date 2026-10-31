/**
 * Multiplayer arena: messages between each player's game and the arena server, plus the rules
 * both sides share. The server owns the match: who is in it, health, points, deaths, respawns and
 * the clock. Each game simulates its own car and streams its pose; the others draw it.
 */

export const ARENA_PATH = '/arena';
export const MAX_PLAYERS = 8;
/** armour of every car in the arena */
export const ARENA_HP = 400;
/** a wrecked car waits this long before it can respawn */
export const RESPAWN_MS = 5000;
/** a freshly spawned car can't be hurt for this long */
export const SHIELD_MS = 2000;
/** the countdown between the host pressing start and the cars being let go */
export const COUNTDOWN_MS = 3000;
export const MATCH_MINUTES = [3, 5, 10] as const;
/** points: a wreck is worth KILL_POINTS, plus one point per DAMAGE_PER_POINT armour knocked off */
export const KILL_POINTS = 100;
export const DAMAGE_PER_POINT = 4;
/** the most damage one hit report may carry (a direct missile hit with its blast is about 220) */
export const MAX_HIT = 240;

export const NAME_MIN = 2;
export const NAME_MAX = 16;

/** A username, tidied: trimmed, inner spaces collapsed, only letters, digits, spaces, _ - . allowed. Null if unusable. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (s.length < NAME_MIN || s.length > NAME_MAX) return null;
  return /^[\p{L}\p{N} _.-]+$/u.test(s) ? s : null;
}

export type Phase = 'lobby' | 'play' | 'results';

export interface PlayerInfo {
  id: string;
  name: string;
  car: string;
  score: number;
  kills: number;
  deaths: number;
  alive: boolean;
  hp: number;
  /** server time the current score was reached (tiebreak: earlier wins) */
  at: number;
}

/** A car's pose and visible state, streamed about 20 times a second. */
export interface PoseMsg {
  t: 'st';
  /** position, rotation (quaternion), velocity */
  p: [number, number, number];
  q: [number, number, number, number];
  v: [number, number, number];
  /** forward speed (m/s), for the wheels; steering angle (rad) */
  w: number;
  s: number;
  /** braking, guns out, launcher up */
  b?: boolean;
  g?: number;
  l?: number;
}

/** Things other players should see happen: a gun burst, a missile launch, an explosion. */
export type FxMsg = { t: 'fx' } & (
  | { k: 'shot'; a: [number, number, number]; b: [number, number, number]; hit: boolean }
  | { k: 'msl'; p: [number, number, number]; v: [number, number, number]; tgt: string | null }
  | { k: 'boom'; p: [number, number, number] }
);

export type ClientMsg =
  | { t: 'hello'; name: string; car: string; v: number }
  | { t: 'car'; car: string }
  | { t: 'start'; minutes: number }
  | { t: 'lobby' }
  | { t: 'hit'; to: string; dmg: number }
  | { t: 'spawn' }
  | PoseMsg
  | FxMsg;

export interface RoomMsg {
  t: 'room';
  /** server clock, for the countdowns */
  now: number;
  host: string;
  phase: Phase;
  minutes: number;
  /** when the cars are let go, and when the match ends (server time; 0 outside a match) */
  startsAt: number;
  endsAt: number;
  players: PlayerInfo[];
}

export type ServerMsg =
  | { t: 'welcome'; id: string; name: string; now: number; room: string }
  | { t: 'error'; reason: 'full' | 'name' | 'version' | 'bad' }
  | RoomMsg
  | (PoseMsg & { from: string })
  | (FxMsg & { from: string })
  | { t: 'dmg'; id: string; hp: number; by: string }
  | { t: 'wreck'; id: string; by: string | null }
  | { t: 'spawn'; id: string; shieldUntil: number }
  | { t: 'end'; winner: string | null; players: PlayerInfo[] };

/** Bumped when the protocol changes, so an old tab can't join a newer arena. */
export const ARENA_VERSION = 1;

/** Standings, best first: points, then fewer deaths, then whoever got there first. */
export function rank(players: PlayerInfo[]) {
  return [...players].sort((a, b) => b.score - a.score || a.deaths - b.deaths || a.at - b.at);
}
