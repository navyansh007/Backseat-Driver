import {
  ASSIST_NAMES, CAM_VIEWS, GAME_MODES, QUALITY_LEVELS,
  type CommandMsg, type SettingKey, type Settings, type SettingsMsg,
} from '../shared/protocol';
import { CARS } from '../shared/cars';

type Send = (cmd: DistributiveOmit<CommandMsg, 't' | 'id'>) => void;
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

type Control =
  | { kind: 'seg'; key: SettingKey; options: { label: string; value: Settings[SettingKey] }[] }
  | { kind: 'switch'; key: SettingKey; label: string }
  | { kind: 'slider'; key: 'volume' | 'musicVolume'; label: string }
  | { kind: 'action'; c: 'start' | 'menu' | 'reset' | 'respawn'; label: string; id?: string }
  | { kind: 'note'; id: string };

/** Labels shortened to fit four keys across a phone. */
const SHORT: Record<string, string> = { medium: 'med', strong: 'max' };

/** The settings panel, one module per group. */
const MODULES: { title: string; controls: Control[] }[] = [
  {
    title: 'drive',
    controls: [
      { kind: 'note', id: 'drive-state' },
      { kind: 'seg', key: 'mode', options: GAME_MODES.map((m) => ({ label: m, value: m })) },
      { kind: 'seg', key: 'car', options: CARS.map((c) => ({ label: c.short, value: c.id })) },
      { kind: 'action', c: 'start', label: 'drive', id: 'act-play' },
      { kind: 'action', c: 'reset', label: 'reset car' },
      { kind: 'action', c: 'respawn', label: 'back to start' },
    ],
  },
  {
    title: 'camera',
    controls: [
      { kind: 'seg', key: 'cam', options: CAM_VIEWS.map((v) => ({ label: v, value: v })) },
      { kind: 'switch', key: 'stunts', label: 'stunt cam' },
    ],
  },
  {
    title: 'steering assist',
    controls: [{ kind: 'seg', key: 'assist', options: ASSIST_NAMES.map((n, i) => ({ label: SHORT[n] ?? n, value: i })) }],
  },
  {
    title: 'sound',
    controls: [
      { kind: 'switch', key: 'sound', label: 'sound' },
      { kind: 'slider', key: 'volume', label: 'volume' },
      { kind: 'switch', key: 'music', label: 'music' },
      { kind: 'slider', key: 'musicVolume', label: 'music vol' },
      { kind: 'note', id: 'audio-note' },
    ],
  },
  {
    title: 'screen',
    controls: [
      { kind: 'switch', key: 'hints', label: 'key hints' },
      { kind: 'seg', key: 'quality', options: QUALITY_LEVELS.map((q, i) => ({ label: SHORT[q.name] ?? q.name, value: i })) },
    ],
  },
  {
    title: 'graphics',
    controls: [
      { kind: 'seg', key: 'renderer', options: [{ label: 'webgpu', value: 'webgpu' }, { label: 'webgl', value: 'webgl' }] },
      { kind: 'note', id: 'gfx-note' },
    ],
  },
];

/** How long a value the phone just set wins over older values still arriving from the game. */
const HOLD_MS = 1500;

/**
 * Settings sheet: shows the game's settings and sends changes. A change shows at once;
 * the game's own report confirms it (or puts it back if the game didn't take it).
 */
export class SettingsPanel {
  /** called when the sheet opens, so the remote can let go of the pad and buttons */
  onOpen = () => {};
  private cfg: SettingsMsg | null = null;
  private online = false;
  private pending = new Map<SettingKey, { v: Settings[SettingKey]; until: number }>();
  private renders: (() => void)[] = [];

  constructor(private sheet: HTMLElement, private body: HTMLElement, private send: Send, private buzz: (ms: number) => void) {
    for (const mod of MODULES) {
      const box = el('section', 'mod');
      box.append(el('h3', '', mod.title));
      for (const c of mod.controls) box.append(this.build(c));
      body.append(box);
    }
    sheet.querySelector('[data-close]')!.addEventListener('click', () => this.close());
    this.render();
  }

  get isOpen() {
    return this.sheet.classList.contains('open');
  }

  open() {
    this.sheet.classList.add('open');
    this.sheet.setAttribute('aria-hidden', 'false');
    this.body.scrollTop = 0;
    this.onOpen();
    this.buzz(8);
  }

  close() {
    this.sheet.classList.remove('open');
    this.sheet.setAttribute('aria-hidden', 'true');
    this.buzz(8);
  }

  update(cfg: SettingsMsg) {
    this.cfg = cfg;
    this.render();
  }

  setOnline(on: boolean) {
    if (on === this.online) return;
    this.online = on;
    this.render();
  }

  /** The value to show: one the phone just set, else the game's. */
  value<K extends SettingKey>(k: K): Settings[K] | undefined {
    const p = this.pending.get(k);
    if (p && this.cfg && this.cfg[k] === p.v) this.pending.delete(k);
    else if (p && performance.now() < p.until) return p.v as Settings[K];
    else if (p) this.pending.delete(k);
    return this.cfg?.[k];
  }

