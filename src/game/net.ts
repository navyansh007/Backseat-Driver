import QRCode from 'qrcode';
import {
  ICE_SERVERS, LAN_ENDPOINT, RELAY_PATH, makeRoomCode,
  type HostToRemote, type RelayMsg, type RemoteToHost, type SignalMsg,
} from '../shared/protocol';

export interface RemoteState {
  x: number;
  y: number;
  active: boolean;
  gun: boolean;
  missileSeq: number;
  lastSeen: number;
}

interface Peer {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  /** resolves once the phone's offer is applied; ICE candidates wait on it */
  ready: Promise<unknown>;
}

/**
 * Host side of the phone link: owns the room code, QR and the relay socket.
 * Each phone opens a direct WebRTC data channel to the game; the relay carries the
 * handshake, and carries input itself only for phones whose direct link isn't up.
 */
export class RemoteLink {
  readonly room: string;
  readonly state: RemoteState = { x: 0, y: 0, active: false, gun: false, missileSeq: 0, lastSeen: 0 };
  phones = 0;
  onPeers: (count: number) => void = () => {};
  private ws: WebSocket | null = null;
  private retry = 0;
  /** phone ids the relay reports in the room */
  private relayIds: string[] = [];
  /** phones we can reach: on the relay, or on a direct link that outlived a relay drop */
  private ids: string[] = [];
  private peers = new Map<string, Peer>();

  constructor() {
    const fromUrl = new URLSearchParams(location.search).get('room')?.toUpperCase() ?? '';
    const saved = sessionStorageGet('rc-room');
    this.room = /^[A-Z0-9]{4,12}$/.test(fromUrl) ? fromUrl : saved ?? makeRoomCode();
    sessionStorageSet('rc-room', this.room);
    this.connect();
  }

  /** Phones on a direct (peer-to-peer) link. */
  get direct() {
    let n = 0;
    for (const p of this.peers.values()) if (p.dc?.readyState === 'open') n++;
    return n;
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}${RELAY_PATH}?role=host&room=${this.room}`);
    this.ws = ws;
    ws.onopen = () => { this.retry = 0; };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string) as (RemoteToHost & { from?: string }) | RelayMsg;
      if (msg.t === 'peer') {
        this.relayIds = msg.ids ?? [];
        for (const [id, p] of this.peers) if (!this.relayIds.includes(id) && p.dc?.readyState !== 'open') this.dropPeer(id);
        this.recount();
      } else if (msg.t === 'sig') {
        if (msg.from) void this.onSignal(msg.from, msg);
      } else {
        this.onInput(msg);
      }
    };
    ws.onclose = () => {
      // phones already on a direct link keep driving while the relay reconnects
      this.relayIds = [];
      this.recount();
      setTimeout(() => this.connect(), Math.min(5000, 500 * 2 ** this.retry++));
    };
  }

  private recount() {
    const ids = new Set(this.relayIds);
    for (const [id, p] of this.peers) if (p.dc?.readyState === 'open') ids.add(id);
    this.ids = [...ids];
    this.setPhones(this.ids.length);
  }

  private setPhones(n: number) {
    this.phones = n;
    if (n === 0) {
      this.state.active = false;
      this.state.gun = false;
    }
    this.onPeers(n);
  }

  private onInput(msg: RemoteToHost) {
    if (msg.t !== 'in') return;
    this.state.x = clamp(msg.x);
    this.state.y = clamp(msg.y);
    this.state.active = !!msg.a;
    this.state.gun = !!msg.g;
    if (typeof msg.m === 'number' && Number.isFinite(msg.m)) this.state.missileSeq = msg.m;
    this.state.lastSeen = performance.now();
  }

  private async onSignal(id: string, msg: SignalMsg) {
    if (msg.sdp?.type === 'offer') {
      this.dropPeer(id);
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      const peer: Peer = { pc, dc: null, ready: Promise.resolve() };
      this.peers.set(id, peer);
      pc.onicecandidate = (e) => this.relay({ t: 'sig', to: id, ice: e.candidate ? e.candidate.toJSON() : null });
      pc.ondatachannel = (e) => {
        const dc = e.channel;
        peer.dc = dc;
        dc.onopen = () => this.recount();
        dc.onclose = () => {
          if (this.peers.get(id) === peer) this.dropPeer(id);
          this.recount();
        };
        dc.onmessage = (ev) => {
          try { this.onInput(JSON.parse(ev.data as string) as RemoteToHost); } catch { /* ignore */ }
        };
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' && this.peers.get(id) === peer) this.dropPeer(id);
      };
      peer.ready = (async () => {
        await pc.setRemoteDescription(msg.sdp!);
        await pc.setLocalDescription(await pc.createAnswer());
        const local = pc.localDescription!;
        this.relay({ t: 'sig', to: id, sdp: { type: 'answer', sdp: local.sdp } });
      })().catch((err) => {
        console.warn('[link] answer failed', err);
        this.dropPeer(id);
      });
    } else if (msg.ice) {
      const peer = this.peers.get(id);
      if (!peer) return;
      await peer.ready;
      peer.pc.addIceCandidate(msg.ice).catch(() => { /* stale candidate */ });
    }
  }

  private dropPeer(id: string) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    peer.dc?.close();
    peer.pc.close();
  }

  private relay(msg: HostToRemote) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  send(msg: HostToRemote) {
    if (this.phones === 0) return;
    const text = JSON.stringify(msg);
    let viaRelay = 0;
    for (const id of this.ids) {
      const dc = this.peers.get(id)?.dc;
      if (dc?.readyState === 'open') dc.send(text);
      else viaRelay++;
    }
    if (viaRelay === 0) return;
    if (viaRelay === this.ids.length) this.relay(msg);
    else for (const id of this.ids) if (this.peers.get(id)?.dc?.readyState !== 'open') this.relay({ ...msg, to: id });
  }

  /** True when the phone link is live and recent. */
  fresh() {
    return this.phones > 0 && performance.now() - this.state.lastSeen < 600;
  }

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
