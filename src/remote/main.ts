import '../styles/remote.css';
import {
  CHANNEL_LABEL, CHANNEL_OPTS, ICE_SERVERS, RELAY_PATH,
  type HostToRemote, type InputMsg, type RelayMsg, type SignalMsg,
} from '../shared/protocol';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const device = $<HTMLElement>('device');
const pad = $<HTMLDivElement>('pad');
const touch = $<HTMLDivElement>('touch');
const trail = $<HTMLDivElement>('trail');
const led = $<HTMLDivElement>('led');
const statusEl = $<HTMLSpanElement>('status');
const speedEl = $<HTMLElement>('speed');
const gearEl = $<HTMLElement>('gear');
const lockEl = $<HTMLSpanElement>('lockflag');
const gunBtn = $<HTMLButtonElement>('gun');
const mslBtn = $<HTMLButtonElement>('msl');
const heatEl = $<HTMLElement>('heat');
const pips = Array.from($<HTMLDivElement>('pips').children) as HTMLElement[];

const room = new URLSearchParams(location.search).get('room');
const buzz = (ms: number) => navigator.vibrate?.(ms);

function setStatus(kind: 'wait' | 'ok' | 'bad', text: string) {
  led.className = `led ${kind}`;
  statusEl.textContent = text;
}

// ---------------------------------------------------------------- connection
// The relay socket pairs us with the game and carries the WebRTC handshake. Once the
// direct data channel opens, input and telemetry go peer-to-peer; until then (or if a
// direct path can't be found) they travel over the relay. `?p2p=0` forces relay mode.
const P2P = typeof RTCPeerConnection !== 'undefined' && new URLSearchParams(location.search).get('p2p') !== '0';
let ws: WebSocket | null = null;
let retry = 0;
let hostOnline = false;
let pc: RTCPeerConnection | null = null;
let dc: RTCDataChannel | null = null;
let pcReady: Promise<unknown> = Promise.resolve();
let p2pRetry = 0;
let p2pTimer = 0;
const peerId = (() => {
  const make = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');
  try {
    const id = sessionStorage.getItem('rc-peer') ?? make();
    sessionStorage.setItem('rc-peer', id);
    return id;
  } catch {
    return make();
  }
})();

const direct = () => dc?.readyState === 'open';
const relayOpen = () => ws?.readyState === WebSocket.OPEN;

function refreshStatus() {
  if (direct()) setStatus('ok', `${room} direct`);
  else if (!relayOpen()) setStatus('bad', 'reconnecting');
  else if (hostOnline) setStatus('ok', `${room} relay`);
  else setStatus('wait', 'no game');
}

function onHostMsg(msg: HostToRemote | RelayMsg) {
  if (msg.t === 'peer') {
    hostOnline = msg.online;
    if (hostOnline) startP2P();
    else stopP2P();
    refreshStatus();
  } else if (msg.t === 'sig') {
    void onSignal(msg);
  } else if (msg.t === 'tele') {
    speedEl.textContent = String(Math.min(999, Math.round(msg.kmh))).padStart(3, '0');
    gearEl.textContent = msg.gear;
    if (msg.msl !== undefined) {
      pips.forEach((p, i) => p.classList.toggle('on', i < msg.msl!));
      mslBtn.classList.toggle('empty', msg.msl === 0);
    }
    if (msg.heat !== undefined) heatEl.style.width = `${Math.round(msg.heat * 100)}%`;
    heatEl.parentElement!.classList.toggle('hot', !!msg.hot);
    lockEl.classList.toggle('on', !!msg.lock);
  } else if (msg.t === 'hit') {
    buzz(Math.min(140, 20 + msg.power * 110));
    if (msg.power > 0.15) {
      device.classList.remove('shake');
      void device.offsetWidth;
      device.classList.add('shake');
    }
  }
}

