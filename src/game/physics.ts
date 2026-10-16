import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

export { RAPIER };

/** Collision group bits. */
export const G = {
  WORLD: 0x0001,
  PLAYER: 0x0002,
  PROP: 0x0004,
  CAR: 0x0008,
} as const;

export const groups = (membership: number, filter: number) => (membership << 16) | filter;

export class Physics {
  readonly world: RAPIER.World;
  readonly events: RAPIER.EventQueue;
  private syncs: InstancedBodies[] = [];
  private objects: { body: RAPIER.RigidBody; obj: THREE.Object3D }[] = [];

  private constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = 1 / 60;
    this.events = new RAPIER.EventQueue(true);
  }

  static async create() {
    await RAPIER.init();
    return new Physics();
  }

  step() {
    this.world.step(this.events);
  }

  // ------------------------------------------------------------- statics
  private fixed(pos: THREE.Vector3Like, rot?: THREE.Quaternion) {
    const desc = RAPIER.RigidBodyDesc.fixed().setTranslation(pos.x, pos.y, pos.z);
    if (rot) desc.setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w });
    return this.world.createRigidBody(desc);
  }

  staticBox(center: THREE.Vector3Like, half: THREE.Vector3Like, rot?: THREE.Quaternion, friction = 0.9) {
    const body = this.fixed(center, rot);
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z).setFriction(friction).setCollisionGroups(groups(G.WORLD, 0xffff)),
      body,
    );
    return body;
  }

  /** Static convex hull through world-space points (ramps, kickers). */
  staticHull(points: THREE.Vector3Like[], friction = 0.9) {
    const flat = new Float32Array(points.flatMap((p) => [p.x, p.y, p.z]));
    const desc = RAPIER.ColliderDesc.convexHull(flat);
    if (!desc) throw new Error('degenerate hull');
    return this.world.createCollider(desc.setFriction(friction).setCollisionGroups(groups(G.WORLD, 0xffff)));
  }

  staticCylinder(center: THREE.Vector3Like, halfHeight: number, radius: number) {
    const body = this.fixed(center);
    this.world.createCollider(
      RAPIER.ColliderDesc.cylinder(halfHeight, radius).setCollisionGroups(groups(G.WORLD, 0xffff)),
      body,
    );
    return body;
  }

  // ------------------------------------------------------------ dynamics
  dynamic(pos: THREE.Vector3Like, rot: THREE.Quaternion | null, opts: { linearDamping?: number; angularDamping?: number; ccd?: boolean } = {}) {
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      .setLinearDamping(opts.linearDamping ?? 0.05)
      .setAngularDamping(opts.angularDamping ?? 0.2)
      .setCcdEnabled(opts.ccd ?? false)
      .setCanSleep(true);
    if (rot) desc.setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w });
    const body = this.world.createRigidBody(desc);
    body.sleep();
    return body;
  }

  register(set: InstancedBodies) {
    this.syncs.push(set);
  }

  bind(body: RAPIER.RigidBody, obj: THREE.Object3D) {
    this.objects.push({ body, obj });
  }

  /** Copy awake body transforms into their visuals. */
  sync(force = false) {
    for (const s of this.syncs) s.sync(force);
    for (const { body, obj } of this.objects) {
      if (!force && body.isSleeping()) continue;
      const t = body.translation();
      const r = body.rotation();
      obj.position.set(t.x, t.y, t.z);
      obj.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }
}

export interface Part {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  castShadow?: boolean;
  receiveShadow?: boolean;
  /** this part receives the per-instance colour */
  tinted?: boolean;
}

/**
 * Several InstancedMeshes sharing one set of instance transforms, each instance
 * driven by a rigid body. Only awake bodies are re-uploaded each frame.
 */
export class InstancedBodies {
  readonly meshes: THREE.InstancedMesh[];
  readonly bodies: RAPIER.RigidBody[] = [];
  private scales: (THREE.Vector3 | null)[] = [];
  private hidden: boolean[] = [];
  private offset: THREE.Matrix4;
  private m = new THREE.Matrix4();
  private p = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3(1, 1, 1);

  constructor(parts: Part[], capacity: number, offset = new THREE.Matrix4()) {
    this.offset = offset;
    this.meshes = parts.map((part) => {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, capacity);
      mesh.count = 0;
      mesh.castShadow = part.castShadow ?? true;
      mesh.receiveShadow = part.receiveShadow ?? true;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (part.tinted) {
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
      }
      mesh.userData.tinted = !!part.tinted;
      return mesh;
    });
  }

  add(body: RAPIER.RigidBody, color?: THREE.Color, scale?: THREE.Vector3) {
    const i = this.bodies.length;
    this.bodies.push(body);
    this.scales.push(scale ?? null);
    this.hidden.push(false);
    for (const mesh of this.meshes) {
      mesh.count = this.bodies.length;
      if (color && mesh.instanceColor) mesh.setColorAt(i, color);
    }
    this.write(i);
    return i;
  }

  addTo(parent: THREE.Object3D) {
    for (const m of this.meshes) parent.add(m);
    return this;
  }

  /** Hide/show one instance (its body is managed by the caller). */
  setHidden(i: number, hidden: boolean) {
    this.hidden[i] = hidden;
    this.write(i);
    for (const mesh of this.meshes) mesh.instanceMatrix.needsUpdate = true;
  }

  /** Recolour the tinted part of one instance. */
  setColor(i: number, color: THREE.Color) {
    for (const mesh of this.meshes) {
      if (!mesh.instanceColor) continue;
      mesh.setColorAt(i, color);
      mesh.instanceColor.needsUpdate = true;
    }
  }

  /** Re-upload one instance's transform right away (e.g. after a teleport). */
  refresh(i: number) {
    this.write(i);
    for (const mesh of this.meshes) mesh.instanceMatrix.needsUpdate = true;
  }

  private write(i: number) {
    if (this.hidden[i]) {
      this.m.makeScale(0, 0, 0);
      for (const mesh of this.meshes) mesh.setMatrixAt(i, this.m);
      return;
    }
    const b = this.bodies[i];
    const t = b.translation();
    const r = b.rotation();
    this.p.set(t.x, t.y, t.z);
    this.q.set(r.x, r.y, r.z, r.w);
    this.m.compose(this.p, this.q, this.scales[i] ?? this.s).multiply(this.offset);
    for (const mesh of this.meshes) mesh.setMatrixAt(i, this.m);
  }

  sync(force: boolean) {
    let dirty = force;
    for (let i = 0; i < this.bodies.length; i++) {
      if (!force && this.bodies[i].isSleeping()) continue;
      this.write(i);
      dirty = true;
    }
    if (dirty) for (const mesh of this.meshes) mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Static instanced geometry (no bodies). */
export function staticInstances(parts: Part[], matrices: THREE.Matrix4[], colors?: THREE.Color[]) {
  const group = new THREE.Group();
  for (const part of parts) {
    const mesh = new THREE.InstancedMesh(part.geometry, part.material, matrices.length);
    matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    if (part.tinted && colors) colors.forEach((c, i) => mesh.setColorAt(i, c));
    mesh.castShadow = part.castShadow ?? true;
    mesh.receiveShadow = part.receiveShadow ?? true;
    mesh.computeBoundingSphere();
    group.add(mesh);
  }
  return group;
}
