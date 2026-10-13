import type { DriveInput } from './vehiclePhysics';
import type { RemoteLink } from './net';

/** Merges keyboard (fallback/testing) with the phone touchpad. */
export class Controls {
  private keys = new Set<string>();
  private kbSteer = 0;
  private kbThrottle = 0;
  private smoothSteer = 0;
  private smoothThrottle = 0;
  private kbMissiles = 0;
  /** weapon state merged from keyboard and phone */
  readonly weapons = { gun: false, missileSeq: 0 };
  source: 'phone' | 'keyboard' | 'none' = 'none';

  constructor(private link: RemoteLink) {
    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'KeyG') this.kbMissiles++;
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  has(code: string) {
    return this.keys.has(code);
  }

  read(dt: number): DriveInput {
    const k = this.keys;
    const left = k.has('KeyA') || k.has('ArrowLeft');
    const right = k.has('KeyD') || k.has('ArrowRight');
    const up = k.has('KeyW') || k.has('ArrowUp');
    const down = k.has('KeyS') || k.has('ArrowDown');
    const kbActive = left || right || up || down || k.has('Space');

    // keyboard is digital: ramp it so it feels analog
    const steerT = (right ? 1 : 0) - (left ? 1 : 0);
    const thrT = (up ? 1 : 0) - (down ? 1 : 0);
    this.kbSteer += clampStep(steerT - this.kbSteer, dt * (steerT === 0 ? 6 : 3.5));
    this.kbThrottle += clampStep(thrT - this.kbThrottle, dt * 4);

    let steer: number, throttle: number;
    if (this.link.fresh() && (this.link.state.active || !kbActive)) {
      this.source = 'phone';
      // light smoothing to hide network jitter; response curve for finer control near centre
      const s = this.link.state;
      const curve = (v: number) => Math.sign(v) * Math.pow(Math.abs(v), 1.35);
      this.smoothSteer += (curve(s.x) - this.smoothSteer) * Math.min(1, dt * 18);
      this.smoothThrottle += (s.y - this.smoothThrottle) * Math.min(1, dt * 14);
      steer = this.smoothSteer;
      throttle = this.smoothThrottle;
    } else {
      this.source = kbActive ? 'keyboard' : this.source === 'phone' && this.link.phones > 0 ? 'phone' : this.source;
      steer = this.kbSteer;
      throttle = this.kbThrottle;
      this.smoothSteer = steer;
      this.smoothThrottle = throttle;
    }
    // weapons: either source can fire; missile presses from both are summed
    this.weapons.gun = k.has('KeyF') || (this.link.fresh() && this.link.state.gun);
    this.weapons.missileSeq = this.kbMissiles + this.link.state.missileSeq;
    return { steer, throttle, handbrake: k.has('Space') };
  }
}

const clampStep = (v: number, max: number) => Math.max(-max, Math.min(max, v));
