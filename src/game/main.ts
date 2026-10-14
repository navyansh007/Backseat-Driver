import '../styles/game.css';
import * as THREE from 'three';
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
import { Weapons } from './combat/weapons';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  loading: $('loading'), loadingText: $('loading-text'), title: $('title'), hud: $('hud'), brand: $('brand'),
  speed: $('speed'), gear: $('gear'), chip: $('link-chip'), chipText: $('link-text'), hints: $('hints'),
  soundNote: $('sound-note'), toast: $('toast'), qr: $<HTMLCanvasElement>('qr'), qrUrl: $<HTMLAnchorElement>('qr-url'),
  room: $('room-code'), qrDot: $('qr-dot'), qrStatus: $('qr-status'), kbStart: $('kb-start'),
  lock: $('lock'), heat: $('heat-fill'), heatBox: $('heat'), pips: $('pips'),
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
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const link = new RemoteLink();
  ui.room.textContent = link.room;
  void link.drawQR(ui.qr, 260).then((url) => {
    ui.qrUrl.textContent = url.replace(/^https?:\/\//, '');
    ui.qrUrl.href = url;
  });

  ui.loadingText.textContent = 'starting the physics engine…';
  await nextFrame();
  const phys = await Physics.create();
  const env = new Environment(scene, renderer);

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
  });
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

  const weapons = new Weapons(scene, car, phys, fx, destruction, {
    gunshot: () => audio.gunshot(),
    launch: () => audio.launch(),
  });

  // settle props/cars before showing anything
  for (let i = 0; i < 30; i++) {
    car.drive(1 / 60, { steer: 0, throttle: 0, handbrake: false });
    phys.step();
  }
  phys.events.clear();
  car.capture();
  car.capture();
  phys.sync(true);
  renderer.compile(scene, cam.camera);

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

    acc += dt;
    let steps = 0;
    while (acc >= STEP && steps < 5) {
      car.drive(STEP, input);
      phys.step();
      car.capture();
      acc -= STEP;
      steps++;
      phys.events.drainContactForceEvents((ev) => {
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
    car.render(acc / STEP, dt);
    lot.update(dt, car.position);
    life.update(dt, car.position);
    weapons.update(dt, controls.weapons, playing);

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
    smoke.update(dt);
    audio.update(dt, speed, Math.max(0, Math.abs(input.throttle)), slipTotal, car.sim.reversing);
    // soundtrack: starts with the player's first real movement (intro, then the loop)
    if (!musicStarted && playing && (Math.abs(input.throttle) > 0.08 || speed > 0.8)) {
      musicStarted = true;
      music.begin();
    }

    // ---------------------------------------------------- recovery
    if (car.sim.upright() < 0.35) {
      flippedFor += dt;
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

    cam.update(dt, car.root, speed);
    destruction.update(dt, cam.camera, car.position);
    fx.update(dt);
    updateCombatHud();
    env.follow(car.position);
    renderer.render(scene, cam.camera);
  }
  // lock-on bracket + weapon readouts
  const lockPos = new THREE.Vector3();
  let lastMsl = -1;
  function updateCombatHud() {
    const target = weapons.lock;
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
  (window as unknown as { game: unknown }).game = { car, cam, phys, link, renderer, scene, start, weapons, destruction, controls, tick, music };
}

boot().catch((err) => {
  console.error(err);
  ui.loadingText.textContent = `something went wrong: ${err instanceof Error ? err.message : String(err)}`;
});
