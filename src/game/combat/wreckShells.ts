import * as THREE from 'three';
import { InstancedBodies, type Part, type Physics, type RAPIER } from '../physics';
import type { CarSpec } from '../models/carModel';
import { buildWreck } from '../models/wreckModel';

const WHITE = new THREE.Color(1, 1, 1);

interface Pool {
  set: InstancedBodies;
  /** body handle held by each slot, or -1 */
  slots: number[];
}

/**
 * Burnt-out shells that stand in for destroyed cars. Each car model drawn by an InstancedBodies gets a
 * small pool of shells sharing its body offset; destroying a car binds a free shell to the car's body
 * (the intact model is hidden by the caller), respawning gives the shell back.
 */
export class WreckShells {
  private pools = new Map<InstancedBodies, Pool>();
  private bound = new Map<number, { pool: Pool; slot: number }>();
  private parts = new Map<string, Part[]>();

  constructor(private phys: Physics, private parent: THREE.Object3D) {}

  /** Shells for the cars `source` draws (all of model `spec`); `wheels` when the source draws its own wheels. */
  register(source: InstancedBodies, spec: CarSpec, wheels: boolean, size = 6) {
    const key = `${spec.name}:${wheels}`;
    let parts = this.parts.get(key);
    if (!parts) this.parts.set(key, (parts = buildWreck(spec, { wheels })));
    const set = new InstancedBodies(parts, size, source.offset).reserve(size).addTo(this.parent);
    this.phys.register(set);
    const pool = { set, slots: new Array(size).fill(-1) };
    this.pools.set(source, pool);
    this.trim(pool);
  }

  /** Put a shell on `body`, tinted a little by the car's old paint. False when none is free. */
  attach(body: RAPIER.RigidBody, source: InstancedBodies, paint: THREE.Color) {
    const pool = this.pools.get(source);
    if (!pool || this.bound.has(body.handle)) return !!pool && this.bound.has(body.handle);
    const slot = pool.slots.indexOf(-1);
    if (slot < 0) return false;
    pool.slots[slot] = body.handle;
    this.bound.set(body.handle, { pool, slot });
    pool.set.setColor(slot, WHITE.clone().lerp(paint, 0.18));
    pool.set.bind(slot, body);
    this.trim(pool);
    return true;
  }

  detach(body: RAPIER.RigidBody) {
    const b = this.bound.get(body.handle);
    if (!b) return;
    this.bound.delete(body.handle);
    b.pool.slots[b.slot] = -1;
    b.pool.set.bind(b.slot, null);
    this.trim(b.pool);
  }

  /** Draw only up to the last shell in use, and nothing at all when the pool is empty. */
  private trim(pool: Pool) {
    let n = 0;
    pool.slots.forEach((h, i) => { if (h >= 0) n = i + 1; });
    for (const mesh of pool.set.meshes) {
      mesh.count = n;
      mesh.visible = n > 0;
    }
  }
}
