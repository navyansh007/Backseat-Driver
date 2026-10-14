import * as THREE from 'three';

/** Deterministic PRNG so the world looks the same every load. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  return { c, ctx };
}

function toTexture(c: HTMLCanvasElement, repeat = 1, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

function speckle(ctx: CanvasRenderingContext2D, w: number, h: number, n: number, rand: () => number, colors: string[], maxR: number) {
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = colors[(rand() * colors.length) | 0];
    const r = rand() * maxR + 0.3;
    ctx.globalAlpha = 0.25 + rand() * 0.5;
    ctx.fillRect(rand() * w, rand() * h, r, r);
  }
  ctx.globalAlpha = 1;
}

export function asphaltTexture() {
  const S = 512;
  const { c, ctx } = canvas(S, S);
  const rand = rng(11);
  ctx.fillStyle = '#5d6166';
  ctx.fillRect(0, 0, S, S);
  // large soft blotches
  for (let i = 0; i < 60; i++) {
    const x = rand() * S, y = rand() * S, r = 30 + rand() * 90;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const tone = rand() > 0.5 ? '255,255,255' : '0,0,0';
    g.addColorStop(0, `rgba(${tone},0.05)`);
    g.addColorStop(1, `rgba(${tone},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  speckle(ctx, S, S, 22000, rand, ['#3f4246', '#787c80', '#4c5054', '#8b8e90', '#2f3236'], 1.8);
  // hairline cracks
  ctx.strokeStyle = 'rgba(30,32,35,0.35)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 7; i++) {
    let x = rand() * S, y = rand() * S;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let k = 0; k < 12; k++) {
      x += (rand() - 0.5) * 30;
      y += (rand() - 0.5) * 30;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  return toTexture(c);
}

export function concreteTexture() {
  const S = 512;
  const { c, ctx } = canvas(S, S);
  const rand = rng(23);
  ctx.fillStyle = '#a9a7a1';
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 80; i++) {
    const x = rand() * S, y = rand() * S, r = 20 + rand() * 120;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${rand() > 0.5 ? '90,88,84' : '220,218,212'},0.08)`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  speckle(ctx, S, S, 9000, rand, ['#8f8d88', '#bdbab4', '#7d7b77'], 1.4);
  // formwork seams
  ctx.strokeStyle = 'rgba(80,78,74,0.25)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, S - 2, S - 2);
  ctx.beginPath();
  ctx.moveTo(S / 2, 0);
  ctx.lineTo(S / 2, S);
  ctx.stroke();
  return toTexture(c);
}

export function grassTexture() {
  const S = 512;
  const { c, ctx } = canvas(S, S);
  const rand = rng(5);
  ctx.fillStyle = '#7da35a';
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 120; i++) {
    const x = rand() * S, y = rand() * S, r = 20 + rand() * 80;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rand() > 0.5 ? 'rgba(160,190,90,0.18)' : 'rgba(60,100,50,0.18)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (let i = 0; i < 26000; i++) {
    const x = rand() * S, y = rand() * S;
    ctx.strokeStyle = ['#6a9447', '#8fb766', '#5b8540', '#a3c477'][(rand() * 4) | 0];
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rand() - 0.5) * 3, y - 2 - rand() * 4);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return toTexture(c);
}

/** Facade texture with a grid of windows; a few lit, some with blinds. */
export function windowsTexture(seed: number, wall: string, glass: string, cols = 8, rows = 16) {
  const W = 256, H = 512;
  const { c, ctx } = canvas(W, H);
  const rand = rng(seed);
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, W, H);
  const cw = W / cols, rh = H / rows;
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < cols; k++) {
      const x = k * cw + cw * 0.18, y = r * rh + rh * 0.22;
      const w = cw * 0.64, h = rh * 0.58;
      const g = ctx.createLinearGradient(x, y, x, y + h);
      g.addColorStop(0, glass);
      g.addColorStop(1, shade(glass, -25));
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w, h);
      if (rand() < 0.25) {
        ctx.fillStyle = 'rgba(240,230,210,0.55)';
        ctx.fillRect(x, y, w, h * (0.3 + rand() * 0.6));
      }
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(x, y, w * 0.25, h);
    }
  }
  const t = toTexture(c);
  t.repeat.set(1, 1);
  return t;
}

