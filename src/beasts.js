/**
 * The monsters, as data: which model each one is, how the animation clips it shipped with map
 * onto fighter states, where its gameplay points sit, and its moves.
 *
 * `fit`, `points`, `states`, `react` and a move's `anim` / `spin` / `lean` are read by ClipBody
 * and explained at the top of body.js. Every beast needs the points `core`, `footL` and
 * `footR`; its moves name the rest. `strideLength` is the ground one walking stride covers.
 * The other move fields (hit windows, lunges, events, AI weights) are the same as the hero's.
 */

/** What a spat fireball is. */
const FIREBALL = {
  from: 'mouth', shape: 'orb', speed: 30, r: 1.15, life: 3, aim: 0.8, trail: 2.4, sfx: 'fire', burst: 0.75,
  hit: { dmg: 85, knock: 13, stun: 0.5, guardDmg: 30 },
};

/** A shockwave running along the ground from a hammer blow. */
const SHOCKWAVE = {
  from: 'hammer', level: 1.2, shape: 'orb', speed: 34, r: 1.3, life: 1.1, aim: 0, trail: 3, sfx: 'fire', burst: 0.6,
  hit: { dmg: 70, knock: 14, stun: 0.5, guardDmg: 35 },
};

const troll = {
  file: 'troll.glb',
  fit: { size: 11.4, axis: 'y' },
  points: {
    core: [0.5, 0.62, 0.5],
    head: [0.5, 0.9, 0.7],
    hammer: [0.1, 0.1, 0.95],
    footL: [0.8, 0.02, 0.6],
    footR: [0.25, 0.02, 0.6],
  },
  spark: [3.6, 1.5, 0.35],
  glow: 0xff7a2a,
  radius: 2.3,
  hurt: { r: 2.4, h: 11 },
  chestY: 6.8,
  strideLength: 6.9,
  states: {
    idle: { clip: 'idle', loop: true },
    // its walk clip is a slow trudge; at fighting pace the lumbering run is what fits
    walk: { clip: 'run', stride: 2 },
    guard: { clip: 'take_damage', from: 0.25, to: 0.3 },
    hit: { clip: 'take_damage', speed: 1.8, blend: 30 },
    held: { clip: 'take_damage', from: 0.2, to: 0.5, speed: 0.6 },
    dizzy: { clip: 'idle_break', loop: true, speed: 1.4 },
    // it falls on its face a few steps ahead: slid back so that it lies where the fighter is
    down: { clip: 'death', speed: 1.7, blend: 24, shift: -4.3 },
    getup: { clip: 'death', reverse: true, speed: 2.3, shift: -4.3 },
    ko: { clip: 'death', blend: 24, shift: -4.3 },
    win: { clip: 'attack2', to: 0.78 }, // hammer held high
  },
  moves: {
    // a wide overhead-to-side sweep: the hammer crosses far out in front
    sweep: {
      dur: 1.34, track: 0.42, cd: 0.7, ai: { melee: 3, mid: 0.6 },
      anim: { clip: 'attack1', speed: 1.25 },
      lunge: [[0.3, 0.5, 5]],
      hits: [{ t0: 0.5, t1: 0.75, point: 'hammer', r: 1.8, dmg: 70, knock: 13, stun: 0.5, guardDmg: 30 }],
    },
    slam: {
      dur: 1.74, track: 0.9, cd: 2.4, armor: 1, ai: { melee: 2.2, mid: 1 },
      anim: { clip: 'attack2', speed: 1.25 },
      lunge: [[0.6, 0.95, 5]],
      hits: [{ t0: 0.95, t1: 1.13, point: 'hammer', r: 2.6, dmg: 120, knock: 22, kd: true, guardDmg: 55 }],
      events: [{ t: 1.08, type: 'impact', point: 'hammer', size: 1 }],
    },
    // the same blow from range: it sends a shockwave along the ground
    quake: {
      dur: 1.74, track: 0.95, cd: 4, armor: 1, ai: { mid: 1.2, far: 3, by: 'ranged' },
      anim: { clip: 'attack2', speed: 1.25 },
      events: [
        { t: 0.02, type: 'glow', v: 1 },
        { t: 1.08, type: 'impact', point: 'hammer', size: 1.2 },
        { t: 1.09, type: 'projectile', spec: SHOCKWAVE },
        { t: 1.15, type: 'glow', v: 0 },
      ],
    },
    charge: {
      dur: 1.5, track: 0.45, cd: 4.5, armor: 2, ai: { mid: 1.4, far: 1.4 },
      anim: { clip: 'run', loop: true, speed: 1.7 },
      lunge: [[0.4, 1.15, 21]],
      hits: [{ t0: 0.42, t1: 1.17, point: 'head', r: 2.4, dmg: 105, knock: 24, kd: true, guardDmg: 60 }],
      events: [{ t: 0.05, type: 'roar', vol: 0.5 }],
    },
    roar: {
      dur: 1.8, track: 0.3, armor: 2,
      anim: { clip: 'attack2', to: 0.78 }, // heaves the hammer overhead and holds it there
      events: [
        { t: 0.5, type: 'roar', vol: 1 },
        { t: 0.5, type: 'glow', v: 0.6 },
        { t: 1.4, type: 'glow', v: 0 },
      ],
    },
  },
};

