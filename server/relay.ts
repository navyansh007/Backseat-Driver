/**
 * Tiny WebSocket relay that pairs a game screen ("host") with phones ("remote")
 * by room code. It is mounted on Vite's own HTTP server, so `npm run dev` and
 * `npm run preview` serve the game, the remote page and the relay on one port.
 */
import type { Plugin, ViteDevServer, PreviewServer } from 'vite';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import os from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';

const RELAY_PATH = '/relay';
const LAN_ENDPOINT = '/api/lan';

interface Room {
  host: WebSocket | null;
  remotes: Set<WebSocket>;
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

function send(ws: WebSocket | null | undefined, data: unknown) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(typeof data === 'string' ? data : JSON.stringify(data));
}

function attachRelay(httpServer: HttpServer) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const rooms = new Map<string, Room>();
  const alive = new WeakMap<WebSocket, boolean>();

  const getRoom = (code: string) => {
    let r = rooms.get(code);
    if (!r) {
      r = { host: null, remotes: new Set() };
      rooms.set(code, r);
    }
    return r;
  };

  const announce = (room: Room) => {
    const count = room.remotes.size;
    send(room.host, { t: 'peer', role: 'remote', online: count > 0, count });
    for (const r of room.remotes) send(r, { t: 'peer', role: 'host', online: !!room.host, count });
  };

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname !== RELAY_PATH) return; // leave Vite HMR alone
    wss.handleUpgrade(req, socket, head, (ws) => {
      const code = (url.searchParams.get('room') ?? '').toUpperCase().slice(0, 12);
      const role = url.searchParams.get('role');
      if (!code || (role !== 'host' && role !== 'remote')) {
        ws.close(1008, 'bad params');
        return;
      }
      const room = getRoom(code);
      alive.set(ws, true);
      ws.on('pong', () => alive.set(ws, true));

      if (role === 'host') {
        if (room.host && room.host !== ws) room.host.close(4000, 'replaced');
        room.host = ws;
        ws.on('message', (data, isBinary) => {
          if (isBinary) return;
          const text = data.toString();
          for (const r of room.remotes) send(r, text);
        });
      } else {
        room.remotes.add(ws);
        ws.on('message', (data, isBinary) => {
          if (isBinary) return;
          send(room.host, data.toString());
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

function mount(server: ViteDevServer | PreviewServer) {
  server.middlewares.use(LAN_ENDPOINT, (_req, res) => {
    const addr = server.httpServer?.address();
    const port = addr && typeof addr === 'object' ? addr.port : undefined;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({ addresses: lanAddresses(), port, publicUrl: process.env.PUBLIC_URL || null }));
  });
  if (server.httpServer) attachRelay(server.httpServer as HttpServer);
}

export function relayPlugin(): Plugin {
  return {
    name: 'phone-relay',
    configureServer: mount,
    configurePreviewServer: mount,
  };
}
