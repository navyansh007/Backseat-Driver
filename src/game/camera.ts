import * as THREE from 'three';
import { RAPIER, G, groups, type Physics } from './physics';

export type CamMode = 'chase' | 'far' | 'bumper' | 'orbit';

const RAY_GROUPS = groups(0xffff, G.WORLD | G.CAR);

/** Smoothed chase camera with obstruction handling. */
export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;
  mode: CamMode = 'orbit';
  private yaw = 0;
  private pos = new THREE.Vector3(0, 6, -12);
  private look = new THREE.Vector3();
  private orbitT = 0;
  private shake = 0;
  private baseFov = 58;

  constructor(private phys: Physics) {
    this.camera = new THREE.PerspectiveCamera(this.baseFov, innerWidth / innerHeight, 0.1, 3000);
  }

  bump(power: number) {
    this.shake = Math.min(1, this.shake + power);
  }

  snap(target: THREE.Object3D) {
    this.yaw = headingOf(target);
    this.pos.copy(target.position).add(new THREE.Vector3(-Math.sin(this.yaw) * 7, 3, -Math.cos(this.yaw) * 7));
    this.look.copy(target.position);
  }

  update(dt: number, target: THREE.Object3D, speed: number) {
    const cam = this.camera;
    const p = target.position;
    const heading = headingOf(target);

    if (this.mode === 'orbit') {
      this.orbitT += dt * 0.12;
      const r = 9.5;
      const desired = new THREE.Vector3(p.x + Math.sin(this.orbitT) * r, p.y + 2.2 + Math.sin(this.orbitT * 0.7) * 0.6, p.z + Math.cos(this.orbitT) * r);
      this.pos.lerp(desired, 1 - Math.exp(-dt * 2));
      this.look.lerp(new THREE.Vector3(p.x, p.y + 0.3, p.z), 1 - Math.exp(-dt * 4));
      cam.position.copy(this.pos);
      cam.lookAt(this.look);
      this.fov(this.baseFov - 6, dt);
      return;
    }

    // camera heading lags the car heading; when reversing keep looking forward
    let dyaw = heading - this.yaw;
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
    this.yaw += dyaw * (1 - Math.exp(-dt * (this.mode === 'bumper' ? 12 : 3.4)));

    const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    let desired: THREE.Vector3;
    let lookAt: THREE.Vector3;
    if (this.mode === 'bumper') {
      const q = target.quaternion;
      desired = new THREE.Vector3(0, 0.55, 0.4).applyQuaternion(q).add(p);
      lookAt = new THREE.Vector3(0, 0.45, 12).applyQuaternion(q).add(p);
      this.pos.copy(desired);
    } else {
      const far = this.mode === 'far';
      const dist = (far ? 11.5 : 7.2) + Math.min(speed, 30) * 0.05;
      const height = far ? 4.2 : 2.35;
      desired = p.clone().addScaledVector(fwd, -dist).add(new THREE.Vector3(0, height, 0));
      lookAt = p.clone().addScaledVector(fwd, 2.5).add(new THREE.Vector3(0, 0.9, 0));
      this.pos.lerp(desired, 1 - Math.exp(-dt * 7));
      // keep the camera out of slabs, pillars and walls
      const from = p.clone().add(new THREE.Vector3(0, 1.0, 0));
      const dir = this.pos.clone().sub(from);
      const len = dir.length();
      if (len > 0.01) {
        dir.divideScalar(len);
        const hit = this.phys.world.castRay(new RAPIER.Ray(from, dir), len, true, undefined, RAY_GROUPS);
        if (hit) {
          const t = Math.max(0.6, hit.timeOfImpact - 0.35);
          this.pos.copy(from).addScaledVector(dir, t);
        }
      }
    }
    this.look.lerp(lookAt, 1 - Math.exp(-dt * 10));
    cam.position.copy(this.pos);
    if (this.shake > 0.001) {
      const s = this.shake * 0.25;
      cam.position.add(new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s));
      this.shake *= Math.exp(-dt * 7);
    }
    cam.lookAt(this.look);
    this.fov(this.baseFov + Math.min(speed, 40) * 0.42, dt);
  }

  private fov(target: number, dt: number) {
    const cam = this.camera;
    cam.fov += (target - cam.fov) * (1 - Math.exp(-dt * 3));
    cam.updateProjectionMatrix();
  }

  resize() {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }
}

function headingOf(o: THREE.Object3D) {
  const f = new THREE.Vector3(0, 0, 1).applyQuaternion(o.quaternion);
  return Math.atan2(f.x, f.z);
}
