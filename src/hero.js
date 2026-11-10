import * as THREE from 'three';
import { Rig } from './rig.js';
import { kf, add } from './poses.js';
import { SkinDriver, findBone } from './skin.js';

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

/* ------------------------------------ helmet ------------------------------------ */

// Silhouette of the helmet as [radius, height above the skull base]: a smooth cranium
// that narrows through the cheeks to the chin.
const HELM_PROFILE = [
  [0.0, 1.42], [0.11, 1.41], [0.23, 1.365], [0.34, 1.28], [0.43, 1.15], [0.495, 0.98], [0.525, 0.8],
  [0.52, 0.62], [0.485, 0.45], [0.43, 0.3], [0.36, 0.17], [0.29, 0.07], [0.25, -0.02],
];
const HELM_WIDTH = 0.93; // slightly narrower than it is deep
const HELM_DEPTH = 1.1;

function helmRadius(y) {
  const P = HELM_PROFILE;
  for (let i = 1; i < P.length; i++) {
    if (y >= P[i][1]) {
      const k = (y - P[i][1]) / (P[i - 1][1] - P[i][1]);
      return P[i][0] + (P[i - 1][0] - P[i][0]) * k;
    }
  }
  return P[P.length - 1][0];
}

/** A point on the helmet surface: `phi` is the angle round the head from straight ahead. */
function onHelm(phi, y, lift = 1) {
  const r = helmRadius(y) * lift;
  return [Math.sin(phi) * r * HELM_WIDTH, y, Math.cos(phi) * r * HELM_DEPTH];
}

/**
 * A ribbon lying on the helmet surface between two angles. `centre(k)` and `half(k)` give
 * its mid-height and half-height along the way, k = 0..1.
 */
