import '../styles/game.css';
import * as THREE from 'three/webgpu';
import { Physics } from './physics';
import { Environment, buildSurroundings } from './world/environment';
import { buildLot } from './world/lot';
import { Life } from './world/life';
import { PlayerCar } from './playerCar';
import { ChaseCamera } from './camera';
import { SkidMarks, Smoke } from './effects';
import { CarAudio } from './audio';
import { RemoteLink } from './net';
import { Controls } from './input';
import { MusicDirector } from './music';
import { CombatFx } from './combat/fx';
import { Destruction } from './combat/destruction';
import { WreckFx } from './combat/wreck';
import { Weapons } from './combat/weapons';
import { StuntDirector } from './stunts';
import { useWebGLOutput } from './render/output';
import { ActionMode } from './action/action';
import { WreckShells } from './combat/wreckShells';
import { carDef } from './cars/roster';
import { CAR_IDS, DEFAULT_CAR } from '../shared/cars';
import { CarPicker } from './cars/picker';
import {
  ASSIST_NAMES, CAM_VIEWS, GAME_MODES, QUALITY_LEVELS, TRAP_KINDS,
  type CommandMsg, type GameMode, type RendererChoice, type Settings, type SettingsMsg,
} from '../shared/protocol';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  loading: $('loading'), loadingText: $('loading-text'), title: $('title'), hud: $('hud'), brand: $('brand'),
  speed: $('speed'), gear: $('gear'), chip: $('link-chip'), chipText: $('link-text'), hints: $('hints'),
  soundNote: $('sound-note'), toast: $('toast'), qr: $<HTMLCanvasElement>('qr'), qrUrl: $<HTMLAnchorElement>('qr-url'),
  room: $('room-code'), lanNote: $('lan-note'), qrDot: $('qr-dot'), qrStatus: $('qr-status'), kbStart: $('kb-start'),
  lock: $('lock'), heat: $('heat-fill'), heatBox: $('heat'), pips: $('pips'),
  letterbox: $('letterbox'), card: $('stunt-card'), cardTitle: $('stunt-title'), cardTags: $('stunt-tags'),
  cardStats: $('stunt-stats'), cardPoints: $('stunt-points'), modes: $('modes'), qrMode: $('qr-mode'), restart: $('a-restart'),
  garage: $('garage'),
};

let toastTimer = 0;
function toast(text: string, ms = 2400) {
  ui.toast.textContent = text;
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => ui.toast.classList.remove('show'), ms);
}

const storageGet = (k: string) => {
  try { return localStorage.getItem(k); } catch { return null; }
};
const storageSet = (k: string, v: string) => {
  try { localStorage.setItem(k, v); } catch { /* storage unavailable */ }
};
/** A saved number in [min, max], else `fallback`. */
const storedNumber = (k: string, fallback: number, min: number, max: number) => {
  const raw = storageGet(k);
  const v = raw === null ? NaN : Number(raw);
  return Number.isFinite(v) && v >= min && v <= max ? v : fallback;
};

// yield so loading text can paint; setTimeout (not rAF) so loading also progresses in a background tab
const nextFrame = () => new Promise((r) => setTimeout(r, 30));

