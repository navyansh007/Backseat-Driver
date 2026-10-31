/**
 * Tiny WebSocket relay that pairs a game screen ("host") with phones ("remote")
 * by room code. It is mounted on Vite's own HTTP server, so `npm run dev` and
 * `npm run preview` serve the game, the remote page and the relay on one port.
 * In production the same routing runs in a Cloudflare Durable Object (worker/).
 */
import type { Plugin, ViteDevServer, PreviewServer } from 'vite';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import os from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import { LAN_ENDPOINT, MAX_FRAME, RELAY_PATH } from '../src/shared/protocol';
import { fromHost, fromRemote, parseParams, peerMsgs } from './relayCore';
import { ARENA_PATH } from '../src/shared/arena';
import { ArenaRoom, parseArenaParams } from './arenaCore';

interface Room {
  host: WebSocket | null;
  remotes: Map<WebSocket, string>;
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  // Prefer typical home/office ranges first.
  const score = (a: string) => (a.startsWith('192.168.') ? 0 : a.startsWith('10.') ? 1 : a.startsWith('172.') ? 2 : 3);
  return out.sort((a, b) => score(a) - score(b));
}

function send(ws: WebSocket | null | undefined, text: string) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(text);
}

function attachRelay(httpServer: HttpServer) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  const rooms = new Map<string, Room>();
  const alive = new WeakMap<WebSocket, boolean>();

  const getRoom = (code: string) => {
    let r = rooms.get(code);
    if (!r) {
      r = { host: null, remotes: new Map() };
      rooms.set(code, r);
    }
    return r;
  };

  const announce = (room: Room) => {
    const { toHost, toRemote } = peerMsgs(!!room.host, [...room.remotes.values()]);
    send(room.host, toHost);
    for (const r of room.remotes.keys()) send(r, toRemote);
  };

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (new URL(req.url ?? '/', 'http://local').pathname !== RELAY_PATH) return; // leave Vite HMR alone
    wss.handleUpgrade(req, socket, head, (ws) => {
      const params = parseParams(req.url ?? '/');
      if (!params) {
        ws.close(1008, 'bad params');
        return;
      }
      const { room: code, role, id } = params;
      const room = getRoom(code);
      alive.set(ws, true);
      ws.on('pong', () => alive.set(ws, true));
      // oversized or malformed frames emit 'error'; unhandled, that would take down the server
      ws.on('error', () => ws.terminate());

      if (role === 'host') {
        if (room.host && room.host !== ws) room.host.close(4000, 'replaced');
        room.host = ws;
        ws.on('message', (data, isBinary) => {
          if (isBinary) return;
          const out = fromHost(data.toString());
          if (!out) return;
          for (const [r, id] of room.remotes) if (!out.to || out.to === id) send(r, out.text);
        });
      } else {
        room.remotes.set(ws, id);
        ws.on('message', (data, isBinary) => {
          if (isBinary) return;
          const out = fromRemote(data.toString(), id);
          if (out) send(room.host, out);
        });
      }

      ws.on('close', () => {
        if (role === 'host' && room.host === ws) room.host = null;
        else room.remotes.delete(ws);
        if (!room.host && room.remotes.size === 0) rooms.delete(code);
        else announce(room);
      });
      announce(room);
    });
  });

  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, 5000);
  httpServer.on('close', () => clearInterval(ping));
}

/** Multiplayer arenas: one ArenaRoom per code, on the same HTTP server. */
function attachArenas(httpServer: HttpServer) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  const arenas = new Map<string, ArenaRoom>();
  const alive = new WeakMap<WebSocket, boolean>();

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (new URL(req.url ?? '/', 'http://local').pathname !== ARENA_PATH) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      const params = parseArenaParams(req.url ?? '/');
      if (!params) {
        ws.close(1008, 'bad params');
        return;
      }
      let arena = arenas.get(params.room);
      if (!arena) {
        arena = new ArenaRoom(params.room);
        arenas.set(params.room, arena);
      }
      const room = arena;
      const conn = { send: (text: string) => send(ws, text), close: (code?: number, reason?: string) => ws.close(code, reason) };
      alive.set(ws, true);
      ws.on('pong', () => alive.set(ws, true));
      ws.on('error', () => ws.terminate());
      ws.on('message', (data, isBinary) => {
        if (!isBinary) room.message(conn, data.toString());
      });
      ws.on('close', () => room.leave(conn));
      room.join(conn, params.id);
    });
  });

  // the match clock and dropped players need a tick even when nobody is sending; a heartbeat every 5 s
  let beats = 0;
  const timer = setInterval(() => {
    for (const [code, arena] of arenas) {
      arena.tick();
      if (arena.empty) arenas.delete(code);
    }
    if (++beats % 10) return;
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, 500);
  httpServer.on('close', () => clearInterval(timer));
}

function mount(server: ViteDevServer | PreviewServer) {
  server.middlewares.use(LAN_ENDPOINT, (_req, res) => {
    const addr = server.httpServer?.address();
    const port = addr && typeof addr === 'object' ? addr.port : undefined;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({ addresses: lanAddresses(), port, publicUrl: process.env.PUBLIC_URL || null }));
  });
  if (server.httpServer) {
    attachRelay(server.httpServer as HttpServer);
    attachArenas(server.httpServer as HttpServer);
  }
}

export function relayPlugin(): Plugin {
  return {
    name: 'phone-relay',
    configureServer: mount,
    configurePreviewServer: mount,
  };
}