function helmRibbon(phi0, phi1, centre, half, lift, steps = 40) {
  const pos = [];
  const idx = [];
  const rows = 4;
  for (let i = 0; i <= steps; i++) {
    const k = i / steps;
    const phi = phi0 + (phi1 - phi0) * k;
    for (let j = 0; j <= rows; j++) pos.push(...onHelm(phi, centre(k) + half(k) * ((j / rows) * 2 - 1), lift));
  }
  const flip = phi1 < phi0;
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < rows; j++) {
      const a = i * (rows + 1) + j;
      const b = a + rows + 1;
      if (flip) idx.push(a, b + 1, b, a, a + 1, b + 1);
      else idx.push(a, b, b + 1, a, b + 1, a + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** The giant's head: a smooth helm with one swept visor of light. Origin = base of the skull. */
function buildHelmet(head, M) {
  const helm = new THREE.Group();
  helm.position.z = 0.06;
  head.add(helm);

  const shell = part(helm, new THREE.LatheGeometry(HELM_PROFILE.map(([r, y]) => new THREE.Vector2(r, y)).reverse(), 56), M.silver);
  shell.scale.set(HELM_WIDTH, 1, HELM_DEPTH);

  // visor: a single band of light, tapering and sweeping up toward the temples
  const span = 1.22;
  const sweep = (k) => 0.8 + 0.2 * (2 * k - 1) ** 2;
  const taper = (h) => (k) => h * Math.sqrt(Math.max(0.02, 1 - (2 * k - 1) ** 4));
  part(helm, helmRibbon(-span - 0.07, span + 0.07, sweep, taper(0.105), 1.008), M.dark);
  part(helm, helmRibbon(-span, span, sweep, taper(0.062), 1.016), M.glow);

  // a low ridge from brow to nape, and a red flash sweeping back along each side
  const ridge = [];
  for (let i = 0; i <= 28; i++) {
    const a = -1.08 + (i / 28) * 3.0; // angle over the top: brow (-) to nape (+)
    const y = 0.72 + Math.cos(a) * 0.71;
    ridge.push(new THREE.Vector3(0, y, -Math.sin(a) * helmRadius(y) * HELM_DEPTH * 1.004));
  }
  part(helm, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(ridge), 48, 0.028, 8), M.silver);
  for (const s of [-1, 1]) {
    const flash = helmRibbon(s * 1.42, s * 2.72, (k) => 1.0 - 0.3 * k, (k) => 0.085 * (1 - k) + 0.012, 1.01, 24);
    part(helm, flash, M.red);
    const ear = part(helm, new THREE.CylinderGeometry(0.105, 0.125, 0.05, 28), M.dark, s * 0.5, 0.62, -0.02);
    ear.rotation.z = Math.PI / 2;
  }
  // breather: a short dark line where a mouth would be
  part(helm, helmRibbon(-0.3, 0.3, () => 0.36, taper(0.022), 1.01, 16), M.dark);

  const gem = part(helm, new THREE.OctahedronGeometry(0.055, 0), M.glow, ...onHelm(0, 1.06, 1.02));
  gem.scale.set(0.8, 1.6, 0.5);
  gem.rotation.x = -0.5;

  // collar over the neck stump of the base mesh
  part(head, new THREE.CylinderGeometry(0.33, 0.43, 0.42, 36), M.dark, 0, -0.06, -0.02);
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

/**
 * Build the hero around a rigged base body (see tools/extract-body.mjs).
 * The proxy Rig's joints are placed on the model's own bones, so gameplay points
 * (fists, feet, ground contacts) line up with what is drawn.
 */
export function createHero({ scene, mesh }) {
  const rig = new Rig();
  const M = heroMaterials();

  const holder = new THREE.Group();
  holder.add(scene);
  rig.root.add(holder);
  const bone = (name) => findBone(scene, 'CC_Base_' + name);
  const at = (name) => bone(name).getWorldPosition(new THREE.Vector3());

  rig.root.updateMatrixWorld(true);
  holder.scale.setScalar(SKULL_BASE_Y / at('Head').y);
  rig.root.updateMatrixWorld(true);

  mesh.material = suitMaterial(mesh.getWorldScale(new THREE.Vector3()).x / BODY_HEIGHT);
  mesh.castShadow = true;
  mesh.frustumCulled = false; // its bounds are those of the bind pose

  const rel = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z];
  const P = { hip: at('Hip'), waist: at('Waist'), chest: at('Spine02'), head: at('Head') };
  const hips = rig.joint('hips', rig.body, P.hip.x, P.hip.y, P.hip.z);
  const torso = rig.joint('torso', hips, ...rel(P.waist, P.hip));
  const chest = rig.joint('chest', torso, ...rel(P.chest, P.waist));
  const head = rig.joint('head', chest, ...rel(P.head, P.chest));
  const links = [
    { joint: hips, bone: bone('Hip') },
    { joint: torso, bone: bone('Waist') },
    { joint: torso, toward: chest, mix: 0.5, bone: bone('Spine01') }, // spread the bend along the spine
    { joint: chest, bone: bone('Spine02') },
    { joint: chest, toward: head, mix: 0.45, bone: bone('NeckTwist01') },
    { joint: head, bone: bone('Head') },
  ];

  for (const n of ['L', 'R']) {
    const upper = at(`${n}_Upperarm`);
    const fore = at(`${n}_Forearm`);
    const wrist = at(`${n}_Hand`);
    const knuckle = at(`${n}_Mid1`);
    const sh = rig.joint('sh' + n, chest, ...rel(upper, P.chest));
    const el = rig.joint('el' + n, sh, 0, -upper.distanceTo(fore), 0);
    rig.point('hand' + n, el, 0, -(fore.distanceTo(wrist) + wrist.distanceTo(knuckle)), 0, 0.36);
    links.push(
      { shoulder: sh, chest, bone: bone(`${n}_Clavicle`) }, // the collarbone follows a raised arm
      { joint: sh, bone: bone(`${n}_Upperarm`), child: bone(`${n}_Forearm`) },
      { joint: el, bone: bone(`${n}_Forearm`), child: bone(`${n}_Hand`) },
    );

    const thigh = at(`${n}_Thigh`);
    const calf = at(`${n}_Calf`);
    const ankle = at(`${n}_Foot`);
    const toe = at(`${n}_ToeBase`);
    const th = rig.joint('th' + n, hips, ...rel(thigh, P.hip));
    const kn = rig.joint('kn' + n, th, 0, -thigh.distanceTo(calf), 0);
    const an = rig.joint('an' + n, kn, 0, -calf.distanceTo(ankle), 0);
    const sole = -ankle.y; // the bind pose stands on y = 0
    const reach = toe.z - ankle.z;
    rig.point('toe' + n, an, 0, sole, reach + 0.5, 0);
    rig.point('heel' + n, an, 0, sole, -0.32, 0);
    rig.point('foot' + n, an, 0, sole * 0.5, reach * 0.8);
    links.push(
      { joint: th, bone: bone(`${n}_Thigh`), child: bone(`${n}_Calf`) },
      { joint: kn, bone: bone(`${n}_Calf`), child: bone(`${n}_Foot`) },
      { joint: an, bone: bone(`${n}_Foot`) },
    );
  }

  // extra contacts so the giant rests on its back when knocked down
  rig.point('cHips', hips, 0, 0, -0.1, 0.62);
  rig.point('cChest', chest, 0, 0.75, -0.1, 0.8);
  rig.point('cHead', head, 0, 0.7, 0, 0.64);
  rig.point('core', chest, 0, 0.55, 0);

  const driver = new SkinDriver(links, { joint: hips, bone: bone('Hip') });
  rig.onPosed = () => driver.sync();
  for (const n of ['L', 'R']) curlFingers(bone, n, [0.75, 1.15, 0.8, 0.4]);

  buildHelmet(head, M);
  buildCrest(chest, M);

  const aura = new THREE.PointLight(0x9fefff, 3, 0, 2);
  aura.position.set(0, 0.8, 3.0);
  chest.add(aura);

  /** Per-frame cosmetics: the visor brightens with the energy gauge and flares while charging. */
  function visual(f, dt, time) {
    const e = f.energy / 100;
    const alive = f.state === 'ko' ? Math.max(0, 1 - f.t * 0.8) : 1;
    const pulse = e >= 1 ? 0.5 + 0.5 * Math.sin(time * 9) : 0;
    M.glow.emissiveIntensity = (1.0 + e * 0.5 + pulse * 0.5 + f.glow * 2.2) * alive + 0.04;
    aura.intensity = (3 + e * 5 + f.glow * 22) * alive;
  }

  rig.apply({}, 1);
  return { rig, visual };
}

/* ---------------------------------- poses ---------------------------------- */

// Orthodox fighting stance: left side leads, guard up.
const S = {
  y: 0,
  body: [0, 0, 0],
  hips: [0, -0.45, 0],
  torso: [0.12, 0.1, 0],
  chest: [0.06, 0.1, 0],
  head: [-0.05, 0.25, 0],
  shL: [-0.95, 0, 0.2],
  elL: [-1.5, 0, 0],
  shR: [-0.45, 0, -0.25],
  elR: [-2.05, 0, 0],
  thL: [-0.32, 0, 0.12],
  knL: [0.52, 0, 0],
  anL: [-0.2, 0, 0],
  thR: [0.22, 0, -0.14],
  knR: [0.52, 0, 0],
  anR: [-0.55, 0, 0],
};
const H = (o) => ({ ...S, ...o });

const JAB = H({
  hips: [0, -0.75, 0], chest: [0.06, -0.15, 0], head: [-0.05, 0.8, 0],
  shL: [-1.55, 0, 0.85], elL: [-0.05, 0, 0],
  thL: [-0.5, 0, 0.1], knL: [0.7, 0, 0],
});
// the lead shoulder dips back and the weight sinks before the jab goes out
const JAB_LOAD = H({
  hips: [0, -0.32, 0], torso: [0.16, 0.16, 0], chest: [0.08, 0.2, 0], head: [-0.05, 0.02, 0],
  shL: [-0.55, 0, 0.3], elL: [-2.1, 0, 0],
  thL: [-0.5, 0, 0.1], knL: [0.78, 0, 0], knR: [0.72, 0, 0],
});
// hips wind away from the target with the rear hand cocked at the jaw
const CROSS_LOAD = H({
  hips: [0, -0.8, 0], torso: [0.14, -0.05, 0], chest: [0.06, -0.12, 0], head: [-0.05, 0.95, 0],
  shR: [-0.15, 0, -0.35], elR: [-2.35, 0, 0], shL: [-1.1, 0, 0.5], elL: [-1.2, 0, 0],
  thL: [-0.48, 0, 0.1], knL: [0.72, 0, 0], thR: [0.4, 0, -0.12], knR: [0.8, 0, 0],
});
const CROSS = H({
  hips: [0, 0.35, 0], torso: [0.2, 0.25, 0], chest: [0.1, 0.3, 0], head: [-0.05, -0.9, 0],
  shR: [-1.5, 0, -0.95], elR: [-0.05, 0, 0],
  shL: [-0.5, 0, 0.3], elL: [-2.0, 0, 0],
  thL: [-0.55, 0, 0.1], knL: [0.8, 0, 0], thR: [0.15, 0, -0.1], knR: [0.5, 0, 0],
});
const UPPER_WIND = H({
  hips: [0, -0.2, 0], torso: [0.45, 0, 0], head: [0.1, 0.2, 0],
  shL: [0.3, 0, 0.3], elL: [-1.3, 0, 0],
  thL: [-0.7, 0, 0.1], knL: [1.1, 0, 0], anL: [-0.4, 0, 0], thR: [0.1, 0, -0.1], knR: [1.0, 0, 0],
});
const UPPER = H({
  y: 0.45,
  hips: [0, -0.7, 0], torso: [-0.22, 0, 0], chest: [-0.12, -0.25, 0], head: [-0.2, 0.95, 0],
  shL: [-1.85, 0, 0.55], elL: [-1.6, 0, 0], shR: [0.35, 0, -0.45], elR: [-1.7, 0, 0],
  thL: [-0.2, 0, 0.1], knL: [0.2, 0, 0], anL: [0, 0, 0], thR: [0.2, 0, -0.1], knR: [0.3, 0, 0], anR: [-0.5, 0, 0],
});
const KICK_CHAMBER = H({
  hips: [0, 0.2, 0], torso: [-0.1, 0, 0], head: [0, -0.3, 0],
  thR: [-1.5, 0, -0.1], knR: [1.9, 0, 0], anR: [0, 0, 0],
  thL: [-0.1, 0, 0.1], knL: [0.3, 0, 0], anL: [-0.2, 0, 0],
  shL: [-0.6, 0, 0.5], shR: [-0.3, 0, -0.6],
});
const KICK = H({
  hips: [0, 0.3, 0], torso: [-0.35, 0, 0], chest: [-0.1, 0, 0], head: [0.25, -0.3, 0],
  thR: [-1.55, 0, -0.05], knR: [0.05, 0, 0], anR: [0.35, 0, 0],
  thL: [0.05, 0, 0.1], knL: [0.2, 0, 0], anL: [-0.25, 0, 0],
  shL: [-0.3, 0, 0.7], elL: [-1.0, 0, 0], shR: [0.3, 0, -0.6], elR: [-1.0, 0, 0],
});
const HIGH_CHAMBER = H({
  hips: [0, -0.3, 0], torso: [-0.15, 0, 0], head: [0.1, 0.3, 0],
  thL: [-1.7, 0, 0.1], knL: [2.0, 0, 0], anL: [0, 0, 0],
  thR: [0.05, 0, -0.1], knR: [0.3, 0, 0], anR: [-0.3, 0, 0],
});
const HIGH_KICK = H({
  y: 0.2,
  hips: [0, -0.3, 0], torso: [-0.5, 0, 0], chest: [-0.15, 0, 0], head: [0.5, 0.3, 0],
  thL: [-2.05, 0, 0.05], knL: [0.05, 0, 0], anL: [0.4, 0, 0],
  thR: [0.1, 0, -0.1], knR: [0.15, 0, 0], anR: [-0.25, 0, 0],
  shL: [0.4, 0, 0.7], elL: [-0.8, 0, 0], shR: [-0.4, 0, -0.8], elR: [-1.2, 0, 0],
});
const FLY = H({
  y: 2.1,
  body: [-0.35, 0, 0], hips: [0, 0, 0], torso: [-0.2, 0, 0], chest: [0, 0, 0], head: [0.45, 0, 0],
  thR: [-1.3, 0, 0], knR: [0, 0, 0], anR: [0.4, 0, 0],
  thL: [-1.5, 0, 0.2], knL: [2.2, 0, 0], anL: [0, 0, 0],
  shL: [-0.2, 0, 1.2], elL: [-0.4, 0, 0], shR: [-0.2, 0, -1.2], elR: [-0.4, 0, 0],
});
const LAND = H({
  torso: [0.4, 0, 0], hips: [0, -0.2, 0],
  thL: [-0.8, 0, 0.1], knL: [1.2, 0, 0], anL: [-0.4, 0, 0], thR: [-0.2, 0, -0.1], knR: [1.0, 0, 0], anR: [-0.8, 0, 0],
});
const GUARD = H({
  torso: [0.2, 0.1, 0], head: [0.15, 0.25, 0],
  shL: [-1.25, 0, -0.35], elL: [-1.9, 0, 0], shR: [-1.2, 0, 0.35], elR: [-1.95, 0, 0],
  thL: [-0.5, 0, 0.1], knL: [0.8, 0, 0], anL: [-0.3, 0, 0], thR: [0.35, 0, -0.12], knR: [0.8, 0, 0],
});
const DASH = H({
  y: 0.25,
  torso: [0.45, 0.1, 0],
  thL: [-0.9, 0, 0.1], knL: [1.2, 0, 0], anL: [-0.3, 0, 0], thR: [0.7, 0, -0.1], knR: [0.5, 0, 0],
  shL: [-0.3, 0, 0.4], elL: [-1.6, 0, 0], shR: [0.5, 0, -0.4], elR: [-1.4, 0, 0],
});
const HIT = H({
  torso: [-0.3, 0.1, 0], chest: [-0.15, 0.1, 0], head: [-0.35, 0.2, 0],
  shL: [-0.3, 0, 0.7], elL: [-0.9, 0, 0], shR: [0.1, 0, -0.7], elR: [-0.9, 0, 0],
  thL: [-0.2, 0, 0.1], knL: [0.4, 0, 0], thR: [0.5, 0, -0.1], knR: [0.5, 0, 0],
});
const HIT_HEAVY = H({
  body: [-0.14, 0, 0], torso: [-0.5, 0.2, 0], chest: [-0.25, 0.1, 0], head: [-0.4, 0.1, 0],
  shL: [-0.5, 0, 1.0], elL: [-0.7, 0, 0], shR: [0.2, 0, -1.0], elR: [-0.7, 0, 0],
  thL: [-0.5, 0, 0.15], knL: [0.5, 0, 0], thR: [0.6, 0, -0.15], knR: [0.7, 0, 0],
});
const FALLING = H({
  y: 1.0,
  body: [-0.9, 0, 0], hips: [0, 0, 0], torso: [0.2, 0, 0], chest: [0.1, 0, 0], head: [0.4, 0, 0],
  shL: [-0.8, 0, 1.0], elL: [-0.5, 0, 0], shR: [-0.8, 0, -1.0], elR: [-0.5, 0, 0],
  thL: [-0.9, 0, 0.2], knL: [0.8, 0, 0], anL: [0, 0, 0], thR: [-0.5, 0, -0.2], knR: [1.0, 0, 0], anR: [0, 0, 0],
});
const LYING = H({
  body: [-1.52, 0, 0], hips: [0, 0, 0], torso: [0, 0, 0], chest: [0, 0, 0], head: [0.15, 0.3, 0],
  shL: [0, 0, 1.2], elL: [-0.3, 0, 0], shR: [0, 0, -1.35], elR: [-0.5, 0, 0],
  thL: [-0.1, 0, 0.2], knL: [0.1, 0, 0], anL: [0.3, 0, 0], thR: [-0.5, 0, -0.25], knR: [0.9, 0, 0], anR: [0.2, 0, 0],
});
const KNEEL = H({
  body: [-0.2, 0, 0], hips: [0, -0.2, 0], torso: [0.6, 0, 0], chest: [0.2, 0, 0], head: [0.1, 0.2, 0],
  shL: [-0.4, 0, 0.3], elL: [-0.6, 0, 0], shR: [-0.2, 0, -0.3], elR: [-0.6, 0, 0],
  thL: [-1.5, 0, 0.1], knL: [1.7, 0, 0], anL: [-0.2, 0, 0], thR: [-0.1, 0, -0.1], knR: [1.7, 0, 0], anR: [0.4, 0, 0],
});
const LANCE_WIND = H({
  hips: [0, -0.9, 0], chest: [0.06, -0.2, 0], head: [-0.05, 1.0, 0],
  shR: [-3.3, 0, -0.3], elR: [-1.3, 0, 0], shL: [-1.4, 0, 1.0], elL: [-0.15, 0, 0],
});
const LANCE_THROW = H({
  hips: [0, 0.4, 0], torso: [0.35, 0.2, 0], chest: [0.1, 0.3, 0], head: [-0.1, -0.9, 0],
  shR: [-1.3, 0, -0.9], elR: [-0.1, 0, 0], shL: [0.2, 0, 0.4], elL: [-1.2, 0, 0],
  thL: [-0.6, 0, 0.1], knL: [0.9, 0, 0],
});
const BEAM_GATHER = H({
  hips: [0, 0, 0], torso: [0.05, 0, 0], chest: [-0.15, 0, 0], head: [0.05, 0, 0],
  shL: [0.25, 0, 1.45], elL: [-0.3, 0, 0], shR: [0.25, 0, -1.45], elR: [-0.3, 0, 0],
  thL: [-0.15, 0, 0.35], knL: [0.4, 0, 0], anL: [-0.2, 0, -0.3], thR: [-0.15, 0, -0.35], knR: [0.4, 0, 0], anR: [-0.2, 0, 0.3],
});
const BEAM_CHARGE = H({
  hips: [0, 0, 0], torso: [0.12, 0, 0], chest: [-0.2, 0, 0], head: [0.05, 0, 0],
  shL: [0.35, 0, 0.5], elL: [-2.0, 0, 0], shR: [0.35, 0, -0.5], elR: [-2.0, 0, 0],
  thL: [-0.62, 0, 0.42], knL: [1.15, 0, 0], anL: [-0.5, 0, -0.38], thR: [-0.62, 0, -0.42], knR: [1.15, 0, 0], anR: [-0.5, 0, 0.38],
});
const BEAM_FIRE = H({
  hips: [0, 0, 0], torso: [0.25, 0, 0], chest: [0.05, 0, 0], head: [-0.2, 0, 0],
  shL: [-1.72, 0, -0.32], elL: [-0.1, 0, 0], shR: [-1.72, 0, 0.32], elR: [-0.1, 0, 0],
  thL: [-0.55, 0, 0.3], knL: [0.85, 0, 0], anL: [-0.3, 0, -0.3], thR: [0.3, 0, -0.3], knR: [0.7, 0, 0], anR: [-0.7, 0, 0.3],
});
const VICTORY = H({
  hips: [0, 0, 0], torso: [-0.08, 0, 0], chest: [-0.14, 0, 0], head: [-0.28, 0, 0],
  shR: [-2.95, 0, -0.16], elR: [-0.12, 0, 0], shL: [0.3, 0, 0.42], elL: [-1.55, 0, 0],
  thL: [0, 0, 0.13], knL: [0, 0, 0], anL: [0, 0, -0.13], thR: [0, 0, -0.13], knR: [0, 0, 0], anR: [0, 0, 0.13],
});

const REEL = H({
  hips: [0, -0.15, 0], torso: [0.38, 0, 0], chest: [0.2, 0, 0], head: [0.55, 0, 0],
  shL: [0.12, 0, 0.16], elL: [-0.35, 0, 0], shR: [0.2, 0, -0.2], elR: [-0.3, 0, 0],
  thL: [-0.25, 0, 0.2], knL: [0.6, 0, 0], anL: [-0.3, 0, -0.1], thR: [0.05, 0, -0.22], knR: [0.5, 0, 0], anR: [-0.5, 0, 0.1],
});
const GRAB = H({
  hips: [0, -0.1, 0], torso: [0.35, 0, 0], chest: [0.1, 0, 0], head: [-0.3, 0.1, 0],
  shL: [-1.35, 0, 0.25], elL: [-0.35, 0, 0], shR: [-1.35, 0, -0.25], elR: [-0.35, 0, 0],
  thL: [-0.7, 0, 0.1], knL: [0.9, 0, 0], anL: [-0.25, 0, 0], thR: [0.35, 0, -0.1], knR: [0.6, 0, 0],
});
const HOIST = H({
  hips: [0, 0, 0], torso: [-0.25, 0, 0], chest: [-0.2, 0, 0], head: [-0.2, 0, 0],
  shL: [-2.6, 0, 0.25], elL: [-0.5, 0, 0], shR: [-2.6, 0, -0.25], elR: [-0.5, 0, 0],
  thL: [-0.3, 0, 0.25], knL: [0.6, 0, 0], anL: [-0.3, 0, -0.25], thR: [-0.3, 0, -0.25], knR: [0.6, 0, 0], anR: [-0.3, 0, 0.25],
});
const SLAM = H({
  hips: [0, 0, 0], torso: [0.7, 0, 0], chest: [0.3, 0, 0], head: [-0.6, 0, 0],
  shL: [-0.9, 0, 0.3], elL: [-0.3, 0, 0], shR: [-0.9, 0, -0.3], elR: [-0.3, 0, 0],
  thL: [-0.9, 0, 0.2], knL: [1.2, 0, 0], anL: [-0.3, 0, 0], thR: [0.4, 0, -0.2], knR: [0.9, 0, 0],
});
const STOMP_UP = H({
  hips: [0, 0.2, 0], torso: [-0.1, 0, 0],
  thR: [-1.7, 0, -0.1], knR: [1.7, 0, 0], anR: [0.2, 0, 0], thL: [-0.05, 0, 0.1], knL: [0.25, 0, 0], anL: [-0.2, 0, 0],
  shL: [-0.8, 0, 0.5], shR: [-0.2, 0, -0.7],
});
const STOMP_DOWN = H({
  hips: [0, 0.2, 0], torso: [0.45, 0, 0], chest: [0.15, 0, 0], head: [-0.3, -0.2, 0],
  thR: [-0.75, 0, -0.1], knR: [0.35, 0, 0], anR: [0.3, 0, 0], thL: [0.15, 0, 0.1], knL: [0.75, 0, 0], anL: [-0.6, 0, 0],
  shL: [-0.2, 0, 0.6], elL: [-1.2, 0, 0], shR: [0.3, 0, -0.5], elR: [-1.0, 0, 0],
});

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
    cost, dur: start + fire + 0.38, track: start + fire, trackRate: 0.12, armor: 2, rate: 18,
    clip: kf([[0, BEAM_CHARGE], [0.12, BEAM_FIRE], [start + fire, BEAM_FIRE], [start + fire + 0.38, S]]),
    beam: { from: ['handL', 'handR'], start, dur: fire, ticks, width, hit, finish: finisher ? { ...hit, knock: 22, kd: true } : hit },
    events: [
      { t: 0.08, type: 'glow', v: 1 },
      { t: start + fire, type: 'glow', v: 0 },
    ],
  };
}

