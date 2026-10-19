import * as THREE from 'three';
import { RAPIER, G, groups, type Physics } from '../physics';
import type { CombatFx } from './fx';

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpM = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);
const CHAR = new THREE.Color(0x15130f);
const SOOT = new THREE.Color(0x3a332c);

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** A torn, crumpled scrap of sheet metal, about 1 m across before scaling. Non-indexed so it shades faceted. */
function shardGeometry(seed: number) {
  let s = seed;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const n = 5 + Math.floor(r() * 3);
  const ring: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (r() - 0.5) * 0.6;
    const rad = 0.3 + r() * 0.25;
    ring.push(new THREE.Vector3(Math.cos(a) * rad, (r() - 0.5) * 0.14, Math.sin(a) * rad * (0.6 + r() * 0.5)));
  }
  const mid = new THREE.Vector3((r() - 0.5) * 0.1, (r() - 0.3) * 0.18, (r() - 0.5) * 0.1);
  // a crease halfway out on every spoke gives the crumpled look
  const crease = ring.map((v) => v.clone().lerp(mid, 0.5).setY(v.y * 0.5 + mid.y * 0.5 + (r() - 0.5) * 0.12));
  const pos: number[] = [];
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tri(mid, crease[j], crease[i]);
    tri(crease[i], crease[j], ring[j]);
    tri(crease[i], ring[j], ring[i]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

interface Frag {
  p: THREE.Vector3;
  v: THREE.Vector3;
  q: THREE.Quaternion;
  w: THREE.Vector3;
  s: THREE.Vector3;
  t: number;
  life: number;
  floor: number;
  rest: boolean;
  burn: number; // seconds of flame left
}

/**
 * Instanced ballistic fragments with air drag, bouncing and settling.
 * `flat` pieces (panels) come to rest lying flat instead of balanced on an edge.
 */
class Fragments {
  readonly mesh: THREE.InstancedMesh;
  private f: Frag[] = [];
  private next = 0;
  private live = 0;
  private flatTarget = new THREE.Quaternion();

  constructor(scene: THREE.Scene, geo: THREE.BufferGeometry, mat: THREE.Material, private max: number,
    private o: { drag: number; bounce: number; flat: boolean; shadow: boolean }) {
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3).fill(1), 3);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = o.shadow;
    this.mesh.receiveShadow = true;
    for (let i = 0; i < max; i++) {
      this.f.push({ p: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(), w: new THREE.Vector3(), s: new THREE.Vector3(), t: 0, life: 0, floor: 0, rest: false, burn: 0 });
      this.mesh.setMatrixAt(i, tmpM.makeScale(0, 0, 0));
    }
    scene.add(this.mesh);
  }

  spawn(p: THREE.Vector3, v: THREE.Vector3, scale: THREE.Vector3, color: THREE.Color, floor: number, life: number, spin: number, burn = 0) {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    const f = this.f[i];
    if (f.life === 0) this.live++;
    f.p.copy(p);
    f.v.copy(v);
    f.q.setFromEuler(new THREE.Euler(rand(0, 6.3), rand(0, 6.3), rand(0, 6.3)));
    f.w.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize().multiplyScalar(spin * rand(0.5, 1.2));
    f.s.copy(scale);
    f.t = 0;
    f.life = life;
    f.floor = floor;
    f.rest = false;
    f.burn = burn;
    this.mesh.setColorAt(i, color);
    this.mesh.instanceColor!.needsUpdate = true;
  }

  update(dt: number, onBurn?: (p: THREE.Vector3, v: THREE.Vector3, dt: number) => void) {
    if (!this.live) return;
    const { drag, bounce, flat } = this.o;
    for (let i = 0; i < this.max; i++) {
      const f = this.f[i];
      if (f.life === 0) continue;
      f.t += dt;
      if (f.t >= f.life) {
        f.life = 0;
        this.live--;
        this.mesh.setMatrixAt(i, tmpM.makeScale(0, 0, 0));
        continue;
      }
      if (!f.rest) {
        f.v.y -= 9.81 * dt;
        f.v.multiplyScalar(Math.exp(-drag * dt));
        f.p.addScaledVector(f.v, dt);
        const wl = f.w.length();
        if (wl > 0.01) f.q.premultiply(tmpQ.setFromAxisAngle(tmpV.copy(f.w).divideScalar(wl), wl * dt));
        const lift = Math.min(f.s.x, f.s.y, f.s.z) * 0.5;
        if (f.p.y < f.floor + lift) {
          f.p.y = f.floor + lift;
          if (f.v.y < 0) f.v.y *= -bounce;
          f.v.x *= 0.55;
          f.v.z *= 0.55;
          f.w.multiplyScalar(0.5);
          f.burn *= 0.5;
          if (flat) f.q.slerp(this.flat(f.q), 0.5);
          if (Math.abs(f.v.y) < 0.6 && f.v.x * f.v.x + f.v.z * f.v.z < 0.3) {
            f.rest = true;
            if (flat) f.q.copy(this.flat(f.q));
          }
        }
        if (f.burn > 0 && onBurn) {
          f.burn -= dt;
          onBurn(f.p, f.v, dt);
        }
      }
      const shrink = Math.min(1, (f.life - f.t) / 1.2);
      this.mesh.setMatrixAt(i, tmpM.compose(f.p, f.q, tmpV2.copy(f.s).multiplyScalar(shrink)));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** The nearest orientation lying flat on whichever face is already pointing down. */
  private flat(q: THREE.Quaternion) {
    const n = tmpV.set(0, 1, 0).applyQuaternion(q);
    return this.flatTarget.setFromUnitVectors(n, n.y >= 0 ? UP : tmpV2.set(0, -1, 0)).multiply(q);
  }
}

interface Part {
  body: RAPIER.RigidBody;
  obj: THREE.Object3D;
  paint: THREE.MeshStandardMaterial | null;
  t: number;
  life: number;
  smoke: number;
  active: boolean;
}

/**
 * Car wrecks coming apart: crumpled paint/scorched body panels, tempered-glass
 * crumbs, oily mechanical chunks, embers, and a few real rigid-body parts
 * (wheels, a hood/door) that bounce, roll and smoulder.
 */
export class WreckFx {
  private metal: Fragments[];
  private glass: Fragments;
  private chunks: Fragments;
  private wheels: Part[] = [];
  private panels: Part[] = [];
  private nextWheel = 0;
  private nextPanel = 0;

  constructor(scene: THREE.Scene, private phys: Physics, private fx: CombatFx) {
    const paint = new THREE.MeshStandardMaterial({ roughness: 0.38, metalness: 0.55, side: THREE.DoubleSide, flatShading: true });
    this.metal = [11, 23, 47].map((seed) => new Fragments(scene, shardGeometry(seed), paint, 140, { drag: 0.9, bounce: 0.3, flat: true, shadow: true }));
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0xd8eef4, roughness: 0.04, metalness: 0.2, transparent: true, opacity: 0.8, envMapIntensity: 2.2,
    });
    this.glass = new Fragments(scene, new THREE.BoxGeometry(1, 1, 1), glassMat, 500, { drag: 0.4, bounce: 0.35, flat: false, shadow: false });
    const chunkMat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.6, flatShading: true });
    this.chunks = new Fragments(scene, new THREE.DodecahedronGeometry(0.5, 0), chunkMat, 160, { drag: 0.2, bounce: 0.25, flat: false, shadow: true });

    // rigid parts pool
    const rubber = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.92 });
    const rim = new THREE.MeshStandardMaterial({ color: 0xb9bec4, roughness: 0.3, metalness: 0.9 });
    for (let i = 0; i < 6; i++) {
      const obj = new THREE.Group();
      const tyre = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.09, 10, 22), rubber);
      tyre.rotation.y = Math.PI / 2;
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.16, 16), rim);
      hub.rotation.z = Math.PI / 2;
      obj.add(tyre, hub);
      tyre.castShadow = hub.castShadow = true;
      this.wheels.push(this.part(scene, obj, null, RAPIER.ColliderDesc.cylinder(0.1, 0.34).setRotation({ x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 }), 18, 0.9, 0.35));
    }
    for (let i = 0; i < 6; i++) {
      // a bent hood / door skin
      const geo = new THREE.BoxGeometry(1.25, 0.035, 1.05, 6, 1, 5);
      const pos = geo.attributes.position as THREE.BufferAttribute;
      for (let k = 0; k < pos.count; k++) {
        const x = pos.getX(k), z = pos.getZ(k);
        pos.setY(k, pos.getY(k) + Math.sin(x * 2.4 + i) * 0.07 + Math.cos(z * 3.1 + i * 2) * 0.05 + x * z * 0.18);
      }
      geo.computeVertexNormals();
      const mat = paint.clone();
      mat.side = THREE.FrontSide;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.panels.push(this.part(scene, mesh, mat, RAPIER.ColliderDesc.cuboid(0.62, 0.05, 0.52), 14, 0.55, 0.2));
    }
  }

  private part(scene: THREE.Scene, obj: THREE.Object3D, paint: THREE.MeshStandardMaterial | null, desc: RAPIER.ColliderDesc, mass: number, friction: number, restitution: number): Part {
    const body = this.phys.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setCcdEnabled(true).setLinearDamping(0.15).setAngularDamping(0.25).setTranslation(0, -50, 0),
    );
    this.phys.world.createCollider(desc.setMass(mass).setFriction(friction).setRestitution(restitution).setCollisionGroups(groups(G.PROP, 0xffff)), body);
    body.setEnabled(false);
    obj.visible = false;
    scene.add(obj);
    return { body, obj, paint, t: 0, life: 0, smoke: 0, active: false };
  }

  private launch(pool: Part[], idx: number, p: THREE.Vector3, v: THREE.Vector3, spin: number, life: number, smoke: number) {
    const part = pool[idx];
    part.active = true;
    part.t = 0;
    part.life = life;
    part.smoke = smoke;
    part.obj.visible = true;
    part.obj.scale.setScalar(1);
    const q = tmpQ.setFromEuler(new THREE.Euler(rand(0, 6.3), rand(0, 6.3), rand(0, 6.3)));
    part.body.setEnabled(true);
    part.body.setTranslation(p, true);
    part.body.setRotation(q, true);
    part.body.setLinvel(v, true);
    part.body.setAngvel({ x: rand(-spin, spin), y: rand(-spin, spin), z: rand(-spin, spin) }, true);
    return part;
  }

  /**
   * Blow a car apart. `size` is (width, height, length) of its body,
   * `paint` its colour; `vel` is the car's own velocity, inherited by the pieces.
   */
  carExplode(pos: THREE.Vector3, rot: THREE.Quaternion, vel: THREE.Vector3, size: THREE.Vector3, paint: THREE.Color, floor: number) {
    const c = new THREE.Color();
    const inherit = vel.clone().multiplyScalar(0.6);
    const center = pos.clone().setY(pos.y + size.y * 0.55);
    // a random point on the car's body, and its outward direction
    const onBody = (hmin: number, hmax: number) => {
      const local = new THREE.Vector3(rand(-0.5, 0.5) * size.x, rand(hmin, hmax) * size.y, rand(-0.5, 0.5) * size.z);
      const world = local.applyQuaternion(rot).add(pos);
      const out = world.clone().sub(center).setY(0).normalize();
      return { world, out };
    };

    // body panels: paint, scorched paint and bare charred metal
    for (let i = 0; i < 34; i++) {
      const { world, out } = onBody(0.25, 1);
      const sp = rand(5, 13);
      const v = out.multiplyScalar(sp).add(tmpV.set(rand(-1.5, 1.5), rand(4, 11), rand(-1.5, 1.5))).add(inherit);
      const k = Math.random();
      c.copy(paint).lerp(k < 0.5 ? SOOT : CHAR, k < 0.5 ? rand(0, 0.35) : rand(0.6, 0.95));
      const s = rand(0.18, 0.55);
      this.metal[i % 3].spawn(world, v, tmpV2.set(s * rand(0.7, 1.3), s, s * rand(0.7, 1.3)), c, floor, rand(10, 16), rand(6, 16), Math.random() < 0.25 ? rand(0.6, 1.6) : 0);
    }
    // windows: tempered glass breaks into glittering little cubes
    for (let i = 0; i < 110; i++) {
      const { world, out } = onBody(0.62, 0.95);
      const v = out.multiplyScalar(rand(2, 9)).add(tmpV.set(rand(-2, 2), rand(1.5, 7), rand(-2, 2))).add(inherit);
      const s = rand(0.018, 0.042);
      c.setRGB(1, 1, 1).multiplyScalar(rand(0.8, 1.05));
      this.glass.spawn(world, v, tmpV2.set(s, s * rand(0.5, 1), s * rand(0.8, 1.2)), c, floor, rand(9, 15), rand(10, 30));
    }
    // mechanical bits: brackets, bolts, plastic trim
    for (let i = 0; i < 26; i++) {
      const { world, out } = onBody(0.05, 0.5);
      const v = out.multiplyScalar(rand(3, 9)).add(tmpV.set(0, rand(3, 9), 0)).add(inherit);
      const s = rand(0.05, 0.16);
      c.setHex(Math.random() < 0.5 ? 0x2b2b2b : 0x4a4640).multiplyScalar(rand(0.7, 1.2));
      this.chunks.spawn(world, v, tmpV2.set(s, s * rand(0.5, 1), s * rand(0.6, 1.4)), c, floor, rand(9, 14), rand(8, 20));
    }
    // embers drifting out of the fire
    for (let i = 0; i < 30; i++) {
      const v = new THREE.Vector3(rand(-1, 1), rand(0.6, 1.4), rand(-1, 1)).normalize().multiplyScalar(rand(3, 9));
      this.fx.sparks.spark(center, v, rand(1.2, 2.2));
    }

    // real loose parts
    const wheels = Math.random() < 0.55 ? 2 : 1;
    for (let i = 0; i < wheels; i++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const p = new THREE.Vector3(side * size.x * 0.45, 0.35, (Math.random() < 0.5 ? -1 : 1) * size.z * 0.3).applyQuaternion(rot).add(pos);
      const out = p.clone().sub(center).setY(0).normalize();
      const v = out.multiplyScalar(rand(5, 9)).add(tmpV.set(0, rand(5, 9), 0)).add(inherit);
      this.launch(this.wheels, this.nextWheel, p, v, 14, rand(14, 18), rand(1.5, 3));
      this.nextWheel = (this.nextWheel + 1) % this.wheels.length;
    }
    const panels = Math.random() < 0.5 ? 2 : 1;
    for (let i = 0; i < panels; i++) {
      const { world, out } = onBody(0.6, 0.9);
      const v = out.multiplyScalar(rand(3, 7)).add(tmpV.set(0, rand(9, 14), 0)).add(inherit);
      const part = this.launch(this.panels, this.nextPanel, world, v, 9, rand(14, 18), rand(2.5, 4.5));
      part.paint!.color.copy(paint).lerp(CHAR, rand(0.25, 0.6));
      this.nextPanel = (this.nextPanel + 1) % this.panels.length;
    }
  }

  update(dt: number) {
    const burn = (p: THREE.Vector3, v: THREE.Vector3, step: number) => {
      if (Math.random() < step * 30) {
        this.fx.fire.emit(p, tmpV.copy(v).multiplyScalar(0.2), { life: rand(0.2, 0.4), size: 0.35, grow: 1.6, color: 0xffd27a, color2: 0xff3d0a, gravity: 2, drag: 2, alpha: 0.9 });
      }
      if (Math.random() < step * 14) {
        this.fx.smoke.emit(p, tmpV.set(0, 0.6, 0), { life: rand(1, 1.8), size: 0.3, grow: 4, color: 0x2a2725, color2: 0x7d776f, gravity: 0.6, drag: 1, alpha: 0.5 });
      }
    };
    for (const m of this.metal) m.update(dt, burn);
    this.glass.update(dt);
    this.chunks.update(dt);

    for (const part of [...this.wheels, ...this.panels]) {
      if (!part.active) continue;
      part.t += dt;
      const t = part.body.translation();
      const r = part.body.rotation();
      part.obj.position.set(t.x, t.y, t.z);
      part.obj.quaternion.set(r.x, r.y, r.z, r.w);
      // smouldering trail for the first few seconds
      if (part.t < part.smoke && Math.random() < dt * 22) {
        const k = 1 - part.t / part.smoke;
        this.fx.smoke.emit(part.obj.position, tmpV.set(rand(-0.2, 0.2), 0.8, rand(-0.2, 0.2)), {
          life: rand(1.5, 2.5), size: 0.35 + k * 0.3, grow: 5, color: 0x24211f, color2: 0x8a857e, gravity: 0.5, drag: 0.9, alpha: 0.45 * k + 0.1,
        });
        if (k > 0.5 && Math.random() < 0.5) {
          this.fx.fire.emit(part.obj.position, tmpV.set(0, 1, 0), { life: 0.3, size: 0.4, grow: 1.5, color: 0xffd27a, color2: 0xff3d0a, gravity: 2, drag: 2, alpha: 0.8 });
        }
      }
      const left = part.life - part.t;
      if (left < 1) part.obj.scale.setScalar(Math.max(0.001, left));
      if (left <= 0) {
        part.active = false;
        part.obj.visible = false;
        part.body.setEnabled(false);
      }
    }
  }
}
