import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { VehicleSim, TUNING, type DriveInput } from './vehiclePhysics';
import { buildCar, carMeshes, makeCarMaterials, wheelMesh, SPECS, type CarMaterials } from './models/carModel';
import { G, groups } from './physics';

export const PLAYER_GROUPS = groups(G.PLAYER, 0xffff);

/** The remote-controlled hero car: physics, interpolated visuals, lights. */
export class PlayerCar {
  readonly sim: VehicleSim;
  readonly root = new THREE.Group();
  readonly mats: CarMaterials;
  readonly wheels: THREE.Group[] = [];
  private prevPos = new THREE.Vector3();
  private currPos = new THREE.Vector3();
  private prevRot = new THREE.Quaternion();
  private currRot = new THREE.Quaternion();
  private brakeGlow = 0;

  constructor(world: RAPIER.World, scene: THREE.Scene, spawn: { x: number; y: number; z: number; yaw: number }) {
    const spec = SPECS.executive;
    const parts = buildCar(spec, { includeWheels: false, interior: true });
    this.mats = makeCarMaterials(0x5b636c, spec.plate, { seeThrough: true });
    const body = carMeshes(parts, this.mats);
    body.position.y = -TUNING.rideHeight;
    this.root.add(body);

    this.sim = new VehicleSim(
      world,
      { frontAxleZ: spec.frontAxleZ, rearAxleZ: spec.rearAxleZ, track: spec.track, radius: spec.wheelR },
      spawn,
      PLAYER_GROUPS,
    );
    for (let i = 0; i < 4; i++) {
      const w = wheelMesh(parts, this.mats, i % 2 === 0 ? 1 : -1);
      w.rotation.order = 'YXZ';
      this.wheels.push(w);
      this.root.add(w);
    }

    // headlamp beams for the darker garage interior
    for (const s of [-1, 1]) {
      const spot = new THREE.SpotLight(0xfff1d6, 18, 32, 0.42, 0.6, 1.6);
      spot.position.set(s * 0.57, 0.0, 2.5);
      spot.target.position.set(s * 0.8, -0.6, 12);
      this.root.add(spot, spot.target);
    }

    scene.add(this.root);
    this.capture();
    this.capture();
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
      } else if ((o as THREE.Mesh).isMesh) o.visible = on;
    });
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
