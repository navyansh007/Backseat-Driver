/**
 * The cars you can drive, as the title screen and the phone list them.
 * Names are affectionate parodies of the real cars they are modelled on.
 * To add a car: add an entry here and a matching one in game/cars/roster.ts.
 */
export interface CarInfo {
  /** stable key, stored in settings */
  id: string;
  maker: string;
  model: string;
  /** a few words for the picker */
  blurb: string;
  /** label on the phone's car switch */
  short: string;
  /** 1–5, for the picker's bars */
  stats: { speed: number; accel: number; grip: number; weight: number };
}

export const CARS: readonly CarInfo[] = [
  {
    id: 'saloon', maker: 'BMV', model: '750 iL', short: '750',
    blurb: 'long-wheelbase executive saloon, sunroof missiles optional',
    stats: { speed: 3, accel: 3, grip: 3, weight: 5 },
  },
  {
    id: 'db10', maker: 'Ashton Martyn', model: 'DB10', short: 'DB10',
    blurb: 'one-off grand tourer: low, wide and very, very fast',
    stats: { speed: 5, accel: 5, grip: 4, weight: 3 },
  },
];

export const CAR_IDS = CARS.map((c) => c.id);
export const DEFAULT_CAR = CARS[0].id;

export function carInfo(id: string) {
  return CARS.find((c) => c.id === id) ?? CARS[0];
}
