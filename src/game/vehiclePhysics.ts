import RAPIER from '@dimforge/rapier3d-compat';

/**
 * Rear-wheel-drive raycast vehicle on top of Rapier's DynamicRayCastVehicleController.
 * No DOM / three.js dependencies so it can be tuned headlessly.
 *
 * Body space: +Z forward, +Y up. The body origin sits RIDE_H above the ground at rest.
 */

export const TUNING = {
  mass: 1550,
  rideHeight: 0.62, // body origin above ground at rest
  suspensionRest: 0.3,
  suspensionTravel: 0.22,
  stiffness: 32,
  compression: 3.2,
  relaxation: 4.2,
  maxSuspensionForce: 60000,
  frictionFront: 2.4,
  frictionRear: 2.15,
  frictionRearHandbrake: 0.75,
  sideStiffness: 1.0,
  engineForce: 5400, // per driven wheel
  reverseForce: 2200,
  topSpeed: 36, // m/s ≈ 130 km/h
  reverseTopSpeed: 9,
  brake: 52, // per wheel
  coastBrake: 2.2,
  maxSteer: 0.62,
  highSpeedSteer: 0.16,
  steerRate: 3.2,
};

const WORLD_BITS = 0x0001 | 0x0008; // wheels ride on world + cars, never on small props
const RAY_GROUPS = (0xffff << 16) | WORLD_BITS;

export interface WheelLayout {
  frontAxleZ: number;
  rearAxleZ: number;
  track: number;
  radius: number;
}

export interface DriveInput {
  steer: number; // -1 left .. 1 right
  throttle: number; // -1 .. 1
  handbrake: boolean;
}

export class VehicleSim {
  readonly body: RAPIER.RigidBody;
  readonly controller: RAPIER.DynamicRayCastVehicleController;
  readonly chassisColliders: RAPIER.Collider[] = [];
  readonly layout: WheelLayout;
  steer = 0;
  /** Driving assist strength, 0 (off) … 1 (strong). */
  assist = 0.7;
  /** How much the assist changed the steering this step (for UI/debug). */
  assistSteer = 0;
  braking = false;
  reversing = false;
  engineLoad = 0;
  private world: RAPIER.World;

  constructor(world: RAPIER.World, layout: WheelLayout, spawn: { x: number; y: number; z: number; yaw: number }, playerGroups: number) {
    this.world = world;
    this.layout = layout;
    const T = TUNING;
    const q = yawQuat(spawn.yaw);
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(spawn.x, spawn.y + T.rideHeight, spawn.z)
        .setRotation(q)
        .setLinearDamping(0.02)
        .setAngularDamping(0.6)
        .setCcdEnabled(true)
        .setCanSleep(false),
    );
    const main = RAPIER.ColliderDesc.cuboid(0.9, 0.27, 2.52)
      .setTranslation(0, -0.06, 0)
      .setMassProperties(T.mass, { x: 0, y: -0.24, z: 0.05 }, { x: 3300, y: 3700, z: 750 }, { x: 0, y: 0, z: 0, w: 1 })
      .setFriction(0.35)
      .setRestitution(0.15)
      .setCollisionGroups(playerGroups)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(9000);
    const cabin = RAPIER.ColliderDesc.cuboid(0.74, 0.24, 1.3)
      .setTranslation(0, 0.5, -0.3)
      .setDensity(0)
      .setFriction(0.3)
      .setCollisionGroups(playerGroups)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(9000);
    this.chassisColliders.push(world.createCollider(main, this.body), world.createCollider(cabin, this.body));

    const vc = world.createVehicleController(this.body);
    vc.indexUpAxis = 1;
    vc.setIndexForwardAxis = 2;
    const restCenterY = layout.radius - T.rideHeight; // wheel centre in body space at rest
    const restLen = T.suspensionRest - (9.81 / (4 * T.stiffness)); // expected static compression
    const connY = restCenterY + restLen;
    const positions = [
      { x: layout.track, z: layout.frontAxleZ },
      { x: -layout.track, z: layout.frontAxleZ },
      { x: layout.track, z: layout.rearAxleZ },
      { x: -layout.track, z: layout.rearAxleZ },
    ];
    positions.forEach((p, i) => {
      vc.addWheel({ x: p.x, y: connY, z: p.z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, T.suspensionRest, layout.radius);
      vc.setWheelSuspensionStiffness(i, T.stiffness);
      vc.setWheelSuspensionCompression(i, T.compression);
      vc.setWheelSuspensionRelaxation(i, T.relaxation);
      vc.setWheelMaxSuspensionTravel(i, T.suspensionTravel);
      vc.setWheelMaxSuspensionForce(i, T.maxSuspensionForce);
      vc.setWheelFrictionSlip(i, i < 2 ? T.frictionFront : T.frictionRear);
      vc.setWheelSideFrictionStiffness(i, T.sideStiffness);
    });
    this.controller = vc;
  }

