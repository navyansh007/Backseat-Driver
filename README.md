# Backseat Driver

A browser driving game where your phone is the remote control. Steer a late-90s executive saloon through a multi-storey car park with a touchpad on your phone, then switch on the guns and missiles.

Inspired by the remote-controlled car chase in *Tomorrow Never Dies* (1997). All models, textures and sound effects are generated in code; the soundtrack is an original composition.

## Features

- **Phone remote.** A full-screen, retro, landscape remote with one round touchpad for driving, two fire buttons, quick **CAM** / **RESET** keys and a **SETUP** sheet that controls every game setting. Scan the QR code on the game screen to pair. The phone talks to the game directly over WebRTC, so input doesn't go through a server.
- **Driving.** Raycast-vehicle physics (Rapier) with rear-wheel drive, suspension, speed-sensitive steering, skid marks, tyre smoke and a synthesized engine.
- **Steering assist.** Counter-steer, spin control, traction control and obstacle avoidance. Press `V` to choose off, light, medium or strong.
- **Cars.** Choose on the title screen (or from the phone's **SETUP** sheet): the *BMV 750 iL*, a long executive saloon, the *Ashton Martyn DB10*, a low, fast grand tourer with lofted, curved bodywork, or the *Fjord Mustanger Boss 429*, a black 1969 fastback with a bonnet scoop, rear-window slats, a deck wing and chrome bumpers. Each car has its own handling, and they swap in place without reloading. To add a car, add an entry to `src/shared/cars.ts` and `src/game/cars/roster.ts`.
- **Weapons.** Twin machine guns with heat build-up and a launcher with four homing missiles: in the bumper and roof of the saloon, rising out of the bonnet of the DB10, and through the bonnet scoop of the Mustanger.
- **Destruction.** Cars, barrels, boxes, barriers, trolleys and glass break, explode and burn. A destroyed car is blown into the air and lands as a burnt-out shell: cabin and doors torn away, sooty dented bodywork, bare seat frames and glowing embers. It burns, then smoulders, and is light enough to shove aside with your car. Anything wrecked respawns once it is out of the camera's view.
- **The world.** A spacious two-level car park with ramps and a roof jump, parked cars you can push, traffic, birds, clouds and a rental showroom.
- **Driver name.** Type it on the title screen; it's kept on this browser and shown on the arena scoreboard and kill feed (2–16 letters, numbers, spaces, `_ - .`).
- **Modes.** Pick on the title screen. *Casual* is the free drive. *Action* clears the traffic and sends waves of black saloons after you; the QR code opens the matching remote. *Arena* is online multiplayer (below).
- **Arena (online multiplayer).** Up to 8 drivers in the same car park, wrecking each other for destruction points until the clock runs out.
  - Pick your car, then **create an arena** and share its code (or the **copy invite link** button), or type a code and **join**. The car is locked once the match starts.
  - The host picks 3, 5 or 10 minutes and starts the match; everyone gets a 3-second countdown. Players can also join a match already under way.
  - Every car has 400 armour. Guns and missiles hurt other players; rams and the car park's own explosions don't. A wreck scores **100 points**, plus **1 point for every 4 armour** you knock off anyone. Most points when time is up wins; ties go to fewer wrecks, then whoever got there first.
  - A wrecked car comes back after **5 seconds** at a clear spot away from the others, with 2 seconds of spawn shield.
  - Other players' cars look like cars and nothing else: no name tags or health bars. Names are on the scoreboard and in the feed.
  - Drive with the keyboard, or press `Esc`/`Q` in the arena for the optional phone pairing panel: open the remote link on the phone and type the phone code (or scan it).
  - The arena server keeps the score, armour, respawns and clock, so everyone sees the same result. Each game drives its own car and streams it to the others about 20 times a second; a dropped connection gets its place and points back if it returns within 15 seconds.
- **Action mode.** Pursuers drive on the same physics as your car, follow you up and down the car park ramps, ram you (only your weapons and traps can wreck them), and from wave 2 lean out of the windows and shoot. Each wave is bigger, faster, tougher and better armed; armoured executive saloons join from wave 4. Your car has 1000 armour; clearing a wave repairs 30% and restocks the traps, and wrecked pursuers sometimes drop a repair kit.
- **Traps (action mode).** Five gadgets that drop from the boot, each with charges that recharge:
  - **Spike strip**: shreds the tyres of anything that crosses it, so it slows, wanders and loses grip.
  - **Oil slick**: no grip at all, for them or you. A gunshot, a missile or a mine sets it alight.
  - **Mine**: arms after a moment, only pursuers set it off, and it chain-reacts with other mines and oil.
  - **Smoke screen**: a trail of thick smoke; pursuers inside it or behind it lose sight of you and can't aim.
  - **EMP**: kills every engine and gun within 30 m for a few seconds.

  A wreck caused by a trap scores 50% extra.
- **Soundtrack.** An original score (`bgm.mp3`): the intro plays as you first pull away, then a seamless loop carries the drive.

## Run it

```bash
npm install
npm run dev            # http://localhost:5173 (phone must be on the same Wi-Fi)
npm run serve:worker   # production build on the real Worker runtime, http://localhost:8787
npm run dev:public     # same, plus a temporary public HTTPS URL via ngrok
npm run preview:public # production build behind the ngrok tunnel
```

`dev:public` needs [ngrok](https://ngrok.com) installed and authenticated (`ngrok config add-authtoken <token>`). It prints the game URL, the phone-remote URL and a QR code in the terminal.

## Controls

| Action | Phone | Keyboard |
| --- | --- | --- |
| Drive / steer | touchpad | `W A S D` / arrows |
| Machine guns | hold **GUN** | hold `F` |
| Missile | tap **MSL** | `G` |
| Handbrake | — | `Space` |
| Camera / reset | **CAM** / **RESET** | `C` / `R` |
| Steering assist / stunt cam | **SETUP** | `V` / `K` |
| Pairing screen / mute / hide hints | **SETUP** | `Q` / `M` / `H` |
| Music on/off | **SETUP** | `B` |
| Back to start, volumes, resolution, WebGPU/WebGL | **SETUP** | — |
| Casual / action mode | title screen or **SETUP** | — |
| Traps: spikes / oil / mine / smoke / EMP (action) | **SPIKE** **OIL** **MINE** **SMOKE** **EMP** | `1`–`5` |
| Go again after being wrecked (action) | tap the pad | `Enter` |

The action remote adds a radar, an armour bar and the wave count on its LCD. Volumes, resolution, steering assist, the mode, your best action score and the graphics backend are remembered by the game's browser. Switching between WebGPU and WebGL reloads the game; the phone reconnects on its own. Browsers only play sound after the game page has been clicked once, so the phone can't unlock sound by itself.

## Deploy (free)

The whole game runs on one Cloudflare Worker, on the free plan:

```bash
npx wrangler login     # once
npm run deploy         # builds and deploys to https://backseat-driver.<your-subdomain>.workers.dev
```

The Worker (`worker/index.ts`) serves the built files from `dist/` and runs the phone relay in a Durable Object, one per room code. Static files are free and unlimited. The relay uses the WebSocket Hibernation API, so rooms where everyone is on a direct link cost nothing while idle.

## How the phone link works

1. The game opens a WebSocket to `/relay` under a random room code and shows it as a QR code.
2. The phone joins the same room and sends a WebRTC offer. The relay passes the handshake (offer, answer, ICE candidates) between them. Public STUN servers (Cloudflare, Google) help each side find its address.
3. Once the data channel opens, input and telemetry go **directly between phone and game**. The channel is unordered with no retransmits, because a late steering packet is useless; the phone repeats each change for 200 ms to cover dropped packets. Setting changes and other commands go over both the data channel and the relay, and the game acts on each once; the game sends its full settings back on every change and once a second.
4. If no direct path can be found (guest Wi-Fi with client isolation, strict carrier NAT, or a computer without mDNS), everything keeps working over the relay and the phone retries a direct link in the background. The remote's screen shows `direct` or `relay`. Add `?p2p=0` to the remote URL to force relay mode.

The relay routing (`server/relayCore.ts`) is shared by the Vite dev server (`server/relay.ts`) and the Durable Object, so local development behaves like production.

**macOS tip:** browsers hide local IPs behind `.local` names, so the computer needs the **Local Network** permission (System Settings → Privacy & Security → Local Network) for the browser to connect directly. Without it, the phone falls back to the relay.

## Tech

Vite + TypeScript, Three.js (WebGPU renderer, with an automatic WebGL 2 fallback; add `?gl=1` to force WebGL 2) for rendering, Rapier (WASM) for physics, Web Audio for sound, WebRTC data channels for the phone link, and a Cloudflare Worker + Durable Object (or the Vite server, in development) for pairing.
