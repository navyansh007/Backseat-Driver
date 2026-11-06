import { LOBBY_PATH, type LobbyClientMsg, type LobbyServerMsg } from '../../shared/arena';

const KEEPALIVE_MS = 30000;
const FIND_TIMEOUT_MS = 6000;

/**
 * This game's place in the game-wide lobby. It stays connected from page load to close, whatever
 * is being played: that connection is what counts us as online. It also finds random arenas.
 */
export class LobbyClient {
  /** drivers online, or null while we can't reach the lobby */
  online: number | null = null;
  /** open arenas with a free seat */
  rooms = 0;
  onChange: () => void = () => {};
  private ws: WebSocket | null = null;
  private retry = 0;
  private looking: { resolve(code: string): void; reject(err: Error): void; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor() {
    this.connect();
    setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send('ping');
    }, KEEPALIVE_MS);
  }

  /** The code of a random open arena (or a new open one), skipping these codes. */
  find(skip: string[]) {
    return new Promise<string>((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return reject(new Error('offline'));
      this.settle();
      const timer = setTimeout(() => this.settle(new Error('timeout')), FIND_TIMEOUT_MS);
      this.looking = { resolve, reject, timer };
      this.ws.send(JSON.stringify({ t: 'find', skip } satisfies LobbyClientMsg));
    });
  }

  private settle(result: string | Error = new Error('superseded')) {
    const looking = this.looking;
    if (!looking) return;
    this.looking = null;
    clearTimeout(looking.timer);
    if (typeof result === 'string') looking.resolve(result);
    else looking.reject(result);
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}${LOBBY_PATH}`);
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; };
    ws.onmessage = (ev) => {
      let msg: LobbyServerMsg;
      try { msg = JSON.parse(ev.data as string); } catch { return; }
      if (msg.t === 'found') this.settle(msg.code);
      else if (msg.t === 'lobby') {
        this.online = msg.online;
        this.rooms = msg.rooms;
        this.onChange();
      }
    };
    ws.onclose = () => {
      this.settle(new Error('offline'));
      this.online = null;
      this.onChange();
      setTimeout(() => this.connect(), Math.min(15000, 1000 * 2 ** this.retry++));
    };
  }
}
