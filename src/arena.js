import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { ARENA_RADIUS } from './config.js';
import { mulberry32 } from './util.js';

/**
 * The city at night.
 *
 * The buildings, streets, cars and trees are models from Kenney's City Kits, packed into one
 * file by tools/pack-city.mjs; the sky and the ground are photographed textures from Poly
 * Haven. Three rings, nearest first:
 *
 *  - the low-rise district: a street grid of small buildings, street lights, parked cars and
 *    trees. The fight and the camera never leave it, so nothing in it is tall enough to hide
 *    a fighter; its inner part can be knocked down and trodden flat.
 *  - midtown: the same kit's taller buildings and towers, bigger the farther out they stand.
 *  - the skyline: plain boxes with painted windows, lost in the haze.
 *
 * Every model is drawn as one InstancedMesh per ring, however many copies there are.
 */

/** World units per kit unit: a 1 x 1 street tile becomes a 12 m street beside a 50 m giant. */
const UNIT = 2.6;
/** The car kit is modelled at its own, much larger scale. */
const CAR = 0.36;
/** Every 4th column of tiles is a north-south street, every 6th row an east-west one: blocks are 3 x 5 tiles. */
const STREET_X = 4;
const STREET_Z = 6;
const LOW_RISE = 60; // radius of the low-rise district
const MIDTOWN = 140; // towers out to here, the painted skyline beyond
const SKYLINE = 240;
const PLAZA = 9.5; // kept clear around the centre, where the fighters start
/** Inside this radius buildings cast shadows and can be destroyed. */
const CORE = ARENA_RADIUS + 12;
const KERB = UNIT * 0.02; // height of the kit's pavements
/** The key light comes from the moon's side, but from much higher than the moon hangs, so shadows stay short. */
const KEY_ELEVATION = (52 * Math.PI) / 180;

const LOW_BUILDINGS = [
  ...'abcdeh'.split('').map((c) => `commercial_building-${c}`),
  'commercial_building-a',
  'commercial_building-b',
  'commercial_building-d',
  'commercial_building-k',
  ...'abdghijkopst'.split('').map((c) => `industrial_building-${c}`),
];
const MID_BUILDINGS = [...'fgijklmn'.split('').map((c) => `commercial_building-${c}`), 'commercial_building-skyscraper-a'];
const TOWERS = 'abcde'.split('').map((c) => `commercial_building-skyscraper-${c}`);
const CARS = ['sedan', 'taxi', 'police', 'suv', 'hatchback-sports', 'van', 'delivery', 'truck', 'firetruck', 'ambulance', 'garbage-truck'].map((n) => `cars_${n}`);
/** Slight washes of colour, so two copies of a building do not look identical. */
const TINTS = [0xffffff, 0xffffff, 0xe6ecff, 0xfff0dc, 0xd8dcea, 0xf2e6e6, 0xdfeee6];

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);
const AHEAD = new THREE.Vector3(0, 0, 1);

const mod = (a, n) => ((a % n) + n) % n;

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** Everything the arena draws with; resolve it before constructing an Arena. */
export async function loadArenaAssets(base) {
  const textures = new THREE.TextureLoader();
  const surface = async (name, repeat) => {
    const [map, normalMap, arm] = await Promise.all(['diff', 'nor_gl', 'arm'].map((kind) => textures.loadAsync(`${base}textures/${name}_${kind}_1k.jpg`)));
    map.colorSpace = THREE.SRGBColorSpace;
    for (const t of [map, normalMap, arm]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.setScalar(repeat);
      t.anisotropy = 8;
    }
    // Poly Haven's "arm" packs occlusion, roughness and metalness into r, g, b: the channels three.js reads them from
    return { map, normalMap, roughnessMap: arm, metalnessMap: arm, aoMap: arm, metalness: 1 };
  };
  const [gltf, sky, asphalt, paving] = await Promise.all([
    new GLTFLoader().loadAsync(`${base}models/city.glb`),
    new HDRLoader().setDataType(THREE.FloatType).loadAsync(`${base}textures/kloppenheim_02_puresky_2k.hdr`), // floats: makeSky() regrades it
    surface('aerial_asphalt_01', 1), // repeats are set where the texture is used
    surface('large_square_pattern_01', 1),
  ]);

  const kit = new Map();
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry.computeBoundingBox();
    const box = o.geometry.boundingBox;
    kit.set(o.name, { geometry: o.geometry, material: o.material, box, size: box.getSize(new THREE.Vector3()), lamps: o.userData.lamps ?? [] });
  });
  return { kit, sky, asphalt, paving };
}

