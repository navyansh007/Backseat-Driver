import * as THREE from 'three';
import { RAPIER, type Physics } from '../physics';
import type { PlayerCar } from '../playerCar';
import type { Destruction } from './destruction';

/** A hit has to carry this much impulse (N·s) to hurt: a shove doesn't, a ram at 15 km/h does. */
const MIN_IMPULSE = 4000;
/** What a hit weighs against something with no mass of its own (traffic on rails): a parked car. */
const TRAFFIC_MASS = 1400;
const STEP = 1 / 60;
/** After a blast the air is full of bins and pallets: for this many steps they can't slow the car. */
const HOLD_STEPS = 45;

/**
 * A heavy car ramming things. A hit that wrecks a car costs the rammer nothing: it's seen coming
 * before the physics step and the target blows up before there is any contact to slow us down.
 * Lesser hits go through the ordinary collision and do damage by the impulse it reports.
 */
export class Ram {
  private linvel = { x: 0, y: 0, z: 0 };
  private angvel = { x: 0, y: 0, z: 0 };
  private holding = 0;
  private q = new THREE.Quaternion();
  private n = new THREE.Vector3();

  constructor(
    private phys: Physics,
    private car: PlayerCar,
    private destruction: Destruction,
    /** rams can't hurt anyone right now (in the arena they never hurt other players) */
    private off: () => boolean,
    private playerHandles: Set<number>,
  ) {}

  /** Before each physics step: sweep the chassis along its velocity and blow up whatever it would wreck. */
  preStep() {
    const heavy = this.car.def.heavy;
    const body = this.car.body;
    this.linvel = body.linvel();
    this.angvel = body.angvel();
    if (!heavy || this.off()) return;
    const chassis = this.car.sim.chassisColliders[0];
    const filter = (c: RAPIER.Collider) => {
      const b = c.parent();
      return !!b && this.destruction.isCar(b);
    };
    for (let i = 0; i < 4; i++) {
      const v = body.linvel();
      const hit = this.phys.world.castShape(
        chassis.translation(), chassis.rotation(), v, chassis.shape, 0.02, STEP * 1.6, true,
        undefined, undefined, undefined, body, filter,
      );
      const target = hit?.collider.parent();
      if (!hit || !target) return;
      // closing speed along the contact normal: a glancing touch isn't a ram
      const r = hit.collider.rotation();
      this.n.set(hit.normal1.x, hit.normal1.y, hit.normal1.z).applyQuaternion(this.q.set(r.x, r.y, r.z, r.w));
      const w = target.linvel();
      const closing = Math.abs((v.x - w.x) * this.n.x + (v.y - w.y) * this.n.y + (v.z - w.z) * this.n.z);
      const m = target.isDynamic() ? target.mass() : TRAFFIC_MASS;
      const impulse = ((body.mass() * m) / (body.mass() + m)) * closing;
      if (impulse < MIN_IMPULSE || !this.destruction.plough(target, (heavy.ram * impulse) / 1000)) return;
      this.holding = HOLD_STEPS;
    }
  }

  /** Right after each physics step: debris from a blast bounces off without costing any speed. */
  postStep() {
    if (this.holding <= 0) return;
    this.holding--;
    let loose = false;
    let solid = false;
    const world = this.phys.world;
    for (const c of this.car.sim.chassisColliders) {
      world.contactPairsWith(c, (other) => {
        world.contactPair(c, other, (manifold) => {
          if (manifold.numContacts() === 0) return;
          if (other.parent()?.isFixed()) solid = true;
          else loose = true;
        });
      });
    }
    // anything solid is a real crash; only loose stuff is ignored
    if (solid || !loose) return;
    const body = this.car.body;
    body.setLinvel({ x: this.linvel.x, y: body.linvel().y, z: this.linvel.z }, true);
    body.setAngvel(this.angvel, true);
  }

  /** After a physics step: a hit the sweep didn't see (something drove into us) still does its damage. */
  onContact(ev: RAPIER.TempContactForceEvent) {
    const heavy = this.car.def.heavy;
    const a = this.playerHandles.has(ev.collider1()), b = this.playerHandles.has(ev.collider2());
    if (!heavy || a === b || this.off()) return;
    const impulse = ev.totalForceMagnitude() * STEP;
    const hit = this.phys.world.getCollider(a ? ev.collider2() : ev.collider1())?.parent();
    if (impulse < MIN_IMPULSE || !hit || !this.destruction.isTarget(hit)) return;
    const t = hit.translation();
    const amount = (heavy.ram * impulse) / 1000;
    if (this.destruction.plough(hit, amount)) {
      // it blew up: undo what the collision took from us
      this.holding = HOLD_STEPS;
      this.car.body.setLinvel(this.linvel, true);
      this.car.body.setAngvel(this.angvel, true);
    } else this.destruction.damage(hit, amount, new THREE.Vector3(t.x, t.y, t.z));
  }
}
