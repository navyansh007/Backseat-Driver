import { RAPIER, G, type Physics } from './physics';
import type { CarDef } from './cars/roster';

export interface Spot {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** Room left free behind the car, so it can always reverse out. */
const REVERSE_ROOM = 3.5;
const SIDE_MARGIN = 0.2;
const END_MARGIN = 0.3;
/** How far a search goes, in steps of STEP_M. */
const MAX_RADIUS = 60;
const STEP_M = 1.5;
/** Ground this much out of level isn't somewhere to put a car down. */
const MIN_NORMAL_Y = 0.985;
const MAX_STEP = 0.05;

/**
 * The nearest place to put a car down: flat fixed ground under all of it, nothing in the space it
 * will fill, and room to reverse. Rings out from (x, z) a step at a time; at each point the car's
 * own heading is tried first, then the other three. Null if there is nowhere in range.
 */
export function clearSpot(phys: Physics, def: CarDef, self: RAPIER.RigidBody, x: number, y: number, z: number, yaw: number): Spot | null {
  const world = phys.world;
  const halfW = def.spec.W / 2 + SIDE_MARGIN;
  const { half, at } = def.chassis.body;
  const front = Math.max(def.spec.L / 2, at[2] + half[2]) + END_MARGIN;
  const rear = Math.max(def.spec.L / 2, half[2] - at[2]) + END_MARGIN;
  const height = def.spec.H;
  const fromY = y + 1.5;
  const down = { x: 0, y: -1, z: 0 };

  /** The fixed surface under a point, if it's what's there and it's level. */
  const ground = (px: number, pz: number) => {
    const hit = world.castRayAndGetNormal(
      new RAPIER.Ray({ x: px, y: fromY, z: pz }, down), 40, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, self,
    );
    if (!hit || hit.normal.y < MIN_NORMAL_Y || !hit.collider.parent()?.isFixed() || !(hit.collider.collisionGroups() >> 16 & G.WORLD)) return null;
    return fromY - hit.timeOfImpact;
  };
  /** A box standing on `base` is free of everything but us. */
  const free = (cx: number, cz: number, base: number, hx: number, hy: number, hz: number, q: { x: number; y: number; z: number; w: number }) => !world.intersectionWithShape(
    { x: cx, y: base + hy, z: cz }, q, new RAPIER.Cuboid(hx, hy, hz), RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, self,
  );

  const fits = (px: number, pz: number, heading: number): Spot | null => {
    const sin = Math.sin(heading), cos = Math.cos(heading);
    const y0 = ground(px, pz);
    if (y0 === null) return null;
    // the whole footprint on one level, reversing room included
    const local = (right: number, along: number) => [px + cos * right + sin * along, pz - sin * right + cos * along] as const;
    for (const [right, along] of [[-1, 1], [1, 1], [-1, 0], [1, 0], [-1, -1], [1, -1]] as const) {
      const [cx, cz] = local(right * halfW, along > 0 ? front : along < 0 ? -rear - REVERSE_ROOM : 0);
      const g = ground(cx, cz);
      if (g === null || Math.abs(g - y0) > MAX_STEP) return null;
    }
    const q = { x: 0, y: Math.sin(heading / 2), z: 0, w: Math.cos(heading / 2) };
    const base = y0 + 0.08;
    const mid = (front - rear) / 2;
    const [bx, bz] = local(0, mid);
    if (!free(bx, bz, base, halfW, height / 2, (front + rear) / 2, q)) return null;
    const [rx, rz] = local(0, -rear - REVERSE_ROOM / 2);
    if (!free(rx, rz, base, halfW, height / 2, REVERSE_ROOM / 2, q)) return null;
    return { x: px, y: y0, z: pz, yaw: heading };
  };

  for (let r = 0; r <= MAX_RADIUS; r += STEP_M) {
    const n = r === 0 ? 1 : Math.max(8, Math.round((Math.PI * 2 * r) / STEP_M));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      for (const turn of [0, Math.PI, Math.PI / 2, -Math.PI / 2]) {
        const spot = fits(px, pz, yaw + turn);
        if (spot) return spot;
      }
    }
  }
  return null;
}
