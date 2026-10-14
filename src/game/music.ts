import bgmUrl from '../../bgm.mp3?url';

/**
 * Soundtrack from bgm.mp3, kept deliberately simple so nothing ever overlaps:
 *   - on the player's first movement: 0:00–0:08 plays once (the engine rev-up into gear 1)
 *   - right after it ends: 0:09–0:18 loops for as long as the game runs
 *
 * Only those 18 seconds are kept in memory. Both parts are AudioBuffers scheduled
 * sample-accurately on the audio clock, so the loop starts exactly when the intro
 * ends and only one source is ever audible.
 */

const INTRO = { start: 0, end: 8.0 };
const LOOP = { start: 9.0, end: 18.0 };
const MUSIC_VOLUME = 0.6;
/** Length of the blend baked into the loop seam so it repeats without a click. */
const SEAM = 0.025;

export class MusicDirector {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private intro: AudioBuffer | null = null;
  private loop: AudioBuffer | null = null;
  private requested = false;
  private started = false;
  private enabled = true;

  /** Connect to the game's audio graph (called once audio is unlocked) and prepare the clips. */
  attach(ctx: AudioContext, bus: GainNode) {
    if (this.ctx) return;
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = this.enabled ? MUSIC_VOLUME : 0;
    this.out.connect(bus);
    void this.load(ctx);
  }

  private async load(ctx: AudioContext) {
    try {
      const data = await (await fetch(bgmUrl)).arrayBuffer();
      const full = await ctx.decodeAudioData(data);
      this.intro = slice(ctx, full, INTRO.start, INTRO.end);
      this.loop = seamlessLoop(ctx, full, LOOP.start, LOOP.end);
      // the full decode is dropped here; only the two short clips stay in memory
      if (this.requested) this.begin();
    } catch (err) {
      console.warn('[music] could not load the soundtrack', err);
    }
  }

  /** First movement: intro once, then the loop. Safe to call more than once. */
  begin() {
    this.requested = true;
    const ctx = this.ctx;
    if (!ctx || !this.out || !this.intro || !this.loop || this.started) return;
    this.started = true;
    const t0 = ctx.currentTime + 0.05;
    const intro = ctx.createBufferSource();
    intro.buffer = this.intro;
    intro.connect(this.out);
    intro.start(t0);
    const loop = ctx.createBufferSource();
    loop.buffer = this.loop;
    loop.loop = true;
    loop.connect(this.out);
    loop.start(t0 + this.intro.duration);
  }

  toggle() {
    this.enabled = !this.enabled;
    if (this.ctx && this.out) this.out.gain.setTargetAtTime(this.enabled ? MUSIC_VOLUME : 0, this.ctx.currentTime, 0.2);
    return this.enabled;
  }
}

/** Copy [from, to) seconds of a buffer into a new buffer. */
function slice(ctx: AudioContext, src: AudioBuffer, from: number, to: number) {
  const a = Math.floor(from * src.sampleRate);
  const b = Math.min(src.length, Math.floor(to * src.sampleRate));
  const out = ctx.createBuffer(src.numberOfChannels, b - a, src.sampleRate);
  for (let c = 0; c < src.numberOfChannels; c++) out.copyToChannel(src.getChannelData(c).subarray(a, b), c);
  return out;
}

/**
 * Slice [from, to) and blend its last few milliseconds toward the audio that leads
 * into `from`, so wrapping from the end back to the start is continuous.
 */
function seamlessLoop(ctx: AudioContext, src: AudioBuffer, from: number, to: number) {
  const out = slice(ctx, src, from, to);
  const sr = src.sampleRate;
  const n = Math.floor(SEAM * sr);
  const a = Math.floor(from * sr);
  if (a < n) return out;
  for (let c = 0; c < out.numberOfChannels; c++) {
    const dst = out.getChannelData(c);
    const orig = src.getChannelData(c);
    for (let i = 0; i < n; i++) {
      const k = i / n; // 0 → 1 across the seam
      const tail = dst[dst.length - n + i];
      const lead = orig[a - n + i]; // what naturally plays just before the loop start
      dst[dst.length - n + i] = tail * Math.cos((k * Math.PI) / 2) + lead * Math.sin((k * Math.PI) / 2);
    }
  }
  return out;
}
