import { makeRoomCode } from '../../shared/protocol';
import { ARENA_PATH, ARENA_VERSION, type ClientMsg, type RoomMsg, type ServerMsg } from '../../shared/arena';

export type ArenaError = Extract<ServerMsg, { t: 'error' }>['reason'] | 'lost';

/**
 * The connection to one arena. Keeps the same player id for this tab, so a dropped connection
 * that comes back within a few seconds keeps its car, armour and points.
 */
export class ArenaClient {
  readonly id: string;
  name = '';
  room: RoomMsg | null = null;
  /** server clock minus ours, from the last message that carried the time */
  private offset = 0;
  private ws: WebSocket | null = null;
  private retry = 0;
  private closed = false;
  private welcomed = false;
  onMessage: (msg: ServerMsg) => void = () => {};
  onError: (reason: ArenaError) => void = () => {};
  /** connected and welcomed (true), or trying to get back (false) */
  onStatus: (online: boolean) => void = () => {};

  constructor(readonly code: string, private hello: { name: string; car: string }) {
    this.id = tabId();
    this.connect();
  }

  /** A fresh arena code for a new arena. */
  static newCode() {
    return makeRoomCode();
  }

  /** The server's clock, in ms. */
  now() {
    return Date.now() + this.offset;
  }

  get online() {
    return this.welcomed && this.ws?.readyState === WebSocket.OPEN;
  }

  get isHost() {
    return this.room?.host === this.id;
  }

  me() {
    return this.room?.players.find((p) => p.id === this.id);
  }

  send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Change the car we'll join with (the arena only takes it outside a match). */
  setCar(car: string) {
    this.hello.car = car;
    this.send({ t: 'car', car });
  }

  leave() {
    this.closed = true;
    this.ws?.close(1000, 'left');
    this.ws = null;
  }

  private connect() {
    if (this.closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}${ARENA_PATH}?room=${this.code}&id=${this.id}`);
    this.ws = ws;
    this.welcomed = false;
    ws.onopen = () => {
      this.retry = 0;
      this.send({ t: 'hello', name: this.hello.name, car: this.hello.car, v: ARENA_VERSION });
    };
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try { msg = JSON.parse(ev.data as string); } catch { return; }
      if (msg.t === 'error') {
        // refused for good: don't keep knocking
        this.closed = true;
        this.onError(msg.reason);
        return;
      }
      if (msg.t === 'welcome') {
        this.welcomed = true;
        this.name = msg.name;
        this.offset = msg.now - Date.now();
        this.onStatus(true);
      } else if (msg.t === 'room') {
        this.room = msg;
        this.offset = msg.now - Date.now();
      }
      this.onMessage(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      const was = this.welcomed;
      this.welcomed = false;
      if (this.closed) return;
      if (was) this.onStatus(false);
      // the server keeps our place for 15 s; give up a little after that
      if (this.retry > 7) {
        this.closed = true;
        this.onError('lost');
        return;
      }
      setTimeout(() => this.connect(), Math.min(3000, 300 * 2 ** this.retry++));
    };
  }
}

/** One player id per tab, so a reload rejoins as the same player. */
function tabId() {
  const make = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');
  try {
    const id = sessionStorage.getItem('tnd-arena-id') ?? make();
    sessionStorage.setItem('tnd-arena-id', id);
    return id;
  } catch {
    return make();
  }
}
