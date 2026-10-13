# TND Car Chase

A browser driving game where your phone is the remote control. Steer a late-90s executive saloon through a multi-storey car park with a touchpad on your phone, then switch on the guns and missiles.

Inspired by the remote-controlled car chase in *Tomorrow Never Dies* (1997). All models, textures and sounds are generated in code.

## Features

- **Phone remote.** A full-screen, retro, landscape remote with one round touchpad for driving and two fire buttons. Scan the QR code on the game screen to pair.
- **Driving.** Raycast-vehicle physics (Rapier) with rear-wheel drive, suspension, speed-sensitive steering, skid marks, tyre smoke and a synthesized engine.
- **Steering assist.** Counter-steer, spin control, traction control and obstacle avoidance. Press `V` to choose off, light, medium or strong.
- **Weapons.** Twin bumper machine guns with heat build-up and a roof launcher with four homing missiles.
- **Destruction.** Cars, barrels, boxes, barriers, trolleys and glass break, explode and burn. Anything wrecked respawns once it is out of the camera's view.
- **The world.** A two-level car park with ramps and a roof jump, around 200 parked cars you can push, traffic, pedestrians, birds, clouds and a rental showroom.

## Run it

```bash
npm install
npm run dev            # http://localhost:5173 (phone must be on the same Wi-Fi)
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
| Camera / reset / assist | — | `C` / `R` / `V` |
| Pairing code / mute / hide hints | — | `Q` / `M` / `H` |

## Tech

Vite + TypeScript, Three.js for rendering, Rapier (WASM) for physics, Web Audio for sound, and a small WebSocket relay that runs inside the Vite server and pairs phones with the game by room code.
