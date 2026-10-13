import * as THREE from 'three';
import { puffTexture } from '../world/textures';

const tmpM = new THREE.Matrix4();
const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

export interface EmitOpts {
  life: number;
  size: number;
  grow: number; // final size multiplier
  color: THREE.ColorRepresentation;
  color2?: THREE.ColorRepresentation; // colour at end of life
  gravity?: number; // positive = rises
  drag?: number;
  alpha?: number;
}

/** Camera-facing billboard particles with per-instance colour/alpha. */
export class Particles {
  private mesh: THREE.InstancedMesh;
  private color: THREE.InstancedBufferAttribute;
  private alpha: THREE.InstancedBufferAttribute;
  private p: { pos: THREE.Vector3; vel: THREE.Vector3; t: number; o: Required<EmitOpts>; c1: THREE.Color; c2: THREE.Color; spin: number }[] = [];
  private next = 0;
  private live = 0;

  constructor(scene: THREE.Scene, private max: number, additive: boolean) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.color = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    geo.setAttribute('aColor', this.color);
    geo.setAttribute('aAlpha', this.alpha);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { map: { value: puffTexture() } },
      vertexShader: `
        attribute vec3 aColor; attribute float aAlpha;
        varying vec3 vC; varying float vA; varying vec2 vUv;
        void main(){
          vUv = uv; vC = aColor; vA = aAlpha;
          vec3 c = (instanceMatrix * vec4(0.0,0.0,0.0,1.0)).xyz;
          float s = length(instanceMatrix[0].xyz);
          float r = atan(instanceMatrix[0].y, instanceMatrix[0].x);
          vec2 q = vec2(cos(r)*position.x - sin(r)*position.y, sin(r)*position.x + cos(r)*position.y);
          vec4 mv = modelViewMatrix * vec4(c,1.0);
          mv.xy += q * s;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D map; varying vec3 vC; varying float vA; varying vec2 vUv;
        void main(){ float a = texture2D(map, vUv).a * vA; if (a < 0.003) discard; gl_FragColor = vec4(vC, a); }`,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 4 : 3;
    for (let i = 0; i < max; i++) {
      this.p.push({ pos: new THREE.Vector3(), vel: new THREE.Vector3(), t: 0, o: null!, c1: new THREE.Color(), c2: new THREE.Color(), spin: 0 });
      this.mesh.setMatrixAt(i, tmpM.makeScale(0, 0, 0));
    }
    scene.add(this.mesh);
  }

  emit(pos: THREE.Vector3, vel: THREE.Vector3, o: EmitOpts) {
    const s = this.p[this.next];
    this.next = (this.next + 1) % this.max;
    s.pos.copy(pos);
    s.vel.copy(vel);
    s.t = 0;
    s.o = { gravity: 0, drag: 1, alpha: 1, color2: o.color, ...o } as Required<EmitOpts>;
    s.c1.set(o.color);
    s.c2.set(o.color2 ?? o.color);
    s.spin = Math.random() * Math.PI * 2;
    this.live = this.max;
  }

  update(dt: number) {
    if (!this.live) return;
    let alive = 0;
    const c = new THREE.Color();
    for (let i = 0; i < this.max; i++) {
      const s = this.p[i];
      if (!s.o || s.t >= s.o.life) {
        if (this.alpha.getX(i) !== 0) {
          this.alpha.setX(i, 0);
          this.mesh.setMatrixAt(i, tmpM.makeScale(0, 0, 0));
        }
        continue;
      }
      alive++;
      s.t += dt;
      const k = Math.min(1, s.t / s.o.life);
      s.vel.y += s.o.gravity * dt;
      s.vel.multiplyScalar(Math.exp(-s.o.drag * dt));
      s.pos.addScaledVector(s.vel, dt);
      const size = s.o.size * (1 + (s.o.grow - 1) * Math.sqrt(k));
      tmpQ.setFromAxisAngle(new THREE.Vector3(0, 0, 1), s.spin + k * 0.8);
      tmpM.compose(s.pos, tmpQ, tmpV.set(size, size, size));
      this.mesh.setMatrixAt(i, tmpM);
      c.copy(s.c1).lerp(s.c2, k);
      this.color.setXYZ(i, c.r, c.g, c.b);
      const fadeIn = Math.min(1, k * 8);
      this.alpha.setX(i, s.o.alpha * fadeIn * (1 - k) * (1 - k * 0.3));
    }
    this.live = alive;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.color.needsUpdate = true;
    this.alpha.needsUpdate = true;
  }
}

