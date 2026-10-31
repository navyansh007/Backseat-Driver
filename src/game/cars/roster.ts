import { SPECS, type CarSpec } from '../models/carModel';
import type { Tuning } from '../vehiclePhysics';
import { CARS, carInfo, type CarInfo } from '../../shared/cars';

type V3 = [number, number, number];

/**
 * Everything the game needs to put one car on the road. Heights are in car space (ground at y = 0),
 * lengths along +Z (forward). To add a car, add a CarInfo in shared/cars.ts and a CarDef here.
 */
export interface CarDef {
  info: CarInfo;
  spec: CarSpec;
  paint: number;
  /** wheel rim colour; chrome when left out */
  rim?: number;
  /** dark, opaque glass and no cabin behind it */
  blackout?: boolean;
  /** solid gloss paint instead of metallic */
  solid?: boolean;
  /** cabin trim colour, when the glass shows it */
  interior?: number;
  /** handling, on top of the shared TUNING */
  handling: Partial<Tuning>;
  /** collision boxes: half extents and centre, for the lower body and the cabin */
  chassis: { body: { half: V3; at: V3 }; cabin: { half: V3; at: V3 } };
  mounts: {
    /** left headlamp; the right one mirrors it */
    headlamp: V3;
    /** left gun, stowed; the right one mirrors it */
    gun: V3;
    /** guns rise this far out of the bodywork to fire (default: they slide forward out of the bumper) */
    gunLift?: number;
    /** missile launcher, stowed: y of its centre and z */
    launcher: [number, number];
  };
}

