import * as THREE from 'three';
import { ClipBody } from './body.js';
import { TAU } from './util.js';

/**
 * Build one stage's monster from its model: { rig, def, visual }, ready for a Fighter.
 * `stage` is a STAGES entry (config.js), `beast` its BEASTS entry (beasts.js).
 */
export function createBeast(asset, stage, beast) {
  const materials = new Set();
  asset.scene.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    materials.add(o.material);
    if (o.material.transparent) {
      // hair cards and the like: cut-out instead of blended, so they sort and shadow properly
      o.material.transparent = false;
      o.material.alphaTest = 0.5;
      o.material.depthWrite = true;
    }
  });
  const glowColor = new THREE.Color(beast.glow);

  /** Per-frame cosmetics: the hide glows while it winds up a special, and pulses when enraged. */
  function visual(f, dt, time) {
    const alive = f.state === 'ko' ? Math.max(0, 1 - f.t * 0.6) : 1;
    const rage = f.enraged ? 0.5 + 0.5 * Math.sin(time * 9) : 0;
    // the tint covers the whole textured hide, so a little goes a long way
    const glow = (f.glow * 0.14 + rage * 0.06) * alive;
    for (const m of materials) m.emissive.copy(glowColor).multiplyScalar(glow);
    f.aura = (5 + rage * 16 + f.glow * 80) * alive;
  }

  const def = {
    name: stage.name,
    title: stage.title,
    spark: beast.spark,
    glow: beast.glow,
    maxHp: stage.maxHp,
    speed: stage.speed,
    stride: TAU / beast.strideLength, // walkPhase radians per unit walked: one cycle per stride
    radius: beast.radius,
    hurt: beast.hurt,
    chestY: beast.chestY,
    turn: stage.turn ?? 3.2,
    dmgScale: stage.dmgScale ?? 1,
    downTime: beast.downTime ?? 1.3,
    getupTime: beast.getupTime ?? 0.85,
    roarPitch: stage.roarPitch ?? 1,
    moves: beast.moves,
  };
  return { rig: new ClipBody(asset, beast), def, visual };
}
