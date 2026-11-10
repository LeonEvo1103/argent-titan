import * as THREE from 'three';
import { Game } from './game.js';
import { createHero } from './hero.js';
import { loadModel } from './skin.js';
import { loadArenaAssets } from './arena.js';
import { STAGES } from './config.js';
import { BEASTS } from './beasts.js';

const canvas = document.getElementById('stage');

function fail(text, err) {
  console.error(err);
  const msg = document.createElement('p');
  msg.textContent = text;
  msg.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;margin:0;padding:2em;text-align:center;color:#fff;background:#05070d';
  document.body.append(msg);
}

async function boot() {
  const base = import.meta.env.BASE_URL;
  let model;
  let world;
  try {
    [model, world] = await Promise.all([loadModel(`${base}models/titan-body.glb`), loadArenaAssets(base)]);
  } catch (err) {
    fail('素材加载失败：请确认 public/models 与 public/textures 完整。', err);
    return;
  }

  let game;
  try {
    game = new Game(canvas, createHero(model), world);
  } catch (err) {
    fail('无法启动 3D 渲染：这台设备或浏览器可能不支持 WebGL2。', err);
    return;
  }
  window.__game = game; // handy for poking at state from the console
  if (import.meta.env.DEV) window.__THREE = THREE;

  // the monsters are much bigger downloads: fetch them while the title screen is up
  STAGES.forEach((stage, i) => {
    const file = BEASTS[stage.beast].file;
    loadModel(`${base}models/${file}`)
      .then((asset) => game.addBeast(i, asset))
      .catch((err) => fail(`模型文件加载失败：public/models/${file}`, err));
  });

  const loop = (now) => {
    // schedule first: one bad frame must not stop the game for good
    requestAnimationFrame(loop);
    game.frame(now);
  };
  requestAnimationFrame((now) => {
    game.last = now;
    requestAnimationFrame(loop);
  });
}

boot();
