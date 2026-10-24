import bgmUrl from '../../bgm.mp3?url';

/**
 * Soundtrack from bgm.mp3, kept deliberately simple so nothing ever overlaps:
 *   - on the player's first movement: 0:00–0:08 plays once (the engine rev-up into gear 1)
 *   - right after it ends: 0:09–0:18 loops for as long as the game runs
 *   - during a stunt the drive music ducks out and the stunt score plays instead:
 *       3:56 → 3:58 as written, then the bar starting at 3:58 repeats for as long as the
 *       stunt lasts, then 3:58 → 4:00 starts on the next bar line to finish.
 *       A short stunt plays 3:56 → 4:00 straight through.
 *
 * Only these clips are kept in memory. All parts are AudioBuffers scheduled
 * sample-accurately on the audio clock.
 */

const INTRO = { start: 0, end: 8.0 };
const LOOP = { start: 9.0, end: 18.0 };
const MUSIC_VOLUME = 0.6;
/** Length of the blend baked into the loop seam so it repeats without a click. */
const SEAM = 0.025;

/** Stunt score: 3:56 → 3:58 (head), the bar from 3:58 on repeat (hold), 3:58 → 4:00 (tail). */
const STUNT = { start: 236, pivot: 238, end: 240 };
/** One bar of the track at 128 BPM. */
const BAR = 60 / 128 * 4;
const STUNT_VOLUME = 1.15;
/** Seam blended into the repeating bar so it wraps without a click. */
const BAR_SEAM = 0.06;

export class MusicDirector {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  /** Drive music (intro + loop); ducked to silence while a stunt score plays. */
  private drive: GainNode | null = null;
  private intro: AudioBuffer | null = null;
  private loop: AudioBuffer | null = null;
  private head: AudioBuffer | null = null;
  private hold: AudioBuffer | null = null;
  private tail: AudioBuffer | null = null;
  private requested = false;
  private started = false;
  private enabled = true;
  /** soundtrack volume, 0–1 (1 = the original level) */
  private volume = 1;
  /** Output of the stunt score currently playing. */
  private scoreNode: GainNode | null = null;
  private stunt: { headEnd: number; holdSrc: AudioBufferSourceNode; end: number } | null = null;

  /** Connect to the game's audio graph (called once audio is unlocked) and prepare the clips. */
  attach(ctx: AudioContext, bus: GainNode) {
    if (this.ctx) return;
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = this.level();
    this.out.connect(bus);
    this.drive = ctx.createGain();
    this.drive.connect(this.out);
    void this.load(ctx);
  }

  private async load(ctx: AudioContext) {
    try {
      const data = await (await fetch(bgmUrl)).arrayBuffer();
      const full = await ctx.decodeAudioData(data);
      this.intro = slice(ctx, full, INTRO.start, INTRO.end);
      this.loop = seamlessLoop(ctx, full, LOOP.start, LOOP.end);
      this.head = slice(ctx, full, STUNT.start, STUNT.pivot);
      this.hold = seamlessLoop(ctx, full, STUNT.pivot, STUNT.pivot + BAR, BAR_SEAM);
      this.tail = slice(ctx, full, STUNT.pivot, STUNT.end);
      fadeEdges(this.tail, 0, 0.03);
      // the full decode is dropped here; only the short clips stay in memory
      if (this.requested) this.begin();
    } catch (err) {
      console.warn('[music] could not load the soundtrack', err);
    }
  }

  /** First movement: intro once, then the loop. Safe to call more than once. */
  begin() {
    this.requested = true;
    const ctx = this.ctx;
    if (!ctx || !this.drive || !this.intro || !this.loop || this.started) return;
    this.started = true;
    const t0 = ctx.currentTime + 0.05;
    const intro = ctx.createBufferSource();
    intro.buffer = this.intro;
    intro.connect(this.drive);
    intro.start(t0);
    const loop = ctx.createBufferSource();
    loop.buffer = this.loop;
    loop.loop = true;
    loop.connect(this.drive);
    loop.start(t0 + this.intro.duration);
  }

  /** Can a stunt score play right now (loaded, audio running, music switched on)? */
  get stuntReady() {
    return !!(this.ctx && this.ctx.state === 'running' && this.head && this.hold && this.tail && this.enabled);
  }