async function boot() {
  // ------------------------------------------------------------ renderer
  const canvas = $<HTMLCanvasElement>('view');
  // WebGPU where the browser has it (it can pick the discrete GPU), WebGL 2 otherwise.
  // ?gl=1 or the phone's graphics setting forces WebGL 2.
  const preferred: RendererChoice = storageGet('tnd-renderer') === 'webgl' ? 'webgl' : 'webgpu';
  const renderer = new THREE.WebGPURenderer({
    canvas, antialias: true, alpha: false, powerPreference: 'high-performance',
    forceWebGL: new URLSearchParams(location.search).get('gl') === '1' || preferred === 'webgl',
  });
  await renderer.init();
  const backend: RendererChoice = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl';
  let quality = storedNumber('tnd-quality', QUALITY_LEVELS.length - 1, 0, QUALITY_LEVELS.length - 1);
  const applyQuality = () => renderer.setPixelRatio(Math.min(devicePixelRatio, QUALITY_LEVELS[quality].ratio));
  applyQuality();
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  // three.js r186 had already replaced PCFSoftShadowMap with PCFShadowMap under WebGL too
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.onDeviceLost = (info) => {
    console.error('[gpu] device lost', info);
    toast('the graphics device was reset — reload the page to keep driving', 600000);
  };

  const scene = new THREE.Scene();
  const link = new RemoteLink();
  ui.room.textContent = link.room;
  // casual or action: ?mode= wins, then the last choice on this browser
  const urlMode = new URLSearchParams(location.search).get('mode');
  let mode: GameMode = GAME_MODES.find((m) => m === urlMode) ?? (storageGet('tnd-mode') === 'action' ? 'action' : 'casual');
  // each mode has its own remote: the QR opens the matching one
  const drawQR = () => void link.drawQR(ui.qr, 260, mode).then((url) => {
    ui.qrUrl.textContent = url.replace(/^https?:\/\//, '');
    ui.qrUrl.href = url;
    // a LAN address only works on the same network; a public URL works from anywhere
    const lan = /^(10|127|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(new URL(url).hostname);
    ui.lanNote.textContent = lan ? 'phone and computer must be on the same wi-fi' : 'same wi-fi is fastest · mobile data works too';
  });
  drawQR();

  ui.loadingText.textContent = 'starting the physics engine…';
  await nextFrame();
  const phys = await Physics.create();
  const env = new Environment(scene, renderer);
  useWebGLOutput(renderer, scene, scene.fog as THREE.Fog);

  ui.loadingText.textContent = 'building the car park…';
  await nextFrame();
  buildSurroundings(scene, phys);
  const lot = buildLot(scene, phys);
  const life = new Life(scene, lot.parked);

  ui.loadingText.textContent = 'polishing the saloon…';
  await nextFrame();
  // the car: ?car= wins, then the last one driven on this browser
  const urlCar = new URLSearchParams(location.search).get('car');
  const storedCar = storageGet('tnd-car');
  let carId = [urlCar, storedCar].find((c): c is string => !!c && CAR_IDS.includes(c)) ?? DEFAULT_CAR;
  const car = new PlayerCar(phys.world, scene, lot.spawn, carDef(carId));
  const playerHandles = new Set(car.sim.chassisColliders.map((c) => c.handle));
  const cam = new ChaseCamera(phys);
  const skids = new SkidMarks(scene);
  const smoke = new Smoke(scene);
  const audio = new CarAudio();
  const controls = new Controls(link);
  const music = new MusicDirector();
  audio.onReady((ctx, bus) => music.attach(ctx, bus));

  // ------------------------------------------------------------ combat
  const fx = new CombatFx(scene);
  const wreck = new WreckFx(scene, phys, fx);
  // destroyed cars become burnt-out shells: a small pool per car model
  const shells = new WreckShells(phys, scene);
  for (const { set, spec } of lot.parked.models()) shells.register(set, spec, true, 8);
  const destruction = new Destruction([...lot.parked.entries, ...lot.props.entries], phys, fx, car.body, {
    onExplosion(p, scale) {
      const dist = p.distanceTo(car.position);
      audio.explosion(dist, scale);
      const k = Math.max(0, 1 - dist / 60) * scale;
      cam.bump(k * 0.9);
      if (k > 0.05) link.send({ t: 'hit', power: Math.min(1, k) });
    },
    onTrafficDestroyed: (body) => life.trafficDestroyed(body),
    onTrafficRespawn: (body) => life.trafficRespawn(body),
    onPlayerBlast: (damage) => action.onPlayerBlast(damage),
  }, wreck, shells);
  // driving assist level, remembered per browser
  const ASSIST_VALUES = [0, 0.4, 0.7, 1];
  let assistIdx = storedNumber('tnd-assist', 2, 0, ASSIST_VALUES.length - 1);
  if (!Number.isInteger(assistIdx)) assistIdx = 2;
  car.sim.assist = ASSIST_VALUES[assistIdx];
  const setAssist = (i: number) => {
    assistIdx = i;
    car.sim.assist = ASSIST_VALUES[assistIdx];
    storageSet('tnd-assist', String(assistIdx));
    toast(`steering assist: ${ASSIST_NAMES[assistIdx]}`, 1600);
  };
  const cycleAssist = () => setAssist((assistIdx + 1) % ASSIST_VALUES.length);
  // volumes are remembered too; mute and music on/off reset with each visit, as before
  audio.setVolume(storedNumber('tnd-volume', 1, 0, 1));
  music.setVolume(storedNumber('tnd-music-volume', 1, 0, 1));

  // fences, lamp posts, flag poles and bollards snapping under a hard hit
  lot.breakables.hooks = {
    onBreak(point, normal, power, def, hitter) {
      const color = new THREE.Color(def.color);
      fx.impactSparks(point, normal, 3 + Math.round(power * 8));
      fx.debris.burst(point, 3 + Math.round(power * 6), color, 0.35, 3 + power * 6, 0);
      if (hitter.handle !== car.body.handle) return;
      audio.impact(0.25 + power * 0.6);
      cam.bump(0.15 + power * 0.5);
      link.send({ t: 'hit', power: Math.min(1, 0.2 + power * 0.6) });
    },
  };

  // soft hedges: the player and any shoved parked car push through them
  const hedgeMovers = [
    { body: car.body, halfLength: 1.8, radius: 0.95, drag: true },
    ...lot.parked.entries.filter((e) => !e.kinematic).map((e) => ({ body: e.body, halfLength: 1.6, radius: 0.85, drag: true })),
  ];
  lot.hedges.hooks = {
    onRustle(power, entering, body) {
      const mine = body.handle === car.body.handle;
      audio.rustle(mine ? power : power * 0.5);
      if (mine && entering) link.send({ t: 'hit', power: Math.min(0.35, power * 0.5) });
    },
  };

  const weapons = new Weapons(scene, car, phys, fx, destruction, {
    gunshot: () => audio.gunshot(),
    launch: () => audio.launch(),
    hit: (p) => action.onGunHit(p),
  });
  car.onModel = () => weapons.fit();

  // action mode: waves of pursuers, armour, traps
  const action = new ActionMode(scene, phys, car, fx, destruction, wreck, audio, {
    root: $('action-hud'), wave: $('a-wave'), hp: $('a-hp'), hpText: $('a-hp-text'), foes: $('a-foes'), score: $('a-score'),
    feed: $('a-feed'), banner: $('a-banner'), bannerSub: $('a-banner-sub'), bannerTitle: $('a-banner-title'), bannerNote: $('a-banner-note'),
    traps: $('a-traps'), threats: $('a-threats'), vignette: $('a-vignette'), over: $('a-over'), overStats: $('a-over-stats'),
  }, {
    hurt(power) {
      cam.bump(power * 0.7);
      link.send({ t: 'hit', power });
    },
    wrecked() {
      stunts.cancel();
      pushSettings();
    },
  });
  // pursuers draw their own wheels, so their shells come without
  for (const { set, spec } of action.fleet.models()) shells.register(set, spec, false, 6);

  // stunts: slow-motion cinematics with their own score
  const glass = lot.props.entries.filter((e) => e.kind === 'glass').map((e) => e.body);
  const stunts = new StuntDirector(phys, car, lot.features, cam.camera, music, audio, {
    letterbox: ui.letterbox, card: ui.card, title: ui.cardTitle, tags: ui.cardTags, stats: ui.cardStats, points: ui.cardPoints,
    hide: [ui.hud],
  }, glass);

  // settle props/cars before showing anything
  for (let i = 0; i < 30; i++) {
    car.drive(1 / 60, { steer: 0, throttle: 0, handbrake: false });
    phys.step();
  }
  phys.events.clear();
  car.capture();
  car.capture();
  phys.sync(true);
  // compile every pipeline up front, including effects that start hidden (fireballs, rings),
  // so the first explosion doesn't stall on shader compilation
  const hidden: THREE.Object3D[] = [];
  scene.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } });
  await renderer.compileAsync(scene, cam.camera);
  for (const o of hidden) o.visible = false;

  // ------------------------------------------------------------ UI state
  let playing = false;
  // the chosen chase view, kept while the title screen orbits the car
  let view: Settings['cam'] = 'chase';
  let hintsOn = true;
  const start = () => {
    if (playing) return;
    playing = true;
    ui.title.classList.add('hidden');
    ui.hud.classList.remove('hidden');
    ui.brand.classList.add('hidden');
    cam.mode = view;
    if (mode === 'action') {
      resetCar(true);
      action.begin();
    }
    cam.snap(car.root);
    pushSettings();
  };
  const showMenu = () => {
    stunts.cancel();
    if (action.running) action.end();
    playing = false;
    ui.title.classList.remove('hidden');
    ui.hud.classList.add('hidden');
    ui.brand.classList.remove('hidden');
    cam.mode = 'orbit';
    pushSettings();
  };
  const audioStart = () => {
    audio.start();
    ui.soundNote.classList.add('hidden');
    // the browser unlocks audio a moment later; let the phone know it can play
    setTimeout(pushSettings, 300);
  };
  addEventListener('pointerdown', audioStart);
  addEventListener('keydown', audioStart);
  ui.kbStart.addEventListener('click', () => { audioStart(); start(); });
  ui.chip.addEventListener('click', showMenu);
  ui.title.addEventListener('click', (e) => { if (e.target === ui.title && link.phones > 0) start(); });

  const setLinkUi = (n: number) => {
    const ok = n > 0;
    ui.chip.classList.toggle('ok', ok);
    ui.chipText.textContent = ok ? (n > 1 ? `${n} phones linked` : 'phone linked') : 'no phone';
    ui.chip.title = ok ? `${link.direct} of ${n} on a direct link · show pairing code (Q)` : 'Show pairing code (Q)';
    ui.qrDot.classList.toggle('ok', ok);
    ui.qrStatus.textContent = ok ? 'phone linked · touch the pad to drive' : 'waiting for phone';
  };
  let prevPhones = 0;
  link.onPeers = (n) => {
    setLinkUi(n);
    if (n > prevPhones) toast('phone linked — the car is yours');
    else if (n < prevPhones) toast('phone disconnected');
    if (n > prevPhones) pushSettings();
    prevPhones = n;
  };

  // ------------------------------------------------------------ mode
  // action mode clears the traffic off the perimeter road and sends in the pursuers
  const applyMode = () => {
    const act = mode === 'action';
    document.body.classList.toggle('mode-action', act);
    for (const b of life.trafficBodies) destruction.setSuspended(b, act);
    life.setTraffic(!act);
    for (const el of Array.from(ui.modes.children) as HTMLElement[]) {
      const on = el.dataset.mode === mode;
      el.classList.toggle('on', on);
      el.setAttribute('aria-checked', String(on));
    }
    ui.qrMode.textContent = act ? 'action remote · with traps' : 'casual remote';
  };
  const setMode = (m: GameMode) => {
    if (m === mode) return;
    const wasPlaying = playing;
    if (action.running) action.end();
    mode = m;
    storageSet('tnd-mode', m);
    applyMode();
    drawQR();
    if (wasPlaying && m === 'action') {
      resetCar(true);
      action.begin();
    }
    toast(m === 'action' ? 'action mode · survive the waves' : 'casual mode', 1800);
  };
  applyMode();
  for (const el of Array.from(ui.modes.children) as HTMLElement[]) {
    el.addEventListener('click', () => {
      setMode(el.dataset.mode === 'action' ? 'action' : 'casual');
      pushSettings();
    });
  }
  const restart = () => {
    if (!action.over) return;
    action.restart(lot.spawn);
    cam.snap(car.root);
    pushSettings();
  };
  ui.restart.addEventListener('click', restart);
  const dropTrap = (k: (typeof TRAP_KINDS)[number]) => {
    if (!playing || mode !== 'action') return;
    if (!action.trap(k)) toast(`no ${k === 'emp' ? 'EMP' : k} ready`, 900);
  };

  // ------------------------------------------------------------ car
  const picker = new CarPicker(ui.garage, carId, (id) => { setCar(id); pushSettings(); });
  const setCar = (id: string) => {
    if (id === carId || !CAR_IDS.includes(id)) return;
    carId = id;
    storageSet('tnd-car', id);
    stunts.cancel();
    car.setModel(carDef(id));
    // same spot, new car: lift it a touch so the new wheels settle onto the floor
    const p = car.body.translation();
    car.reset(p.x, Math.max(0, p.y - 0.6), p.z, car.sim.yaw());
    picker.show(id);
    if (playing) toast(`${carDef(id).info.maker} ${carDef(id).info.model}`, 1600);
  };

  // ------------------------------------------------------------ settings (keyboard and phone)
  const setView = (v: Settings['cam']) => {
    view = v;
    if (playing) cam.mode = v;
  };
  const setStunts = (on: boolean) => {
    stunts.enabled = on;
    if (!on) stunts.cancel();
  };
  const setHints = (on: boolean) => {
    hintsOn = on;
    ui.hints.classList.toggle('hidden', !on);
  };
  const settingsMsg = (): SettingsMsg => ({
    t: 'cfg', playing, backend, audio: audio.unlocked, mode, car: carId,
    cam: view, assist: assistIdx, stunts: stunts.enabled, sound: !audio.isMuted, volume: +audio.masterVolume.toFixed(2),
    music: music.isEnabled, musicVolume: +music.musicVolume.toFixed(2), hints: hintsOn, quality, renderer: preferred,
  });
  function pushSettings() {
    link.send(settingsMsg());
  }

  const onCommand = (cmd: CommandMsg) => {
    switch (cmd.c) {
      case 'start': start(); break;
      case 'menu': if (playing) showMenu(); break;
      case 'reset': resetCar(); break;
      case 'respawn': resetCar(true); break;
      case 'restart': restart(); break;
      case 'trap': if (TRAP_KINDS.includes(cmd.k)) dropTrap(cmd.k); break;
      case 'set': applySetting(cmd); break;
    }
    pushSettings();
  };
  link.onCommand = onCommand;

  // values come from the network: check each one before using it
  const unit = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null);
  const index = (v: unknown, n: number) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < n ? v : null);
  function applySetting({ k, v }: Extract<CommandMsg, { c: 'set' }>) {
    switch (k) {
      case 'mode': if (GAME_MODES.includes(v)) setMode(v); break;
      case 'car': if (typeof v === 'string') setCar(v); break;
      case 'cam': if (CAM_VIEWS.includes(v)) setView(v); break;
      case 'assist': { const i = index(v, ASSIST_VALUES.length); if (i !== null) setAssist(i); break; }
      case 'stunts': if (typeof v === 'boolean') setStunts(v); break;
      case 'sound': if (typeof v === 'boolean') audio.setMuted(!v); break;
      case 'volume': {
        const x = unit(v);
        if (x !== null) { audio.setVolume(x); storageSet('tnd-volume', String(x)); }
        break;
      }
      case 'music': if (typeof v === 'boolean') music.setEnabled(v); break;
      case 'musicVolume': {
        const x = unit(v);
        if (x !== null) { music.setVolume(x); storageSet('tnd-music-volume', String(x)); }
        break;
      }
      case 'hints': if (typeof v === 'boolean') setHints(v); break;
      case 'quality': {
        const i = index(v, QUALITY_LEVELS.length);
        if (i === null) break;
        quality = i;
        storageSet('tnd-quality', String(i));
        applyQuality();
        renderer.setSize(innerWidth, innerHeight);
        toast(`resolution: ${QUALITY_LEVELS[i].name}`, 1400);
        break;
      }
      case 'renderer': {
        if ((v !== 'webgpu' && v !== 'webgl') || v === preferred) break;
        // a different backend needs a fresh page; the room code survives the reload
        storageSet('tnd-renderer', v);
        toast(`switching to ${v === 'webgpu' ? 'WebGPU' : 'WebGL'}…`, 4000);
        const url = new URL(location.href);
        url.searchParams.delete('gl');
        setTimeout(() => location.replace(url), 400);
        break;
      }
    }
  }

  addEventListener('keydown', (e) => {
    const trap = /^Digit([1-5])$/.exec(e.code);
    if (trap) {
      dropTrap(TRAP_KINDS[Number(trap[1]) - 1]);
      return;
    }
    switch (e.code) {
      case 'Enter': if (action.over) restart(); else start(); break;
      case 'Escape': playing ? showMenu() : start(); break;
      case 'KeyC': if (playing) setView(CAM_VIEWS[(CAM_VIEWS.indexOf(view) + 1) % CAM_VIEWS.length]); break;
      case 'KeyR': resetCar(); break;
      case 'KeyM': toast(audio.toggleMute() ? 'sound off' : 'sound on', 1200); break;
      case 'KeyB': toast(music.toggle() ? 'music on' : 'music off', 1200); break;
      case 'KeyV': cycleAssist(); break;
      case 'KeyK':
        setStunts(!stunts.enabled);
        toast(stunts.enabled ? 'stunt cam on' : 'stunt cam off', 1400);
        break;
      case 'KeyQ': playing ? showMenu() : start(); break;
      case 'KeyH': setHints(!hintsOn); break;
      case 'KeyF': case 'KeyG':
      case 'KeyW': case 'KeyA': case 'KeyS': case 'KeyD':
      case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight':
        start(); return;
      default: return;
    }
    pushSettings();
  });
  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    cam.resize();
  });

  const resetCar = (toSpawn = false) => {
    stunts.cancel();
    const p = car.body.translation();
    if (toSpawn) car.reset(lot.spawn.x, lot.spawn.y, lot.spawn.z, lot.spawn.yaw);
    else car.reset(p.x, Math.max(0, p.y - 0.6), p.z, car.sim.yaw());
    cam.snap(car.root);
  };

  // ------------------------------------------------------------ loop
  const STEP = 1 / 60;
  let acc = 0;
  let last = performance.now();
  let flippedFor = 0;
  let musicStarted = false;
  let teleT = 0;
  let cfgT = 0;
  let input = { steer: 0, throttle: 0, handbrake: false };
  const tmp = new THREE.Vector3();
  const right = new THREE.Vector3();
  const vel = new THREE.Vector3();

  ui.loading.classList.add('hidden');
  setTimeout(() => ui.loading.remove(), 1000);
  ui.title.classList.remove('hidden');
  setLinkUi(link.phones);

  const frame = (now: number) => {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    tick(dt);
  };

  /** One simulation + render step (also callable from the console as game.tick for debugging). */
  function tick(dt: number) {
    input = controls.read(dt);
    if (!playing && controls.source === 'phone' && link.state.active) start();
    if (!playing || action.over) input = { steer: 0, throttle: 0, handbrake: true };

    // game time runs slower during a stunt; the camera and audio keep real time
    const gdt = dt * stunts.timeScale;
    acc += gdt;
    let steps = 0;
    while (acc >= STEP && steps < 5) {
      car.drive(STEP, input);
      lot.breakables.preStep(car.body, car.sim.chassisColliders[0]);
      action.preStep(STEP, lot.breakables);
      phys.step();
      car.capture();
      action.postStep();
      stunts.postStep(STEP, playing && !action.over);
      acc -= STEP;
      steps++;
      phys.events.drainContactForceEvents((ev) => {
        lot.breakables.onContactForce(ev);
        if (action.onContact(ev, playerHandles)) return; // trading paint with a pursuer
        if (!playerHandles.has(ev.collider1()) && !playerHandles.has(ev.collider2())) return;
        const f = ev.totalForceMagnitude();
        const power = Math.min(1, (f - 9000) / 160000);
        if (power > 0.02) {
          audio.impact(power);
          cam.bump(power * 0.8);
          link.send({ t: 'hit', power });
        }
      });
    }
    if (steps === 5) acc = 0;

    phys.sync();
    lot.breakables.update(gdt, cam.camera, car.position);
    lot.hedges.update(gdt, action.running ? [...hedgeMovers, ...action.movers()] : hedgeMovers);
    car.render(acc / STEP, dt);
    action.render(acc / STEP);
    lot.update(gdt, car.position);
    life.update(gdt, car.position);
    weapons.update(gdt, controls.weapons, playing && !action.over);

    // ---------------------------------------------------- tyres: skids & smoke
    const speed = Math.abs(car.sim.forwardSpeed());
    const lv = car.body.linvel();
    const av = car.body.angvel();
    const com = car.body.translation();
    right.set(1, 0, 0).applyQuaternion(car.root.quaternion);
    let slipTotal = 0;
    const vc = car.sim.controller;
    for (let i = 0; i < 4; i++) {
      const contact = vc.wheelIsInContact(i) ? vc.wheelContactPoint(i) : null;
      if (!contact) {
        skids.add(i, null, right, 0);
        continue;
      }
      tmp.set(contact.x, contact.y, contact.z);
      const rx = tmp.x - com.x, ry = tmp.y - com.y, rz = tmp.z - com.z;
      vel.set(lv.x + av.y * rz - av.z * ry, lv.y + av.z * rx - av.x * rz, lv.z + av.x * ry - av.y * rx);
      const steer = vc.wheelSteering(i) ?? 0;
      const axle = right.clone().applyAxisAngle(car.root.up.clone().applyQuaternion(car.root.quaternion), steer);
      const lateral = Math.abs(vel.dot(axle));
      let slip = Math.max(0, (lateral - 1.6) / 5);
      const rear = i >= 2;
      if (car.sim.braking && speed > 7 && (input.handbrake ? rear : true)) slip = Math.max(slip, input.handbrake ? 0.8 : 0.35);
      if (rear && input.throttle > 0.85 && speed < 7 && speed > 0.3) slip = Math.max(slip, 0.5);
      slip = Math.min(1, slip);
      slipTotal = Math.max(slipTotal, slip);
      skids.add(i, slip > 0.12 ? tmp : null, axle, slip);
      if (slip > 0.3 && Math.random() < slip * 0.9) smoke.emit(tmp, vel, slip);
    }
    smoke.update(gdt);
    audio.update(dt, speed, Math.max(0, Math.abs(input.throttle)), slipTotal, car.sim.reversing);
    // soundtrack: starts with the player's first real movement (intro, then the loop)
    if (!musicStarted && playing && (Math.abs(input.throttle) > 0.08 || speed > 0.8)) {
      musicStarted = true;
      music.begin();
    }

    // ---------------------------------------------------- recovery
    if (car.sim.upright() < 0.35 && !stunts.active && !action.over) {
      flippedFor += gdt;
      if (flippedFor > 2.2) {
        resetCar();
        toast('car righted');
        flippedFor = 0;
      }
    } else flippedFor = 0;
    if (car.body.translation().y < -10) resetCar(true);

    // ---------------------------------------------------- hud + telemetry
    const kmh = Math.round(car.kmh());
    const gear = car.sim.reversing ? 'R' : speed < 0.4 && Math.abs(input.throttle) < 0.05 ? 'N' : String(audio.gear);
    ui.speed.textContent = String(kmh);
    ui.gear.textContent = gear;
    teleT += dt;
    if (teleT > 0.1) {
      teleT = 0;
      link.send({
        t: 'tele', kmh, gear, msl: weapons.missiles, heat: +weapons.heat.toFixed(2), hot: weapons.overheated, lock: !!weapons.lock,
        ...(action.running ? action.telemetry() : {}),
      });
    }
    // settings again once a second: the direct link may drop a packet, and new phones need them
    cfgT += dt;
    if (cfgT > 1) {
      cfgT = 0;
      pushSettings();
    }

    // during a stunt the director drives the camera; cut straight back to the chase cam after
    const wasCine = stunts.active;
    stunts.update(dt, car.root);
    if (!stunts.active) {
      if (wasCine) cam.snap(car.root);
      cam.update(dt, car.root, speed);
    }
    destruction.update(gdt, cam.camera, car.position);
    action.update(gdt, dt, cam.camera);
    fx.update(gdt);
    wreck.update(gdt);
    updateCombatHud();
    env.follow(car.position);
    renderer.render(scene, cam.camera);
  }
  // lock-on bracket + weapon readouts
  const lockPos = new THREE.Vector3();
  let lastMsl = -1;
  let lastLock = -1;
  function updateCombatHud() {
    const target = weapons.lock;
    const handle = target && playing ? target.handle : -1;
    if (handle !== lastLock) {
      lastLock = handle;
      ui.lock.classList.remove('acquire');
      if (handle >= 0) {
        void ui.lock.offsetWidth; // restart the settle animation for the new target
        ui.lock.classList.add('acquire');
      }
    }
    if (target && playing) {
      const t = target.translation();
      lockPos.set(t.x, t.y + 0.8, t.z).project(cam.camera);
      const onScreen = lockPos.z < 1 && Math.abs(lockPos.x) < 1.1 && Math.abs(lockPos.y) < 1.1;
      ui.lock.classList.toggle('hidden', !onScreen);
      ui.lock.style.transform = `translate(${((lockPos.x + 1) / 2) * innerWidth}px, ${((1 - lockPos.y) / 2) * innerHeight}px) translate(-50%, -50%)`;
    } else ui.lock.classList.add('hidden');
    ui.heat.style.width = `${Math.round(weapons.heat * 100)}%`;
    ui.heatBox.classList.toggle('hot', weapons.overheated);
    if (weapons.missiles !== lastMsl) {
      lastMsl = weapons.missiles;
      ui.pips.innerHTML = Array.from({ length: 4 }, (_, i) => `<i class="${i < weapons.missiles ? 'on' : ''}"></i>`).join('');
    }
  }

  requestAnimationFrame(frame);

  // debug handle for development
  (window as unknown as { game: unknown }).game = { car, cam, phys, link, renderer, scene, start, weapons, destruction, controls, tick, music, stunts, lot, action, setMode, setCar };
}

boot().catch((err) => {
  console.error(err);
  ui.loadingText.textContent = `something went wrong: ${err instanceof Error ? err.message : String(err)}`;
});
