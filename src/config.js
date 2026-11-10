export const ARENA_RADIUS = 34;
export const ROUND_TIME = 99;

/**
 * One monster per stage. `beast` names its body and moves (see BEASTS in beasts.js); the rest
 * is how tough it is here and how its AI plays (see ai.js).
 */
export const STAGES = [
  {
    name: '格罗姆',
    title: '碎岩巨魔',
    beast: 'troll',
    maxHp: 1500,
    speed: 5.2,
    dmgScale: 0.9,
    roarPitch: 0.85,
    ai: { aggr: 0.8, think: [0.5, 0.95], guard: 0.09, beamGuard: 0.25, melee: 6.4, ranged: 0.5 },
  },
  {
    name: '泽鲁加',
    title: '猎牙兽',
    beast: 'predator',
    maxHp: 1800,
    speed: 6.4,
    dmgScale: 1.0,
    roarPitch: 1.3,
    turn: 3.8,
    ai: { aggr: 1.0, think: [0.4, 0.82], guard: 0.15, beamGuard: 0.4, melee: 6.6, ranged: 0.35 },
  },
  {
    name: '奥布西昂',
    title: '冥晶龙',
    beast: 'dragon',
    maxHp: 2300,
    speed: 6.4,
    dmgScale: 1.1,
    roarPitch: 0.72,
    ai: { aggr: 1.08, think: [0.38, 0.82], guard: 0.16, beamGuard: 0.55, melee: 7.0, ranged: 0.5 },
  },
];
