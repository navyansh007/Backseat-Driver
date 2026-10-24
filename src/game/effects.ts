import * as THREE from 'three/webgpu';
import { attribute, texture, uv, varying, vec3, vec4 } from 'three/tsl';
import { billboardGeometry, billboardVertex, dynamicInstanced } from './render/billboard';
import { puffTexture } from './world/textures';

const SKID_V = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

/** Ring-buffer of skid-mark quads laid on the ground. */
export class SkidMarks {
  private max = 3000;
  private geo = new THREE.BufferGeometry();
  private pos: Float32Array;
  private alpha: Float32Array;
  private next = 0;
  private last: (THREE.Vector3 | null)[] = [null, null, null, null];

  constructor(scene: THREE.Scene) {
    this.pos = new Float32Array(this.max * 6 * 3);
    this.alpha = new Float32Array(this.max * 6);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.NodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.fog = false;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -4;
    mat.polygonOffsetUnits = -4;
    mat.fragmentNode = vec4(0.06, 0.06, 0.07, varying(attribute('alpha', 'float')).mul(0.55));
    const mesh = new THREE.Mesh(this.geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    scene.add(mesh);
  }

  /** p: contact point, side: unit vector across the tyre. */
  add(wheel: number, p: THREE.Vector3 | null, side: THREE.Vector3, strength: number) {
    const prev = this.last[wheel];
    if (!p || strength <= 0) {
      this.last[wheel] = null;
      return;
    }
    if (!prev) {
      this.last[wheel] = p.clone();
      return;
    }
    if (prev.distanceToSquared(p) < 0.09) return;
    const w = 0.11;
    const a1 = SKID_V[0].copy(prev).addScaledVector(side, w), a2 = SKID_V[1].copy(prev).addScaledVector(side, -w);
    const b1 = SKID_V[2].copy(p).addScaledVector(side, w), b2 = SKID_V[3].copy(p).addScaledVector(side, -w);
    const verts = [a1, a2, b1, a2, b2, b1];
    const base = this.next * 18;
    const a = Math.min(1, strength);
    for (let i = 0; i < 6; i++) {
      const v = verts[i];
      this.pos[base + i * 3] = v.x;
      this.pos[base + i * 3 + 1] = v.y + 0.015;
      this.pos[base + i * 3 + 2] = v.z;
      this.alpha[this.next * 6 + i] = a;
    }
    // upload just this segment, not the whole ring buffer
    const posAttr = this.geo.attributes.position as THREE.BufferAttribute;
    const alphaAttr = this.geo.attributes.alpha as THREE.BufferAttribute;
    posAttr.addUpdateRange(base, 18);
    alphaAttr.addUpdateRange(this.next * 6, 6);
    posAttr.needsUpdate = true;
    alphaAttr.needsUpdate = true;
    this.next = (this.next + 1) % this.max;
    prev.copy(p);
  }
}

/** Billboarded instanced smoke puffs with per-instance alpha. */
export class Smoke {
  private max = 220;
  private center: THREE.InstancedBufferAttribute;
  private alphaAttr: THREE.InstancedBufferAttribute;
  private parts: { p: THREE.Vector3; v: THREE.Vector3; life: number; ttl: number; size: number }[] = [];
  private next = 0;

  constructor(scene: THREE.Scene) {
    const geo = billboardGeometry(this.max);
    this.center = dynamicInstanced(this.max, 4);
    this.alphaAttr = dynamicInstanced(this.max, 1);
    geo.setAttribute('aCenter', this.center);
    geo.setAttribute('aAlpha', this.alphaAttr);
    const mat = new THREE.NodeMaterial();
    mat.transparent = true;
    mat.depthWrite = false;
    mat.fog = false;
    mat.vertexNode = billboardVertex(attribute('aCenter', 'vec4'));
    const vA = varying(attribute('aAlpha', 'float'));
    mat.fragmentNode = vec4(vec3(0.86, 0.87, 0.88), texture(puffTexture(), uv()).a.mul(vA).mul(0.5));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    for (let i = 0; i < this.max; i++) {
      this.parts.push({ p: new THREE.Vector3(), v: new THREE.Vector3(), life: 0, ttl: 1, size: 0 });
    }
    scene.add(mesh);
  }

  emit(p: THREE.Vector3, vel: THREE.Vector3, amount: number) {
    const s = this.parts[this.next];
    this.next = (this.next + 1) % this.max;
    s.p.copy(p).add(TMP.set((Math.random() - 0.5) * 0.3, 0.15, (Math.random() - 0.5) * 0.3));
    s.v.copy(vel).multiplyScalar(0.15).add(TMP.set((Math.random() - 0.5) * 0.8, 0.6 + Math.random() * 0.6, (Math.random() - 0.5) * 0.8));
    s.ttl = 1.2 + Math.random() * 1.2;
    s.life = s.ttl;
    s.size = 0.5 + amount * 0.6;
  }

  update(dt: number) {
    const c = this.center.array as Float32Array;
    const a = this.alphaAttr.array as Float32Array;
    for (let i = 0; i < this.max; i++) {
      const s = this.parts[i];
      if (s.life <= 0) {
        a[i] = 0;
        continue;
      }
      s.life -= dt;
      s.p.addScaledVector(s.v, dt);
      s.v.multiplyScalar(Math.exp(-dt * 1.2));
      const k = 1 - s.life / s.ttl;
      c[i * 4] = s.p.x;
      c[i * 4 + 1] = s.p.y;
      c[i * 4 + 2] = s.p.z;
      c[i * 4 + 3] = s.size * (1 + k * 3.5);
      a[i] = Math.max(0, Math.sin(Math.min(1, k * 4) * Math.PI / 2) * (1 - k));
    }
    this.center.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
  }
}

const TMP = new THREE.Vector3();
