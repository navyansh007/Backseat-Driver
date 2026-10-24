import * as THREE from 'three/webgpu';
import { SkyMesh } from 'three/examples/jsm/objects/SkyMesh.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Physics } from '../physics';
import { grassTexture, rng, windowsTexture } from './textures';

export const FOG_COLOR = new THREE.Color(0xcfdde3);

/** Sky dome, sun + hemisphere lights, IBL for reflections, fog. */
export class Environment {
  readonly sun: THREE.DirectionalLight;
  readonly sunDir = new THREE.Vector3();
  private shadowSize = 46;

  constructor(scene: THREE.Scene, renderer: THREE.WebGPURenderer) {
    // late-afternoon sun, soft and warm
    const elevation = 34;
    const azimuth = 215;
    const phi = THREE.MathUtils.degToRad(90 - elevation);
    const theta = THREE.MathUtils.degToRad(azimuth);
    this.sunDir.setFromSphericalCoords(1, phi, theta);

    const makeSky = (scale: number) => {
      const sky = new SkyMesh();
      sky.scale.setScalar(scale);
      sky.turbidity.value = 4.5;
      sky.rayleigh.value = 1.25;
      sky.mieCoefficient.value = 0.004;
      sky.mieDirectionalG.value = 0.82;
      sky.sunPosition.value.copy(this.sunDir);
      // clouds hold still, as they did with the WebGL sky (its time uniform stayed at 0)
      sky.cloudSpeed.value = 0;
      return sky;
    };
    scene.add(makeSky(4500));

    // Image-based lighting from the same sky so paint and glass reflect the scene's sky.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    envScene.add(makeSky(1000));
    const ground = new THREE.Mesh(new THREE.CircleGeometry(900, 24), new THREE.MeshBasicMaterial({ color: 0x6f7568 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -2;
    envScene.add(ground);
    scene.environment = pmrem.fromScene(envScene, 0.02).texture;
    scene.environmentIntensity = 0.75;
    pmrem.dispose();

    scene.fog = new THREE.Fog(FOG_COLOR, 120, 620);

    const hemi = new THREE.HemisphereLight(0xdfeaff, 0x7a7a62, 0.75);
    scene.add(hemi);

    this.sun = new THREE.DirectionalLight(0xfff0dc, 3.1);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.left = -this.shadowSize;
    sc.right = this.shadowSize;
    sc.top = this.shadowSize;
    sc.bottom = -this.shadowSize;
    sc.near = 1;
    sc.far = 260;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.035;
    this.sun.shadow.radius = 3;
    scene.add(this.sun, this.sun.target);
  }

  /** Keep the shadow frustum centred on the action; snap to texels to avoid shimmering. */
  follow(p: THREE.Vector3) {
    const texel = (this.shadowSize * 2) / this.sun.shadow.mapSize.x;
    const x = Math.round(p.x / texel) * texel;
    const z = Math.round(p.z / texel) * texel;
    this.sun.target.position.set(x, 0, z);
    this.sun.position.set(x, 0, z).addScaledVector(this.sunDir, 140);
    this.sun.target.updateMatrixWorld();
  }
}

/** Grass field, rolling hills on the horizon, perimeter city blocks. */
export function buildSurroundings(scene: THREE.Scene, phys: Physics) {
  const rand = rng(77);

  // --------------------------------------------------------------- ground
  const grass = grassTexture();
  grass.repeat.set(140, 140);
  const groundMat = new THREE.MeshStandardMaterial({ map: grass, roughness: 0.95, color: 0xd6e6c0 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  ground.receiveShadow = true;
  scene.add(ground);
  phys.staticBox({ x: 0, y: -0.5, z: 0 }, { x: 700, y: 0.5, z: 700 }, undefined, 1.0);

  // ----------------------------------------------------------------- hills
  const hillGeo = new THREE.PlaneGeometry(2600, 2600, 160, 160);
  hillGeo.rotateX(-Math.PI / 2);
  const pos = hillGeo.attributes.position as THREE.BufferAttribute;
  const colors: number[] = [];
  const low = new THREE.Color(0x86a866), high = new THREE.Color(0x5d8452), rock = new THREE.Color(0x9a9a86);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const d = Math.hypot(x, z);
    const ramp = THREE.MathUtils.smoothstep(d, 330, 700);
    const n =
      Math.sin(x * 0.006 + 1.3) * Math.cos(z * 0.005 - 0.4) * 0.6 +
      Math.sin(x * 0.013 - z * 0.011) * 0.3 +
      Math.sin(x * 0.031 + z * 0.027) * 0.1;
    const h = ramp * (60 + n * 55 + THREE.MathUtils.smoothstep(d, 700, 1200) * 90);
    pos.setY(i, h - 1.5);
    const t = THREE.MathUtils.clamp(h / 150, 0, 1);
    c.copy(low).lerp(high, t).lerp(rock, Math.max(0, t - 0.7) * 1.6);
    colors.push(c.r, c.g, c.b);
  }
  hillGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  hillGeo.computeVertexNormals();
  const hills = new THREE.Mesh(hillGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }));
  hills.receiveShadow = false;
  scene.add(hills);

  // distant low-poly forest on the hills
  const treeGeo = mergeGeometries([
    new THREE.CylinderGeometry(0.4, 0.5, 4, 5).translate(0, 2, 0),
    new THREE.ConeGeometry(3, 9, 6).translate(0, 8, 0),
  ]);
  const farTrees = new THREE.InstancedMesh(treeGeo, new THREE.MeshStandardMaterial({ color: 0x46703f, flatShading: true, roughness: 1 }), 900);
  const m = new THREE.Matrix4();
  let n = 0;
  for (let i = 0; i < 2600 && n < 900; i++) {
    const a = rand() * Math.PI * 2;
    const d = 360 + rand() * 520;
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    const h = sampleHeight(hillGeo, x, z);
    if (h < 8) continue;
    const s = 0.8 + rand() * 1.1;
    m.compose(new THREE.Vector3(x, h - 1, z), new THREE.Quaternion(), new THREE.Vector3(s, s * (0.8 + rand() * 0.5), s));
    farTrees.setMatrixAt(n++, m);
  }
  farTrees.count = n;
  farTrees.computeBoundingSphere();
  scene.add(farTrees);

  // ------------------------------------------------------------ city block
  const palette: [string, string][] = [
    ['#e8d9c4', '#5f7f99'], ['#d7c3b0', '#4d6e86'], ['#c9d3d6', '#3f5a70'], ['#efe5d6', '#6b8aa3'],
    ['#b9a593', '#47657d'], ['#dcd0c0', '#577790'], ['#a8b4b8', '#33495a'],
  ];
  const facadeMats = palette.map(([wall, glass], i) =>
    new THREE.MeshStandardMaterial({ map: windowsTexture(100 + i, wall, glass), roughness: 0.75 }),
  );
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x8d8a85, roughness: 0.9 });
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  boxGeo.translate(0, 0.5, 0);
  // materials: [px, nx, py, ny, pz, nz]; facades on the sides, roof on top
  const ring = (cx: number, cz: number, ax: 'x' | 'z', len: number, depth: number) => {
    let s = -len / 2;
    while (s < len / 2) {
      const w = 14 + rand() * 22;
      const h = 9 + rand() * rand() * 48;
      const d = depth * (0.7 + rand() * 0.3);
      const fm = facadeMats[(rand() * facadeMats.length) | 0].clone();
      fm.map = fm.map!.clone();
      fm.map.repeat.set(Math.max(1, Math.round(w / 12)), Math.max(1, Math.round(h / 12)));
      fm.map.needsUpdate = true;
      const mesh = new THREE.Mesh(boxGeo, [fm, fm, roofMat, roofMat, fm, fm]);
      const along = s + w / 2;
      mesh.scale.set(ax === 'x' ? w - 1.5 : d, h, ax === 'x' ? d : w - 1.5);
      mesh.position.set(ax === 'x' ? cx + along : cx, 0, ax === 'x' ? cz : cz + along);
      mesh.castShadow = h < 30;
      mesh.receiveShadow = true;
      scene.add(mesh);
      phys.staticBox(
        { x: mesh.position.x, y: h / 2, z: mesh.position.z },
        { x: mesh.scale.x / 2, y: h / 2, z: mesh.scale.z / 2 },
      );
      s += w;
    }
  };
  ring(0, -178, 'x', 380, 30); // north
  ring(0, 182, 'x', 380, 30); // south
  ring(-190, 0, 'z', 330, 30); // west
  ring(192, 0, 'z', 330, 30); // east
}

/** Approximate height lookup on a regular plane grid. */
function sampleHeight(geo: THREE.BufferGeometry, x: number, z: number) {
  const params = (geo as THREE.PlaneGeometry).parameters;
  const segs = params.widthSegments;
  const size = params.width;
  const gx = Math.round(((x + size / 2) / size) * segs);
  const gz = Math.round(((z + size / 2) / size) * segs);
  if (gx < 0 || gz < 0 || gx > segs || gz > segs) return 0;
  return (geo.attributes.position as THREE.BufferAttribute).getY(gz * (segs + 1) + gx);
}
