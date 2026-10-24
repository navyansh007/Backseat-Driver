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

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  loading: $('loading'), loadingText: $('loading-text'), title: $('title'), hud: $('hud'), brand: $('brand'),
  speed: $('speed'), gear: $('gear'), chip: $('link-chip'), chipText: $('link-text'), hints: $('hints'),
  soundNote: $('sound-note'), toast: $('toast'), qr: $<HTMLCanvasElement>('qr'), qrUrl: $<HTMLAnchorElement>('qr-url'),
  room: $('room-code'), lanNote: $('lan-note'), qrDot: $('qr-dot'), qrStatus: $('qr-status'), kbStart: $('kb-start'),
  lock: $('lock'), heat: $('heat-fill'), heatBox: $('heat'), pips: $('pips'),
  letterbox: $('letterbox'), card: $('stunt-card'), cardTitle: $('stunt-title'), cardTags: $('stunt-tags'),
  cardStats: $('stunt-stats'), cardPoints: $('stunt-points'),
};

let toastTimer = 0;
function toast(text: string, ms = 2400) {
  ui.toast.textContent = text;
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => ui.toast.classList.remove('show'), ms);
}

// yield so loading text can paint; setTimeout (not rAF) so loading also progresses in a background tab
const nextFrame = () => new Promise((r) => setTimeout(r, 30));

async function boot() {
  // ------------------------------------------------------------ renderer
  const canvas = $<HTMLCanvasElement>('view');
  // WebGPU where the browser has it (it can pick the discrete GPU), WebGL 2 otherwise; ?gl=1 forces WebGL 2
  const renderer = new THREE.WebGPURenderer({
    canvas, antialias: true, alpha: false, powerPreference: 'high-performance',
    forceWebGL: new URLSearchParams(location.search).get('gl') === '1',
  });
  await renderer.init();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
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
  void link.drawQR(ui.qr, 260).then((url) => {
    ui.qrUrl.textContent = url.replace(/^https?:\/\//, '');
    ui.qrUrl.href = url;
    // a LAN address only works on the same network; a public URL works from anywhere
    const lan = /^(10|127|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(new URL(url).hostname);
    ui.lanNote.textContent = lan ? 'phone and computer must be on the same wi-fi' : 'same wi-fi is fastest · mobile data works too';
  });

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
  const car = new PlayerCar(phys.world, scene, lot.spawn);
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
  }, wreck);
  // driving assist level, remembered per browser
  const ASSIST_LEVELS = [
    { name: 'off', value: 0 },
    { name: 'light', value: 0.4 },
    { name: 'medium', value: 0.7 },
    { name: 'strong', value: 1 },
  ];
  let assistIdx = 2;
  try {
    const saved = Number(localStorage.getItem('tnd-assist'));
    if (Number.isInteger(saved) && saved >= 0 && saved < ASSIST_LEVELS.length && localStorage.getItem('tnd-assist') !== null) assistIdx = saved;
  } catch { /* storage unavailable */ }
  car.sim.assist = ASSIST_LEVELS[assistIdx].value;
  const cycleAssist = () => {
    assistIdx = (assistIdx + 1) % ASSIST_LEVELS.length;
    car.sim.assist = ASSIST_LEVELS[assistIdx].value;
    try { localStorage.setItem('tnd-assist', String(assistIdx)); } catch { /* ignore */ }
    toast(`steering assist: ${ASSIST_LEVELS[assistIdx].name}`, 1600);
  };

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
  });

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
  let hintsOn = true;
  const start = () => {
    if (playing) return;
    playing = true;
    ui.title.classList.add('hidden');
    ui.hud.classList.remove('hidden');
    ui.brand.classList.add('hidden');
    cam.mode = 'chase';
    cam.snap(car.root);
  };
  const showMenu = () => {
    stunts.cancel();
    playing = false;
    ui.title.classList.remove('hidden');
    ui.hud.classList.add('hidden');
    ui.brand.classList.remove('hidden');
    cam.mode = 'orbit';
  };
  const audioStart = () => {
    audio.start();
    ui.soundNote.classList.add('hidden');
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
    prevPhones = n;
  };

  addEventListener('keydown', (e) => {
    switch (e.code) {
      case 'Enter': start(); break;
      case 'Escape': playing ? showMenu() : start(); break;
      case 'KeyC': if (playing) cam.cycle(); break;
      case 'KeyR': resetCar(); break;
      case 'KeyM': toast(audio.toggleMute() ? 'sound off' : 'sound on', 1200); break;
      case 'KeyB': toast(music.toggle() ? 'music on' : 'music off', 1200); break;
      case 'KeyV': cycleAssist(); break;
      case 'KeyK':
        stunts.enabled = !stunts.enabled;
        if (!stunts.enabled) stunts.cancel();
        toast(stunts.enabled ? 'stunt cam on' : 'stunt cam off', 1400);
        break;
      case 'KeyQ': playing ? showMenu() : start(); break;
      case 'KeyH': hintsOn = !hintsOn; ui.hints.classList.toggle('hidden', !hintsOn); break;
      case 'KeyF': case 'KeyG':
      case 'KeyW': case 'KeyA': case 'KeyS': case 'KeyD':
      case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight':
        start(); break;
    }
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
    if (!playing) input = { steer: 0, throttle: 0, handbrake: true };

    // game time runs slower during a stunt; the camera and audio keep real time
    const gdt = dt * stunts.timeScale;
    acc += gdt;
    let steps = 0;
    while (acc >= STEP && steps < 5) {
      car.drive(STEP, input);
      lot.breakables.preStep(car.body, car.sim.chassisColliders[0]);
      phys.step();
      car.capture();
      stunts.postStep(STEP, playing);
      acc -= STEP;
      steps++;
      phys.events.drainContactForceEvents((ev) => {
        lot.breakables.onContactForce(ev);
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
    lot.hedges.update(gdt, hedgeMovers);
    car.render(acc / STEP, dt);
    lot.update(gdt, car.position);
    life.update(gdt, car.position);
    weapons.update(gdt, controls.weapons, playing);

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
    if (car.sim.upright() < 0.35 && !stunts.active) {
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
      link.send({ t: 'tele', kmh, gear, msl: weapons.missiles, heat: +weapons.heat.toFixed(2), hot: weapons.overheated, lock: !!weapons.lock });
    }

    // during a stunt the director drives the camera; cut straight back to the chase cam after
    const wasCine = stunts.active;
    stunts.update(dt, car.root);
    if (!stunts.active) {
      if (wasCine) cam.snap(car.root);
      cam.update(dt, car.root, speed);
    }
    destruction.update(gdt, cam.camera, car.position);
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
  (window as unknown as { game: unknown }).game = { car, cam, phys, link, renderer, scene, start, weapons, destruction, controls, tick, music, stunts, lot };
}

boot().catch((err) => {
  console.error(err);
  ui.loadingText.textContent = `something went wrong: ${err instanceof Error ? err.message : String(err)}`;
});