  /** Signed speed along the car's forward axis, m/s. */
  forwardSpeed() {
    const v = this.body.linvel();
    const r = this.body.rotation();
    // forward = rotate (0,0,1) by r
    const fx = 2 * (r.x * r.z + r.w * r.y);
    const fy = 2 * (r.y * r.z - r.w * r.x);
    const fz = 1 - 2 * (r.x * r.x + r.y * r.y);
    return v.x * fx + v.y * fy + v.z * fz;
  }

  /** World-space Y component of the car's up axis (1 = upright). */
  upright() {
    const r = this.body.rotation();
    return 1 - 2 * (r.x * r.x + r.z * r.z);
  }

  drive(dt: number, input: DriveInput) {
    const T = TUNING;
    const vc = this.controller;
    const speed = this.forwardSpeed();
    const abs = Math.abs(speed);

    // speed-sensitive steering with a rate limit
    const lim = T.maxSteer + (T.highSpeedSteer - T.maxSteer) * Math.min(1, abs / 30);
    const help = this.assists(dt, input, speed);
    this.assistSteer = help.steer;
    const target = THREE_CLAMP(-input.steer * lim + help.steer, -T.maxSteer, T.maxSteer);
    const rate = T.steerRate * dt * (input.steer === 0 ? 1.6 : 1);
    this.steer += Math.max(-rate, Math.min(rate, target - this.steer));
    vc.setWheelSteering(0, this.steer);
    vc.setWheelSteering(1, this.steer);

    let engine = 0;
    let brake = 0;
    const th = input.throttle;
    this.braking = false;
    if (th > 0.02) {
      if (speed < -0.8) {
        brake = T.brake * th;
        this.braking = true;
      } else {
        engine = T.engineForce * th * Math.max(0, 1 - Math.max(0, speed) / T.topSpeed) * help.traction;
        this.reversing = false;
      }
    } else if (th < -0.02) {
      if (speed > 0.8) {
        brake = T.brake * -th;
        this.braking = true;
      } else {
        engine = -T.reverseForce * -th * Math.max(0, 1 - Math.max(0, -speed) / T.reverseTopSpeed);
        this.reversing = true;
      }
    } else {
      brake = abs < 0.6 ? T.brake * 0.4 : T.coastBrake;
    }
    if (abs < 0.3 && Math.abs(th) < 0.02) this.reversing = false;
    this.engineLoad = Math.abs(th);

    for (let i = 0; i < 4; i++) {
      const rear = i >= 2;
      vc.setWheelEngineForce(i, rear ? engine : 0);
      let b = brake;
      if (input.handbrake && rear) {
        b = Math.max(b, T.brake * 0.9);
        this.braking = true;
      }
      vc.setWheelBrake(i, b);
      vc.setWheelFrictionSlip(i, !rear ? T.frictionFront : input.handbrake ? T.frictionRearHandbrake : T.frictionRear);
    }

    vc.updateVehicle(dt, undefined, RAY_GROUPS);
  }