const predator = {
  file: 'predator.glb',
  // long and low: it stands on the fighter's position by its shoulders, so that what the
  // hero faces (and hits) is its head, not thin air in front of its belly
  fit: { size: 23, axis: 'z', pivot: [0.5, 0.84] },
  points: {
    core: [0.5, 0.55, 0.72],
    mouth: [0.5, 0.6, 0.98],
    tail: [0.5, 0.25, 0.4],
    footL: [0.8, 0.02, 0.75],
    footR: [0.2, 0.02, 0.75],
  },
  spark: [1.2, 3.2, 4.5],
  glow: 0x38c8ff,
  radius: 3.2,
  hurt: { r: 3.4, h: 8.6 },
  chestY: 4.5,
  strideLength: 2.5,
  react: { flinch: 0.05, guard: 0.03, hoist: 4, heldPitch: 0.12 },
  states: {
    idle: { clip: 'rig|Idle', loop: true },
    walk: { clip: 'rig|walk', stride: 1, offset: 0.9 },
    // it has no clips for being hurt: the crouch that opens its roar serves as a recoil, and
    // its sleeping pose as lying knocked down
    guard: { clip: 'rig|Roar', from: 0.85, to: 0.9 },
    hit: { clip: 'rig|Roar', from: 0.3, to: 0.9, speed: 1.6, blend: 25 },
    dizzy: { clip: 'rig|Idle', loop: true },
    down: { clip: 'rig|Sleeping', blend: 9 },
    getup: { clip: 'rig|Idle', blend: 5 },
    ko: { clip: 'rig|Sleeping', blend: 9 },
    win: { clip: 'rig|Roar', to: 3, loop: true },
  },
  moves: {
    // a sideways snap of the head
    bite: {
      dur: 0.9, track: 0.36, cd: 0.6, ai: { melee: 3 },
      anim: { clip: 'rig|attack', to: 1.08, speed: 1.2 },
      lunge: [[0.2, 0.44, 8]],
      hits: [{ t0: 0.4, t1: 0.68, point: 'mouth', r: 2.0, dmg: 65, knock: 11, stun: 0.45 }],
    },
    // rears up and comes down with both forelegs
    maul: {
      dur: 1.85, track: 0.6, cd: 2.6, armor: 1, ai: { melee: 2.2, mid: 0.8 },
      anim: { clip: 'rig|Powerfull_attack', to: 2.4, speed: 1.3 },
      lunge: [[0.35, 0.72, 9]],
      hits: [
        { g: 'm', t0: 0.64, t1: 0.84, point: 'mouth', r: 2.4, dmg: 120, knock: 22, kd: true, guardDmg: 55 },
        { g: 'm', t0: 0.64, t1: 0.84, point: 'footL', r: 2.0, dmg: 120, knock: 22, kd: true, guardDmg: 55 },
        { g: 'm', t0: 0.64, t1: 0.84, point: 'footR', r: 2.0, dmg: 120, knock: 22, kd: true, guardDmg: 55 },
      ],
      events: [{ t: 0.77, type: 'impact', point: 'mouth', size: 0.9 }],
    },
    // one long bound across the gap
    pounce: {
      dur: 1.15, track: 0.3, cd: 3.6, armor: 2, ai: { mid: 2, far: 2.6 },
      anim: { clip: 'rig|Run', to: 0.96, speed: 1.1 },
      lunge: [[0.12, 0.8, 21]],
      hits: [{ t0: 0.3, t1: 0.86, point: 'mouth', r: 2.4, dmg: 105, knock: 24, kd: true, guardDmg: 60 }],
      events: [{ t: 0.02, type: 'roar', vol: 0.5 }],
    },
    tailSpin: {
      dur: 1.25, track: 0.25, cd: 3.4, armor: 1, ai: { melee: 1.4, mid: 0.9 },
      anim: { clip: 'rig|walk', loop: true, speed: 2 },
      spin: [0.32, 0.98],
      hits: [{ t0: 0.4, t1: 0.95, point: 'tail', r: 2.0, dmg: 100, knock: 22, kd: true, guardDmg: 45 }],
    },
    roar: {
      dur: 2.0, track: 0.3, armor: 2,
      anim: { clip: 'rig|Roar', to: 2.7, speed: 1.3 },
      events: [
        { t: 0.4, type: 'glow', v: 0.6 },
        { t: 1.0, type: 'roar', vol: 1 },
        { t: 1.7, type: 'glow', v: 0 },
      ],
    },
  },
};

