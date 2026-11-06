/**
 * The game-wide lobby, shared by the Vite server (Node) and the Cloudflare Durable Object: the
 * book of open arenas and the matchmaking over it. Who is online is simply who holds a lobby
 * socket; each host keeps that count its own way.
 */
import { MAX_PLAYERS, MIN_MATCH_LEFT_MS, type LobbyServerMsg, type Listing } from '../src/shared/arena';
import { MAX_FRAME, makeRoomCode } from '../src/shared/protocol';

/** An arena that hasn't reported for this long is gone (open arenas report at least every RELIST_MS). */
const STALE_MS = 75000;

export interface Listed extends Listing {
  code: string;
  at: number;
}

export class LobbyBook {
  private rooms = new Map<string, Listed>();

  constructor(saved: Listed[] = [], private now: () => number = Date.now) {
    for (const r of saved) this.rooms.set(r.code, r);
  }

  /** Everything to save, for hosts that lose their memory between messages. */
  dump() {
    return [...this.rooms.values()];
  }

  /** An arena's latest state; null takes it off the book. */
  report(code: string, listing: Listing | null) {
    if (listing) this.rooms.set(code, { ...listing, code, at: this.now() });
    else this.rooms.delete(code);
  }

  /** Arenas a driver can be sent to right now. */
  open() {
    const now = this.now();
    for (const [code, r] of this.rooms) if (now - r.at > STALE_MS) this.rooms.delete(code);
    return this.dump().filter((r) => r.players > 0 && r.players < MAX_PLAYERS && (!r.endsAt || r.endsAt - now >= MIN_MATCH_LEFT_MS));
  }

  /**
   * A random open arena, or a new one if there is none. Either way the seat is booked at once,
   * so drivers looking at the same moment land together instead of in rooms of their own.
   */
  find(skip: string[]) {
    const options = this.open().filter((r) => !skip.includes(r.code));
    const room = options[Math.floor(Math.random() * options.length)];
    if (room) {
      room.players++;
      return room.code;
    }
    const code = makeRoomCode();
    this.report(code, { players: 1, phase: 'lobby', endsAt: 0 });
    return code;
  }
}

export const lobbyMsg = (online: number, rooms: number) => JSON.stringify({ t: 'lobby', online, rooms } satisfies LobbyServerMsg);
export const foundMsg = (code: string) => JSON.stringify({ t: 'found', code } satisfies LobbyServerMsg);

/** The arenas a `find` asks to skip, or null if the frame isn't a `find`. */
export function parseFind(text: string): string[] | null {
  if (text.length > MAX_FRAME) return null;
  try {
    const msg = JSON.parse(text);
    if (msg?.t !== 'find') return null;
    return Array.isArray(msg.skip) ? msg.skip.filter((c: unknown): c is string => typeof c === 'string').slice(0, MAX_PLAYERS) : [];
  } catch {
    return null;
  }
}
