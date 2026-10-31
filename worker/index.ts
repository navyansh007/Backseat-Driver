/**
 * Production server: a Cloudflare Worker that serves the built game (dist/) as static
 * assets and runs the phone relay in a Durable Object, one instance per room code.
 *
 * The relay mostly carries the few WebRTC handshake messages; phone and game then talk
 * directly. It uses the WebSocket Hibernation API, so an idle room (everyone on a direct
 * link) costs nothing while it waits.
 */
import { DurableObject } from 'cloudflare:workers';
import { LAN_ENDPOINT, RELAY_PATH } from '../src/shared/protocol';
import { fromHost, fromRemote, MAX_FRAME, parseParams, peerMsgs } from '../server/relayCore';
import { ARENA_PATH } from '../src/shared/arena';
import { ArenaRoom, parseArenaParams, type Conn } from '../server/arenaCore';

interface Env {
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace<Room>;
  ARENAS: DurableObjectNamespace<Arena>;
}

interface Tag {
  role: 'host' | 'remote';
  id: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === RELAY_PATH) {
      if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
      const params = parseParams(req.url);
      if (!params) return new Response('bad params', { status: 400 });
      return env.ROOMS.get(env.ROOMS.idFromName(params.room)).fetch(req);
    }
    if (url.pathname === ARENA_PATH) {
      if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
      const params = parseArenaParams(req.url);
      if (!params) return new Response('bad params', { status: 400 });
      return env.ARENAS.get(env.ARENAS.idFromName(params.room)).fetch(req);
    }
    if (url.pathname === LAN_ENDPOINT) {
      // no LAN fallback in production: the phone opens the same public origin
      return Response.json({ addresses: [], publicUrl: null }, { headers: { 'cache-control': 'no-store' } });
    }
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;

export class Room extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const params = parseParams(req.url);
    if (!params) return new Response('bad params', { status: 400 });
    const { 0: client, 1: server } = new WebSocketPair();

    if (params.role === 'host') {
      for (const old of this.ctx.getWebSockets('host')) old.close(4000, 'replaced');
    }
    this.ctx.acceptWebSocket(server, [params.role]);
    server.serializeAttachment({ role: params.role, id: params.id } satisfies Tag);
    this.announce();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    if (typeof data !== 'string' || data.length > MAX_FRAME) return;
    const tag = ws.deserializeAttachment() as Tag;
    if (tag.role === 'host') {
      const out = fromHost(data);
      if (!out) return;
      for (const r of this.open('remote')) {
        if (!out.to || out.to === (r.deserializeAttachment() as Tag).id) r.send(out.text);
      }
    } else {
      const out = fromRemote(data, tag.id);
      if (out) for (const h of this.open('host')) h.send(out);
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code); } catch { /* already closed */ }
    this.announce(ws);
  }

  async webSocketError(ws: WebSocket) {
    this.announce(ws);
  }

  private open(role: Tag['role'], except?: WebSocket) {
    return this.ctx.getWebSockets(role).filter((w) => w !== except && w.readyState === WebSocket.OPEN);
  }

  private announce(except?: WebSocket) {
    const hosts = this.open('host', except);
    const remotes = this.open('remote', except);
    const { toHost, toRemote } = peerMsgs(hosts.length > 0, remotes.map((r) => (r.deserializeAttachment() as Tag).id));
    for (const h of hosts) h.send(toHost);
    for (const r of remotes) r.send(toRemote);
  }
}

/**
 * One multiplayer arena. Unlike the phone relay it keeps the match in memory, so it uses plain
 * (non-hibernating) WebSockets: the object stays awake while anyone is connected, then goes away.
 */
export class Arena extends DurableObject<Env> {
  private arena: ArenaRoom | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  async fetch(req: Request): Promise<Response> {
    const params = parseArenaParams(req.url);
    if (!params) return new Response('bad params', { status: 400 });
    const room = (this.arena ??= new ArenaRoom(params.room));
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    const conn: Conn = {
      send: (text) => { try { server.send(text); } catch { /* closed */ } },
      close: (code, reason) => { try { server.close(code, reason); } catch { /* closed */ } },
    };
    server.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') room.message(conn, ev.data);
    });
    const gone = () => {
      room.leave(conn);
      if (room.empty && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
        this.arena = null;
      }
    };
    server.addEventListener('close', gone);
    server.addEventListener('error', gone);
    room.join(conn, params.id);
    // the match clock and dropped players need a tick even when nobody is sending
    this.timer ??= setInterval(() => room.tick(), 500);
    return new Response(null, { status: 101, webSocket: client });
  }
}
