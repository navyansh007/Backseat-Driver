import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { VehicleSim, TUNING, type DriveInput } from './vehiclePhysics';
import { buildCar, carMeshes, makeCarMaterials, wheelMesh, type CarMaterials } from './models/carModel';
import { G, groups } from './physics';
import type { CarDef } from './cars/roster';
import { buildWreck } from './models/wreckModel';

export const PLAYER_GROUPS = groups(G.PLAYER, 0xffff);

/** The remote-controlled hero car: physics, interpolated visuals, lights. */
export class PlayerCar {
  readonly sim: VehicleSim;
  readonly root = new THREE.Group();
  mats!: CarMaterials;
  def!: CarDef;
  readonly wheels: THREE.Group[] = [];
  /** the bodywork and wheels of the current model (lamps and weapons stay on the root) */
  private model = new THREE.Group();
  /** the burnt-out shell shown in its place once wrecked */
  private shell = new THREE.Group();
  private lamps: THREE.SpotLight[] = [];
  /** called after the model changes, so things mounted on the car can move */
  onModel = () => {};
  private prevPos = new THREE.Vector3();
  private currPos = new THREE.Vector3();
  private prevRot = new THREE.Quaternion();
  private currRot = new THREE.Quaternion();
  private brakeGlow = 0;

  constructor(world: RAPIER.World, scene: THREE.Scene, spawn: { x: number; y: number; z: number; yaw: number }, def: CarDef) {
    const spec = def.spec;
    this.sim = new VehicleSim(
      world,
      { frontAxleZ: spec.frontAxleZ, rearAxleZ: spec.rearAxleZ, track: spec.track, radius: spec.wheelR },
      spawn,
      PLAYER_GROUPS,
    );
    this.root.add(this.model);
    this.shell.visible = false;
    this.shell.position.y = -TUNING.rideHeight;
    this.root.add(this.shell);

    // headlamp beams for the darker garage interior (kept for good: lights must never leave the scene)
    for (let i = 0; i < 2; i++) {
      const spot = new THREE.SpotLight(0xfff1d6, 18, 32, 0.42, 0.6, 1.6);
      this.lamps.push(spot);
      this.root.add(spot, spot.target);
    }

    this.setModel(def);
    scene.add(this.root);
    this.capture();
    this.capture();
  }

  /** Swap to another car: new bodywork, wheels, lamps and handling on the same physics body. */
  setModel(def: CarDef) {
    if (this.def?.info.id === def.info.id) return;
    const spec = def.spec;
    for (const part of [...this.model.children]) {
      part.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
      this.model.remove(part);
    }
    const old = this.mats;
    // see-through glass shows the cabin; a blacked-out car gets dark glass and no cabin
    this.mats = makeCarMaterials(def.paint, spec.plate, { seeThrough: !def.blackout, rim: def.rim });
    if (old) {
      old.plate.map?.dispose();
      for (const m of new Set(Object.values(old))) m.dispose();
    }
    this.def = def;

    const parts = buildCar(spec, { includeWheels: false, interior: !def.blackout });
    const body = carMeshes(parts, this.mats);
    body.position.y = -TUNING.rideHeight;
    this.model.add(body);
    this.wheels.length = 0;
    for (let i = 0; i < 4; i++) {
      const w = wheelMesh(parts, this.mats, i % 2 === 0 ? 1 : -1);
      w.rotation.order = 'YXZ';
      this.wheels.push(w);
      this.model.add(w);
    }
    // the wreck of this model, ready for when it's needed
    for (const part of [...this.shell.children]) {
      (part as THREE.Mesh).geometry.dispose();
      this.shell.remove(part);
    }
    const tint = new THREE.Color(1, 1, 1).lerp(new THREE.Color(def.paint), 0.18);
    for (const part of buildWreck(spec, { wheels: true })) {
      const mesh = new THREE.Mesh(part.geometry, part.material);
      mesh.castShadow = part.castShadow ?? true;
      mesh.receiveShadow = part.receiveShadow ?? true;
      if (part.tinted) {
        // per-instance tint isn't available on a plain mesh: bake it into the vertex colours
        const col = part.geometry.getAttribute('color') as THREE.BufferAttribute;
        const out = new Float32Array(col.count * 3);
        for (let i = 0; i < col.count; i++) {
          out[i * 3] = col.getX(i) * tint.r;
          out[i * 3 + 1] = col.getY(i) * tint.g;
          out[i * 3 + 2] = col.getZ(i) * tint.b;
        }
        mesh.geometry = part.geometry.clone();
        mesh.geometry.setAttribute('color', new THREE.BufferAttribute(out, 3));
      }
      mesh.userData.shell = true;
      this.shell.add(mesh);
    }

    const [hx, hy, hz] = def.mounts.headlamp;
    this.lamps.forEach((spot, i) => {
      const s = i === 0 ? 1 : -1;
      spot.position.set(s * hx, hy - TUNING.rideHeight, hz);
      spot.target.position.set(s * (hx + 0.23), hy - TUNING.rideHeight - 0.6, hz + 9.5);
    });

    const box = (b: { half: number[]; at: number[] }) => ({
      half: { x: b.half[0], y: b.half[1], z: b.half[2] },
      at: { x: b.at[0], y: b.at[1] - TUNING.rideHeight, z: b.at[2] },
    });
    this.sim.fit(
      { frontAxleZ: spec.frontAxleZ, rearAxleZ: spec.rearAxleZ, track: spec.track, radius: spec.wheelR },
      def.handling,
      { body: box(def.chassis.body), cabin: box(def.chassis.cabin) },
    );
    this.onModel();
  }

