/** Messages exchanged over the relay. Remote → host and host → remote. */

/** Touchpad state. x: steer (-1 left … 1 right), y: throttle (-1 reverse … 1 forward). */
export interface InputMsg {
  t: 'in';
  x: number;
  y: number;
  /** finger is on the pad */
  a: boolean;
  /** machine-gun button held */
  g?: boolean;
  /** missile button press counter (each increment = one launch) */
  m?: number;
}

/** Telemetry the game streams back to the phone. */
export interface TelemetryMsg {
  t: 'tele';
  kmh: number;
  gear: string;
  /** missiles ready (0–4) */
  msl?: number;
  /** gun heat 0–1 */
  heat?: number;
  /** gun overheated */
  hot?: boolean;
  /** missile lock on a target */
  lock?: boolean;
}

/** Collision feedback, used for phone haptics. */
export interface HitMsg {
  t: 'hit';
  power: number;
}

/** Sent by the relay server. */
export interface PeerMsg {
  t: 'peer';
  role: 'host' | 'remote';
  online: boolean;
  count: number;
}

export type RemoteToHost = InputMsg;
export type HostToRemote = TelemetryMsg | HitMsg;
export type RelayMsg = PeerMsg;

export const RELAY_PATH = '/relay';
export const LAN_ENDPOINT = '/api/lan';

export function makeRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}