const dragon = {
  file: 'dragon.glb',
  fit: { size: 12, axis: 'y' },
  points: {
    core: [0.5, 0.5, 0.5],
    mouth: [0.5, 0.8, 0.98],
    tail: [0.5, 0.2, 0.03],
    footL: [0.7, 0.02, 0.6],
    footR: [0.3, 0.02, 0.6],
  },
  spark: [3.4, 1.0, 4.6],
  glow: 0xb040ff,
  radius: 2.6,
  hurt: { r: 2.8, h: 10 },
  chestY: 6,
  strideLength: 8,
  states: {
    idle: { clip: 'Idle Stand', loop: true },
    walk: { clip: 'Walk', stride: true },
    dizzy: { clip: 'Idle Sit', loop: true },
    down: { clip: 'Idle Sit', roll: 1.35, rest: 2 },
    getup: { clip: 'Idle Sit', roll: 1.35, rest: 2 },
    win: { clip: 'Fly', loop: true },
  },
  moves: {
    bite: {
      dur: 0.95, track: 0.4, cd: 0.7, ai: { melee: 3 },
      anim: { clip: 'Idle Stand', loop: true },
      lean: [[0, 0, 0], [0.3, -0.25, 0.4], [0.46, 0.4, 0], [0.62, 0.4, 0], [0.95, 0, 0]],
      lunge: [[0.3, 0.5, 12]],
      hits: [{ t0: 0.38, t1: 0.62, point: 'mouth', r: 1.9, dmg: 70, knock: 12, stun: 0.45 }],
    },
    tailSpin: {
      dur: 1.2, track: 0.25, cd: 3, armor: 1, ai: { melee: 1.8, mid: 0.8 },
      anim: { clip: 'Walk', loop: true },
      spin: [0.3, 0.95],
      hits: [{ t0: 0.4, t1: 0.92, point: 'tail', r: 2.2, dmg: 100, knock: 22, kd: true, guardDmg: 45 }],
    },
    swoop: {
      dur: 2.0, track: 0.9, cd: 4.5, armor: 2, ai: { mid: 1.8, far: 2.2 },
      anim: { clip: 'Fly', loop: true, speed: 1.5 },
      lean: [[0, 0, 0], [0.7, -0.3, 5], [1.0, 0.45, 3.5], [1.4, 0.3, 1], [2.0, 0, 0]],
      lunge: [[0.9, 1.5, 30]],
      hits: [{ t0: 0.95, t1: 1.5, point: 'mouth', r: 2.6, dmg: 120, knock: 24, kd: true, guardDmg: 60 }],
      events: [{ t: 0.1, type: 'roar', vol: 0.5 }],
    },
    fireball: {
      dur: 1.35, track: 0.6, cd: 2.4, ai: { mid: 2, far: 3.2, by: 'ranged' },
      anim: { clip: 'Idle Stand', loop: true },
      lean: [[0, 0, 0], [0.5, -0.3, 0.5], [0.64, 0.25, 0], [0.95, 0.25, 0], [1.35, 0, 0]],
      events: [
        { t: 0.02, type: 'glow', v: 1 },
        { t: 0.62, type: 'projectile', spec: FIREBALL },
        { t: 0.7, type: 'glow', v: 0 },
      ],
    },
    tripleFire: {
      dur: 2.4, track: 1.5, cd: 5.5, armor: 1, ai: { mid: 1.4, far: 2.6, by: 'ranged' },
      anim: { clip: 'Fly', loop: true },
      lean: [[0, 0, 0], [0.6, -0.2, 5], [1.7, -0.1, 5], [2.4, 0, 0]],
      events: [
        { t: 0.02, type: 'glow', v: 1 },
        { t: 0.8, type: 'projectile', spec: FIREBALL, spread: -0.22 },
        { t: 1.1, type: 'projectile', spec: FIREBALL, spread: 0 },
        { t: 1.4, type: 'projectile', spec: FIREBALL, spread: 0.22 },
        { t: 1.5, type: 'glow', v: 0 },
      ],
    },
    roar: {
      dur: 1.8, track: 0.3, armor: 2,
      anim: { clip: 'Fly', loop: true },
      lean: [[0, 0, 0], [0.35, -0.45, 1.2], [1.4, -0.45, 1.2], [1.8, 0, 0]],
      events: [
        { t: 0.3, type: 'roar', vol: 1 },
        { t: 0.3, type: 'glow', v: 0.6 },
        { t: 1.4, type: 'glow', v: 0 },
      ],
    },
  },
};

export const BEASTS = { troll, predator, dragon };
