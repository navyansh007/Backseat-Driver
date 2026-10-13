import '../styles/remote.css';
import { RELAY_PATH, type HostToRemote, type InputMsg, type RelayMsg } from '../shared/protocol';

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
let ws: WebSocket | null = null;
let retry = 0;

function connect() {
  if (!room) {
    setStatus('bad', 'scan the qr');
    return;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}${RELAY_PATH}?role=remote&room=${encodeURIComponent(room)}`);
  setStatus('wait', 'linking');
  ws.onopen = () => {
    retry = 0;
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data as string) as HostToRemote | RelayMsg;
    if (msg.t === 'peer') {
      setStatus(msg.online ? 'ok' : 'wait', msg.online ? `linked ${room}` : 'no game');
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
  };
  ws.onclose = () => {
    setStatus('bad', 'reconnecting');
    setTimeout(connect, Math.min(4000, 400 * 2 ** retry++));
  };
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
// ~40 Hz while anything is held, plus a slow keepalive so the game can detect a stalled link.
let lastSend = 0;
function pump(now: number) {
  requestAnimationFrame(pump);
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const busy = state.a || state.g;
  const interval = busy ? 25 : 250;
  if ((dirty && now - lastSend > 16) || now - lastSend > interval) {
    ws.send(JSON.stringify({ t: 'in', x: +state.x.toFixed(3), y: +state.y.toFixed(3), a: state.a, g: state.g, m: state.m }));
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
