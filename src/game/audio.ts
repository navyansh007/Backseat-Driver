/** Sound-effect level relative to the music. */
const SFX_LEVEL = 0.75;

/** Procedural car audio with WebAudio: engine, tyres, wind, impacts. */
export class CarAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engA!: OscillatorNode;
  private engB!: OscillatorNode;
  private engSub!: OscillatorNode;
  private engFilter!: BiquadFilterNode;
  private engGain!: GainNode;
  private screechGain!: GainNode;
  private screechFilter!: BiquadFilterNode;
  private windGain!: GainNode;
  private noise!: AudioBuffer;
  private muted = false;
  /** master volume, 0–1 (1 = the original mix level) */
  private volume = 1;
  rpm = 900;
  gear = 1;

  private static RATIOS = [0, 3.4, 2.2, 1.55, 1.18, 0.92, 0.74];

  /** Bus for engine, tyres, wind, guns and explosions. */
  private sfx!: GainNode;
  /** Bus for the soundtrack; goes through the master so `M` mutes everything. */
  musicBus: GainNode | null = null;
  private readyCallbacks: ((ctx: AudioContext, bus: GainNode) => void)[] = [];

  /** Run cb once audio is allowed to play (after the first user gesture). */
  onReady(cb: (ctx: AudioContext, bus: GainNode) => void) {
    if (this.ctx && this.musicBus && this.ctx.state === 'running') cb(this.ctx, this.musicBus);
    else this.readyCallbacks.push(cb);
  }

  private flushReady() {
    if (!this.ctx || !this.musicBus || this.ctx.state !== 'running') return;
    const list = this.readyCallbacks.splice(0);
    for (const cb of list) cb(this.ctx, this.musicBus);
  }

  start() {
    if (this.ctx) {
      void this.ctx.resume().then(() => this.flushReady());
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.level();
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);
    this.musicBus = ctx.createGain();
    this.musicBus.connect(this.master);
    // all sound effects share one bus, kept ~25% below full so the soundtrack stays clear
    this.sfx = ctx.createGain();
    this.sfx.gain.value = SFX_LEVEL;
    this.sfx.connect(this.master);
    void ctx.resume().then(() => this.flushReady());

    // engine: two detuned saws + sub square → shaper → lowpass
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.Q.value = 2.5;
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0.0;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * 2.2);
    }
    shaper.curve = curve;
    const mix = ctx.createGain();
    mix.gain.value = 0.25;
    this.engA = ctx.createOscillator();
    this.engA.type = 'sawtooth';
    this.engB = ctx.createOscillator();
    this.engB.type = 'sawtooth';
    this.engB.detune.value = 9;
    this.engSub = ctx.createOscillator();
    this.engSub.type = 'square';
    const subGain = ctx.createGain();
    subGain.gain.value = 0.5;
    this.engA.connect(mix);
    this.engB.connect(mix);
    this.engSub.connect(subGain).connect(mix);
    mix.connect(shaper).connect(this.engFilter).connect(this.engGain).connect(this.sfx);
    for (const o of [this.engA, this.engB, this.engSub]) o.start();

    // noise sources
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    const screechSrc = ctx.createBufferSource();
    screechSrc.buffer = this.noise;
    screechSrc.loop = true;
    this.screechFilter = ctx.createBiquadFilter();
    this.screechFilter.type = 'bandpass';
    this.screechFilter.frequency.value = 1500;
    this.screechFilter.Q.value = 9;
    this.screechGain = ctx.createGain();
    this.screechGain.gain.value = 0;
    screechSrc.connect(this.screechFilter).connect(this.screechGain).connect(this.sfx);
    screechSrc.start();

    const windSrc = ctx.createBufferSource();
    windSrc.buffer = this.noise;
    windSrc.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 500;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    windSrc.connect(windFilter).connect(this.windGain).connect(this.sfx);
    windSrc.start();
  }

  toggleMute() {
    return this.setMuted(!this.muted);
  }

  setMuted(on: boolean) {
    this.muted = on;
    this.applyLevel();
    return this.muted;
  }

  get isMuted() {
    return this.muted;
  }

  /** True once the browser has let audio play (needs a click or key press on the game page). */
  get unlocked() {
    return this.ctx?.state === 'running';
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    this.applyLevel();
  }

  get masterVolume() {
    return this.volume;
  }

  private level() {
    return this.muted ? 0 : 0.55 * this.volume;
  }

  private applyLevel() {
    if (this.ctx) this.master.gain.setTargetAtTime(this.level(), this.ctx.currentTime, 0.05);
  }

  /** Silence every sound effect (stunt cinematics play the score alone), or bring them back. */
  silenceSfx(on: boolean) {
    if (!this.ctx) return;
    const g = this.sfx.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    if (on) g.linearRampToValueAtTime(0, now + 0.08);
    else g.linearRampToValueAtTime(SFX_LEVEL, now + 0.6);
  }

  /** speed m/s (abs), throttle 0..1, slip 0..1 */
  update(dt: number, speed: number, throttle: number, slip: number, reversing: boolean) {
    // simulated automatic gearbox
    const wheelRpm = (speed / (2 * Math.PI * 0.345)) * 60;
    const finalDrive = 3.15;
    if (reversing) this.gear = 1;
    let target = 800 + wheelRpm * CarAudio.RATIOS[this.gear] * finalDrive;
    if (target > 6000 && this.gear < 6) this.gear++;
    else if (this.gear > 1 && wheelRpm * CarAudio.RATIOS[this.gear - 1] * finalDrive < 3200) this.gear--;
    target = 800 + wheelRpm * CarAudio.RATIOS[this.gear] * finalDrive + throttle * 600;
    target = Math.min(target, 6800);
    this.rpm += (target - this.rpm) * Math.min(1, dt * 8);
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    // a V12 fires 6 times per crank revolution
    const f = (this.rpm / 60) * 3;
    this.engA.frequency.setTargetAtTime(f, t, 0.03);
    this.engB.frequency.setTargetAtTime(f * 1.004, t, 0.03);
    this.engSub.frequency.setTargetAtTime(f / 2, t, 0.03);
    this.engFilter.frequency.setTargetAtTime(350 + throttle * 1300 + this.rpm * 0.18, t, 0.05);
    this.engGain.gain.setTargetAtTime(0.16 + throttle * 0.2, t, 0.05);
    this.screechGain.gain.setTargetAtTime(Math.min(0.32, slip * 0.32), t, 0.04);
    this.screechFilter.frequency.setTargetAtTime(1300 + slip * 500, t, 0.1);
    this.windGain.gain.setTargetAtTime(Math.min(0.25, (speed / 35) ** 2 * 0.25), t, 0.2);
  }

  /** Leaves and twigs scraping along the bodywork when driving through a hedge. */
  rustle(power: number) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.5;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800 + Math.random() * 1400 + power * 1200;
    bp.Q.value = 0.8;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 700;
    const g = ctx.createGain();
    const v = Math.min(0.5, 0.08 + power * 0.4);
    const len = 0.18 + power * 0.25;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + 0.025);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    src.connect(bp).connect(hp).connect(g).connect(this.sfx);
    src.start(t, Math.random());
    src.stop(t + len + 0.05);
  }

  impact(power: number) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 600 + power * 2400;
    const g = ctx.createGain();
    const v = Math.min(1, 0.25 + power);
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25 + power * 0.3);
    src.connect(lp).connect(g).connect(this.sfx);
    src.start(t, Math.random());
    src.stop(t + 0.7);
    const thump = ctx.createOscillator();
    thump.frequency.setValueAtTime(110, t);
    thump.frequency.exponentialRampToValueAtTime(40, t + 0.2);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(v * 0.9, t);
    tg.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    thump.connect(tg).connect(this.sfx);
    thump.start(t);
    thump.stop(t + 0.35);
  }

  /** Filtered noise burst through the effects bus. */
  private noiseHit(filter: BiquadFilterType, freq: number, q: number, gain: number, len: number, delay = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    src.connect(f).connect(g).connect(this.sfx);
    src.start(t, Math.random());
    src.stop(t + len + 0.05);
    return f;
  }

  /** A tone sweeping from f0 to f1 through the effects bus. */
  private tone(type: OscillatorType, f0: number, f1: number, gain: number, len: number, delay = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + len);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    o.connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + len + 0.05);
  }

  /** A pursuer's rifle round, quieter with distance. */
  enemyShot(dist: number) {
    const k = Math.max(0.06, 1 - dist / 90);
    this.noiseHit('bandpass', 1100 + Math.random() * 400, 0.9, 0.42 * k, 0.12);
    this.tone('square', 120, 45, 0.16 * k, 0.07);
  }

  /** A round striking the player's car. */
  ricochet() {
    this.noiseHit('highpass', 3200, 0.7, 0.3, 0.06);
    this.tone('sine', 2400 + Math.random() * 1200, 900, 0.07, 0.16);
  }

  /** Dropping a trap from the boot. */
  deploy(kind: 'spikes' | 'oil' | 'mine' | 'smoke' | 'emp') {
    switch (kind) {
      case 'spikes':
        for (let i = 0; i < 4; i++) this.noiseHit('bandpass', 2600 + i * 300, 4, 0.22, 0.07, i * 0.05);
        this.tone('triangle', 520, 380, 0.08, 0.2);
        break;
      case 'oil':
        this.noiseHit('lowpass', 700, 0.8, 0.5, 0.5);
        this.tone('sine', 180, 60, 0.18, 0.35);
        break;
      case 'mine':
        this.noiseHit('bandpass', 1800, 6, 0.25, 0.06);
        this.tone('sine', 1400, 1400, 0.1, 0.09, 0.15);
        break;
      case 'smoke': {
        const f = this.noiseHit('highpass', 1400, 0.5, 0.45, 1.6);
        if (f && this.ctx) f.frequency.exponentialRampToValueAtTime(500, this.ctx.currentTime + 1.6);
        break;
      }
      case 'emp':
        this.tone('sawtooth', 90, 2400, 0.22, 0.5);
        this.tone('square', 2400, 60, 0.14, 0.9, 0.05);
        this.noiseHit('bandpass', 5000, 2, 0.3, 0.8);
        break;
    }
  }

  /** Armed-mine chirp. */
  beep(high: boolean) {
    this.tone('sine', high ? 2200 : 1500, high ? 2200 : 1500, 0.09, 0.07);
  }

  /** Electrical crackle on an EMP'd car. */
  crackle() {
    this.noiseHit('highpass', 4200, 1, 0.12, 0.05);
  }

  /** New wave: a two-tone siren. */
  siren() {
    for (let i = 0; i < 3; i++) {
      this.tone('triangle', 660, 660, 0.12, 0.28, i * 0.6);
      this.tone('triangle', 880, 880, 0.12, 0.28, i * 0.6 + 0.3);
    }
  }

  /** Wave cleared / repair kit picked up: a short rising chime. */
  chime(big = false) {
    const notes = big ? [523, 659, 784, 1047] : [784, 1175];
    notes.forEach((f, i) => this.tone('sine', f, f, 0.14, 0.4, i * 0.09));
  }

  /** One machine-gun round: sharp noise crack plus a low punch. `vol` scales it (other players' guns, further off). */
  gunshot(vol = 1) {
    if (!this.ctx || vol < 0.02) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800 + Math.random() * 600;
    bp.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5 * vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    src.connect(bp).connect(g).connect(this.sfx);
    src.start(t, Math.random() * 1.5);
    src.stop(t + 0.1);
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(50, t + 0.06);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.25 * vol, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    o.connect(og).connect(this.sfx);
    o.start(t);
    o.stop(t + 0.08);
  }

  /** Missile launch: rising filtered whoosh. */
  launch(vol = 1) {
    if (!this.ctx || vol < 0.02) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.2;
    f.frequency.setValueAtTime(300, t);
    f.frequency.exponentialRampToValueAtTime(2600, t + 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.7 * vol, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.1);
    src.connect(f).connect(g).connect(this.sfx);
    src.start(t, Math.random());
    src.stop(t + 1.2);
  }

  /** Explosion, attenuated by distance (metres). */
  explosion(distance: number, scale = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + Math.min(0.4, distance / 340);
    const vol = Math.min(1, (1.2 * scale) / (1 + distance / 25));
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2400, t);
    lp.frequency.exponentialRampToValueAtTime(140, t + 1.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.8);
    src.connect(lp).connect(g).connect(this.sfx);
    src.start(t, Math.random() * 0.5);
    src.stop(t + 1.9);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(25, t + 0.9);
    const og = ctx.createGain();
    og.gain.setValueAtTime(vol * 1.2, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 1.0);
    o.connect(og).connect(this.sfx);
    o.start(t);
    o.stop(t + 1.05);
  }
}
