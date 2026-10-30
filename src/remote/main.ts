import '../styles/remote.css';
import {
  CAM_VIEWS, CHANNEL_LABEL, CHANNEL_OPTS, ICE_SERVERS, RELAY_PATH, TRAP_KINDS,
  type CommandMsg, type GameMode, type HostToRemote, type InputMsg, type RelayMsg, type SignalMsg, type TelemetryMsg,
} from '../shared/protocol';
import { SettingsPanel } from './settings';

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
const camKey = $<HTMLButtonElement>('k-cam');
const camKeyValue = $<HTMLElement>('k-cam-v');
const resetKey = $<HTMLButtonElement>('k-reset');
const setupKey = $<HTMLButtonElement>('k-setup');
const hpEl = $<HTMLElement>('hp');
const waveEl = $<HTMLElement>('wave');
const scope = $<HTMLCanvasElement>('scope');
const padMsg = $<HTMLButtonElement>('pad-msg');
const padMsgStats = $<HTMLElement>('pad-msg-stats');

const room = new URLSearchParams(location.search).get('room');

// the QR says which remote to show; after that the game's own mode wins (it can change live)
let mode: GameMode = new URLSearchParams(location.search).get('mode') === 'action' ? 'action' : 'casual';
function setMode(m: GameMode) {
  mode = m;
  document.body.classList.toggle('action', m === 'action');
  if (m !== 'action') document.body.classList.remove('over');
}
setMode(mode);
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
  panel.setOnline(direct() || (relayOpen() && hostOnline));
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
    if (msg.hp !== undefined) showAction(msg);
  } else if (msg.t === 'cfg') {
    panel.update(msg);
    showCam();
    if (msg.mode !== mode) setMode(msg.mode);
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

// Commands go over both paths: the direct channel may drop a packet, the relay may be
// down. The game acts on each id once.
let cmdSeq = 0;
const cmdBase = `${peerId}-${Date.now().toString(36)}`;
type Command = CommandMsg extends infer T ? (T extends unknown ? Omit<T, 't' | 'id'> : never) : never;
function sendCommand(cmd: Command) {
  const text = JSON.stringify({ t: 'cmd', id: `${cmdBase}-${++cmdSeq}`, ...cmd });
  if (direct()) dc!.send(text);
  if (relayOpen()) ws!.send(text);
}

// ---------------------------------------------------------------- settings
const panel = new SettingsPanel($('sheet'), $('sheet-body'), sendCommand, buzz);

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

// ---------------------------------------------------------------- action remote
// trap buttons, armour, wave, radar, and the wrecked screen
const trapEls = TRAP_KINDS.map((k) => {
  const b = document.createElement('button');
  b.className = 'trap';
  b.dataset.k = k;
  b.setAttribute('aria-label', `Drop ${k}`);
  b.innerHTML = `<span>${k === 'spikes' ? 'spike' : k}</span><b class="tp"></b>`;
  $('traps').append(b);
  b.addEventListener('pointerdown', (e) => {
    b.classList.add('down');
    buzz(b.classList.contains('empty') ? 8 : 22);
    sendCommand({ c: 'trap', k });
    e.preventDefault();
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) b.addEventListener(type, () => b.classList.remove('down'));
  return { b, pips: b.querySelector('.tp') as HTMLElement };
});
padMsg.addEventListener('pointerdown', (e) => {
  buzz(30);
  sendCommand({ c: 'restart' });
  e.preventDefault();
});

let radar: number[] = [];
function showAction(msg: TelemetryMsg) {
  const hp = msg.hp ?? 1;
  hpEl.style.width = `${Math.round(hp * 100)}%`;
  hpEl.parentElement!.classList.toggle('low', hp < 0.3);
  const over = msg.st === 'over';
  document.body.classList.toggle('over', over);
  if (over) padMsgStats.textContent = `wave ${msg.wave ?? 0} · ${msg.score ?? 0} pts`;
  waveEl.textContent = msg.st === 'break' ? `w${(msg.wave ?? 0) + 1} in ${msg.next ?? 0}` : `w${msg.wave ?? 0} ×${msg.foes ?? 0}`;
  TRAP_KINDS.forEach((_, i) => {
    const n = msg.tc?.[i] ?? 0;
    const k = msg.tk?.[i] ?? 1;
    const t = trapEls[i];
    t.b.classList.toggle('empty', n === 0);
    t.b.style.setProperty('--k', String(k));
    const html = '<i class="on"></i>'.repeat(n) + (k < 1 ? '<i></i>' : '');
    if (t.pips.innerHTML !== html) t.pips.innerHTML = html;
  });
  radar = msg.rad ?? [];
}

// radar scope: green phosphor, a rotating sweep, one blip per pursuer (140 m range)
const sctx = scope.getContext('2d')!;
function drawScope(now: number) {
  requestAnimationFrame(drawScope);
  if (mode !== 'action') return;
  const w = scope.width, c = w / 2, R = c - 4;
  sctx.clearRect(0, 0, w, w);
  sctx.strokeStyle = 'rgba(110, 255, 160, 0.22)';
  sctx.lineWidth = 1.5;
  for (const k of [0.33, 0.66, 1]) {
    sctx.beginPath();
    sctx.arc(c, c, R * k, 0, Math.PI * 2);
    sctx.stroke();
  }
  sctx.beginPath();
  sctx.moveTo(c, c - R); sctx.lineTo(c, c + R);
  sctx.moveTo(c - R, c); sctx.lineTo(c + R, c);
  sctx.stroke();
  const a = (now / 1000) * 2.4;
  const sweep = sctx.createConicGradient(a - Math.PI / 2, c, c);
  sweep.addColorStop(0, 'rgba(110, 255, 160, 0.35)');
  sweep.addColorStop(0.12, 'rgba(110, 255, 160, 0)');
  sweep.addColorStop(1, 'rgba(110, 255, 160, 0)');
  sctx.fillStyle = sweep;
  sctx.beginPath();
  sctx.arc(c, c, R, 0, Math.PI * 2);
  sctx.fill();
  for (let i = 0; i + 1 < radar.length; i += 2) {
    const b = (radar[i] * Math.PI) / 180;
    const d = Math.min(1, radar[i + 1] / 140) * R;
    const x = c + Math.sin(b) * d, y = c - Math.cos(b) * d;
    sctx.fillStyle = '#ff5a3c';
    sctx.shadowColor = '#ff5a3c';
    sctx.shadowBlur = 8;
    sctx.beginPath();
    sctx.arc(x, y, 4.5, 0, Math.PI * 2);
    sctx.fill();
  }
  sctx.shadowBlur = 0;
  // you, pointing up
  sctx.fillStyle = '#b8ffcf';
  sctx.beginPath();
  sctx.moveTo(c, c - 7); sctx.lineTo(c + 5, c + 5); sctx.lineTo(c - 5, c + 5);
  sctx.fill();
}
requestAnimationFrame(drawScope);

// ---------------------------------------------------------------- quick keys
function showCam() {
  const v = panel.value('cam');
  if (v) camKeyValue.textContent = v;
}
function quickKey(btn: HTMLButtonElement, fn: () => void) {
  btn.addEventListener('pointerdown', (e) => {
    btn.classList.add('down');
    buzz(12);
    fn();
    e.preventDefault();
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
    btn.addEventListener(type, () => btn.classList.remove('down'));
  }
}
quickKey(camKey, () => {
  const v = panel.value('cam');
  if (!v) return;
  panel.set('cam', CAM_VIEWS[(CAM_VIEWS.indexOf(v) + 1) % CAM_VIEWS.length]);
  showCam();
});
quickKey(resetKey, () => sendCommand({ c: 'reset' }));
quickKey(setupKey, () => panel.open());
// the sheet covers the pad and fire buttons: let go of them
panel.onOpen = () => {
  if (padPointer !== null) releasePad();
  if (gunPointer !== null) {
    gunPointer = null;
    gunBtn.classList.remove('down');
    state.g = false;
    dirty = true;
  }
};

// the settings sheet scrolls; nothing else on the page should
const sheetBody = $('sheet-body');
document.addEventListener('touchmove', (e) => {
  if (!sheetBody.contains(e.target as Node)) e.preventDefault();
}, { passive: false });
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