  get body() {
    return this.sim.body;
  }

  /**
   * Show or hide the car (it's hidden while wrecked). The lights stay in the scene and only go dark:
   * adding or removing a light makes the renderer rebuild every material, a second-long stall.
   */
  setShown(on: boolean) {
    this.root.traverse((o) => {
      if ((o as THREE.Light).isLight) {
        const l = o as THREE.Light;
        l.userData.on ??= l.intensity;
        l.intensity = on ? l.userData.on : 0;
      } else if ((o as THREE.Mesh).isMesh && !o.userData.shell) o.visible = on;
    });
  }

  /** Wrecked: the car is replaced by its burnt-out shell (and its lamps go dark). */
  setWrecked(on: boolean) {
    this.setShown(!on);
    this.shell.visible = on;
  }

  /** Save the post-step pose for interpolation. */
  capture() {
    this.prevPos.copy(this.currPos);
    this.prevRot.copy(this.currRot);
    const t = this.sim.body.translation();
    const r = this.sim.body.rotation();
    this.currPos.set(t.x, t.y, t.z);
    this.currRot.set(r.x, r.y, r.z, r.w);
  }

  drive(dt: number, input: DriveInput) {
    this.sim.drive(dt, input);
  }

  /** Update visuals; alpha ∈ [0,1] blends previous → current physics state. */
  render(alpha: number, dt: number) {
    this.root.position.lerpVectors(this.prevPos, this.currPos, alpha);
    this.root.quaternion.slerpQuaternions(this.prevRot, this.currRot, alpha);
    const vc = this.sim.controller;
    for (let i = 0; i < 4; i++) {
      const c = vc.wheelChassisConnectionPointCs(i)!;
      const len = vc.wheelSuspensionLength(i) ?? TUNING.suspensionRest;
      const w = this.wheels[i];
      w.position.set(c.x, c.y - len, c.z);
      w.rotation.y = vc.wheelSteering(i) ?? 0;
      (w.userData.spin as THREE.Object3D).rotation.x = vc.wheelRotation(i) ?? 0;
    }
    const target = this.sim.braking ? 1 : 0;
    this.brakeGlow += (target - this.brakeGlow) * Math.min(1, dt * 14);
    this.mats.tail.emissiveIntensity = 0.35 + this.brakeGlow * 2.6;
  }

  get position() {
    return this.root.position;
  }

  kmh() {
    return Math.abs(this.sim.forwardSpeed()) * 3.6;
  }

  reset(x: number, y: number, z: number, yaw: number) {
    this.sim.reset(x, y, z, yaw);
    this.capture();
    this.capture();
  }
}