/* ------------------------------- windows ------------------------------- */

const WINDOWS_GLSL = /* glsl */ `
  // Each pane of glass is lit or dark by its own random number (_lit, baked into the model by
  // tools/pack-city.mjs), reshuffled per building (vVar.x). A large sheet of glass, such as a
  // tower's curtain wall, is cut into storeys and bays first, with frame lines between them.
  float pane = step(0.004, vLit);
  float sheet = step(0.5, vLit);
  vec2 grid = vec2(vObj.y * 6.0, (vObj.x - vObj.z) * 4.5);
  vec2 cell = floor(grid) * sheet;
  vec2 edge = abs(fract(grid) - 0.5);
  float frame = sheet * step(0.41, max(edge.x, edge.y));
  float rnd = fract(sin(dot(vec3(cell, vLit * 255.0 + vVar.x * 61.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  float lamp = pane * (1.0 - frame) * step(0.56, rnd) * vVar.y;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.025, 0.035, 0.07), pane * (1.0 - lamp) * 0.85);
  diffuseColor.rgb *= mix(0.2, 1.0, vVar.y); // vVar.y falls to 0 as a building is destroyed: soot, and the lights go out
  vec3 paneGlow = mix(vec3(1.0, 0.74, 0.4), vec3(0.6, 0.82, 1.0), step(0.8, fract(rnd * 7.31))) * lamp * 2.3;
`;

/**
 * Teach a kit material the per-copy data in `aVar` (seed, life, fade): every material can
 * dissolve a copy that stands too close to the camera (fade 1 solid .. 0 gone, as a fine
 * dither rather than real transparency, so nothing needs sorting); with `windows`, its meshes
 * carry `_lit` and their windows light up.
 */
function patchKitMaterial(material, windows) {
  // three.js shares compiled programs between materials whose patch function reads the same:
  // say which of the two variants this one is
  material.customProgramCacheKey = () => (windows ? 'kit+windows' : 'kit');
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float _lit;\nattribute vec3 aVar;\nvarying float vLit;\nvarying vec3 vVar;\nvarying vec3 vObj;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLit = _lit;\nvVar = aVar;\nvObj = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vLit;\nvarying vec3 vVar;\nvarying vec3 vObj;')
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (vVar.z < fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))))) discard;');
    if (!windows) return;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_fragment>', `#include <map_fragment>\n${WINDOWS_GLSL}`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += paneGlow;');
  };
}

/** Wall + lit-window textures for the far skyline's plain boxes. */
function facadeMaterials(rng, rows, tint) {
  const cols = 6;
  const lit = [];
  for (let i = 0; i < cols * rows; i++) lit.push(rng() < 0.38 ? (rng() < 0.75 ? '#ffd58a' : '#bfe4ff') : null);
  const W = 96;
  const Hh = rows * 16;
  const paint = (wall, pane) => (g) => {
    g.fillStyle = wall;
    g.fillRect(0, 0, W, Hh);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const colour = pane(lit[r * cols + c]);
        if (!colour) continue;
        g.fillStyle = colour;
        g.fillRect(c * 16 + 4, r * 16 + 4, 9, 9);
      }
    }
  };
  const wall = canvasTex(W, Hh, paint(tint, (on) => (on ? '#6a6250' : '#0c0f16')));
  const glow = canvasTex(W, Hh, paint('#000', (on) => on));
  const side = new THREE.MeshStandardMaterial({ map: wall, emissive: 0xffffff, emissiveMap: glow, emissiveIntensity: 1.5, roughness: 0.8, metalness: 0.1 });
  const roof = new THREE.MeshStandardMaterial({ color: 0x14171f, roughness: 0.9 });
  return [side, roof];
}

/* ------------------------------- instancing ------------------------------- */

/**
 * All the copies of one model in one ring, drawn as a single InstancedMesh. A copy is a plain
 * record - { x, y, z, yaw, sx, sy, sz, seed, tint } plus what changes in play: `squash`
 * (height factor), `tilt`, `life` (1 standing .. 0 destroyed) and `fade` (1 solid .. 0 gone).
 */