/** Ready stance in motion: a slow bounce on the knees with the guard riding on it. */
const breathe = (t) => {
  const b = Math.sin(t * 2.6);
  const w = Math.sin(t * 1.3);
  return {
    hips: [0, w * 0.035, w * 0.015], torso: [b * 0.012, -w * 0.035, 0], chest: [Math.sin(t * 1.9) * 0.03, 0, 0], head: [0, w * 0.02, 0],
    shL: [w * 0.05, 0, 0], elL: [b * 0.05, 0, 0], shR: [-w * 0.04, 0, 0], elR: [-b * 0.03, 0, 0],
    // the bounce comes from the knees: grounding turns the flex into a dip of the whole body
    thL: [-b * 0.04, 0, 0], knL: [b * 0.09 + 0.05, 0, 0], thR: [-b * 0.02, 0, 0], knR: [b * 0.07 + 0.05, 0, 0],
  };
};

const clips = {
  idle: (t) => add(S, breathe(t)),
  // Guard stays up; the legs step in whatever direction the fighter is travelling.
  walk: (t, f) => {
    const s = Math.sin(f.walkPhase);
    const c = Math.cos(f.walkPhase);
    const fw = f.stepFwd;
    const sd = f.stepSide;
    return add(S, {
      hips: [0, s * 0.05 * fw, sd * 0.05], torso: [0.07 * fw, -s * 0.07 * fw, -sd * 0.05],
      thL: [-s * 0.4 * fw, 0, s * 0.2 * sd], knL: [Math.max(0, c) * 0.55, 0, 0],
      thR: [s * 0.4 * fw, 0, s * 0.2 * sd], knR: [Math.max(0, -c) * 0.55, 0, 0],
      shL: [s * 0.07, 0, 0], shR: [-s * 0.07, 0, 0],
    });
  },
  dash: () => DASH,
  guard: () => GUARD,
  hit: () => HIT,
  hitHeavy: () => HIT_HEAVY,
  down: kf([[0, HIT_HEAVY], [0.26, FALLING], [0.55, LYING]]),
  getup: kf([[0, LYING], [0.28, KNEEL], [0.55, S]]),
  dizzy: (t) => {
    const a = Math.sin(t * 3.1);
    const b = Math.sin(t * 4.3 + 1);
    return add(REEL, {
      hips: [0, a * 0.12, a * 0.06], torso: [b * 0.1, 0, a * 0.12], chest: [0, 0, a * 0.08], head: [b * 0.12, a * 0.35, 0],
      shL: [a * 0.12, 0, 0], shR: [-a * 0.12, 0, 0], thL: [0, 0, a * 0.05], thR: [0, 0, a * 0.05],
    });
  },
  win: (t) => add(VICTORY, { y: Math.sin(t * 1.6) * 0.03, chest: [Math.sin(t * 1.6) * 0.02, 0, 0] }),
};

