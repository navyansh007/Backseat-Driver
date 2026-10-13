import * as THREE from 'three';
import { puffTexture } from './world/textures';

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
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      vertexShader: `attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying float vA; void main(){ gl_FragColor = vec4(0.06,0.06,0.07, vA * 0.55); }`,
    });
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
    const a1 = prev.clone().addScaledVector(side, w), a2 = prev.clone().addScaledVector(side, -w);
    const b1 = p.clone().addScaledVector(side, w), b2 = p.clone().addScaledVector(side, -w);
    const verts = [a1, a2, b1, a2, b2, b1];
    const base = this.next * 18;
    verts.forEach((v, i) => {
      this.pos[base + i * 3] = v.x;
      this.pos[base + i * 3 + 1] = v.y + 0.015;
      this.pos[base + i * 3 + 2] = v.z;
      this.alpha[this.next * 6 + i] = Math.min(1, strength);
    });
    this.next = (this.next + 1) % this.max;
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.alpha as THREE.BufferAttribute).needsUpdate = true;
    prev.copy(p);
  }
}

/** Billboarded instanced smoke puffs with per-instance alpha. */
export class Smoke {
  private max = 220;
  private mesh: THREE.InstancedMesh;
  private alphaAttr: THREE.InstancedBufferAttribute;
  private parts: { p: THREE.Vector3; v: THREE.Vector3; life: number; ttl: number; size: number }[] = [];
  private m = new THREE.Matrix4();
  private next = 0;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.alphaAttr = new THREE.InstancedBufferAttribute(new Float32Array(this.max), 1);
    geo.setAttribute('aAlpha', this.alphaAttr);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { map: { value: puffTexture() } },
      vertexShader: `
        attribute float aAlpha; varying float vA; varying vec2 vUv;
        void main(){
          vUv = uv; vA = aAlpha;
          vec3 c = (instanceMatrix * vec4(0.0,0.0,0.0,1.0)).xyz;
          float s = length(instanceMatrix[0].xyz);
          vec4 mv = modelViewMatrix * vec4(c,1.0);
          mv.xy += position.xy * s;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D map; varying float vA; varying vec2 vUv;
        void main(){ vec4 t = texture2D(map, vUv); gl_FragColor = vec4(vec3(0.86,0.87,0.88), t.a * vA * 0.5); }`,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, this.max);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    for (let i = 0; i < this.max; i++) {
      this.parts.push({ p: new THREE.Vector3(), v: new THREE.Vector3(), life: 0, ttl: 1, size: 0 });
      this.m.makeScale(0, 0, 0);
      this.mesh.setMatrixAt(i, this.m);
    }
    scene.add(this.mesh);
  }

  emit(p: THREE.Vector3, vel: THREE.Vector3, amount: number) {
    const s = this.parts[this.next];
    this.next = (this.next + 1) % this.max;
    s.p.copy(p).add(new THREE.Vector3((Math.random() - 0.5) * 0.3, 0.15, (Math.random() - 0.5) * 0.3));
    s.v.copy(vel).multiplyScalar(0.15).add(new THREE.Vector3((Math.random() - 0.5) * 0.8, 0.6 + Math.random() * 0.6, (Math.random() - 0.5) * 0.8));
    s.ttl = 1.2 + Math.random() * 1.2;
    s.life = s.ttl;
    s.size = 0.5 + amount * 0.6;
  }

  update(dt: number) {
    for (let i = 0; i < this.max; i++) {
      const s = this.parts[i];
      if (s.life <= 0) {
        this.alphaAttr.setX(i, 0);
        continue;
      }
      s.life -= dt;
      s.p.addScaledVector(s.v, dt);
      s.v.multiplyScalar(Math.exp(-dt * 1.2));
      const k = 1 - s.life / s.ttl;
      const size = s.size * (1 + k * 3.5);
      this.m.makeScale(size, size, size).setPosition(s.p);
      this.mesh.setMatrixAt(i, this.m);
      this.alphaAttr.setX(i, Math.max(0, Math.sin(Math.min(1, k * 4) * Math.PI / 2) * (1 - k)));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
  }
}
