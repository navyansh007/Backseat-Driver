import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { relayPlugin } from './server/relay';

// Set by `npm run dev:public` so Vite accepts requests for the tunnel's hostname.
const publicHost = process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).hostname : undefined;
const allowedHosts = publicHost ? [publicHost] : undefined;

export default defineConfig({
  plugins: [relayPlugin()],
  // one three.js entry: the WebGPU build (with its WebGL 2 fallback) instead of the classic WebGL renderer
  resolve: { alias: [{ find: /^three$/, replacement: 'three/webgpu' }] },
  server: { host: true, port: 5173, strictPort: true, allowedHosts },
  preview: { host: true, port: 4173, strictPort: true, allowedHosts },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: {
        game: resolve(import.meta.dirname, 'index.html'),
        remote: resolve(import.meta.dirname, 'remote.html'),
      },
    },
  },
});
