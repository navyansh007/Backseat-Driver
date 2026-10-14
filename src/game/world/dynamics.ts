import * as THREE from 'three';
import { RAPIER, G, groups, InstancedBodies, type Part, type Physics } from '../physics';
import { buildCar, makeCarMaterials, SPECS, type CarSpec, type PartKey } from '../models/carModel';
import {
  barrelGeo, barrierGeo, binGeo, cardboardGeo, coneGeo, palletGeo, propMaterial, propMaterialShiny, trolleyGeo,
} from '../models/props';

const yawQ = (yaw: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);

export const CAR_COLORS = [
  0xf2f2ef, 0xf2f2ef, 0xc0c4c8, 0xc0c4c8, 0x8e949a, 0x1d1f22, 0x1d1f22, 0x2b4a7a, 0x9c1f24, 0xc8b89a,
  0x3e5f4a, 0x7da7c9, 0x6b1f2e, 0xe0b53a, 0x4f565e, 0xd65a2e,
];

/** A physics object with an instanced visual — the unit the destruction system works on. */
export interface Entry {
  body: RAPIER.RigidBody;
  set: InstancedBodies;
  index: number;
  kind: string;
  color: THREE.Color;
  car: boolean;
  kinematic: boolean;
}

/** Parked / traffic cars: one InstancedBodies per model, tinted paint per instance. */
export class ParkedCars {
  private sets = new Map<string, { set: InstancedBodies; spec: CarSpec }>();
  readonly bodies: RAPIER.RigidBody[] = [];
  readonly entries: Entry[] = [];

  constructor(private phys: Physics, parent: THREE.Object3D, capacity = 260) {
    const mats = makeCarMaterials(0xffffff, 'PK·2048');
    mats.head.emissiveIntensity = 0.05;
    mats.tail.emissiveIntensity = 0.05;
    for (const key of ['sedan', 'hatch', 'suv', 'van', 'executive']) {
      const spec = SPECS[key];
      const built = buildCar(spec, { includeWheels: true });
      const parts: Part[] = (Object.entries(built.parts) as [PartKey, THREE.BufferGeometry][]).map(([k, geo]) => ({
        geometry: geo,
        material: mats[k],
        tinted: k === 'paint',
        castShadow: !['plate', 'head', 'tail', 'amber', 'ao'].includes(k),
        receiveShadow: k === 'paint',
      }));
      const set = new InstancedBodies(parts, capacity).addTo(parent);
      phys.register(set);
      this.sets.set(key, { set, spec });
    }
  }

  place(kind: string, x: number, y: number, z: number, yaw: number, color: number, kinematic = false) {
    const entry = this.sets.get(kind)!;
    const { spec } = entry;
    const body = kinematic
      ? this.phys.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, y, z).setRotation(yawQ(yaw)))
      : this.phys.dynamic({ x, y: y + 0.02, z }, yawQ(yaw), { linearDamping: 0.6, angularDamping: 1.2 });
    const lowH = (spec.beltH - 0.12) / 2;
    const g = groups(G.CAR, 0xffff);
    this.phys.world.createCollider(
      RAPIER.ColliderDesc.cuboid(spec.W / 2 - 0.04, lowH, spec.L / 2 - 0.04)
        .setTranslation(0, 0.12 + lowH, 0)
        .setMass(1250)
        .setFriction(0.8)
        .setCollisionGroups(g),
      body,
    );
    const cabH = (spec.H - spec.beltH) / 2;
    this.phys.world.createCollider(
      RAPIER.ColliderDesc.cuboid(spec.W / 2 - 0.2, cabH, (spec.roofFrontZ - spec.roofRearZ) / 2 + 0.35)
        .setTranslation(0, spec.beltH + cabH - 0.02, (spec.roofFrontZ + spec.roofRearZ) / 2)
        .setMass(150)
        .setFriction(0.5)
        .setCollisionGroups(g),
      body,
    );
    const c = new THREE.Color(color);
    const index = entry.set.add(body, c);
    this.bodies.push(body);
    this.entries.push({ body, set: entry.set, index, kind, color: c, car: true, kinematic });
    return body;
  }
}

type PropKind = 'cone' | 'barrel' | 'barrelBlue' | 'box' | 'boxBig' | 'trolley' | 'bin' | 'binBlue' | 'barrier' | 'barrierWhite' | 'pallet';

interface PropDef {
  geo: () => THREE.BufferGeometry;
  collider: () => RAPIER.ColliderDesc;
  mass: number;
  /** height of the body origin above the ground when standing */
  rest: number;
  shiny?: boolean;
}

/** Dominant colour of each prop, used for debris. */
const PROP_COLORS: Record<PropKind, number> = {
  cone: 0xff5a1f, barrel: 0xc8432f, barrelBlue: 0x2d5f9a, box: 0xb98d58, boxBig: 0xb98d58, trolley: 0xc8ccd2,
  bin: 0x3f7d4e, binBlue: 0x2f5d8a, barrier: 0xe2462f, barrierWhite: 0xf0f0ea, pallet: 0xa98257,
};