  /**
   * Driving aids, scaled by `assist`:
   *  - counter-steer: point the front wheels along the direction of travel when sliding
   *  - yaw damping: resist rotation beyond what the steering asks for (spin-outs)
   *  - traction control: cut drive while the car is sideways
   *  - obstacle nudge: short feelers steer gently away from walls, pillars and cars
   */
  private assists(dt: number, input: DriveInput, speed: number) {
    const out = { steer: 0, traction: 1 };
    const a = this.assist;
    if (a <= 0) return out;
    const abs = Math.abs(speed);
    const r = this.body.rotation();
    const v = this.body.linvel();
    // world → body: rotate by the inverse quaternion
    const local = rotate({ x: -r.x, y: -r.y, z: -r.z, w: r.w }, v);
    const beta = abs > 3 && speed > 0 ? Math.atan2(local.x, local.z) : 0;

    // 1) counter-steer into a slide
    out.steer += beta * 0.9 * a;

    // 2) yaw damping against oversteer
    if (abs > 4 && !input.handbrake) {
      const yawRate = this.body.angvel().y;
      const desired = (speed * Math.tan(this.steer)) / (this.layout.frontAxleZ - this.layout.rearAxleZ);
      const excess = yawRate - desired;
      if (Math.abs(yawRate) > Math.abs(desired) && Math.sign(excess) === Math.sign(yawRate)) {
        const k = 3.2 * a;
        this.body.applyTorqueImpulse({ x: 0, y: -excess * k * 3700 * dt, z: 0 }, true);
      }
    }

    // 3) traction control while sideways
    if (Math.abs(beta) > 0.2 && input.throttle > 0) out.traction = 1 - Math.min(0.65, (Math.abs(beta) - 0.2) * 2) * a;

    // 4) obstacle nudge (only when the driver isn't already steering hard)
    if (speed > 7 && Math.abs(input.steer) < 0.55 && input.throttle >= 0) {
      const range = Math.min(42, 8 + speed * 1.4);
      const t = this.body.translation();
      const inv = { x: -r.x, y: -r.y, z: -r.z, w: r.w };
      // returns clearance 0..1 and, for a hit, the obstacle's lateral offset in car space (+ = left)
      const feel = (offsetX: number, ang: number) => {
        const dir = rotate(r, { x: Math.sin(ang), y: 0, z: Math.cos(ang) });
        const o = rotate(r, { x: offsetX, y: 0.05, z: 2.4 });
        const hit = this.world.castRayAndGetNormal(
          new RAPIER.Ray({ x: t.x + o.x, y: t.y + o.y, z: t.z + o.z }, dir),
          range, true, undefined, RAY_GROUPS, undefined, this.body,
        );
        if (!hit || hit.normal.y > 0.5) return { clear: 1, side: 0 }; // ignore ramps and floors
        const c = hit.collider.translation();
        const side = rotate(inv, { x: c.x - t.x, y: c.y - t.y, z: c.z - t.z }).x;
        return { clear: hit.timeOfImpact / range, side };
      };
      // straight feelers across the full width of the car (+x is the car's left)
      let nearest = { clear: 1, side: 0 };
      for (const x of [-1.0, -0.5, 0, 0.5, 1.0]) {
        const f = feel(x, 0);
        if (f.clear < nearest.clear) nearest = f;
      }
      // angled feelers tell which side has more room
      const left = feel(0.7, 0.3).clear;
      const right = feel(-0.7, -0.3).clear;
      let push = (left - right) * 0.6; // >0: more room on the left → steer left
      // steer away from the closest thing in our path, harder the closer it is
      if (nearest.clear < 1) {
        const away = Math.abs(nearest.side) < 0.05 ? (left >= right ? 1 : -1) : nearest.side > 0 ? -1 : 1;
        push += away * 0.4 * Math.sqrt(1 - nearest.clear);
      }
      out.steer += THREE_CLAMP(push, -0.35, 0.35) * a;
    }
    return out;
  }

  reset(x: number, y: number, z: number, yaw: number) {
    this.body.setTranslation({ x, y: y + TUNING.rideHeight + 0.3, z }, true);
    this.body.setRotation(yawQuat(yaw), true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.steer = 0;
  }

  yaw() {
    const r = this.body.rotation();
    const fx = 2 * (r.x * r.z + r.w * r.y);
    const fz = 1 - 2 * (r.x * r.x + r.y * r.y);
    return Math.atan2(fx, fz);
  }

  dispose() {
    this.world.removeVehicleController(this.controller);
    this.world.removeRigidBody(this.body);
  }
}

const THREE_CLAMP = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

type Q = { x: number; y: number; z: number; w: number };
type V = { x: number; y: number; z: number };
/** Rotate vector v by unit quaternion q. */
function rotate(q: Q, v: V): V {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + q.y * tz - q.z * ty,
    y: v.y + q.w * ty + q.z * tx - q.x * tz,
    z: v.z + q.w * tz + q.x * ty - q.y * tx,
  };
}

export function yawQuat(yaw: number) {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}