function connect() {
  if (!room) {
    setStatus('bad', 'scan the qr');
    return;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}${RELAY_PATH}?role=remote&room=${encodeURIComponent(room)}&id=${peerId}`);
  if (!direct()) setStatus('wait', 'linking');
  ws.onopen = () => {
    retry = 0;
  };
  ws.onmessage = (ev) => onHostMsg(JSON.parse(ev.data as string) as HostToRemote | RelayMsg);
  ws.onclose = () => {
    // a direct link survives the relay dropping; the new relay session re-pairs anyway
    refreshStatus();
    setTimeout(connect, Math.min(4000, 400 * 2 ** retry++));
  };
}

function relaySend(msg: object) {
  if (relayOpen()) ws!.send(JSON.stringify(msg));
}

function startP2P() {
  if (!P2P || pc || p2pTimer) return;
  const conn = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const chan = conn.createDataChannel(CHANNEL_LABEL, CHANNEL_OPTS);
  pc = conn;
  dc = chan;
  pcReady = new Promise(() => {}); // until the answer lands
  conn.onicecandidate = (e) => relaySend({ t: 'sig', ice: e.candidate ? e.candidate.toJSON() : null });
  conn.onconnectionstatechange = () => {
    if (pc === conn && (conn.connectionState === 'failed' || conn.connectionState === 'closed')) retryP2P();
  };
  chan.onopen = () => {
    p2pRetry = 0;
    dirty = true;
    refreshStatus();
  };
  chan.onclose = () => {
    if (pc === conn) retryP2P();
  };
  chan.onmessage = (ev) => {
    try { onHostMsg(JSON.parse(ev.data as string) as HostToRemote); } catch { /* ignore */ }
  };
  void (async () => {
    await conn.setLocalDescription(await conn.createOffer());
    const local = conn.localDescription!;
    relaySend({ t: 'sig', sdp: { type: 'offer', sdp: local.sdp } });
  })().catch(retryP2P);
  // no direct link after a while: stay on the relay and try again later
  setTimeout(() => {
    if (pc === conn && !direct()) retryP2P();
  }, 12000);
}

async function onSignal(msg: SignalMsg) {
  const conn = pc;
  if (!conn) return;
  if (msg.sdp?.type === 'answer') {
    pcReady = conn.setRemoteDescription(msg.sdp);
    await pcReady.catch(retryP2P);
  } else if (msg.ice) {
    try { await pcReady; } catch { return; }
    if (pc === conn) conn.addIceCandidate(msg.ice).catch(() => { /* stale candidate */ });
  }
}

function stopP2P() {
  const conn = pc;
  pc = null;
  dc = null;
  conn?.close();
  clearTimeout(p2pTimer);
  p2pTimer = 0;
}

function retryP2P() {
  stopP2P();
  refreshStatus();
  if (!hostOnline) return;
  const delay = Math.min(30000, 2000 * 2 ** p2pRetry++);
  p2pTimer = window.setTimeout(() => {
    p2pTimer = 0;
    if (hostOnline && relayOpen()) startP2P();
  }, delay);
}

connect();

// ---------------------------------------------------------------- state
const state: InputMsg = { t: 'in', x: 0, y: 0, a: false, g: false, m: 0 };
let dirty = true;

// ---------------------------------------------------------------- touchpad (circular)
let padPointer: number | null = null;
const DEAD = 0.08;
const shape = (v: number) => {
  const a = Math.abs(v);
  return a < DEAD ? 0 : Math.sign(v) * ((a - DEAD) / (1 - DEAD));
};

function updatePad(e: PointerEvent) {
  const r = pad.getBoundingClientRect();
  const R = r.width / 2;
  const travel = R * 0.8;
  let dx = e.clientX - (r.left + R);
  let dy = e.clientY - (r.top + R);
  const len = Math.hypot(dx, dy);
  if (len > travel) {
    dx *= travel / len;
    dy *= travel / len;
  }
  state.x = shape(dx / travel);
  state.y = shape(-dy / travel);
  state.a = true;
  dirty = true;
  touch.style.left = `${50 + (dx / r.width) * 100}%`;
  touch.style.top = `${50 + (dy / r.height) * 100}%`;
  trail.style.width = `${Math.min(len, travel)}px`;
  trail.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
}

function releasePad() {
  padPointer = null;
  state.x = 0;
  state.y = 0;
  state.a = false;
  dirty = true;
  pad.classList.remove('active');
  touch.style.left = '50%';
  touch.style.top = '50%';
  trail.style.width = '0';
}

pad.addEventListener('pointerdown', (e) => {
  if (padPointer !== null) return;
  padPointer = e.pointerId;
  pad.setPointerCapture(e.pointerId);
  pad.classList.add('active');
  buzz(6);
  updatePad(e);
  e.preventDefault();
});
pad.addEventListener('pointermove', (e) => {
  if (e.pointerId === padPointer) updatePad(e);
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
  pad.addEventListener(type, (e) => {
    if (e.pointerId === padPointer) releasePad();
  });
}

// ---------------------------------------------------------------- fire buttons
let gunPointer: number | null = null;
gunBtn.addEventListener('pointerdown', (e) => {
  gunPointer = e.pointerId;
  gunBtn.setPointerCapture(e.pointerId);
  gunBtn.classList.add('down');
  state.g = true;
  dirty = true;
  buzz(10);
  e.preventDefault();
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
  gunBtn.addEventListener(type, (e) => {
    if (e.pointerId !== gunPointer) return;
    gunPointer = null;
    gunBtn.classList.remove('down');
    state.g = false;
    dirty = true;
  });
}
mslBtn.addEventListener('pointerdown', (e) => {
  mslBtn.classList.add('down');
  state.m = (state.m ?? 0) + 1;
  dirty = true;
  buzz(25);
  e.preventDefault();
});
for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
  mslBtn.addEventListener(type, () => mslBtn.classList.remove('down'));
}

document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------------------------------------------------------------- send loop
// Direct link: ~40 Hz while anything is held, repeated briefly after every change (the
// channel drops late packets rather than resending them). Relay: ~30 Hz. Plus a slow
// keepalive either way so the game can detect a stalled link.
let lastSend = 0;
let lastChange = 0;
function pump(now: number) {
  requestAnimationFrame(pump);
  const p2p = direct();
  if (!p2p && !relayOpen()) return;
  if (dirty) lastChange = now;
  const busy = state.a || state.g || now - lastChange < 200;
  const interval = busy ? (p2p ? 25 : 33) : 250;
  if ((dirty && now - lastSend > 16) || now - lastSend > interval) {
    const text = JSON.stringify({ t: 'in', x: +state.x.toFixed(3), y: +state.y.toFixed(3), a: state.a, g: state.g, m: state.m });
    if (p2p) dc!.send(text);
    else ws!.send(text);
    lastSend = now;
    dirty = false;
  }
}
requestAnimationFrame(pump);

// Keep the screen awake (works over the HTTPS tunnel; ignored on plain http).
async function keepAwake() {
  try {
    await (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<unknown> } }).wakeLock?.request('screen');
  } catch {
    /* not available */
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') keepAwake();
});
addEventListener('pointerdown', keepAwake, { once: true });