const DEFS: Record<string, Omit<CarDef, 'info'>> = {
  // The hero of the film: a long, low late-90s executive saloon.
  saloon: {
    spec: SPECS.executive,
    paint: 0x5b636c,
    handling: {},
    chassis: {
      body: { half: [0.9, 0.27, 2.52], at: [0, 0.56, 0] },
      cabin: { half: [0.74, 0.24, 1.3], at: [0, 1.12, -0.3] },
    },
    mounts: { headlamp: [0.57, 0.62, 2.5], gun: [0.42, 0.34, 2.36], launcher: [1.3, -0.45] },
  },
  // A one-off grand tourer: long bonnet rising to a steeply raked screen, small cabin set back,
  // fastback falling to a ducktail. Proportions taken from a side photo of the real car.
  db10: {
    spec: {
      name: 'db10', L: 4.64, W: 1.96, H: 1.28, bottom: 0.15, hoodH: 0.76, beltH: 0.9, trunkH: 0.9,
      wsBaseZ: 0.46, roofFrontZ: -0.12, roofRearZ: -0.8, rwBaseZ: -1.6,
      wheelR: 0.37, wheelW: 0.27, frontAxleZ: 1.38, rearAxleZ: -1.46, track: 0.83,
      rear: 'fastback', grille: 'vane', plate: 'DB·010', chromeTrim: true, wheels: 'sport',
      cabinInset: 0.2, tumble: 0.5, taper: 0.2, hips: 0.06, pillar: 0.75, doors: 2, bumpers: 'sport', strake: true,
      loft: {
        // centre line: the bonnet climbs steadily from a low nose to the screen, the screen is long and
        // raked, and the roof runs in one line down the fastback to a small ducktail
        top: [
          [2.32, 0.47], [2.26, 0.585], [2.1, 0.675], [1.7, 0.76], [1.2, 0.83], [0.8, 0.885], [0.46, 0.93], [0.2, 1.05],
          [-0.12, 1.22], [-0.45, 1.28], [-0.8, 1.24], [-1.17, 1.13], [-1.5, 1.04], [-1.87, 0.955], [-2.18, 0.9],
          [-2.28, 0.905], [-2.32, 0.86],
        ],
        // shoulder: wings level with the bonnet edges, rising gently to the rear haunches
        belt: [
          [2.32, 0.5], [2.2, 0.64], [1.9, 0.75], [1.38, 0.845], [0.9, 0.865], [0.46, 0.885], [-0.4, 0.92],
          [-1.1, 0.955], [-1.5, 0.965], [-1.9, 0.93], [-2.2, 0.88], [-2.32, 0.8],
        ],
        // plan: a pointed nose, swelling over the front wheels, pinched at the doors, widest over the rear wheels
        width: [
          [2.32, 0.54], [2.25, 0.74], [2.1, 0.85], [1.9, 0.92], [1.38, 0.965], [0.8, 0.945], [0.0, 0.935], [-0.8, 0.96],
          [-1.46, 0.99], [-1.95, 0.95], [-2.2, 0.85], [-2.32, 0.72],
        ],
        bottom: [[2.32, 0.22], [2.15, 0.16], [-2.05, 0.17], [-2.32, 0.32]],
        roofHalf: 0.5,
        glass: { wsBase: 0.46, roofFront: -0.15, roofRear: -0.75, rwBase: -1.6, sideFront: 0.45, sideRear: -1.3 },
        arches: [{ z: 1.38, y: 0.37, r: 0.43 }, { z: -1.46, y: 0.37, r: 0.43 }],
      },
    },
    paint: 0xb4b9bd,
    rim: 0x2a2d31,
    blackout: true,
    handling: {
      mass: 1450, engineForce: 6600, reverseForce: 4600, topSpeed: 46, brake: 108,
      frictionFront: 2.6, frictionRear: 2.4, frictionRearHandbrake: 0.8, maxSteer: 0.6, highSpeedSteer: 0.14, steerRate: 3.6,
    },
    chassis: {
      body: { half: [0.95, 0.3, 2.3], at: [0, 0.53, 0] },
      cabin: { half: [0.65, 0.2, 0.9], at: [0, 1.05, -0.5] },
    },
    // the long bonnet hides everything: the launcher rises out of its middle, the guns out of slots either side
    mounts: { headlamp: [0.62, 0.64, 2.15], gun: [0.45, 0.7, 1.55], gunLift: 0.16, launcher: [0.72, 1.0] },
  },
  // A 1969 fastback with a racing V8: long flat bonnet with a big scoop, a short cabin, a fastback roof
  // running to a Kamm tail, slats over the rear glass and a wing on the deck. Proportions measured from
  // a side photo of the real car (4.76 m long, 2.74 m between the axles, 1.31 m tall).
  boss: {
    spec: {
      name: 'boss', L: 4.76, W: 1.82, H: 1.31, bottom: 0.24, hoodH: 0.78, beltH: 0.915, trunkH: 0.93,
      wsBaseZ: 0.61, roofFrontZ: 0.15, roofRearZ: -0.95, rwBaseZ: -1.8,
      wheelR: 0.33, wheelW: 0.24, frontAxleZ: 1.4, rearAxleZ: -1.34, track: 0.76,
      rear: 'fastback', grille: 'quad', plate: 'BS·429', chromeTrim: true, wheels: 'magnum', letters: true,
      tailLamps: 'triple', pillar: 0.66, doors: 2, bumpers: 'chrome',
      muscle: { scoop: [1.78, 1.06, 0.31, 0.125], louvers: 7, wing: [-1.99, -2.24], quarterScoop: -0.72, badge: ['BOSS', '429'] },
      loft: {
        // centre line: a sharp brow over the grille, a long flat bonnet rising gently to the cowl, a raked
        // screen, then the roof falls in one long line down the fastback to a short flat deck and a
        // squared-off tail
        top: [
          [2.38, 0.74], [2.35, 0.775], [2.25, 0.8], [2.0, 0.83], [1.76, 0.85], [1.2, 0.885], [0.8, 0.91], [0.61, 0.93],
          [0.45, 1.055], [0.3, 1.175], [0.15, 1.28], [0.0, 1.305], [-0.18, 1.31], [-0.55, 1.292], [-0.88, 1.262],
          [-1.0, 1.245], [-1.32, 1.2], [-1.73, 1.1], [-1.98, 1.0], [-2.2, 0.945], [-2.33, 0.94], [-2.38, 0.905],
        ],
        // shoulder: the crease along the tops of the wings and doors, nearly level, kicking up a touch at the back
        belt: [
          [2.38, 0.76], [2.32, 0.8], [2.0, 0.84], [1.4, 0.87], [0.6, 0.905], [-0.7, 0.915], [-1.4, 0.925],
          [-2.2, 0.925], [-2.38, 0.9],
        ],
        // plan: a broad, blunt nose, slab sides and a full-width tail
        width: [
          [2.38, 0.8], [2.3, 0.86], [2.1, 0.895], [1.4, 0.905], [0.6, 0.9], [-0.5, 0.9], [-1.34, 0.912], [-2.0, 0.905],
          [-2.3, 0.88], [-2.38, 0.85],
        ],
        // the underside climbs steeply at the nose, so the brow juts out over a recessed grille
        bottom: [[2.38, 0.66], [2.35, 0.6], [2.31, 0.38], [2.22, 0.26], [1.9, 0.24], [-1.9, 0.24], [-2.2, 0.27], [-2.32, 0.33], [-2.38, 0.37]],
        roofHalf: 0.55,
        glass: { wsBase: 0.6, roofFront: 0.14, roofRear: -1.0, rwBase: -1.8, sideFront: 0.57, sideRear: -0.88 },
        arches: [{ z: 1.4, y: 0.33, r: 0.39 }, { z: -1.34, y: 0.33, r: 0.405 }],
        // flat sides, widest high up, under a crisp shoulder crease that the side glass starts right on
        flank: { sill: 0.88, widest: 0.75, shoulder: 0.985, inset: 0.13, rise: 0.012 },
      },
    },
    paint: 0x0b0b0c,
    solid: true,
    interior: 0x1a1a1c,
    handling: {
      mass: 1720, engineForce: 7000, reverseForce: 4600, topSpeed: 44, brake: 90, stiffness: 28,
      frictionFront: 2.25, frictionRear: 1.95, frictionRearHandbrake: 0.65, maxSteer: 0.58, highSpeedSteer: 0.15, steerRate: 3.0,
    },
    chassis: {
      body: { half: [0.9, 0.3, 2.36], at: [0, 0.55, 0] },
      cabin: { half: [0.6, 0.19, 0.95], at: [0, 1.1, -0.35] },
    },
    // guns slide out of the valence under the front bumper; the launcher rises up through the bonnet scoop
    mounts: { headlamp: [0.65, 0.6, 2.3], gun: [0.4, 0.38, 2.12], launcher: [0.75, 1.35] },
  },
};

export function carDef(id: string): CarDef {
  const info = carInfo(id);
  return { info, ...DEFS[info.id] };
}

// every car listed for the picker must be buildable
for (const c of CARS) if (!DEFS[c.id]) throw new Error(`car "${c.id}" has no definition in roster.ts`);