  /**
   * Start the stunt score: duck the drive music and play 3:56 → 3:58, then repeat the
   * bar from 3:58 until `stuntFinish`. Returns false if the score can't play.
   */
  stuntStart(): boolean {
    const ctx = this.ctx;
    if (!this.stuntReady || !ctx || !this.out || !this.drive || this.stunt) return false;
    const now = ctx.currentTime;
    const t0 = now + 0.03;
    this.drive.gain.cancelScheduledValues(now);
    this.drive.gain.setValueAtTime(this.drive.gain.value, now);
    this.drive.gain.linearRampToValueAtTime(0, t0 + 0.05);

    const score = ctx.createGain();
    score.gain.value = STUNT_VOLUME;
    score.connect(this.out);
    const head = ctx.createBufferSource();
    head.buffer = this.head;
    head.connect(score);
    head.start(t0);
    const headEnd = t0 + this.head!.duration;
    // the bar picks up exactly where the head stops, and each repeat wraps back to 3:58
    const holdSrc = ctx.createBufferSource();
    holdSrc.buffer = this.hold;
    holdSrc.loop = true;
    holdSrc.connect(score);
    holdSrc.start(headEnd);
    this.stunt = { headEnd, holdSrc, end: headEnd + this.tail!.duration };
    this.scoreNode = score;
    return true;
  }

  /**
   * Land the score: finish the bar that's playing, then 3:58 → 4:00 from the next bar
   * line (or straight on from the head if the bar hasn't started yet).
   * Returns the seconds left until the score ends on 4:00.
   */
  stuntFinish(): number {
    const ctx = this.ctx;
    const s = this.stunt;
    if (!ctx || !s || !this.scoreNode || !this.tail || !this.hold) return 0;
    const now = ctx.currentTime;
    // the tail starts with the same audio as every repeat, so swapping on a bar line is seamless
    const bar = this.hold.duration;
    const bars = Math.max(0, Math.ceil((now + 0.03 - s.headEnd) / bar));
    const tailStart = s.headEnd + bars * bar;
    s.holdSrc.stop(tailStart);
    const tail = ctx.createBufferSource();
    tail.buffer = this.tail;
    tail.connect(this.scoreNode);
    tail.start(tailStart);
    s.end = tailStart + this.tail.duration;
    // bring the drive music back in once the score has ended
    const g = this.drive!.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(0, now);
    g.setValueAtTime(0, s.end + 0.15);
    g.linearRampToValueAtTime(1, s.end + 1.6);
    const score = this.scoreNode;
    tail.onended = () => score.disconnect();
    this.scoreNode = null;
    this.stunt = null;
    return s.end - now;
  }

  /** Abort a stunt score immediately (e.g. the player reset the car). */
  stuntCancel() {
    const ctx = this.ctx;
    if (!ctx || !this.stunt || !this.scoreNode) return;
    const now = ctx.currentTime;
    this.scoreNode.gain.setTargetAtTime(0, now, 0.05);
    this.stunt.holdSrc.stop(now + 0.3);
    const score = this.scoreNode;
    setTimeout(() => score.disconnect(), 500);
    const g = this.drive!.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(1, now + 1.2);
    this.stunt = null;
    this.scoreNode = null;
  }

  toggle() {
    return this.setEnabled(!this.enabled);
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    this.applyLevel();
    return this.enabled;
  }

  get isEnabled() {
    return this.enabled;
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    this.applyLevel();
  }

  get musicVolume() {
    return this.volume;
  }

  private level() {
    return this.enabled ? MUSIC_VOLUME * this.volume : 0;
  }

  private applyLevel() {
    if (this.ctx && this.out) this.out.gain.setTargetAtTime(this.level(), this.ctx.currentTime, 0.2);
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

/** Short linear fades at the start/end of a buffer, in place. */
function fadeEdges(buf: AudioBuffer, inSec: number, outSec: number) {
  const nIn = Math.floor(inSec * buf.sampleRate);
  const nOut = Math.floor(outSec * buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < nIn; i++) d[i] *= i / nIn;
    for (let i = 0; i < nOut; i++) d[d.length - 1 - i] *= i / nOut;
  }
}

/**
 * Slice [from, to) and blend its last few milliseconds toward the audio that leads
 * into `from`, so wrapping from the end back to the start is continuous.
 */
function seamlessLoop(ctx: AudioContext, src: AudioBuffer, from: number, to: number, seam = SEAM) {
  const out = slice(ctx, src, from, to);
  const sr = src.sampleRate;
  const n = Math.floor(seam * sr);
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