class Copies {
  constructor(part) {
    this.part = part;
    this.items = [];
    this.mesh = null;
  }

  add(item) {
    item.copies = this;
    item.index = this.items.length;
    item.squash = 1;
    item.tilt = 0;
    item.life = 1;
    item.fade = 1;
    this.items.push(item);
    return item;
  }

  build(scene, castShadow) {
    // share the model's vertex data, add this ring's own per-copy data
    const geometry = new THREE.BufferGeometry();
    geometry.setIndex(this.part.geometry.index);
    for (const [name, attribute] of Object.entries(this.part.geometry.attributes)) geometry.setAttribute(name, attribute);
    this.vars = new THREE.InstancedBufferAttribute(new Float32Array(this.items.length * 3), 3);
    geometry.setAttribute('aVar', this.vars);

    this.mesh = new THREE.InstancedMesh(geometry, this.part.material, this.items.length);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = castShadow;
    this.mesh.receiveShadow = true;
    for (const item of this.items) {
      this.mesh.setColorAt(item.index, _c.set(item.tint ?? 0xffffff));
      this.write(item);
    }
    scene.add(this.mesh);
  }

  /** Push a copy's current state to the GPU buffers. */
  write(item) {
    _q.setFromAxisAngle(UP, item.yaw);
    if (item.tilt) _q.multiply(_q2.setFromAxisAngle(AHEAD, item.tilt));
    this.mesh.setMatrixAt(item.index, _m.compose(_p.set(item.x, item.y, item.z), _q, _s.set(item.sx, item.sy * item.squash, item.sz)));
    this.mesh.instanceMatrix.needsUpdate = true;
    this.writeVars(item);
  }

  /** The cheap half of write(): just the shader's per-copy numbers. */
  writeVars(item) {
    this.vars.setXYZ(item.index, item.seed ?? 0, item.life, item.fade);
    this.vars.needsUpdate = true;
  }
}

/* ---------------------------------- arena ---------------------------------- */

export class Arena {
  /** @param assets what loadArenaAssets() resolved to */
  constructor(scene, assets) {
    this.scene = scene;
    this.kit = assets.kit;
    this.rng = mulberry32(20261110);
    this.groups = new Map(); // "model|ring" -> Copies
    this.nearby = []; // every copy the camera can come close to
    this.buildings = []; // the ones that can be knocked down
    this.props = []; // cars, trees, street lights: flattened underfoot
    this.falling = [];
    this.lampAt = []; // where each street lamp shines from

    for (const part of this.kit.values()) {
      patchKitMaterial(part.material, !!part.geometry.attributes._lit);
      // the kits are daylight-bright; at night the fighters should be the brightest things in the street
      part.material.color.set(0x4a5474);
    }

    this.makeSky(assets.sky);
    this.makeLights();
    this.layOutDistrict(assets);
    this.layOutMidtown();
    this.makeSkyline();
    for (const [key, copies] of this.groups) copies.build(scene, key.endsWith('|core'));
    this.makeLampGlow();
  }

  /* ------------------------------ sky and light ------------------------------ */

  makeSky(sky) {
    // The photograph is a long exposure: far brighter than a night should look, and its moon
    // is tens of thousands of times brighter than the sky around it. Darken it, lean it
    // toward blue, cap the moon so bloom leaves a glow rather than a white screen - and note
    // where the moon is, to light the city from that side.
    const { data, width, height } = sky.image;
    let brightest = 0;
    let moon = 0;
    for (let i = 0; i < data.length; i += 4) {
      const lum = data[i] + data[i + 1] + data[i + 2];
      if (lum > brightest) {
        brightest = lum;
        moon = i / 4;
      }
      data[i] = Math.min(data[i] * 0.04, 5);
      data[i + 1] = Math.min(data[i + 1] * 0.055, 6);
      data[i + 2] = Math.min(data[i + 2] * 0.1, 8);
    }
    // back to half floats: every GPU filters those, and it is half the memory
    sky.image.data = Uint16Array.from(data, THREE.DataUtils.toHalfFloat);
    sky.type = THREE.HalfFloatType;
    sky.mapping = THREE.EquirectangularReflectionMapping;
    sky.needsUpdate = true;
    this.scene.background = sky;
    this.scene.fog = new THREE.FogExp2(0x0a1128, 0.0068);

    // the moon's compass bearing in the picture (three.js maps u to atan2(z, x))
    const bearing = (((moon % width) + 0.5) / width - 0.5) * Math.PI * 2;
    const elevation = (0.5 - (Math.floor(moon / width) + 0.5) / height) * Math.PI;
    // turn the sky so the moon hangs over the far side of the opening shot, left of centre
    const want = Math.atan2(-0.92, -0.4);
    this.scene.backgroundRotation.y = bearing - want;
    this.moon = new THREE.Vector3(Math.cos(elevation) * Math.cos(want), Math.sin(elevation), Math.cos(elevation) * Math.sin(want));
  }

