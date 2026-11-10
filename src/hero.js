import * as THREE from 'three';
import { ClipBody, findNode, loadModel } from './body.js';
import { layerClips, retargetClip } from './retarget.js';
import { TAU } from './util.js';

/** Height of the base of the skull above the ground in world units: fixes the giant's scale. */
const SKULL_BASE_Y = 9.2;
/** The skull base sits at 86.9% of the body's full height in the base mesh. */
const BODY_HEIGHT = SKULL_BASE_Y / 0.869;

/* ------------- suit: silver / red markings painted in the fragment shader ------------- */

// `p` is the bind-pose position divided by body height: y runs 0 (soles) to 1, the arms lie
// along +/-x in a T-pose, +z is the front. Painting in bind space keeps the markings glued
// to the body however it is posed, and needs no UV layout or texture.
const SUIT_GLSL = /* glsl */ `
  float edge(float e, float v) {
    float w = fwidth(v) + 1e-5;
    return smoothstep(e - w, e + w, v);
  }
  float stripe(float d, float halfWidth) {
    return 1.0 - edge(halfWidth, abs(d));
  }
  // 1 where the suit is red
  float suitRed(vec3 p) {
    float ax = abs(p.x);
    float arm = edge(0.105, ax) * edge(0.76, p.y);
    float red = 0.0;

    // boots: the top edge sweeps up to a point on the shin
    red = max(red, 1.0 - edge(0.176 + 0.060 * smoothstep(-0.02, 0.05, p.z), p.y));
    // gauntlets: pointed toward the elbow along the top of the forearm
    red = max(red, edge(0.300 - 0.045 * smoothstep(0.800, 0.832, p.y), ax) * arm);
    // a band round each upper arm
    red = max(red, stripe(ax - 0.168, 0.0085) * arm);
    // trunks, cut high over the hips
    red = max(red, edge(0.448 + ax * 0.74, p.y) * (1.0 - edge(0.552, p.y)) * (1.0 - edge(0.150, ax)));

    // twin chevrons across the chest and back
    float torso = (1.0 - edge(0.098, ax)) * (1.0 - arm);
    float v = p.y - (0.668 + ax * 1.05);
    red = max(red, stripe(v - 0.048, 0.0125) * torso * edge(0.600, p.y));
    red = max(red, stripe(v - 0.006, 0.0125) * torso * edge(0.600, p.y));

    // one line down each side, from under the arm to the boot
    float side = ax - mix(0.066, 0.071, smoothstep(0.50, 0.70, p.y));
    red = max(red, stripe(side, 0.0075) * edge(0.556, p.y) * (1.0 - edge(0.748, p.y)) * (1.0 - arm));
    red = max(red, stripe(ax - 0.048 - 0.034, 0.0075) * (1.0 - edge(0.452, p.y)));
    return red;
  }
`;

