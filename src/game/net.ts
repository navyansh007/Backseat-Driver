import QRCode from 'qrcode';
import { LAN_ENDPOINT, RELAY_PATH, makeRoomCode, type HostToRemote, type RelayMsg, type RemoteToHost } from '../shared/protocol';

export interface RemoteState {
  x: number;
  y: number;
  active: boolean;
  gun: boolean;
  missileSeq: number;
  lastSeen: number;
}

/** Host side of the phone link: owns the room code, QR and the relay socket. */
export class RemoteLink {
  readonly room: string;
  readonly state: RemoteState = { x: 0, y: 0, active: false, gun: false, missileSeq: 0, lastSeen: 0 };
  phones = 0;
  onPeers: (count: number) => void = () => {};
  private ws: WebSocket | null = null;
  private retry = 0;

  constructor() {
    const fromUrl = new URLSearchParams(location.search).get('room')?.toUpperCase() ?? '';
    const saved = sessionStorageGet('rc-room');
    this.room = /^[A-Z0-9]{4,12}$/.test(fromUrl) ? fromUrl : saved ?? makeRoomCode();
    sessionStorageSet('rc-room', this.room);
    this.connect();
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}${RELAY_PATH}?role=host&room=${this.room}`);
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string) as RemoteToHost | RelayMsg;
      if (msg.t === 'in') {
        this.state.x = clamp(msg.x);
        this.state.y = clamp(msg.y);
        this.state.active = msg.a;
        this.state.gun = !!msg.g;
        if (typeof msg.m === 'number' && Number.isFinite(msg.m)) this.state.missileSeq = msg.m;
        this.state.lastSeen = performance.now();
      } else if (msg.t === 'peer') {
        this.phones = msg.count;
        if (msg.count === 0) {
          this.state.active = false;
          this.state.gun = false;
        }
        this.onPeers(msg.count);
      }
    };
    ws.onclose = () => {
      this.phones = 0;
      this.onPeers(0);
      setTimeout(() => this.connect(), Math.min(5000, 500 * 2 ** this.retry++));
    };
  }

  send(msg: HostToRemote) {
    if (this.ws?.readyState === WebSocket.OPEN && this.phones > 0) this.ws.send(JSON.stringify(msg));
  }

  /** True when the phone link is live and recent. */
  fresh() {
    return this.phones > 0 && performance.now() - this.state.lastSeen < 600;
  }

  /** URL the phone should open. Uses the machine's LAN IP when the game runs on localhost. */
  /**
   * URL the phone should open. Prefers the public tunnel URL (npm run dev:public),
   * then the machine's LAN IP when the game runs on localhost, else the current origin.
   */
  async remoteUrl() {
    let origin = location.origin;
    try {
      const res = await fetch(LAN_ENDPOINT);
      const info = (await res.json()) as { addresses: string[]; port?: number; publicUrl?: string | null };
      if (info.publicUrl) origin = info.publicUrl.replace(/\/$/, '');
      else if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) && info.addresses.length) {
        origin = `${location.protocol}//${info.addresses[0]}:${info.port ?? location.port}`;
      }
    } catch { /* fall back to current origin */ }
    return `${origin}/remote.html?room=${this.room}`;
  }

  async drawQR(canvas: HTMLCanvasElement, size: number) {
    const url = await this.remoteUrl();
    await QRCode.toCanvas(canvas, url, { width: size, margin: 1, color: { dark: '#0d1117', light: '#ffffff' }, errorCorrectionLevel: 'M' });
    return url;
  }
}

const clamp = (v: number) => (Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);

function sessionStorageGet(k: string) {
  try { return sessionStorage.getItem(k); } catch { return null; }
}
function sessionStorageSet(k: string, v: string) {
  try { sessionStorage.setItem(k, v); } catch { /* ignore */ }
}
