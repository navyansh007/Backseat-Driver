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
  // ---- action mode only
  /** armour left, 0–1 */
  hp?: number;
  wave?: number;
  /** pursuers still alive */
  foes?: number;
  /** fighting a wave, the break before the next one, or wrecked */
  st?: ActionState;
  /** seconds until the next wave (during a break) */
  next?: number;
  score?: number;
  /** charges ready per trap, in TRAP_KINDS order */
  tc?: number[];
  /** recharge progress of the next charge per trap, 0–1 (1 = full) */
  tk?: number[];
  /** radar: [bearing in degrees (0 = ahead, + = right), distance in m] per pursuer, flattened */
  rad?: number[];
  // ---- arena only
  /** our place in the standings, of how many */
  place?: number;
  of?: number;
  /** our destruction points */
  pts?: number;
  /** seconds until we're back in after a wreck (present only while wrecked) */
  back?: number;
  /** seconds left in the match */
  left?: number;
}

export type ActionState = 'fight' | 'break' | 'over';

export const GAME_MODES = ['casual', 'action'] as const;
export type GameMode = (typeof GAME_MODES)[number];
/** Gadgets the car can drop in action mode. */
export const TRAP_KINDS = ['spikes', 'oil', 'mine', 'smoke', 'emp'] as const;
export type TrapKind = (typeof TRAP_KINDS)[number];

/** Chase-camera views the phone can pick. */
export const CAM_VIEWS = ['chase', 'far', 'bumper'] as const;
export type CamView = (typeof CAM_VIEWS)[number];
/** Steering-assist levels, weakest first. */
export const ASSIST_NAMES = ['off', 'light', 'medium', 'strong'] as const;
/** Render resolution presets: the most device pixels drawn per CSS pixel. */
export const QUALITY_LEVELS = [
  { name: 'low', ratio: 0.75 },
  { name: 'medium', ratio: 1 },
  { name: 'high', ratio: 1.5 },
  { name: 'max', ratio: 2 },
] as const;
export type RendererChoice = 'webgpu' | 'webgl';

/** Game settings the phone can change. */
export interface Settings {
  /** casual drive, or action: waves of pursuers */
  mode: GameMode;
  /** which car you drive: an id from CARS (shared/cars.ts) */
  car: string;
  cam: CamView;
  /** index into ASSIST_NAMES */
  assist: number;
  /** slow-motion stunt cinematics */
  stunts: boolean;
  sound: boolean;
  /** master volume 0–1 */
  volume: number;
  music: boolean;
  /** soundtrack volume 0–1 */
  musicVolume: number;
  /** keyboard hints on the game screen */
  hints: boolean;
  /** index into QUALITY_LEVELS */
  quality: number;
  /** graphics backend to use; changing it reloads the game */
  renderer: RendererChoice;
}
export type SettingKey = keyof Settings;

/** The game's current settings and state, sent to phones on every change and once a second. */
export interface SettingsMsg extends Settings {
  t: 'cfg';
  /** driving (false: on the title / pairing screen) */
  playing: boolean;
  /** backend actually running */
  backend: RendererChoice;
  /** the game page has been clicked, so the browser lets it play sound */
  audio: boolean;
  /** in an online arena match */
  arena?: boolean;
  /** settings the phone can't change right now (the car and mode, mid-match) */
  locked?: SettingKey[];
}

/**
 * A phone command. Sent over both the direct link and the relay so it isn't lost;
 * the game ignores an `id` it has already seen.
 */
export type CommandMsg = { t: 'cmd'; id: string } & (
  | { c: 'start' | 'menu' | 'reset' | 'respawn' | 'restart' }
  | { c: 'trap'; k: TrapKind }
  | { [K in SettingKey]: { c: 'set'; k: K; v: Settings[K] } }[SettingKey]
);

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

export type RemoteToHost = InputMsg | CommandMsg | SignalMsg;
export type HostToRemote = (TelemetryMsg | SettingsMsg | HitMsg | SignalMsg) & { to?: string };
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
