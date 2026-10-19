import * as THREE from 'three';
import { RAPIER, G, groups, type InstancedBodies, type Physics } from '../physics';

/**
 * How a piece of street furniture fails when something runs into it.
 * Below `breakSpeed` it is anchored and behaves like a wall; above it the anchor
 * shears, `absorb` joules go into bending/snapping it, and the rest is an ordinary
 * momentum exchange between the hitter and the (now loose) piece.
 */
export interface BreakDef {
  /** kg once loose */
  mass: number;
  /** closing speed along the contact normal needed to snap the anchor, m/s */
  breakSpeed: number;
  /** energy taken out of the hitter by the failure itself, J */
  absorb: number;
  /** debris / spark colour */
  color: number;
}

export const BREAK = {
  fence: { mass: 32, breakSpeed: 3.5, absorb: 2500, color: 0xb9c0c6 },
  lamp: { mass: 140, breakSpeed: 6, absorb: 28000, color: 0x5b6168 },
  flagPole: { mass: 35, breakSpeed: 4, absorb: 5000, color: 0x9aa1a8 },
  bollard: { mass: 55, breakSpeed: 7, absorb: 22000, color: 0xe8b822 },
} satisfies Record<string, BreakDef>;

/** Collider in the piece's body space. */
export type PieceShape =
  | { kind: 'box'; center: THREE.Vector3; half: THREE.Vector3 }
  | { kind: 'cylinder'; center: THREE.Vector3; halfHeight: number; radius: number };

export type Visual = { set: InstancedBodies; index: number } | { obj: THREE.Object3D };

interface Piece {
  def: BreakDef;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  shape: PieceShape;
  visual: Visual;
  homeP: THREE.Vector3;
  homeQ: THREE.Quaternion;
  broken: boolean;
  brokenAt: number;
}

export interface BreakHooks {
  onBreak(point: THREE.Vector3, normal: THREE.Vector3, power: number, def: BreakDef, hitter: RAPIER.RigidBody): void;
}

const RESTITUTION = 0.25; // how much the piece bounces off the bumper
const DRAG = 0.35; // share of the hitter's sideways velocity the piece picks up (friction)
const RESPAWN_AFTER = 25;
const STEP = 1 / 60;

/**
 * Fences, lamp posts, flag poles and bollards. They start as fixed bodies and turn
 * into loose dynamic ones when hit hard enough, so they topple and slide rather than explode.
 * Broken pieces quietly stand back up once nobody is looking.
 */
export class Breakables {
  hooks: BreakHooks | null = null;
  private pieces: Piece[] = [];
  private byCollider = new Map<number, Piece>();
  private loose = new Set<Piece>();
  private time = 0;
  private scanT = 0;
  private frustum = new THREE.Frustum();
  private pm = new THREE.Matrix4();
  private sphere = new THREE.Sphere();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();

  constructor(private phys: Physics) {}