function shade(hex: string, amt: number) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, (n >> 16) + amt));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt));
  const b = Math.max(0, Math.min(255, (n & 255) + amt));
  return `rgb(${r},${g},${b})`;
}

/** Text sign texture. */
export function signTexture(text: string, opts: { bg: string; fg: string; w?: number; h?: number; font?: string; sub?: string }) {
  const W = opts.w ?? 1024, H = opts.h ?? 256;
  const { c, ctx } = canvas(W, H);
  ctx.fillStyle = opts.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = opts.fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = opts.font ?? `700 ${H * 0.5}px Inter, Helvetica, Arial, sans-serif`;
  ctx.fillText(text, W / 2, opts.sub ? H * 0.42 : H / 2);
  if (opts.sub) {
    ctx.font = `500 ${H * 0.16}px Inter, Helvetica, Arial, sans-serif`;
    ctx.globalAlpha = 0.8;
    ctx.fillText(opts.sub, W / 2, H * 0.78);
  }
  const t = toTexture(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.repeat.set(1, 1);
  return t;
}

export function plateTexture(text: string) {
  const { c, ctx } = canvas(512, 112);
  ctx.fillStyle = '#f4f4ef';
  ctx.fillRect(0, 0, 512, 112);
  ctx.fillStyle = '#1f47a8';
  ctx.fillRect(0, 0, 54, 112);
  ctx.strokeStyle = '#222';
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, 506, 106);
  ctx.fillStyle = '#151515';
  ctx.font = '700 74px "JetBrains Mono", "Courier New", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 283, 60);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Soft round sprite used for smoke/dust particles. */
export function puffTexture() {
  const { c, ctx } = canvas(64, 64);
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  return t;
}

/** Faint radial contact shadow under cars/props. */
export function blobShadowTexture() {
  const { c, ctx } = canvas(128, 128);
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/** Painted arrow decal for driving lanes. */
export function arrowTexture() {
  const { c, ctx } = canvas(128, 256);
  ctx.clearRect(0, 0, 128, 256);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(64, 8);
  ctx.lineTo(118, 90);
  ctx.lineTo(82, 90);
  ctx.lineTo(82, 248);
  ctx.lineTo(46, 248);
  ctx.lineTo(46, 90);
  ctx.lineTo(10, 90);
  ctx.closePath();
  ctx.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Chain-link mesh with alpha. */
export function fenceTexture() {
  const { c, ctx } = canvas(64, 64);
  ctx.clearRect(0, 0, 64, 64);
  ctx.strokeStyle = 'rgba(190,196,200,1)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(64, 64);
  ctx.moveTo(64, 0); ctx.lineTo(0, 64);
  ctx.stroke();
  const t = toTexture(c);
  return t;
}

/** Billowy smoke sprite: fractal value noise under a soft radial falloff. */
export function smokeTexture() {
  const S = 128;
  const { c, ctx } = canvas(S, S);
  const rand = rng(99);
  // lattice of random values, sampled with smooth interpolation at several octaves
  const N = 16;
  const grid = Array.from({ length: (N + 1) * (N + 1) }, () => rand());
  const g = (x: number, y: number) => grid[(y % N) * (N + 1) + (x % N)];
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const noise = (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = smooth(x - xi), yf = smooth(y - yi);
    const a = g(xi, yi), b = g(xi + 1, yi), c2 = g(xi, yi + 1), d = g(xi + 1, yi + 1);
    return a + (b - a) * xf + (c2 - a) * yf + (a - b - c2 + d) * xf * yf;
  };
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let f = 0, amp = 0.5, freq = 4 / S;
      for (let o = 0; o < 4; o++) {
        f += noise(x * freq * 4 + o * 3.1, y * freq * 4 + o * 1.7) * amp;
        amp *= 0.5;
        freq *= 2;
      }
      const dx = x / S - 0.5, dy = y / S - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2;
      const fall = Math.max(0, 1 - r) ** 1.6;
      const a = Math.min(1, Math.max(0, (f - 0.25) * 1.9) * fall * 1.4);
      const i = (y * S + x) * 4;
      const shade = 200 + f * 55;
      img.data[i] = shade;
      img.data[i + 1] = shade;
      img.data[i + 2] = shade;
      img.data[i + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}
