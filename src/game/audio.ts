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
  rpm = 900;
  gear = 1;

  private static RATIOS = [0, 3.4, 2.2, 1.55, 1.18, 0.92, 0.74];

  start() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.55;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);

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
    mix.connect(shaper).connect(this.engFilter).connect(this.engGain).connect(this.master);
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
    screechSrc.connect(this.screechFilter).connect(this.screechGain).connect(this.master);
    screechSrc.start();

    const windSrc = ctx.createBufferSource();
    windSrc.buffer = this.noise;
    windSrc.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 500;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    windSrc.connect(windFilter).connect(this.windGain).connect(this.master);
    windSrc.start();
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.55, this.ctx.currentTime, 0.05);
    return this.muted;
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
    src.connect(lp).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 0.7);
    const thump = ctx.createOscillator();
    thump.frequency.setValueAtTime(110, t);
    thump.frequency.exponentialRampToValueAtTime(40, t + 0.2);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(v * 0.9, t);
    tg.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    thump.connect(tg).connect(this.master);
    thump.start(t);
    thump.stop(t + 0.35);
  }

  /** One machine-gun round: sharp noise crack plus a low punch. */
  gunshot() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800 + Math.random() * 600;
    bp.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t, Math.random() * 1.5);
    src.stop(t + 0.1);
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(50, t + 0.06);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.25, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    o.connect(og).connect(this.master);
    o.start(t);
    o.stop(t + 0.08);
  }

  /** Missile launch: rising filtered whoosh. */
  launch() {
    if (!this.ctx) return;
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
    g.gain.exponentialRampToValueAtTime(0.7, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.1);
    src.connect(f).connect(g).connect(this.master);
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
    src.connect(lp).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + 1.9);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(70, t);
    o.frequency.exponentialRampToValueAtTime(25, t + 0.9);
    const og = ctx.createGain();
    og.gain.setValueAtTime(vol * 1.2, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 1.0);
    o.connect(og).connect(this.master);
    o.start(t);
    o.stop(t + 1.05);
  }
}