function suitMaterial(invHeight) {
  const mat = new THREE.MeshStandardMaterial({ metalness: 0.62, roughness: 0.36 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uInvH = { value: invHeight };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uInvH;\nattribute float _cavity;\nvarying vec3 vRest;\nvarying float vCav;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRest = position * uInvH;\nvCav = _cavity;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vRest;\nvarying float vCav;\nfloat suitRelief;\n${SUIT_GLSL}`)
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        float suitR = suitRed(vRest);
        // the same mask sampled around this point: a soft height field for the relief,
        // and a band along every boundary for the piping
        vec3 st = vec3(0.0032, 0.0, 0.0);
        suitRelief = (suitRed(vRest + st.xyy) + suitRed(vRest - st.xyy) + suitRed(vRest + st.yxy)
          + suitRed(vRest - st.yxy) + suitRed(vRest + st.yyx) + suitRed(vRest - st.yyx)) / 6.0;
        float piping = clamp(1.0 - abs(suitRelief - 0.5) * 2.4, 0.0, 1.0);
        vec3 suitC = mix(vec3(0.640, 0.675, 0.735), vec3(0.520, 0.010, 0.020), suitR);
        suitC *= 1.0 - 0.6 * clamp(vCav, 0.0, 1.0);   // shade the creases between the muscles
        suitC *= 1.0 + 0.2 * clamp(-vCav, 0.0, 1.0);  // and lift the ridges
        diffuseColor.rgb = mix(suitC, suitC * 0.28, piping * 0.8);`,
      )
      // the red is lacquer over the metal: a touch glossier, a touch less mirror-like
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.30, suitR) + 0.22 * clamp(vCav, 0.0, 1.0);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.45, suitR);')
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
        {
          // emboss: tilt the normal by the slope of the relief (screen-space bump mapping)
          vec3 sx = dFdx(-vViewPosition);
          vec3 sy = dFdy(-vViewPosition);
          vec3 r1 = cross(sy, normal);
          vec3 r2 = cross(normal, sx);
          float det = dot(sx, r1);
          vec2 slope = vec2(dFdx(suitRelief), dFdy(suitRelief)) * 0.05;
          normal = normalize(abs(det) * normal - sign(det) * (slope.x * r1 + slope.y * r2));
        }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
        {
          // a cool rim along the silhouette so the figure reads against the night sky
          float rim = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 3.0);
          totalEmissiveRadiance += vec3(0.20, 0.38, 0.62) * rim * 0.4;
        }`,
      );
  };
  return mat;
}

function heroMaterials() {
  return {
    silver: new THREE.MeshStandardMaterial({ color: 0xd6dbe4, metalness: 0.62, roughness: 0.36 }),
    red: new THREE.MeshStandardMaterial({ color: 0xb80f1c, metalness: 0.5, roughness: 0.3 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x1b1f27, metalness: 0.7, roughness: 0.4 }),
    glow: new THREE.MeshStandardMaterial({ color: 0x0a1c22, emissive: 0x8ff4ff, emissiveIntensity: 1.3, roughness: 0.25 }),
  };
}

function part(parent, geo, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = !mat.emissiveIntensity || mat.emissiveIntensity < 1;
  parent.add(m);
  return m;
}

/* ------------------------------------ head ------------------------------------ */

const HELM_HEIGHT = 1.9; // world units, chin guard to crown
const HELM_DROP = -0.34; // where its lowest point sits relative to the base of the skull
const HELM_FORWARD = 0.1;

/**
 * The giant's head is a modelled helmet (see README for its author), refinished: its dark
 * greyscale texture is kept for the surface pattern but lifted to polished silver, and its
 * eye lenses become light sources. Returns a group whose origin is the base of the skull.
 */
function buildHead(asset, M) {
  const helm = new THREE.Group();
  helm.add(asset.scene);
  asset.scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(asset.scene);
  const centre = box.getCenter(new THREE.Vector3());
  const scale = HELM_HEIGHT / (box.max.y - box.min.y);
  asset.scene.scale.setScalar(scale);
  asset.scene.position.set(-centre.x * scale, HELM_DROP - box.min.y * scale, HELM_FORWARD - centre.z * scale);

  let silver = null;
  asset.scene.traverse((o) => {
    if (!o.isMesh) return;
    if (/lenses/.test(o.name)) {
      o.material = M.glow;
      return;
    }
    if (!silver) {
      silver = new THREE.MeshStandardMaterial({ map: o.material.map, metalness: 0.8, roughness: 0.3 });
      silver.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <map_fragment>',
          '#include <map_fragment>\ndiffuseColor.rgb = vec3(0.74, 0.77, 0.83) * (0.5 + 7.0 * dot(diffuseColor.rgb, vec3(0.333)));',
        );
      };
    }
    o.material = silver;
    o.castShadow = true;
  });
  // collar over the neck stump of the base mesh
  part(helm, new THREE.CylinderGeometry(0.33, 0.43, 0.42, 36), M.dark, 0, -0.06, -0.02);
  return helm;
}

/** A small crest over the sternum. */
function buildCrest(chest, M) {
  const outline = new THREE.Shape();
  outline.moveTo(0, -0.3);
  outline.lineTo(0.2, 0.02);
  outline.lineTo(0, 0.26);
  outline.lineTo(-0.2, 0.02);
  outline.closePath();
  const bevel = { bevelEnabled: true, bevelSize: 0.025, bevelThickness: 0.025, bevelSegments: 2 };
  const base = part(chest, new THREE.ExtrudeGeometry(outline, { depth: 0.03, ...bevel }), M.red, 0, 0.64, 0.86);
  base.rotation.x = -0.1;
  const inlay = part(base, new THREE.ExtrudeGeometry(outline, { depth: 0.03, ...bevel }), M.silver, 0, 0, 0.03);
  inlay.scale.set(0.62, 0.62, 1);
}

/**
 * Close the fingers of one hand. The base mesh is bound with flat, palm-down hands; each
 * knuckle is turned about the line across the knuckles, toward the palm.
 */
function curlFingers(bone, side, curl) {
  const index = bone(`${side}_Index1`).getWorldPosition(new THREE.Vector3());
  const across = bone(`${side}_Pinky1`).getWorldPosition(new THREE.Vector3()).sub(index).normalize();
  const along = bone(`${side}_Mid1`).getWorldPosition(new THREE.Vector3()).sub(bone(`${side}_Hand`).getWorldPosition(new THREE.Vector3()));
  const axis = across.clone();
  if (axis.clone().cross(along).y > 0) axis.negate(); // positive turn = fingertips toward the palm
  const turns = [];
  const turn = (b, about, angle) => {
    const world = b.getWorldQuaternion(new THREE.Quaternion());
    const q = new THREE.Quaternion().setFromAxisAngle(about, angle);
    turns.push([b, world.clone().invert().multiply(q).multiply(world)]);
  };
  for (const finger of ['Index', 'Mid', 'Ring', 'Pinky']) {
    for (let i = 1; i <= 3; i++) turn(bone(`${side}_${finger}${i}`), axis, curl[i - 1]);
  }
  // the thumb folds across the palm: turn it about the hand's own long axis
  const fold = along.clone().normalize();
  const thumb = bone(`${side}_Thumb2`).getWorldPosition(new THREE.Vector3()).sub(bone(`${side}_Thumb1`).getWorldPosition(new THREE.Vector3()));
  if (fold.clone().cross(thumb).y > 0) fold.negate();
  for (let i = 1; i <= 3; i++) turn(bone(`${side}_Thumb${i}`), fold, curl[3]);
  // everything was measured in the bind pose; now apply
  for (const [b, local] of turns) b.quaternion.multiply(local);
}

/* ---------------------------------- animation ---------------------------------- */

/**
 * The giant's motions come from the Mesh2Motion library (CC0): one small file per clip in
 * public/moves/, made for a different skeleton and re-keyed onto this one at load time.
 * The fighting clips all start from the same stance (right side leading).
 */
const CLIPS = [
  'fighting-idle', 'jog', 'walk-backwards', 'strafe-left', 'strafe-right', 'shield-dash-rm', 'dodge-back', 'dodge-left', 'dodge-right',
  'defend', 'hit-chest', 'hit-head', 'death-b', 'laytoidle', 'dizzy', 'victory', 'fighting-right-jab', 'fighting-left-jab', 'melee-hook',
  'kick-front', 'kick-roundhouse', 'jump-attack', 'spear-throw', 'power-up', 'two-hand-blast', 'two-handed-overhead-slam',
  'attack-ground-pound',
];
/** Clips made for the opposite stance: flipped left to right, so the feet do not have to swap. */
const MIRRORED = ['melee-hook'];

/** Source bone -> the bone of ours that follows it. Parents before children; the hips first. */
const BONES = [
  ['pelvis', 'Hip'], ['spine_01', 'Waist'], ['spine_02', 'Spine01'], ['spine_03', 'Spine02'], ['neck_01', 'NeckTwist01'], ['head', 'Head'],
  ...['l', 'r'].flatMap((s) => {
    const S = s.toUpperCase();
    return [
      [`clavicle_${s}`, `${S}_Clavicle`], [`upperarm_${s}`, `${S}_Upperarm`], [`lowerarm_${s}`, `${S}_Forearm`], [`hand_${s}`, `${S}_Hand`],
      [`thigh_${s}`, `${S}_Thigh`], [`calf_${s}`, `${S}_Calf`], [`foot_${s}`, `${S}_Foot`], [`ball_${s}`, `${S}_ToeBase`],
    ];
  }),
];
const otherSide = (name) => name.replace(/^([LR])_/, (m, side) => (side === 'L' ? 'R_' : 'L_'));
/** The bones that hold the guard: taken from the fighting stance while the legs walk. */
const GUARD_BONES = ['Spine01', 'Spine02', 'NeckTwist01', 'Head', ...['L', 'R'].flatMap((S) => [`${S}_Clavicle`, `${S}_Upperarm`, `${S}_Forearm`, `${S}_Hand`])];
const GAITS = ['jog', 'walk-backwards', 'strafe-left', 'strafe-right'];

/** Everything createHero() needs, fetched in parallel. */
export async function loadHero(base) {
  const [model, head, ...moves] = await Promise.all([
    loadModel(`${base}models/titan-body.glb`),
    loadModel(`${base}models/titan-head.glb`),
    ...CLIPS.map((name) => loadModel(`${base}moves/${name}.glb`)),
  ]);
  return { model, head, moves: moves.map((m, i) => ({ name: CLIPS[i], scene: m.scene, clip: m.animations[0] })) };
}

/** Ground one stride of the forward gait covers (measured with tools/lab.js). */
const STRIDE = 8.4;

const HERO_BODY = {
  file: 'titan-body.glb',
  points: { handL: 'CC_Base_L_Mid1', handR: 'CC_Base_R_Mid1', footL: 'CC_Base_L_ToeBase', footR: 'CC_Base_R_ToeBase', core: 'CC_Base_Spine02' },
  react: { flinch: 0, recoil: 0.3, guard: 0, sway: 0.02 },
  states: {
    idle: { clip: 'fighting-idle', loop: true },
    // advancing is a jog; backing off and circling are short steps, whose clips cover so
    // little ground that playing them foot-for-foot would blur the legs: `rate` lets them slide a little
    walk: { clip: 'jog+guard', stride: 1 },
    walkBack: { clip: 'walk-backwards+guard', stride: 1, rate: 2.5 },
    strafeL: { clip: 'strafe-left+guard', stride: 1, rate: 1.9 },
    strafeR: { clip: 'strafe-right+guard', stride: 1, rate: 1.9 },
    dash: { clip: 'shield-dash-rm', from: 0.05, speed: 1.6 },
    dashBack: { clip: 'dodge-back', speed: 2 },
    dashL: { clip: 'dodge-left', speed: 2 },
    dashR: { clip: 'dodge-right', speed: 2 },
    guard: { clip: 'defend', loop: true },
    hit: { clip: 'hit-chest' },
    hitHeavy: { clip: 'hit-head' },
    down: { clip: 'death-b', speed: 1.8 },
    getup: { clip: 'laytoidle', speed: 2.2 },
    dizzy: { clip: 'dizzy', loop: true },
    ko: { clip: 'death-b', speed: 1.2 },
    win: { clip: 'victory', loop: true, speed: 0.85 },
  },
};

/**
 * Build the hero around a rigged base body (see tools/extract-body.mjs).
 * @param assets what loadHero() resolved to
 */
export function createHero({ model, head, moves }) {
  const scene = model.scene;
  const M = heroMaterials();
  const bone = (name) => findNode(scene, 'CC_Base_' + name);
  let mesh = null;
  scene.traverse((o) => {
    if (o.isSkinnedMesh) mesh ??= o;
  });
  scene.updateMatrixWorld(true);
  const unit = bone('Head').getWorldPosition(new THREE.Vector3()).y / SKULL_BASE_Y; // model units per world unit
  mesh.material = suitMaterial(mesh.getWorldScale(new THREE.Vector3()).x / (BODY_HEIGHT * unit));
  mesh.castShadow = true;

  // motions first, while the skeleton still stands in its bind pose
  const clips = moves.map(({ name, scene: source, clip }) => {
    const links = BONES.map(([from, to]) => ({ from: findNode(source, from), to: bone(to), twin: bone(otherSide(to)) }));
    return retargetClip(source, clip, links, findNode(source, 'root'), { name, mirror: MIRRORED.includes(name) });
  });
  const stance = clips.find((c) => c.name === 'fighting-idle');
  const guard = GUARD_BONES.map((name) => bone(name).name);
  for (const gait of GAITS) clips.push(layerClips(`${gait}+guard`, clips.find((c) => c.name === gait), stance, guard));
  for (const n of ['L', 'R']) curlFingers(bone, n, [0.75, 1.15, 0.8, 0.4]);

  // Things worn on the body are built in world units around a bone's position, then handed
  // to that bone to carry.
  const mount = (name, build) => {
    const g = new THREE.Group();
    bone(name).getWorldPosition(g.position);
    g.scale.setScalar(unit);
    build(g);
    bone(name).attach(g);
  };
  const aura = new THREE.PointLight(0x9fefff, 3, 0, 2);
  aura.position.set(0, 0.8, 3.0);
  mount('Head', (g) => g.add(buildHead(head, M)));
  mount('Spine02', (g) => {
    buildCrest(g, M);
    g.add(aura);
  });

  /** Per-frame cosmetics: the eyes brighten with the energy gauge and flare while charging. */
  function visual(f, dt, time) {
    const e = f.energy / 100;
    const alive = f.state === 'ko' ? Math.max(0, 1 - f.t * 0.8) : 1;
    const pulse = e >= 1 ? 0.5 + 0.5 * Math.sin(time * 9) : 0;
    M.glow.emissiveIntensity = (1.6 + e * 0.6 + pulse * 0.6 + f.glow * 2.2) * alive + 0.04;
    aura.intensity = (3 + e * 5 + f.glow * 22) * alive;
  }

  return { rig: new ClipBody({ scene, animations: clips }, { ...HERO_BODY, fit: { scale: 1 / unit } }), visual };
}

/* ---------------------------------- moves ---------------------------------- */

/** What a thrown lance of light is. */
const LANCE = {
  from: 'handR', shape: 'lance', speed: 64, r: 0.9, life: 1.6, aim: 1, trail: 1.1, sfx: 'lance',
  hit: { dmg: 80, knock: 12, stun: 0.5, guardDmg: 22 },
};

/** One level of the beam: how long it burns, how many ticks land, how wide it is. */
function beamMove(cost, fire, ticks, width, dmg, finisher) {
  const hit = { dmg, knock: 3, stun: 0.3, guardDmg: 6, stunDmg: 2, pierce: true, beam: true };
  const start = 0.14;
  return {
    cost, dur: start + fire + 0.38, track: start + fire, trackRate: 0.12, armor: 2,
    anim: { clip: 'two-hand-blast', loop: true },
    beam: { from: ['handL', 'handR'], start, dur: fire, ticks, width, hit, finish: finisher ? { ...hit, knock: 22, kd: true } : hit },
    events: [
      { t: 0.08, type: 'glow', v: 1 },
      { t: start + fire, type: 'glow', v: 0 },
    ],
  };
}

// Timings below are in game seconds; a move's `anim` says which stretch of which clip plays
// and how fast, and the hit windows were read off the clips with tools/lab.js.
const moves = {
  // lead hand
  jab: {
    dur: 0.3, track: 0.1,
    anim: { clip: 'fighting-right-jab', from: 0.08, speed: 2.2 },
    lunge: [[0.02, 0.12, 7]],
    hits: [{ t0: 0.05, t1: 0.16, point: 'handR', r: 1.0, dmg: 26, knock: 4, stun: 0.36 }],
    cancel: [0.12, 0.3],
    next: { light: 'cross', heavy: 'kick', lance: 'lance', beam: 'beam' },
  },
  // rear hand
  cross: {
    dur: 0.44, track: 0.12,
    anim: { clip: 'fighting-left-jab', from: 0.12, speed: 1.9 },
    lunge: [[0.04, 0.16, 9]],
    hits: [{ t0: 0.1, t1: 0.22, point: 'handL', r: 1.0, dmg: 36, knock: 6, stun: 0.44 }],
    cancel: [0.18, 0.44],
    next: { light: 'hook', heavy: 'highKick', lance: 'lance', beam: 'beam' },
  },
  // a lunging overhand that ends the three-punch string
  hook: {
    dur: 0.7, track: 0.14,
    anim: { clip: 'melee-hook', speed: 0.85 },
    lunge: [[0.08, 0.26, 6]],
    hits: [{ t0: 0.22, t1: 0.38, point: 'handL', r: 1.4, dmg: 62, knock: 17, kd: true }],
  },
  // front kick with the rear leg
  kick: {
    dur: 0.64, track: 0.16,
    anim: { clip: 'kick-front', from: 0.12, speed: 1.5 },
    lunge: [[0.08, 0.22, 6]],
    hits: [{ t0: 0.12, t1: 0.27, point: 'footL', r: 1.2, dmg: 68, knock: 15, stun: 0.52 }],
    cancel: [0.3, 0.56],
    next: { lance: 'lance', beam: 'beam' },
  },
  highKick: {
    dur: 0.76, track: 0.16,
    anim: { clip: 'kick-roundhouse', from: 0.12, speed: 1.5 },
    lunge: [[0.06, 0.2, 6]],
    hits: [{ t0: 0.11, t1: 0.29, point: 'footL', r: 1.4, dmg: 80, knock: 20, kd: true }],
  },
  // out of a forward dash: leap and come down fist first
  diveSmash: {
    dur: 0.85, track: 0.1, armor: 1,
    anim: { clip: 'jump-attack', from: 0.45, speed: 1.6 },
    lunge: [[0.04, 0.5, 24]],
    hits: [{ t0: 0.4, t1: 0.57, point: 'handR', r: 1.7, dmg: 88, knock: 22, kd: true }],
    events: [{ t: 0.5, type: 'impact', point: 'handR', size: 0.7 }],
  },
  lance: {
    dur: 0.72, track: 0.3, cost: 25,
    anim: { clip: 'spear-throw', from: 0.15, speed: 1.4 },
    events: [
      { t: 0, type: 'glow', v: 0.6 },
      { t: 0.32, type: 'projectile', spec: LANCE },
      { t: 0.36, type: 'glow', v: 0 },
    ],
  },
  // Hold to charge, let go to fire. Each level needs more time and more energy.
  beam: {
    dur: 1.5, minEnergy: 35, armor: 1, track: 1.5, trackRate: 0.5,
    anim: { clip: 'power-up', loop: true, blend: 9 },
    hold: {
      max: 1.35,
      levels: [
        { t: 0.14, cost: 35, next: 'beam1' },
        { t: 0.6, cost: 65, next: 'beam2' },
        { t: 1.1, cost: 100, next: 'beam3' },
      ],
    },
    events: [{ t: 0, type: 'beamCharge' }],
  },
  beam1: beamMove(35, 0.5, 5, 0.7, 26, false),
  beam2: beamMove(65, 0.85, 8, 1.0, 28, false),
  beam3: beamMove(100, 1.25, 12, 1.35, 30, true),
  // Beats a guard, loses to any attack: the grab only catches someone standing or blocking.
  throw: {
    dur: 0.56, track: 0.16,
    anim: { clip: 'two-hand-blast', loop: true, blend: 14 }, // both hands thrust out
    lunge: [[0.04, 0.2, 12]],
    hits: [{ t0: 0.11, t1: 0.26, point: 'handR', r: 1.5, grab: true, dmg: 0, knock: 0 }],
    onGrab: 'slam',
  },
  // heaves the monster overhead and brings it down
  slam: {
    dur: 1.15, track: 0, armor: 2, throws: true,
    anim: { clip: 'two-handed-overhead-slam', speed: 1.25 },
    events: [{ t: 0.6, type: 'throwRelease', hit: { dmg: 95, knock: 26, stunDmg: 30 } }],
  },
  // Pursuit: drive a fist down into a monster that is flat on the ground.
  pound: {
    dur: 0.7, track: 0.2,
    anim: { clip: 'attack-ground-pound', from: 0.1, to: 1.0, speed: 1.6 },
    lunge: [[0.04, 0.2, 9]],
    hits: [{ t0: 0.3, t1: 0.46, point: 'handR', r: 1.9, dmg: 42, knock: 0, stun: 0.4, otg: true, heavy: true }],
    events: [{ t: 0.4, type: 'impact', point: 'handR', size: 0.5 }],
  },
};

export const HERO_DEF = {
  name: '银曜',
  title: '光之巨人',
  spark: [1.3, 3.4, 4.6],
  maxHp: 1000,
  speed: 8.6,
  stride: TAU / STRIDE,
  radius: 1.2,
  hurt: { r: 1.25, h: 10.6 },
  chestY: 7.6,
  turn: 9,
  dashSpeed: 30,
  dashTime: 0.26,
  dashAttack: 'diveSmash',
  downTime: 1.1,
  getupTime: 0.7,
  inputs: { light: 'jab', heavy: 'kick', lance: 'lance', beam: 'beam', throw: 'throw' },
  /** Context-sensitive moves: a kick aimed at a floored opponent becomes a pursuit blow. */
  resolve(f, kind) {
    const o = f.opponent;
    if (kind === 'heavy' && o && o.state === 'down' && Math.hypot(o.pos.x - f.pos.x, o.pos.z - f.pos.z) < 7.5) return 'pound';
    return null;
  },
  moves,
};