  makeLights() {
    this.scene.add(new THREE.HemisphereLight(0x6f86d8, 0x1c1622, 1.0));

    const sun = new THREE.DirectionalLight(0xc3d2ff, 2.6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const cam = sun.shadow.camera;
    cam.left = cam.bottom = -46;
    cam.right = cam.top = 46;
    cam.near = 1;
    cam.far = 220;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.06;
    this.scene.add(sun, sun.target);
    this.sun = sun;
    const flat = Math.hypot(this.moon.x, this.moon.z);
    this.sunOffset = new THREE.Vector3((this.moon.x / flat) * Math.cos(KEY_ELEVATION), Math.sin(KEY_ELEVATION), (this.moon.z / flat) * Math.cos(KEY_ELEVATION)).multiplyScalar(105);

    // warm rim from the lit streets, opposite the moon
    const rim = new THREE.DirectionalLight(0xff9a66, 0.8);
    rim.position.set(-this.moon.x * 60, 18, -this.moon.z * 60);
    this.scene.add(rim);
  }

  /* ------------------------------ layout ------------------------------ */

  /** Queue a copy of `name` in `ring` (only 'core' casts shadows). Position is where the model's origin goes. */
  place(name, ring, item) {
    const key = `${name}|${ring}`;
    if (!this.groups.has(key)) this.groups.set(key, new Copies(this.kit.get(name)));
    const copy = this.groups.get(key).add({ y: 0, sy: item.sx, sz: item.sx, yaw: 0, ...item });
    // the camera only ever comes close to what stands in the low-rise district
    if (ring !== 'mid' && !name.startsWith('roads_road')) this.nearby.push(copy);
    return copy;
  }

  /** Stand a building with the middle of its footprint at (x, z). */
  building(name, x, z, yaw, scale, stretch = 1) {
    const part = this.kit.get(name);
    const core = Math.hypot(x, z) < CORE;
    // the model's origin is not always under its middle
    part.box.getCenter(_p).setY(0).multiplyScalar(scale).applyAxisAngle(UP, yaw);
    const item = this.place(name, core ? 'core' : Math.hypot(x, z) < LOW_RISE + UNIT ? 'outer' : 'mid', {
      x: x - _p.x,
      z: z - _p.z,
      yaw,
      sx: scale,
      sy: scale * stretch,
      seed: this.rng(),
      tint: TINTS[Math.floor(this.rng() * TINTS.length)],
    });
    // what the game needs to knock it over: the footprint's middle and half extents, and its height
    const quarter = Math.abs(Math.sin(yaw)) > 0.5;
    item.cx = x;
    item.cz = z;
    item.hw = ((quarter ? part.size.z : part.size.x) * scale) / 2;
    item.hd = ((quarter ? part.size.x : part.size.z) * scale) / 2;
    item.h = part.size.y * scale * stretch;
    return item;
  }

  /** Something small standing in the street that a giant's foot flattens. */
  prop(name, x, z, yaw, scale, extra) {
    const item = this.place(name, Math.hypot(x, z) < CORE ? 'core' : 'outer', { x, z, yaw, sx: scale, ...extra });
    this.props.push(item);
    return item;
  }

  layOutDistrict({ asphalt, paving }) {
    const n = Math.ceil(LOW_RISE / UNIT) + 1;

    // streets
    for (let i = -n; i <= n; i++) {
      for (let j = -n; j <= n; j++) {
        const x = i * UNIT;
        const z = j * UNIT;
        if (Math.hypot(x, z) > LOW_RISE + UNIT) continue;
        const northSouth = mod(i, STREET_X) === 0;
        const eastWest = mod(j, STREET_Z) === 0;
        if (northSouth && eastWest) this.place('roads_road-crossroad', 'outer', { x, z, sx: UNIT });
        else if (eastWest) this.street(x, z, 0, i);
        else if (northSouth) this.street(x, z, Math.PI / 2, j);
      }
    }

    // blocks: paved, with a row of buildings along each long side
    const slabs = [];
    for (let bi = -Math.ceil(n / STREET_X) - 1; bi * STREET_X <= n; bi++) {
      for (let bj = -Math.ceil(n / STREET_Z) - 1; bj * STREET_Z <= n; bj++) {
        const x0 = (bi * STREET_X + 0.5) * UNIT;
        const x1 = ((bi + 1) * STREET_X - 0.5) * UNIT;
        const z0 = (bj * STREET_Z + 0.5) * UNIT;
        const z1 = ((bj + 1) * STREET_Z - 0.5) * UNIT;
        if (Math.hypot((x0 + x1) / 2, (z0 + z1) / 2) > LOW_RISE) continue;
        slabs.push([x0, x1, z0, z1]);
        for (const side of [-1, 1]) this.row(side < 0 ? x0 : x1, side, z0, z1);
      }
    }
    this.makeGround(asphalt, paving, slabs);
  }

  /** One tile of street running along x (yaw 0) or z (yaw 90 degrees); `k` counts tiles along it. */
  street(x, z, yaw, k) {
    const rng = this.rng;
    this.place('roads_road-straight', 'outer', { x, z, yaw, sx: UNIT });
    if (Math.hypot(x, z) < PLAZA + 3) return;
    const across = (side, dist, along = 0) => _p.set(along, 0, side * dist * UNIT).applyAxisAngle(UP, yaw);

    // a street light on every other tile, alternating sides, its arm over the roadway
    if (mod(k, 2) === 1) {
      const side = mod(k, 4) === 1 ? 1 : -1;
      const at = across(side, 0.45);
      const lightYaw = yaw + (side > 0 ? 0 : Math.PI);
      const part = this.kit.get('roads_light-curved');
      const lamps = part.lamps.map((lamp) => {
        const head = new THREE.Vector3().fromArray(lamp).multiplyScalar(UNIT).applyAxisAngle(UP, lightYaw);
        this.lampAt.push(head.add(_s.set(x + at.x, 0, z + at.z)));
        return this.lampAt.length - 1;
      });
      this.prop('roads_light-curved', x + at.x, z + at.z, lightYaw, UNIT, { lamps });
    }
    if (rng() < 0.3) {
      const lane = rng() < 0.5 ? 1 : -1;
      const at = across(lane, 0.2, (rng() - 0.5) * UNIT * 0.5);
      this.prop(CARS[Math.floor(rng() * CARS.length)], x + at.x, z + at.z, yaw + (lane * Math.PI) / 2, CAR, { tint: TINTS[Math.floor(rng() * TINTS.length)] });
    }
  }

  /** A row of buildings along the side of a block at x = `edge`, facing the street on that side, from z0 to z1. */
  row(edge, side, z0, z1) {
    const rng = this.rng;
    const yaw = (side * Math.PI) / 2; // the models face +z: turn them to face out of the block
    let at = z0 + 0.12;
    while (at < z1 - UNIT * 0.7) {
      const room = (z1 - at) / UNIT - 0.04;
      const mid = Math.hypot(edge, at);
      const fits = LOW_BUILDINGS.filter((name) => this.kit.get(name).size.x <= room && this.kit.get(name).size.z <= 1.46);
      // leave gaps - more of them where the fight happens, so there is room to see it
      if (!fits.length || rng() < (mid < ARENA_RADIUS ? 0.3 : 0.12)) {
        const gap = Math.min(z1 - at, UNIT * (0.7 + rng() * 0.6));
        for (let t = 0; t < 1 + Math.floor(rng() * 3); t++) {
          const x = edge - side * UNIT * (0.3 + rng() * 0.9);
          const z = at + gap * (0.15 + rng() * 0.7);
          if (Math.hypot(x, z) > PLAZA) this.prop(rng() < 0.6 ? 'suburban_tree-large' : 'suburban_tree-small', x, z, rng() * 6.28, UNIT * (0.7 + rng() * 0.4));
        }
        at += gap;
        continue;
      }
      const name = fits[Math.floor(rng() * fits.length)];
      const size = this.kit.get(name).size;
      const x = edge - side * ((size.z * UNIT) / 2 + 0.1);
      const z = at + (size.x * UNIT) / 2;
      at += size.x * UNIT + 0.12 + rng() * 0.3;
      if (Math.hypot(x, z) < PLAZA + (Math.max(size.x, size.z) * UNIT) / 2) continue;
      const item = this.building(name, x, z, yaw, UNIT);
      if (item.copies === this.groups.get(`${name}|core`)) this.buildings.push(item);
    }
  }

  layOutMidtown() {
    const rng = this.rng;
    const cell = 7.6;
    const n = Math.ceil(MIDTOWN / cell);
    for (let i = -n; i <= n; i++) {
      for (let j = -n; j <= n; j++) {
        const x = (i + (rng() - 0.5) * 0.4) * cell;
        const z = (j + (rng() - 0.5) * 0.4) * cell;
        const d = Math.hypot(x, z);
        if (d < LOW_RISE + 6 || d > MIDTOWN || rng() > 0.5) continue;
        // taller the farther out, so the city rises like an amphitheatre around the fight
        const t = (d - LOW_RISE) / (MIDTOWN - LOW_RISE);
        const list = rng() > t * 2.2 ? MID_BUILDINGS : TOWERS;
        const scale = UNIT * (1.25 + t * 0.8) * (0.9 + rng() * 0.25);
        this.building(list[Math.floor(rng() * list.length)], x, z, (Math.floor(rng() * 4) * Math.PI) / 2, scale, 1 + rng() * t * 0.7);
      }
    }
  }

  makeSkyline() {
    const rng = this.rng;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    // BoxGeometry makes one draw group per face; walls and roof only need two materials
    geo.clearGroups();
    geo.addGroup(0, 12, 0); // +x, -x walls
    geo.addGroup(12, 12, 1); // top and bottom
    geo.addGroup(24, 12, 0); // +z, -z walls
    const classes = [
      { mats: facadeMaterials(rng, 11, '#1f2430'), list: [] },
      { mats: facadeMaterials(rng, 24, '#1a1f2b'), list: [] },
    ];
    const cell = 11;
    const n = Math.ceil(SKYLINE / cell);
    for (let i = -n; i <= n; i++) {
      for (let j = -n; j <= n; j++) {
        const x = (i + (rng() - 0.5) * 0.5) * cell;
        const z = (j + (rng() - 0.5) * 0.5) * cell;
        const d = Math.hypot(x, z);
        if (d < MIDTOWN - 4 || d > SKYLINE || rng() > 0.6) continue;
        const h = 12 + rng() * rng() * 46;
        classes[h < 26 ? 0 : 1].list.push(_m.compose(_p.set(x, 0, z), _q.identity(), _s.set(5 + rng() * 4, h, 5 + rng() * 4)).clone());
      }
    }
    for (const c of classes) {
      const inst = new THREE.InstancedMesh(geo, c.mats, c.list.length);
      c.list.forEach((m, i) => inst.setMatrixAt(i, m));
      inst.frustumCulled = false;
      this.scene.add(inst);
    }
  }

  /** Asphalt everywhere; each block of the low-rise district paved, level with the kit's pavements. */
  makeGround(asphalt, paving, slabs) {
    const size = SKYLINE * 2.4;
    for (const key of ['map', 'normalMap', 'roughnessMap']) asphalt[key].repeat.setScalar(size / 6.4); // the photograph covers 30 m
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshStandardMaterial({ ...asphalt, color: 0x8a90a0 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const position = [];
    const uv = [];
    const index = [];
    for (const [x0, x1, z0, z1] of slabs) {
      const base = position.length / 3;
      for (const [x, z] of [[x0, z0], [x0, z1], [x1, z1], [x1, z0]]) {
        position.push(x, KERB, z);
        uv.push(x / 3.2, z / 3.2);
      }
      index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(index);
    geo.computeVertexNormals();
    const blocks = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ ...paving, color: 0x767c8c }));
    blocks.receiveShadow = true;
    this.scene.add(blocks);
  }

  /** Street lamps are not real lights: each is a glowing dot and a pool of light painted on the ground. */
  makeLampGlow() {
    const soft = canvasTex(64, 64, (g) => {
      const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
    });
    const geo = new THREE.BufferGeometry();
    this.lampDots = new THREE.Float32BufferAttribute(this.lampAt.flatMap((p) => [p.x, p.y, p.z]), 3);
    geo.setAttribute('position', this.lampDots);
    const dots = new THREE.Points(geo, new THREE.PointsMaterial({ map: soft, color: new THREE.Color(3.2, 2.2, 1.1), size: 1.1, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    dots.frustumCulled = false;
    this.scene.add(dots);

    const pool = new THREE.PlaneGeometry(1, 1);
    pool.rotateX(-Math.PI / 2);
    this.pools = new THREE.InstancedMesh(pool, new THREE.MeshBasicMaterial({ map: soft, color: new THREE.Color(0.55, 0.36, 0.17), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }), this.lampAt.length);
    this.pools.frustumCulled = false;
    this.scene.add(this.pools);
    this.lampAt.forEach((_, i) => this.lamp(i, true));
  }

  /** Switch one street lamp on or off. */
  lamp(i, on) {
    const p = this.lampAt[i];
    this.lampDots.setY(i, on ? p.y : -1000);
    this.lampDots.needsUpdate = true;
    this.pools.setMatrixAt(i, _m.compose(_p.set(p.x, KERB + 0.04, p.z), _q.identity(), _s.setScalar(on ? 6.5 : 0)));
    this.pools.instanceMatrix.needsUpdate = true;
  }

  /* ------------------------------ in play ------------------------------ */

  /** Put everything destroyed back (new game). */
  reset() {
    for (const item of [...this.buildings, ...this.props]) {
      if (item.life === 1) continue;
      item.life = 1;
      item.squash = 1;
      item.tilt = 0;
      item.copies.write(item);
      for (const i of item.lamps ?? []) this.lamp(i, true);
    }
    this.falling.length = 0;
  }

  /**
   * Flatten what stands inside a circle. Buildings collapse and are reported through
   * onCollapse({ x, z, hw, hd, h }); cars, trees and street lights are just squashed.
   */
  crush(x, z, r, onCollapse) {
    for (const b of this.buildings) {
      if (b.life < 1) continue;
      const nx = Math.max(b.cx - b.hw, Math.min(x, b.cx + b.hw));
      const nz = Math.max(b.cz - b.hd, Math.min(z, b.cz + b.hd));
      if ((x - nx) ** 2 + (z - nz) ** 2 > r * r) continue;
      b.life = 0.999; // falling
      b.t = 0;
      b.lean = (this.rng() - 0.5) * 0.5;
      this.falling.push(b);
      onCollapse({ x: b.cx, z: b.cz, hw: b.hw, hd: b.hd, h: b.h });
    }
    for (const p of this.props) {
      if (p.life < 1 || (p.x - x) ** 2 + (p.z - z) ** 2 > r * r) continue;
      p.life = 0;
      p.squash = 0.12;
      p.copies.write(p);
      for (const i of p.lamps ?? []) this.lamp(i, false);
    }
  }

  update(dt, focus, camera) {
    // dissolve whatever stands right in front of the lens, so it never walls off the shot
    for (const item of this.nearby) {
      const d = Math.hypot(item.x - camera.position.x, item.z - camera.position.z);
      const fade = Math.min(1, Math.max(0, (d - 13) / 3));
      if (fade === item.fade) continue;
      item.fade = fade;
      item.copies.writeVars(item);
    }
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const b = this.falling[i];
      b.t += dt;
      const k = Math.min(1, b.t / 0.7);
      const e = k * k;
      b.squash = 1 - e * 0.88;
      b.tilt = b.lean * e;
      b.life = k >= 1 ? 0 : 0.999 * (1 - e);
      const x = b.x;
      b.x += Math.sin(b.t * 60) * 0.06 * (1 - k);
      b.copies.write(b);
      b.x = x;
      if (k >= 1) this.falling.splice(i, 1);
    }
    // keep the shadow frustum centred on the action
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).add(this.sunOffset);
  }
}
