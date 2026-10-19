/**
 * Room routing shared by the Vite relay (Node) and the Cloudflare Durable Object.
 * Phones talk to the host only; the host talks to every phone, or to one with `to`.
 * The relay mostly carries the WebRTC handshake. Input travels over it only when a
 * direct peer connection can't be made.
 */
export { MAX_FRAME } from '../src/shared/protocol';
import { MAX_FRAME } from '../src/shared/protocol';

export const ROOM_RE = /^[A-Z0-9]{4,12}$/;
const PEER_ID_RE = /^[0-9a-f]{8}$/;

export function parseParams(rawUrl: string) {
  const url = new URL(rawUrl, 'http://local');
  const room = (url.searchParams.get('room') ?? '').toUpperCase();
  const role = url.searchParams.get('role');
  if (!ROOM_RE.test(room) || (role !== 'host' && role !== 'remote')) return null;
  // phones pick their own id so a relay reconnect doesn't break their direct link
  const id = url.searchParams.get('id') ?? '';
  return { room, role, id: PEER_ID_RE.test(id) ? id : makePeerId() } as const;
}

export function makePeerId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');
}

function parse(text: string): Record<string, unknown> | null {
  if (text.length > MAX_FRAME) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** A phone's frame, stamped with its id for the host. */
export function fromRemote(text: string, id: string): string | null {
  const msg = parse(text);
  if (!msg) return null;
  msg.from = id;
  return JSON.stringify(msg);
}

/** A host frame and who it is for (undefined = every phone). */
export function fromHost(text: string): { to?: string; text: string } | null {
  const msg = parse(text);
  if (!msg) return null;
  return typeof msg.to === 'string' ? { to: msg.to, text } : { text };
}

export function peerMsgs(hostOnline: boolean, remoteIds: string[]) {
  const count = remoteIds.length;
  return {
    toHost: JSON.stringify({ t: 'peer', role: 'remote', online: count > 0, count, ids: remoteIds }),
    toRemote: JSON.stringify({ t: 'peer', role: 'host', online: hostOnline, count }),
  };
}
