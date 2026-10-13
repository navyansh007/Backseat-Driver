/**
 * Runs the game behind a temporary public ngrok URL.
 *   npm run dev:public       → Vite dev server + tunnel
 *   npm run preview:public   → production build + preview server + tunnel
 * Prints the game URL and the phone-remote URL (with a terminal QR code).
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import QRCode from 'qrcode';

const preview = process.argv.includes('--preview');
const port = preview ? 4173 : 5173;
const children = [];

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

function fail(msg) {
  console.error(`\n\x1b[31m✖ ${msg}\x1b[0m\n`);
  shutdown(1);
}

function shutdown(code = 0) {
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

if (spawnSync('ngrok', ['version'], { stdio: 'ignore' }).error) {
  fail('ngrok is not installed. Install it with `brew install ngrok` and run `ngrok config add-authtoken <token>`.');
}

// Fixed room code for this session so the remote link can be printed up front.
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const room = Array.from({ length: 5 }, () => alphabet[randomInt(alphabet.length)]).join('');

// 1) open the tunnel and read its public URL from ngrok's JSON log
const publicUrl = await new Promise((resolve) => {
  const ngrok = spawn('ngrok', ['http', String(port), '--log', 'stdout', '--log-format', 'json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(ngrok);
  const timer = setTimeout(() => fail('timed out waiting for the ngrok tunnel.'), 20000);
  let buf = '';
  ngrok.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.url && String(ev.url).startsWith('https://')) {
        clearTimeout(timer);
        resolve(ev.url);
      } else if (ev.lvl === 'eror' || ev.lvl === 'crit') {
        clearTimeout(timer);
        fail(`ngrok: ${ev.err || ev.msg}`);
      }
    }
  });
  ngrok.stderr.on('data', (d) => process.stderr.write(d));
  ngrok.on('exit', (code) => fail(`ngrok exited (code ${code}). Is another ngrok session already running?`));
});

// 2) start the game server with the tunnel URL so the in-game QR uses it
const env = { ...process.env, PUBLIC_URL: publicUrl };
if (preview) {
  const build = spawnSync('npx', ['vite', 'build'], { stdio: 'inherit', env });
  if (build.status !== 0) fail('build failed.');
}
const vite = spawn('npx', preview ? ['vite', 'preview'] : ['vite'], { stdio: 'inherit', env });
children.push(vite);
vite.on('exit', (code) => fail(`vite exited (code ${code}). Is port ${port} already in use?`));

// 3) once the server answers, print the links
for (let i = 0; i < 100; i++) {
  try {
    await fetch(`http://127.0.0.1:${port}/`);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 200));
  }
}
const gameUrl = `${publicUrl}/?room=${room}`;
const localGameUrl = `http://localhost:${port}/?room=${room}`;
const remoteUrl = `${publicUrl}/remote.html?room=${room}`;
const qr = await QRCode.toString(remoteUrl, { type: 'terminal', small: true });

console.log(`
${bold('  tnd car chase · public session')}  ${dim(`room ${room}`)}

  game (this computer)  ${cyan(localGameUrl)}
  game (public)         ${cyan(gameUrl)}
  phone remote          ${cyan(remoteUrl)}

${qr}
  ${dim('scan with your iPhone camera · ngrok may show a one-time "Visit Site" page — tap it')}
  ${dim('the tunnel URL changes every run · press Ctrl+C to stop')}
`);