/** Short-lived glowing streaks: sparks (ballistic) and tracers (static). */
export class Streaks {
  private mesh: THREE.InstancedMesh;
  private s: { a: THREE.Vector3; b: THREE.Vector3; vel: THREE.Vector3; t: number; life: number; width: number; ballistic: boolean; len: number }[] = [];
  private next = 0;

  constructor(scene: THREE.Scene, private max: number, color: THREE.ColorRepresentation) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0, 0.5);
    const mat = new THREE.MeshBasicMaterial({ color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.frustumCulled = false;
    for (let i = 0; i < max; i++) {
      this.s.push({ a: new THREE.Vector3(), b: new THREE.Vector3(), vel: new THREE.Vector3(), t: 1, life: 0, width: 0, ballistic: false, len: 0 });
      this.mesh.setMatrixAt(i, tmpM.makeScale(0, 0, 0));
    }
    scene.add(this.mesh);
  }

  tracer(a: THREE.Vector3, b: THREE.Vector3, width = 0.05, life = 0.06) {
    const s = this.s[this.next];
    this.next = (this.next + 1) % this.max;
    s.a.copy(a);
    s.b.copy(b);
    s.t = 0;
    s.life = life;
    s.width = width;
    s.ballistic = false;
  }

  spark(p: THREE.Vector3, vel: THREE.Vector3, life = 0.35) {
    const s = this.s[this.next];
    this.next = (this.next + 1) % this.max;
    s.a.copy(p);
    s.vel.copy(vel);
    s.t = 0;
    s.life = life * (0.6 + Math.random() * 0.8);
    s.width = 0.025;
    s.len = 0.25 + Math.random() * 0.2;
    s.ballistic = true;
  }

  update(dt: number) {
    for (let i = 0; i < this.max; i++) {
      const s = this.s[i];
      if (s.t >= s.life) {
        if (s.life > 0) {
          this.mesh.setMatrixAt(i, tmpM.makeScale(0, 0, 0));
          s.life = 0;
        }
        continue;
      }
      s.t += dt;
      if (s.ballistic) {
        s.vel.y -= 9.81 * dt;
        s.a.addScaledVector(s.vel, dt);
        if (s.a.y < 0.02 && s.vel.y < 0) {
          s.a.y = 0.02;
          s.vel.y *= -0.35;
          s.vel.x *= 0.6;
          s.vel.z *= 0.6;
        }
        s.b.copy(s.a).addScaledVector(s.vel, -s.len / Math.max(1, s.vel.length()));
      }
      const len = s.a.distanceTo(s.b);
      if (len < 1e-4) continue;
      tmpV.subVectors(s.a, s.b).normalize();
      tmpQ.setFromUnitVectors(new THREE.Vector3(0, 0, 1), tmpV);
      const fade = 1 - s.t / s.life;
      tmpM.compose(s.b, tmpQ, new THREE.Vector3(s.width * fade, s.width * fade, len));
      this.mesh.setMatrixAt(i, tmpM);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Instanced box chunks with cheap ballistic physics (no rigid bodies). */
export class Debris {
  private mesh: THREE.InstancedMesh;
  private d: { p: THREE.Vector3; v: THREE.Vector3; q: THREE.Quaternion; w: THREE.Vector3; s: THREE.Vector3; t: number; life: number; floor: number }[] = [];
  private next = 0;

  constructor(scene: THREE.Scene, private max: number) {
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.1 });
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, max);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3).fill(1), 3);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    for (let i = 0; i < max; i++) {
      this.d.push({ p: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(), w: new THREE.Vector3(), s: new THREE.Vector3(), t: 0, life: 0, floor: 0 });
      this.mesh.setMatrixAt(i, tmpM.makeScale(0, 0, 0));
    }
    scene.add(this.mesh);
  }

  burst(center: THREE.Vector3, count: number, color: THREE.Color, size: number, speed: number, floor: number) {
    const c = new THREE.Color();
    for (let k = 0; k < count; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.max;
      const d = this.d[i];
      d.p.copy(center).add(tmpV.set((Math.random() - 0.5) * size, Math.random() * size * 0.5, (Math.random() - 0.5) * size));
      const dir = new THREE.Vector3(Math.random() - 0.5, 0.4 + Math.random(), Math.random() - 0.5).normalize();
      d.v.copy(dir).multiplyScalar(speed * (0.4 + Math.random() * 0.8));
      d.q.random();
      d.w.set((Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16);
      const sz = size * (0.12 + Math.random() * 0.22);
      d.s.set(sz * (0.6 + Math.random()), sz * (0.3 + Math.random() * 0.6), sz * (0.6 + Math.random()));
      d.t = 0;
      d.life = 3 + Math.random() * 2.5;
      d.floor = floor;
      c.copy(color).multiplyScalar(0.55 + Math.random() * 0.5);
      this.mesh.setColorAt(i, c);
    }
    this.mesh.instanceColor!.needsUpdate = true;
  }

  update(dt: number) {
    const dq = new THREE.Quaternion();
    for (let i = 0; i < this.max; i++) {
      const d = this.d[i];
      if (d.t >= d.life) {
        if (d.life > 0) {
          this.mesh.setMatrixAt(i, tmpM.makeScale(0, 0, 0));
          d.life = 0;
        }
        continue;
      }
      d.t += dt;
      d.v.y -= 9.81 * dt;
      d.p.addScaledVector(d.v, dt);
      const half = d.s.y / 2;
      if (d.p.y < d.floor + half) {
        d.p.y = d.floor + half;
        if (d.v.y < 0) d.v.y *= -0.3;
        d.v.x *= 0.7;
        d.v.z *= 0.7;
        d.w.multiplyScalar(0.7);
      }
      const wl = d.w.length();
      if (wl > 0.01) {
        dq.setFromAxisAngle(tmpV.copy(d.w).divideScalar(wl), wl * dt);
        d.q.premultiply(dq);
      }
      const shrink = Math.min(1, (d.life - d.t) / 0.6);
      tmpM.compose(d.p, d.q, tmpV.copy(d.s).multiplyScalar(shrink));
      this.mesh.setMatrixAt(i, tmpM);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Pool of point lights for muzzle flashes and explosions. */
export class Flashes {
  private lights: { l: THREE.PointLight; t: number; life: number; peak: number }[] = [];
  private next = 0;

  constructor(scene: THREE.Scene, n = 4) {
    for (let i = 0; i < n; i++) {
      const l = new THREE.PointLight(0xffa040, 0, 40, 1.6);
      scene.add(l);
      this.lights.push({ l, t: 1, life: 0, peak: 0 });
    }
  }

  flash(p: THREE.Vector3, intensity: number, life: number, distance: number, color: THREE.ColorRepresentation = 0xffa040) {
    const f = this.lights[this.next];
    this.next = (this.next + 1) % this.lights.length;
    f.l.position.copy(p);
    f.l.color.set(color);
    f.l.distance = distance;
    f.peak = intensity;
    f.t = 0;
    f.life = life;
  }

  update(dt: number) {
    for (const f of this.lights) {
      if (f.t >= f.life) {
        f.l.intensity = 0;
        continue;
      }
      f.t += dt;
      const k = f.t / f.life;
      f.l.intensity = f.peak * (1 - k) * (1 - k);
    }
  }
}

/** Expanding ground rings for explosion shockwaves. */
export class Rings {
  private rings: { m: THREE.Mesh; t: number; life: number; r: number }[] = [];
  private next = 0;

  constructor(scene: THREE.Scene, n = 6) {
    const geo = new THREE.RingGeometry(0.85, 1, 48);
    geo.rotateX(-Math.PI / 2);
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
      m.visible = false;
      scene.add(m);
      this.rings.push({ m, t: 1, life: 0, r: 1 });
    }
  }

  spawn(p: THREE.Vector3, radius: number) {
    const r = this.rings[this.next];
    this.next = (this.next + 1) % this.rings.length;
    r.m.position.copy(p).setY(p.y + 0.05);
    r.t = 0;
    r.life = 0.45;
    r.r = radius;
    r.m.visible = true;
  }

  update(dt: number) {
    for (const r of this.rings) {
      if (!r.m.visible) continue;
      r.t += dt;
      const k = r.t / r.life;
      if (k >= 1) {
        r.m.visible = false;
        continue;
      }
      r.m.scale.setScalar(0.5 + r.r * Math.sqrt(k));
      (r.m.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - k);
    }
  }
}

/** All combat effects bundled together. */
export class CombatFx {
  readonly fire: Particles;
  readonly smoke: Particles;
  readonly sparks: Streaks;
  readonly tracers: Streaks;
  readonly debris: Debris;
  readonly flashes: Flashes;
  readonly rings: Rings;

  constructor(scene: THREE.Scene) {
    this.smoke = new Particles(scene, 500, false);
    this.fire = new Particles(scene, 400, true);
    this.sparks = new Streaks(scene, 300, 0xffc46b);
    this.tracers = new Streaks(scene, 60, 0xfff0a8);
    this.debris = new Debris(scene, 500);
    this.flashes = new Flashes(scene, 4);
    this.rings = new Rings(scene, 6);
  }

  impactSparks(p: THREE.Vector3, normal: THREE.Vector3, n = 6) {
    for (let i = 0; i < n; i++) {
      const v = normal.clone().multiplyScalar(4 + Math.random() * 5).add(new THREE.Vector3((Math.random() - 0.5) * 7, Math.random() * 5, (Math.random() - 0.5) * 7));
      this.sparks.spark(p, v);
    }
    this.smoke.emit(p, normal.clone().multiplyScalar(0.8), { life: 0.9, size: 0.35, grow: 3, color: 0xb8b2a6, alpha: 0.5, drag: 2 });
  }

  explosion(p: THREE.Vector3, scale = 1) {
    for (let i = 0; i < 22 * scale; i++) {
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9 + 0.1, Math.random() - 0.5).normalize();
      this.fire.emit(p.clone().addScaledVector(dir, Math.random() * scale), dir.multiplyScalar(4 + Math.random() * 7 * scale), {
        life: 0.5 + Math.random() * 0.5, size: 1.4 * scale, grow: 3.2, color: 0xfff1c0, color2: 0xff3d0a, gravity: 2, drag: 3, alpha: 1,
      });
    }
    for (let i = 0; i < 16 * scale; i++) {
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 + 0.3, Math.random() - 0.5).normalize();
      this.smoke.emit(p.clone().addScaledVector(dir, Math.random() * 1.5 * scale), dir.multiplyScalar(2 + Math.random() * 3 * scale), {
        life: 2.5 + Math.random() * 2.5, size: 1.6 * scale, grow: 4.5, color: 0x2a2624, color2: 0x6b665f, gravity: 1.2, drag: 1.2, alpha: 0.85,
      });
    }
    for (let i = 0; i < 26 * scale; i++) {
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9, Math.random() - 0.5).normalize().multiplyScalar(8 + Math.random() * 14);
      this.sparks.spark(p, v, 0.8);
    }
    this.flashes.flash(p.clone().setY(p.y + 1), 900 * scale, 0.5, 45 * scale);
    this.rings.spawn(p, 9 * scale);
  }

  /** Flames + smoke rising from a burning wreck. */
  burn(p: THREE.Vector3, dt: number, intensity = 1) {
    if (Math.random() < dt * 26 * intensity) {
      this.fire.emit(p.clone().add(new THREE.Vector3((Math.random() - 0.5) * 1.4, 0, (Math.random() - 0.5) * 2.2)), new THREE.Vector3(0, 1.5 + Math.random() * 2, 0), {
        life: 0.5 + Math.random() * 0.4, size: 0.8, grow: 1.8, color: 0xffe08a, color2: 0xff3300, gravity: 3, drag: 1, alpha: 0.9,
      });
    }
    if (Math.random() < dt * 9 * intensity) {
      this.smoke.emit(p.clone().add(new THREE.Vector3(0, 1, 0)), new THREE.Vector3((Math.random() - 0.5) * 0.6, 2 + Math.random(), (Math.random() - 0.5) * 0.6), {
        life: 4 + Math.random() * 2, size: 1.0, grow: 6, color: 0x1f1d1c, color2: 0x77736c, gravity: 0.4, drag: 0.4, alpha: 0.7,
      });
    }
  }

  update(dt: number) {
    this.fire.update(dt);
    this.smoke.update(dt);
    this.sparks.update(dt);
    this.tracers.update(dt);
    this.debris.update(dt);
    this.flashes.update(dt);
    this.rings.update(dt);
  }
}

export { UP };