  set<K extends SettingKey>(k: K, v: Settings[K]) {
    this.pending.set(k, { v, until: performance.now() + HOLD_MS });
    this.send({ c: 'set', k, v } as DistributiveOmit<CommandMsg, 't' | 'id'>);
    this.render();
  }

  private ready() {
    return this.online && this.cfg !== null;
  }

  private render() {
    this.sheet.classList.toggle('offline', !this.ready());
    for (const r of this.renders) r();
  }

  private build(c: Control): HTMLElement {
    switch (c.kind) {
      case 'seg': {
        const row = el('div', 'seg');
        row.style.setProperty('--n', String(c.options.length));
        const keys = c.options.map((o) => {
          const b = el('button', 'segkey', o.label);
          b.append(el('i'));
          tap(b, () => {
            if (!this.ready() || this.value(c.key) === o.value) return;
            this.buzz(10);
            this.set(c.key, o.value);
          });
          row.append(b);
          return b;
        });
        this.renders.push(() => {
          const v = this.value(c.key);
          c.options.forEach((o, i) => keys[i].classList.toggle('on', o.value === v));
        });
        return row;
      }
      case 'switch': {
        const b = el('button', 'switch');
        b.append(el('span', '', c.label), el('b'));
        tap(b, () => {
          if (!this.ready()) return;
          this.buzz(10);
          this.set(c.key, !this.value(c.key));
        });
        this.renders.push(() => {
          const on = !!this.value(c.key);
          b.classList.toggle('on', on);
          b.setAttribute('aria-pressed', String(on));
        });
        return b;
      }
      case 'slider': {
        const row = el('label', 'slider');
        const input = document.createElement('input');
        input.type = 'range';
        input.min = '0';
        input.max = '100';
        input.step = '1';
        const out = el('output');
        row.append(el('span', '', c.label), input, out);
        // send at most every 80 ms while dragging, and always the final value
        let lastSent = 0;
        let timer = 0;
        let dragging = false;
        const push = () => {
          clearTimeout(timer);
          timer = 0;
          lastSent = performance.now();
          this.set(c.key, Number(input.value) / 100);
        };
        input.addEventListener('pointerdown', () => { dragging = true; });
        input.addEventListener('input', () => {
          if (!this.ready()) return;
          out.textContent = input.value;
          input.style.setProperty('--fill', `${input.value}%`);
          const wait = 80 - (performance.now() - lastSent);
          if (wait <= 0) push();
          else if (!timer) timer = window.setTimeout(push, wait);
        });
        input.addEventListener('change', () => {
          dragging = false;
          if (this.ready()) push();
        });
        this.renders.push(() => {
          input.disabled = !this.ready();
          if (dragging) return;
          const pct = String(Math.round((this.value(c.key) ?? 1) * 100));
          input.value = pct;
          out.textContent = pct;
          input.style.setProperty('--fill', `${pct}%`);
        });
        return row;
      }
      case 'action': {
        const b = el('button', 'action', c.label);
        tap(b, () => {
          if (!this.ready()) return;
          this.buzz(18);
          const cmd = c.id === 'act-play' ? (this.cfg!.playing ? 'menu' : 'start') : c.c;
          this.send({ c: cmd });
          // driving again, or back on the road: get out of the way
          if (cmd !== 'menu') this.close();
        });
        if (c.id === 'act-play') {
          this.renders.push(() => { b.textContent = this.cfg?.playing ? 'pairing screen' : 'drive'; });
        }
        return b;
      }
      case 'note': {
        const p = el('p', 'note');
        this.renders.push(() => { p.textContent = this.note(c.id); });
        return p;
      }
    }
  }

  private note(id: string) {
    const cfg = this.cfg;
    if (!cfg) return '';
    switch (id) {
      case 'drive-state':
        return cfg.playing ? 'driving' : 'on the pairing screen';
      case 'audio-note':
        return cfg.audio ? '' : 'click the game screen once to let it play sound';
      case 'gfx-note': {
        const running = cfg.backend === 'webgpu' ? 'WebGPU' : 'WebGL';
        return `running ${running} · switching reloads the game`;
      }
    }
    return '';
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** Fire on release, so a scroll that started on a control doesn't press it. */
function tap(target: HTMLElement, fn: () => void) {
  let start: { x: number; y: number; id: number } | null = null;
  target.addEventListener('pointerdown', (e) => {
    start = { x: e.clientX, y: e.clientY, id: e.pointerId };
    target.classList.add('down');
  });
  target.addEventListener('pointerup', (e) => {
    target.classList.remove('down');
    if (start?.id === e.pointerId && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 12) fn();
    start = null;
  });
  for (const type of ['pointercancel', 'pointerleave'] as const) {
    target.addEventListener(type, () => {
      target.classList.remove('down');
      start = null;
    });
  }
}