const DEFS: Record<PropKind, PropDef> = {
  cone: { geo: coneGeo, collider: () => RAPIER.ColliderDesc.cone(0.33, 0.17).setTranslation(0, 0.08, 0), mass: 3, rest: 0.25 },
  barrel: { geo: () => barrelGeo(0xc8432f), collider: () => RAPIER.ColliderDesc.cylinder(0.44, 0.29), mass: 35, rest: 0.44 },
  barrelBlue: { geo: () => barrelGeo(0x2d5f9a), collider: () => RAPIER.ColliderDesc.cylinder(0.44, 0.29), mass: 35, rest: 0.44 },
  box: { geo: () => cardboardGeo(0.6, 0.45, 0.5), collider: () => RAPIER.ColliderDesc.cuboid(0.3, 0.225, 0.25), mass: 4, rest: 0.225 },
  boxBig: { geo: () => cardboardGeo(0.9, 0.7, 0.8), collider: () => RAPIER.ColliderDesc.cuboid(0.45, 0.35, 0.4), mass: 8, rest: 0.35 },
  trolley: { geo: trolleyGeo, collider: () => RAPIER.ColliderDesc.cuboid(0.3, 0.5, 0.5), mass: 22, rest: 0.5, shiny: true },
  bin: { geo: () => binGeo(0x3f7d4e), collider: () => RAPIER.ColliderDesc.cuboid(0.31, 0.5, 0.37), mass: 14, rest: 0.5 },
  binBlue: { geo: () => binGeo(0x2f5d8a), collider: () => RAPIER.ColliderDesc.cuboid(0.31, 0.5, 0.37), mass: 14, rest: 0.5 },
  barrier: { geo: () => barrierGeo(0xe2462f), collider: () => RAPIER.ColliderDesc.cuboid(0.75, 0.4, 0.2), mass: 90, rest: 0.4 },
  barrierWhite: { geo: () => barrierGeo(0xf0f0ea), collider: () => RAPIER.ColliderDesc.cuboid(0.75, 0.4, 0.2), mass: 90, rest: 0.4 },
  pallet: { geo: palletGeo, collider: () => RAPIER.ColliderDesc.cuboid(0.6, 0.07, 0.5), mass: 18, rest: 0.07 },
};

/** All small dynamic props, one InstancedMesh per kind. */
export class Props {
  private sets = new Map<PropKind, InstancedBodies>();
  private glass: InstancedBodies;
  readonly entries: Entry[] = [];

  constructor(private phys: Physics, parent: THREE.Object3D) {
    for (const [kind, def] of Object.entries(DEFS) as [PropKind, PropDef][]) {
      const set = new InstancedBodies([{ geometry: def.geo(), material: def.shiny ? propMaterialShiny : propMaterial }], 400).addTo(parent);
      phys.register(set);
      this.sets.set(kind, set);
    }
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0xbfe3ee, transparent: true, opacity: 0.32, roughness: 0.03, metalness: 0.1, depthWrite: false, side: THREE.DoubleSide,
    });
    this.glass = new InstancedBodies([{ geometry: new THREE.BoxGeometry(1, 1, 1), material: glassMat, castShadow: false }], 40).addTo(parent);
    phys.register(this.glass);
  }

  add(kind: PropKind, x: number, y: number, z: number, yaw = 0) {
    const def = DEFS[kind];
    const body = this.phys.dynamic({ x, y: y + def.rest + 0.005, z }, yawQ(yaw), { linearDamping: 0.15, angularDamping: 0.4 });
    this.phys.world.createCollider(
      def.collider().setMass(def.mass).setFriction(0.7).setRestitution(0.2).setCollisionGroups(groups(G.PROP, 0xffff)),
      body,
    );
    const set = this.sets.get(kind)!;
    const index = set.add(body);
    this.entries.push({ body, set, index, kind, color: new THREE.Color(PROP_COLORS[kind]), car: false, kinematic: false });
    return body;
  }

  /** A breakable-looking glass pane (w × h × 0.05) standing on y. */
  pane(x: number, y: number, z: number, w: number, h: number, yaw: number) {
    const body = this.phys.dynamic({ x, y: y + h / 2, z }, yawQ(yaw), { linearDamping: 0.2, angularDamping: 0.3 });
    this.phys.world.createCollider(
      RAPIER.ColliderDesc.cuboid(w / 2, h / 2, 0.03).setMass(45).setFriction(0.4).setCollisionGroups(groups(G.PROP, 0xffff)),
      body,
    );
    const index = this.glass.add(body, undefined, new THREE.Vector3(w, h, 0.06));
    this.entries.push({ body, set: this.glass, index, kind: 'glass', color: new THREE.Color(0xbfe3ee), car: false, kinematic: false });
    return body;
  }
}