  /** Add an anchored piece; `attach` binds its visual to the new body. */
  add(def: BreakDef, pos: THREE.Vector3, rot: THREE.Quaternion, shape: PieceShape, attach: (body: RAPIER.RigidBody) => Visual) {
    const body = this.phys.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(pos.x, pos.y, pos.z)
        .setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w })
        .setLinearDamping(0.1)
        .setAngularDamping(0.3)
        .setCcdEnabled(true),
    );
    const desc = shape.kind === 'box'
      ? RAPIER.ColliderDesc.cuboid(shape.half.x, shape.half.y, shape.half.z)
      : RAPIER.ColliderDesc.cylinder(shape.halfHeight, shape.radius);
    const collider = this.phys.world.createCollider(
      desc.setTranslation(shape.center.x, shape.center.y, shape.center.z)
        .setMass(def.mass)
        .setFriction(0.6)
        .setRestitution(0.1)
        .setCollisionGroups(groups(G.WORLD, 0xffff))
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(20000),
      body,
    );
    const visual = attach(body);
    const piece: Piece = { def, body, collider, shape, visual, homeP: pos.clone(), homeQ: rot.clone(), broken: false, brokenAt: 0 };
    this.pieces.push(piece);
    this.byCollider.set(collider.handle, piece);
    this.write(piece);
    return piece;
  }

  /**
   * Before each physics step: sweep the car's chassis along its velocity and snap
   * anything it is about to hit fast enough, so the solver then sees a loose piece
   * instead of an immovable post and the car carries on through it.
   */
  preStep(car: RAPIER.RigidBody, chassis: RAPIER.Collider) {
    const lv = car.linvel();
    if (lv.x * lv.x + lv.y * lv.y + lv.z * lv.z < 9) return; // nothing breaks below 3 m/s
    const filter = (c: RAPIER.Collider) => {
      const p = this.byCollider.get(c.handle);
      return !!p && !p.broken;
    };
    for (let i = 0; i < 4; i++) {
      const hit = this.phys.world.castShape(
        chassis.translation(), chassis.rotation(), lv, chassis.shape, 0.02, STEP * 1.6, true,
        undefined, undefined, undefined, car, filter,
      );
      if (!hit) return;
      const piece = this.byCollider.get(hit.collider.handle)!;
      const t = chassis.translation();
      const v = car.linvel();
      if (!this.tryBreak(piece, car, new THREE.Vector3(t.x, t.y, t.z), new THREE.Vector3(v.x, v.y, v.z), true)) return;
    }
  }

  /**
   * Contact-force fallback for anything the sweep didn't see coming: parked cars
   * shoved into a fence, wrecks thrown by a blast, a hit with the cabin while airborne.
   */
  onContactForce(ev: RAPIER.TempContactForceEvent) {
    const a = this.byCollider.get(ev.collider1());
    const piece = a ?? this.byCollider.get(ev.collider2());
    if (!piece || piece.broken) return;
    const other = this.phys.world.getCollider(a ? ev.collider2() : ev.collider1());
    const hitter = other?.parent();
    if (!hitter || !hitter.isDynamic()) return;
    // the solver just took this much closing speed out of the hitter (≈ (1 + e)·u)
    const u = (ev.totalForceMagnitude() * STEP) / hitter.mass() / 1.1;
    if (u < piece.def.breakSpeed) return;
    const t = hitter.translation();
    const from = new THREE.Vector3(t.x, t.y, t.z);
    const { normal } = this.contact(piece, from);
    // reconstruct the pre-impact velocity: what's left now plus what the contact removed
    const v = hitter.linvel();
    const now = new THREE.Vector3(v.x, v.y, v.z);
    const closingNow = -now.dot(normal);
    const before = now.addScaledVector(normal, closingNow - u);
    this.tryBreak(piece, hitter, from, before, false, closingNow);
  }

  /** Where `from` meets the piece: world contact point and outward normal (pointing at the hitter). */
  private contact(piece: Piece, from: THREE.Vector3) {
    const t = piece.body.translation();
    const r = piece.body.rotation();
    this.q.set(r.x, r.y, r.z, r.w);
    const inv = this.q.clone().invert();
    const local = from.clone().sub(this.v.set(t.x, t.y, t.z)).applyQuaternion(inv).sub(piece.shape.center);
    const n = new THREE.Vector3();
    const c = new THREE.Vector3();
    const s = piece.shape;
    if (s.kind === 'box') {
      // nearest face by normalised distance, contact on that face
      const fx = Math.abs(local.x) / s.half.x, fz = Math.abs(local.z) / s.half.z;
      c.set(THREE.MathUtils.clamp(local.x, -s.half.x, s.half.x), THREE.MathUtils.clamp(local.y, -s.half.y, s.half.y), THREE.MathUtils.clamp(local.z, -s.half.z, s.half.z));
      if (fz >= fx) {
        n.set(0, 0, Math.sign(local.z) || 1);
        c.z = n.z * s.half.z;
      } else {
        n.set(Math.sign(local.x) || 1, 0, 0);
        c.x = n.x * s.half.x;
      }
    } else {
      n.set(local.x, 0, local.z);
      if (n.lengthSq() < 1e-6) n.set(0, 0, 1);
      n.normalize();
      c.copy(n).multiplyScalar(s.radius).setY(THREE.MathUtils.clamp(local.y, -s.halfHeight, s.halfHeight));
    }
    const point = c.add(s.center).applyQuaternion(this.q).add(this.v.set(t.x, t.y, t.z));
    const normal = n.applyQuaternion(this.q);
    return { point, normal };
  }

  /**
   * Snap the piece if the closing speed is high enough and share momentum:
   * the piece leaves at (1 + e)·M/(M + m)·u along the normal, the hitter loses that
   * momentum plus the energy the anchor absorbed while failing.
   */
  private tryBreak(piece: Piece, hitter: RAPIER.RigidBody, from: THREE.Vector3, vel: THREE.Vector3, predicted: boolean, closingNow = 0) {
    const { point, normal } = this.contact(piece, from);
    const u = -vel.dot(normal); // closing speed
    const def = piece.def;
    if (u < def.breakSpeed) return false;

    const M = hitter.mass();
    const m = def.mass;
    const vo = ((1 + RESTITUTION) * M * u) / (M + m);
    const tangential = vel.clone().addScaledVector(normal, u); // vel minus its normal part
    const impulse = normal.clone().multiplyScalar(-vo * m)
      .addScaledVector(tangential, DRAG * m)
      .add(this.v.set(0, 0.08 * u * m, 0)); // a little lift as the base lets go

    piece.broken = true;
    piece.brokenAt = this.time;
    this.loose.add(piece);
    piece.collider.setCollisionGroups(groups(G.PROP, 0xffff)); // wheels roll over it, sight lines ignore it
    piece.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    piece.body.recomputeMassPropertiesFromColliders();
    piece.body.applyImpulseAtPoint(impulse, point, true);

    // the hitter: momentum handed to the piece + energy spent breaking the anchor
    const lost = Math.min(0.85 * u, (vo * m + def.absorb / u) / M);
    const keep = u - lost; // closing speed the hitter should continue with
    const current = predicted ? u : closingNow;
    hitter.applyImpulse(normal.clone().multiplyScalar((current - keep) * M), true);

    this.hooks?.onBreak(point, normal, Math.min(1, u / 22), def, hitter);
    return true;
  }

  private write(p: Piece) {
    if ('set' in p.visual) {
      p.visual.set.refresh(p.visual.index);
      return;
    }
    const t = p.body.translation();
    const r = p.body.rotation();
    p.visual.obj.position.set(t.x, t.y, t.z);
    p.visual.obj.quaternion.set(r.x, r.y, r.z, r.w);
  }

  update(dt: number, camera: THREE.Camera, playerPos: THREE.Vector3) {
    this.time += dt;
    for (const p of this.loose) if (!p.body.isSleeping()) this.write(p);

    this.scanT -= dt;
    if (this.scanT > 0 || !this.loose.size) return;
    this.scanT = 0.5;
    camera.updateMatrixWorld();
    this.pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pm);
    const cur = new THREE.Vector3();
    for (const p of this.loose) {
      if (this.time - p.brokenAt < RESPAWN_AFTER) continue;
      const t = p.body.translation();
      cur.set(t.x, t.y, t.z);
      if (cur.distanceToSquared(playerPos) < 25 * 25 || p.homeP.distanceToSquared(playerPos) < 25 * 25) continue;
      if (this.frustum.intersectsSphere(this.sphere.set(p.homeP, 4)) || this.frustum.intersectsSphere(this.sphere.set(cur, 4))) continue;
      if (this.homeBlocked(p)) continue;
      this.restore(p);
    }
  }

  /** Something loose (a car, a prop, another fallen piece) is standing where this piece belongs. */
  private homeBlocked(p: Piece) {
    const c = p.shape.center.clone().applyQuaternion(p.homeQ).add(p.homeP);
    let blocked = false;
    this.phys.world.intersectionsWithShape(c, p.homeQ, p.collider.shape, () => {
      blocked = true;
      return false;
    }, RAPIER.QueryFilterFlags.EXCLUDE_FIXED, undefined, p.collider);
    return blocked;
  }

  private restore(p: Piece) {
    p.broken = false;
    this.loose.delete(p);
    p.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    p.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    p.body.setBodyType(RAPIER.RigidBodyType.Fixed, false);
    p.body.setTranslation(p.homeP, false);
    p.body.setRotation(p.homeQ, false);
    p.collider.setCollisionGroups(groups(G.WORLD, 0xffff));
    this.write(p);
  }
}
