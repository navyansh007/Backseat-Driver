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

/** Sent by the relay server. `ids` (host only) lists the phones currently in the room. */
export interface PeerMsg {
  t: 'peer';
  role: 'host' | 'remote';
  online: boolean;
  count: number;
  ids?: string[];
}

/**
 * WebRTC handshake, carried by the relay. The relay stamps `from` on messages a phone sends;
 * the host addresses a phone with `to`. Any host message with `to` goes to that phone only.
 */
export interface SignalMsg {
  t: 'sig';
  sdp?: { type: 'offer' | 'answer'; sdp: string };
  /** a trickled ICE candidate (RTCIceCandidateInit); null marks the end of gathering */
  ice?: { candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number | null; usernameFragment?: string | null } | null;
  from?: string;
  to?: string;
}

export type RemoteToHost = InputMsg | SignalMsg;
export type HostToRemote = (TelemetryMsg | HitMsg | SignalMsg) & { to?: string };
export type RelayMsg = PeerMsg;

export const RELAY_PATH = '/relay';
export const LAN_ENDPOINT = '/api/lan';
/** Relay frames larger than this are dropped (SDP offers are ~1–3 KB). */
export const MAX_FRAME = 16384;

/** Public STUN servers used to find a direct path between phone and game. */
export const ICE_SERVERS: { urls: string[] }[] = [
  { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] },
];
/** Data channel for input + telemetry: unordered, no retransmits — a stale packet is useless. */
export const CHANNEL_LABEL = 'rc';
export const CHANNEL_OPTS = { ordered: false, maxRetransmits: 0 };

export function makeRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}