const moves = {
  jab: {
    dur: 0.3, track: 0.1, rate: 34,
    clip: kf([[0, S], [0.04, JAB_LOAD], [0.09, JAB, 'in'], [0.17, JAB], [0.3, S, 'out']]),
    lunge: [[0.02, 0.12, 7]],
    hits: [{ t0: 0.06, t1: 0.17, point: 'handL', r: 1.0, dmg: 26, knock: 4, stun: 0.36 }],
    cancel: [0.12, 0.3],
    next: { light: 'cross', heavy: 'kick', lance: 'lance', beam: 'beam' },
  },
  cross: {
    dur: 0.44, track: 0.12, rate: 34,
    clip: kf([[0, S], [0.06, CROSS_LOAD], [0.13, CROSS, 'in'], [0.24, CROSS], [0.44, S, 'out']]),
    lunge: [[0.04, 0.16, 9]],
    hits: [{ t0: 0.1, t1: 0.24, point: 'handR', r: 1.0, dmg: 36, knock: 6, stun: 0.44 }],
    cancel: [0.18, 0.44],
    next: { light: 'upper', heavy: 'highKick', lance: 'lance', beam: 'beam' },
  },
  upper: {
    dur: 0.68, track: 0.14, rate: 28,
    clip: kf([[0, S], [0.12, UPPER_WIND], [0.22, UPPER, 'in'], [0.36, UPPER], [0.68, S, 'out']]),
    lunge: [[0.08, 0.24, 9]],
    hits: [{ t0: 0.16, t1: 0.32, point: 'handL', r: 1.3, dmg: 62, knock: 17, kd: true }],
  },
  kick: {
    dur: 0.64, track: 0.16, rate: 26,
    clip: kf([[0, S], [0.14, KICK_CHAMBER], [0.24, KICK, 'in'], [0.36, KICK], [0.5, KICK_CHAMBER, 'out'], [0.64, S]]),
    lunge: [[0.1, 0.26, 8]],
    hits: [{ t0: 0.19, t1: 0.36, point: 'footR', r: 1.2, dmg: 68, knock: 15, stun: 0.52 }],
    cancel: [0.3, 0.56],
    next: { lance: 'lance', beam: 'beam' },
  },
  highKick: {
    dur: 0.76, track: 0.16, rate: 26,
    clip: kf([[0, S], [0.14, HIGH_CHAMBER], [0.25, HIGH_KICK, 'in'], [0.4, HIGH_KICK], [0.58, HIGH_CHAMBER, 'out'], [0.76, S]]),
    lunge: [[0.1, 0.26, 8]],
    hits: [{ t0: 0.2, t1: 0.4, point: 'footL', r: 1.4, dmg: 80, knock: 20, kd: true }],
  },
  flyingKick: {
    dur: 0.8, track: 0.1, armor: 1, rate: 24,
    clip: kf([[0, DASH], [0.14, FLY], [0.5, { ...FLY, y: 1.5 }], [0.64, LAND], [0.8, S]]),
    lunge: [[0.04, 0.5, 24]],
    hits: [{ t0: 0.14, t1: 0.52, point: 'footR', r: 1.5, dmg: 88, knock: 22, kd: true }],
  },
  lance: {
    dur: 0.72, track: 0.3, cost: 25, rate: 26,
    clip: kf([[0, S], [0.2, LANCE_WIND], [0.32, LANCE_THROW], [0.46, LANCE_THROW], [0.72, S]]),
    events: [
      { t: 0, type: 'glow', v: 0.6 },
      { t: 0.3, type: 'projectile', spec: LANCE },
      { t: 0.34, type: 'glow', v: 0 },
    ],
  },
  // Hold to charge, let go to fire. Each level needs more time and more energy.
  beam: {
    dur: 1.5, minEnergy: 35, armor: 1, track: 1.5, trackRate: 0.5, rate: 14,
    clip: kf([[0, S], [0.25, BEAM_GATHER], [0.7, BEAM_CHARGE], [1.5, BEAM_CHARGE]]),
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
    dur: 0.56, track: 0.16, rate: 26,
    clip: kf([[0, S], [0.13, GRAB], [0.3, GRAB], [0.56, S]]),
    lunge: [[0.04, 0.2, 12]],
    hits: [{ t0: 0.11, t1: 0.26, point: 'handR', r: 1.5, grab: true, dmg: 0, knock: 0 }],
    onGrab: 'slam',
  },
  slam: {
    dur: 1.15, track: 0, armor: 2, throws: true, rate: 16,
    clip: kf([[0, GRAB], [0.3, HOIST], [0.52, HOIST], [0.66, SLAM], [0.9, SLAM], [1.15, S]]),
    events: [{ t: 0.6, type: 'throwRelease', hit: { dmg: 95, knock: 26, stunDmg: 30 } }],
  },
  // Pursuit: stamp on a monster that is flat on its back.
  stomp: {
    dur: 0.7, track: 0.2, rate: 24,
    clip: kf([[0, S], [0.2, STOMP_UP], [0.31, STOMP_DOWN], [0.45, STOMP_DOWN], [0.7, S]]),
    lunge: [[0.04, 0.2, 9]],
    hits: [{ t0: 0.27, t1: 0.42, point: 'footR', r: 1.9, dmg: 42, knock: 0, stun: 0.4, otg: true, heavy: true }],
  },
};

export const HERO_DEF = {
  name: '银曜',
  title: '光之巨人',
  spark: [1.3, 3.4, 4.6],
  maxHp: 1000,
  speed: 9.5,
  stride: 0.5,
  radius: 1.2,
  hurt: { r: 1.25, h: 10.6 },
  chestY: 7.6,
  turn: 9,
  dashSpeed: 30,
  dashTime: 0.26,
  dashAttack: 'flyingKick',
  downTime: 1.1,
  getupTime: 0.55,
  inputs: { light: 'jab', heavy: 'kick', lance: 'lance', beam: 'beam', throw: 'throw' },
  /** Context-sensitive moves: a kick aimed at a floored opponent becomes a stomp. */
  resolve(f, kind) {
    const o = f.opponent;
    if (kind === 'heavy' && o && o.state === 'down' && Math.hypot(o.pos.x - f.pos.x, o.pos.z - f.pos.z) < 7.5) return 'stomp';
    return null;
  },
  clips,
  moves,
};
