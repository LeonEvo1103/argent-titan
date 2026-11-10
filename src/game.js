import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import { ARENA_RADIUS, ROUND_TIME, STAGES } from './config.js';
import { angDiff, clamp, damp, rand } from './util.js';
import { Input } from './input.js';
import { AudioSys } from './audio.js';
import { Hud } from './hud.js';
import { Arena } from './arena.js';
import { FX } from './fx.js';
import { Fighter, isHeavy } from './fighter.js';
import { KaijuAI } from './ai.js';
import { HERO_DEF } from './hero.js';
import { createBeast } from './beast.js';
import { BEASTS } from './beasts.js';

const MAX_PIXEL_RATIO = 1.5;
const BASE_FOV = 38;
/** Keys pressed together are one decision: the most committal input wins. */
const ATTACK_PRIORITY = ['beam', 'lance', 'throw', 'heavy', 'light'];

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _want = new THREE.Vector3();
const _look = new THREE.Vector3();
const _focus = new THREE.Vector3();

/** Shortest distance in the ground plane from point p to the segment a-b. */
function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const k = len2 > 1e-9 ? clamp(((px - ax) * dx + (pz - az) * dz) / len2, 0, 1) : 0;
  return Math.hypot(px - (ax + dx * k), pz - (az + dz * k));
}

export class Game {
  /**
   * @param hero { rig, visual } as built by hero.js createHero()
   * @param world what arena.js loadArenaAssets() resolved to
   */
  constructor(canvas, hero, world) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.5, 1400);

    // a soft studio environment so the silver suit has something to reflect
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    this.scene.environment = pmrem.fromScene(room, 0.04).texture;
    this.scene.environmentIntensity = 0.3;
    room.dispose();
    pmrem.dispose();

    // nothing downstream samples scene depth, so the MSAA resolve can skip it
    const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4, resolveDepthBuffer: false });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(4, 4), 0.4, 0.5, 1.0));
    this.composer.addPass(new OutputPass());

    this.input = new Input();
    this.audio = new AudioSys();
    this.hud = new Hud();
    this.arena = new Arena(this.scene, world);
    this.fx = new FX(this.scene);

    this.onEvent = this.onEvent.bind(this);
    this.hero = new Fighter(HERO_DEF, hero.rig, this.onEvent, true);
    this.hero.visual = hero.visual;
    this.scene.add(hero.rig.root);

    this.roster = STAGES.map(() => null); // each stage's monster, once its model has arrived
    this.kaiju = null;
    this.ai = null;
    // The monster's glow lives in the scene for good: adding or removing a light would
    // change the light count and force every lit material to recompile mid-game.
    this.kaijuAura = new THREE.PointLight(0xffffff, 0, 0, 2);
    this.scene.add(this.kaijuAura);

    this.projectiles = [];
    this.shapes = {
      lance: { geo: new THREE.OctahedronGeometry(1, 0), scale: [0.3, 0.3, 2.6], spin: 0 },
      orb: { geo: new THREE.IcosahedronGeometry(1, 1), scale: [1.05, 1.05, 1.05], spin: 9 },
    };
    this.projectileMats = new Map();
    this.beamMove = null; // the move whose beam is burning right now
    this.beamTicks = 0;

    this.state = 'title';
    this.stateT = 0;
    this.timeline = [];
    this.stage = 0;
    this.timer = ROUND_TIME;
    this.time = 0;
    this.last = 0;
    this.timeScale = 1;
    this.hitstop = 0;
    this.paused = false;
    this.dirty = true; // a paused game only redraws when something changed
    this.pixelRatio = 0;
    this.combo = 0;
    this.comboT = 0;
    this.loser = null;
    this.stepSign = false;
    this.wasFull = false;
    this.chargeLv = 0;
    this.stats = { time: 0, maxCombo: 0, buildings: 0 };
    this.cam = { angle: Math.PI / 2, pos: new THREE.Vector3(0, 5, 26), look: new THREE.Vector3(0, 6, 0), fov: BASE_FOV, snap: true };

    this.input.onFirstGesture = () => this.audio.ensure();
    this.hud.onStart = () => this.startGame();
    this.hud.onResult = () => this.confirmResult();

    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => this.audio.setSuspended(document.hidden || this.paused));
    this.resize();
    this.enterTitle();
    this.hud.loading(0, STAGES.length);
  }

  /** The model for stage `index`'s monster has loaded (main.js fetches them behind the title screen). */
  addBeast(index, asset) {
    const stage = STAGES[index];
    const beast = createBeast(asset, stage, BEASTS[stage.beast]);
    const fighter = new Fighter(beast.def, beast.rig, this.onEvent, false);
    fighter.visual = beast.visual;
    this.roster[index] = fighter;
    this.hud.loading(this.roster.filter(Boolean).length, STAGES.length);
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    // re-read the pixel ratio every time: it changes with browser zoom and between displays
    this.pixelRatio = window.devicePixelRatio || 1;
    const ratio = Math.min(this.pixelRatio, MAX_PIXEL_RATIO);
    this.renderer.setPixelRatio(ratio);
    this.composer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  /* ------------------------------ game flow ------------------------------ */

  setState(s) {
    this.state = s;
    this.stateT = 0;
    this.timeline.length = 0;
    this.timeScale = 1;
    if (s !== 'fight') {
      this.hero.clearInput();
      this.kaiju?.clearInput();
    }
  }

  /** Run `fn` once the current state has lasted `t` seconds. */
  at(t, fn) {
    this.timeline.push({ t, fn });
    this.timeline.sort((x, y) => x.t - y.t);
  }

  /** Remove every projectile; with `fizzle` each one pops harmlessly where it is. */
  clearProjectiles(fizzle = false) {
    for (const p of this.projectiles) {
      if (fizzle) this.fx.hit(p.pos, p.color, 0.5);
      this.scene.remove(p.mesh);
    }
    this.projectiles.length = 0;
  }

  clearField() {
    this.clearProjectiles();
    this.fx.hideBeam();
    this.beamMove = null;
    this.combo = 0;
    this.hitstop = 0;
  }

  removeKaiju() {
    if (!this.kaiju) return;
    this.scene.remove(this.kaiju.rig.root); // it stays in the roster for the next time
    this.kaiju = null;
    this.ai = null;
    this.hero.opponent = null;
    this.kaijuAura.intensity = 0;
  }

  enterTitle() {
    this.setState('title');
    this.clearField();
    this.removeKaiju();
    this.arena.reset();
    this.hero.reset();
    this.hero.pos.set(0, 0, 0);
    this.hero.yaw = 0;
    this.cam.snap = true;
    this.hud.show('hud', false);
    this.hud.show('result', false);
    this.hud.show('title', true);
  }

  startGame() {
    if (this.state !== 'title' || this.roster.includes(null)) return;
    this.audio.ensure();
    this.audio.play('ui');
    this.audio.startMusic();
    this.hud.show('title', false);
    this.stats = { time: 0, maxCombo: 0, buildings: 0 };
    this.arena.reset();
    this.hero.reset();
    this.startStage(0, true);
  }

  /** `fresh` restores the hero completely (new game, retry); otherwise they keep what they have plus a breather. */
  startStage(index, fresh) {
    this.clearField();
    const stage = STAGES[index];
    if (this.kaiju !== this.roster[index]) {
      this.removeKaiju();
      this.kaiju = this.roster[index];
      this.scene.add(this.kaiju.rig.root);
      this.kaijuAura.color.set(this.kaiju.def.glow);
    }
    this.kaiju.reset();
    this.stage = index;
    this.ai = new KaijuAI(this.kaiju, stage.ai);

    const hero = this.hero;
    const hp = fresh ? hero.def.maxHp : Math.min(hero.def.maxHp, hero.hp + hero.def.maxHp * 0.4);
    const energy = fresh ? 0 : hero.energy;
    hero.reset();
    hero.hp = hp;
    hero.energy = energy;
    hero.opponent = this.kaiju;
    this.kaiju.opponent = hero;
    hero.pos.set(-9, 0, 0);
    hero.yaw = Math.PI / 2;
    this.kaiju.pos.set(9, 0, 0);
    this.kaiju.yaw = -Math.PI / 2;

    this.timer = ROUND_TIME;
    this.loser = null;
    this.wasFull = false;
    this.cam.angle = Math.PI / 2;
    this.cam.snap = true;
    this.hud.show('result', false);
    this.hud.show('hud', true);
    this.hud.setNames(index, STAGES.length, hero.def, this.kaiju.def);

    this.setState('intro');
    this.kaiju.startMove('roar');
    // snap both bodies onto their opening poses, so the monster's close-up does not begin
    // with it blending out of whatever it was last doing
    this.hero.animate(100, this.time);
    this.kaiju.animate(100, this.time);
    this.hud.banner(`STAGE ${index + 1}`, `${stage.title} · ${stage.name}`, 2.3);
    this.at(2.7, () => {
      this.setState('fight');
      this.hud.banner('FIGHT!', '', 0.9);
      this.audio.play('ui');
    });
  }

  confirmResult() {
    if (this.state === 'gameover') {
      this.audio.play('ui');
      this.startStage(this.stage, true);
    } else if (this.state === 'ending') {
      this.audio.play('ui');
      this.enterTitle();
    }
  }

  onKO(loser, timeUp = false) {
    if (this.state !== 'fight') return;
    this.setState('ko');
    this.loser = loser;
    this.timeScale = 0.22;
    this.clearProjectiles(true); // the round is decided: nothing still in the air may change it
    this.hud.banner(timeUp ? 'TIME UP' : 'K.O.', '', 1.8);
    this.audio.play('ko');
    this.fx.shake(0.8);
    this.at(1.1, () => (this.timeScale = 1));

    const winner = loser.opponent;
    const celebrate = (t, fn) => {
      // wait until the winner is back on their feet
      const tryIt = () => {
        if (winner.ready) fn();
        else this.at(this.stateT + 0.15, tryIt);
      };
      this.at(t, tryIt);
    };

    if (loser === this.kaiju) {
      const k = this.kaiju;
      const color = k.def.spark;
      const boom = (scale, spread) => () => {
        k.rig.world('core', _a);
        _a.x += rand(-spread, spread);
        _a.y = Math.max(1.5, _a.y + rand(0, spread));
        _a.z += rand(-spread, spread);
        this.fx.explosion(_a, scale, color);
        this.audio.play('explosion', { size: scale * 0.7 });
      };
      this.at(2.2, boom(0.8, 2.5));
      this.at(2.5, boom(0.9, 2.5));
      this.at(2.8, () => {
        boom(2.0, 0)();
        k.rig.root.visible = false;
        this.arena.crush(k.pos.x, k.pos.z, 7, (b) => this.onCollapse(b, 0));
      });
      const last = this.stage + 1 >= STAGES.length;
      celebrate(3.4, () => {
        winner.setState('win');
        this.audio.play('fanfare');
        this.hud.banner(last ? '胜利' : 'STAGE CLEAR', last ? '城市得救了' : '', 2.2, !last);
      });
      this.at(6.4, () => (last ? this.showEnding() : this.startStage(this.stage + 1, false)));
    } else {
      celebrate(1.8, () => {
        winner.setState('win');
        this.audio.play('roar', { pitch: winner.def.roarPitch });
        this.fx.shake(0.4);
      });
      this.at(4.2, () => {
        this.setState('gameover');
        const k = this.kaiju.def;
        this.hud.result('巨人倒下了', `${k.title} ${k.name} 仍在肆虐`, this.statRows(), '再次挑战 (Enter)');
      });
    }
  }

  statRows() {
    const s = this.stats;
    const mm = Math.floor(s.time / 60);
    const ss = String(Math.floor(s.time % 60)).padStart(2, '0');
    return [
      ['战斗时间', `${mm}:${ss}`],
      ['最高连击', `${s.maxCombo}`],
      ['建筑损毁', `${s.buildings} 栋`],
    ];
  }

  showEnding() {
    this.setState('ending');
    this.hud.show('hud', false);
    this.hud.result('城市得救了', '三头怪兽全部击破', this.statRows(), '回到标题 (Enter)');
  }

  /* ------------------------------ frame loop ------------------------------ */

  frame(now) {
    const raw = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    const inp = this.input;
    if ((window.devicePixelRatio || 1) !== this.pixelRatio) this.resize();

    if (inp.take('mute')) this.audio.toggleMute();
    if (inp.take('pause') && (this.state === 'fight' || this.state === 'intro' || this.paused)) {
      this.paused = !this.paused;
      this.hud.show('pause', this.paused);
      this.audio.setSuspended(this.paused);
      this.dirty = true;
    }
    if (this.paused) {
      // nothing moves while paused: draw once, then leave the GPU alone
      if (this.dirty) this.composer.render();
      this.dirty = false;
      inp.endFrame(raw);
      return;
    }

    this.time += raw;
    this.stateT += raw;
    while (this.timeline.length && this.stateT >= this.timeline[0].t) this.timeline.shift().fn();

    if (inp.take('confirm')) {
      this.startGame();
      this.confirmResult();
    }

    let sim = raw * this.timeScale;
    if (this.hitstop > 0) {
      this.hitstop -= raw;
      sim = 0;
    }
    if (sim > 0) this.simulate(sim);

    _focus.copy(this.hero.pos);
    if (this.kaiju) _focus.add(this.kaiju.pos).multiplyScalar(0.5);
    this.arena.update(raw, _focus, this.camera);
    this.fx.update(sim > 0 ? sim : raw * 0.1, this.camera, this.renderer.domElement.height);
    this.updateCamera(raw);
    this.updateHud(raw);
    this.composer.render();
    inp.endFrame(raw);
  }

  simulate(dt) {
    const hero = this.hero;
    const kaiju = this.kaiju;
    const fighting = this.state === 'fight';

    if (fighting) {
      this.controlHero();
      this.ai.update(dt);
      this.timer -= dt;
      this.stats.time += dt;
      if (this.timer <= 0) {
        this.timer = 0;
        const loser = hero.hp / hero.def.maxHp >= kaiju.hp / kaiju.def.maxHp ? kaiju : hero;
        loser.setState('ko');
        this.onKO(loser, true);
      }
    }

    hero.update(dt);
    if (kaiju) {
      kaiju.update(dt);
      if (kaiju.rig.root.visible) this.separate(hero, kaiju);
    }
    for (const f of [hero, kaiju]) {
      if (!f) continue;
      if (f.state === 'held' && f.holder) {
        // carried by the thrower: pinned just in front of them
        const h = f.holder;
        const gap = (h.def.radius + f.def.radius) * 0.92;
        f.pos.set(h.pos.x + Math.sin(h.yaw) * gap, 0, h.pos.z + Math.cos(h.yaw) * gap);
        f.yaw = h.yaw + Math.PI;
      }
      const r = Math.hypot(f.pos.x, f.pos.z);
      if (r > ARENA_RADIUS) {
        f.pos.x *= ARENA_RADIUS / r;
        f.pos.z *= ARENA_RADIUS / r;
      }
      f.animate(dt, this.time);
      if (f.rig.root.visible) this.arena.crush(f.pos.x, f.pos.z, f.def.radius + 0.3, (b) => this.onCollapse(b, 0.16));
    }

    if (kaiju) {
      // once the round is decided nothing may deal damage any more
      if (fighting) {
        this.resolveHits(hero, kaiju);
        this.resolveHits(kaiju, hero);
      }
      this.updateProjectiles(dt, fighting);
      this.updateBeam(fighting);
      this.ambientFx(dt);
    }

    if (this.comboT > 0) {
      this.comboT -= dt;
      if (this.comboT <= 0) this.combo = 0;
    }
  }

  controlHero() {
    const h = this.hero;
    const inp = this.input;
    // movement is screen-relative: left/right along the camera's right, up/down into the screen
    this.camera.getWorldDirection(_a);
    _a.y = 0;
    _a.normalize();
    const ax = (inp.held('right') ? 1 : 0) - (inp.held('left') ? 1 : 0);
    const ay = (inp.held('up') ? 1 : 0) - (inp.held('down') ? 1 : 0);
    h.intent.mx = -_a.z * ax + _a.x * ay;
    h.intent.mz = _a.x * ax + _a.z * ay;
    h.intent.guard = inp.held('guard');
    h.intent.charge = inp.held('beam');
    if (inp.take('dash')) h.queueDash();
    const attack = inp.takeFirst(ATTACK_PRIORITY);
    if (attack) h.queueAttack(attack);
  }

  separate(a, b) {
    if (a.state === 'held' || b.state === 'held') return;
    const dx = b.pos.x - a.pos.x;
    const dz = b.pos.z - a.pos.z;
    const d = Math.hypot(dx, dz);
    const min = a.def.radius + b.def.radius;
    if (d >= min) return;
    const nx = d > 1e-4 ? dx / d : 1;
    const nz = d > 1e-4 ? dz / d : 0;
    const push = min - d;
    // the monster is heavier: the hero gives more ground
    a.pos.x -= nx * push * 0.65;
    a.pos.z -= nz * push * 0.65;
    b.pos.x += nx * push * 0.35;
    b.pos.z += nz * push * 0.35;
  }

  /* ------------------------------ combat ------------------------------ */

  /**
   * Melee. A hit volume is not just a ball at the fist or tail tip: it covers the limb back
   * toward the attacker's body (so a target pressed right up against them is still struck)
   * and the path the point travelled since the last frame (so a fast swing cannot skip over
   * a target between two frames, whatever the frame rate).
   */
  resolveHits(att, def) {
    if (att.state !== 'attack' || !att.move.hits) return;
    const m = att.move;
    const hurt = def.def.hurt;
    for (let i = 0; i < m.hits.length; i++) {
      const h = m.hits[i];
      const g = h.g ?? i;
      if (att.hitDone[g] || att.t < h.t0 || att.t > h.t1) continue;
      att.rig.world(h.point, _a);
      let last = att.swung[g + ':' + i];
      if (!last) {
        last = att.swung[g + ':' + i] = _a.clone();
        if (!att.swung[g]) {
          att.swung[g] = true;
          if (!h.grab) this.audio.play(isHeavy(h) ? 'swingHeavy' : 'swing');
        }
      }
      const r = h.r;
      const rootX = att.pos.x + (_a.x - att.pos.x) * 0.3;
      const rootZ = att.pos.z + (_a.z - att.pos.z) * 0.3;
      const reach = Math.min(
        segDist(def.pos.x, def.pos.z, rootX, rootZ, _a.x, _a.z),
        segDist(def.pos.x, def.pos.z, last.x, last.z, _a.x, _a.z),
      );
      const low = Math.min(_a.y, last.y) - r;
      last.copy(_a);
      if (reach >= hurt.r + r || low >= hurt.h) continue;

      const res = def.takeHit(att, h);
      if (res === 'miss') continue;
      att.hitDone[g] = true;
      // show the impact on the defender's surface, on the side facing the attacker
      _b.set(att.pos.x - def.pos.x, 0, att.pos.z - def.pos.z).normalize();
      _c.set(def.pos.x + _b.x * hurt.r * 0.8, clamp(_a.y, 1, hurt.h - 0.5), def.pos.z + _b.z * hurt.r * 0.8);
      if (res === 'grab') {
        def.hold(att);
        att.startMove(m.onGrab);
        this.audio.play('grab');
        this.fx.block(_c);
        this.hitstop = 0.06;
        return; // the attacker is in a different move now
      }
      this.onHit(att, def, h, res, _c);
    }
  }

  onHit(att, def, h, res, at) {
    const heavy = isHeavy(h);
    const color = att.def.spark;
    if (res === 'block' || res === 'break') {
      this.fx.block(at);
      if (res === 'break') {
        this.audio.play('guardBreak');
        this.fx.ring(at, [3, 2.4, 0.8], 7, 0.5, false);
        this.hud.banner('防御崩坏', '', 0.9, true);
        this.hitstop = 0.12;
      } else if (!h.beam) {
        this.audio.play('block');
        this.hitstop = 0.045;
        this.fx.shake(0.12);
      }
      return;
    }

    if (h.beam) {
      this.fx.hit(at, color, 0.6);
      this.fx.shake(0.1);
    } else {
      this.fx.hit(at, color, heavy ? 1.6 : 1);
      this.audio.play(heavy ? 'hitHeavy' : 'hit');
      this.hitstop = heavy ? 0.11 : 0.055;
      this.fx.shake(heavy ? 0.5 : 0.22);
    }
    if (def.state === 'down' || res === 'ko') this.fx.dust(def.pos.x, 0.3, def.pos.z, 8, 2.5, 3.5);
    if (res === 'stun') {
      this.audio.play('stun');
      this.fx.ring(at, [3, 2.6, 1], 8, 0.6, false);
      this.hud.banner('眩晕', def.isHero ? '' : '蓄力必杀的机会', 1.1, true);
      this.hitstop = 0.14;
    }

    if (!h.beam) att.energy = Math.min(100, att.energy + h.dmg * 0.17);
    if (att.isHero) {
      this.combo += 1;
      this.comboT = 1.5;
      this.stats.maxCombo = Math.max(this.stats.maxCombo, this.combo);
    } else {
      this.combo = 0;
    }
    if (res === 'ko') this.onKO(def);
  }

  onEvent(f, ev) {
    switch (ev.type) {
      case 'deny':
        this.audio.play('deny');
        break;
      case 'dash':
        this.audio.play('dash');
        this.fx.dust(f.pos.x, 0.2, f.pos.z, 6, 1.5, 2.5);
        break;
      case 'glow':
        f.glowTarget = ev.v;
        break;
      case 'roar':
        this.audio.play('roar', { pitch: f.def.roarPitch, vol: ev.vol });
        this.fx.shake(0.45 * ev.vol);
        break;
      case 'enrage':
        this.hud.text('p2status', '狂暴化');
        this.hud.banner('狂暴化', '', 1.0, true);
        break;
      case 'projectile':
        this.spawnProjectile(f, ev);
        break;
      case 'impact': {
        // something heavy comes down on the ground
        f.rig.world(ev.point, _a).setY(0.3);
        this.fx.dust(_a.x, 0.3, _a.z, 14, 2.6 * ev.size, 4);
        this.fx.ring(_a, f.def.spark, 9 * ev.size, 0.45);
        this.fx.shake(0.55 * ev.size);
        this.audio.play('explosion', { size: 0.5 * ev.size, vol: 0.7 });
        this.arena.crush(_a.x, _a.z, 3 * ev.size, (b) => this.onCollapse(b, 0));
        break;
      }
      case 'beamCharge':
        this.audio.play('beamCharge');
        f.glowTarget = 1;
        break;
      case 'throwRelease': {
        const v = f.opponent;
        if (v.state !== 'held' || v.holder !== f || this.state !== 'fight') break;
        const res = v.takeThrow(f, ev.hit);
        v.rig.world('core', _a);
        this.fx.hit(_a, f.def.spark, 1.8);
        this.fx.dust(v.pos.x, 0.3, v.pos.z, 12, 3, 4);
        this.audio.play('hitHeavy');
        this.hitstop = 0.12;
        this.fx.shake(0.7);
        if (f.isHero) {
          this.combo += 1;
          this.comboT = 1.5;
          this.stats.maxCombo = Math.max(this.stats.maxCombo, this.combo);
        }
        if (res === 'ko') this.onKO(v);
        break;
      }
      default:
        break;
    }
  }

  projectileMaterial(color) {
    const key = color.join();
    if (!this.projectileMats.has(key)) {
      this.projectileMats.set(key, new THREE.MeshBasicMaterial({ color: new THREE.Color(color[0] * 1.4, color[1] * 1.4, color[2] * 1.4), fog: false }));
    }
    return this.projectileMats.get(key);
  }

  /** `ev.spec` says what is thrown (see LANCE in hero.js, FIREBALL in beasts.js). */
  spawnProjectile(f, ev) {
    const spec = ev.spec;
    const shape = this.shapes[spec.shape];
    const o = f.opponent;
    const color = f.def.spark;
    f.rig.world(spec.from, _a);
    // `level`: it runs along the ground at that height instead of flying at the target's chest
    if (spec.level !== undefined) _a.y = spec.level;
    _b.set(o.pos.x, spec.level ?? o.def.chestY * spec.aim, o.pos.z).sub(_a).normalize();
    if (ev.spread) _b.applyAxisAngle(_c.set(0, 1, 0), ev.spread);

    const mesh = new THREE.Mesh(shape.geo, this.projectileMaterial(color));
    mesh.scale.set(shape.scale[0], shape.scale[1], shape.scale[2]);
    mesh.position.copy(_a);
    mesh.lookAt(_c.copy(_a).add(_b));
    this.scene.add(mesh);

    this.projectiles.push({ owner: f, spec, mesh, pos: mesh.position, vel: _b.clone().multiplyScalar(spec.speed), life: spec.life, color, spin: shape.spin });
    this.audio.play(spec.sfx);
    this.fx.flash(_a, color, 180, 0.3);
  }

  updateProjectiles(dt, fighting) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      const spec = p.spec;
      p.pos.addScaledVector(p.vel, dt);
      p.life -= dt;
      p.mesh.rotation.x += dt * p.spin;
      this.fx.trail(p.pos, p.color, spec.trail);

      const target = p.owner.opponent;
      const hurt = target.def.hurt;
      let done = false;
      if (fighting && Math.hypot(p.pos.x - target.pos.x, p.pos.z - target.pos.z) < hurt.r + spec.r && p.pos.y < hurt.h + spec.r) {
        const res = target.takeHit(p.owner, spec.hit);
        if (res !== 'miss') {
          this.onHit(p.owner, target, spec.hit, res, p.pos);
          done = true;
        }
      }
      // onHit may have ended the round, which already cleared every projectile
      if (this.projectiles[i] !== p) continue;
      const grounded = p.pos.y < 0.4;
      if (done || grounded || p.life <= 0) {
        if (spec.burst) {
          this.fx.explosion(p.pos, spec.burst, p.color);
          this.audio.play('explosion', { size: 0.5, vol: 0.7 });
          if (grounded) this.arena.crush(p.pos.x, p.pos.z, 3.2, (b) => this.onCollapse(b, 0));
        }
        this.scene.remove(p.mesh);
        this.projectiles.splice(i, 1);
      }
    }
  }

  /**
   * A beam burns while a fighter is inside the `beam` window of their move (see beamMove in
   * hero.js). It lands a fixed number of evenly spaced ticks, so damage does not depend on
   * frame rate, and it is aimed from the firer's own body line: a target standing inside
   * arm's reach, behind the muzzle, is still in the beam.
   */
  updateBeam(fighting) {
    const o = [this.hero, this.kaiju].find((f) => {
      const b = f.state === 'attack' && f.move.beam;
      return b && f.t >= b.start && f.t < b.start + b.dur;
    });
    if (!o) {
      if (this.beamMove) {
        this.beamMove = null;
        this.fx.hideBeam();
      }
      return;
    }
    const spec = o.move.beam;
    const bt = o.t - spec.start;
    if (this.beamMove !== o.move) {
      this.beamMove = o.move;
      this.beamTicks = 0;
      this.audio.play('beam', { dur: spec.dur });
      this.fx.shake(0.5);
    }

    const e = o.opponent;
    o.rig.world(spec.from[0], _a);
    if (spec.from[1]) _a.add(o.rig.world(spec.from[1], _b)).multiplyScalar(0.5);
    const sin = Math.sin(o.yaw);
    const cos = Math.cos(o.yaw);
    const dx = e.pos.x - o.pos.x;
    const dz = e.pos.z - o.pos.z;
    const ahead = dx * sin + dz * cos; // how far in front of the firer the target stands
    const aside = Math.abs(dx * cos - dz * sin);
    const muzzle = (_a.x - o.pos.x) * sin + (_a.z - o.pos.z) * cos;
    const pitch = clamp(Math.atan2(e.def.chestY - _a.y, Math.max(1, ahead - muzzle)), -0.5, 0.3);
    _b.set(sin * Math.cos(pitch), Math.sin(pitch), cos * Math.cos(pitch));

    const inBeam = ahead > 0 && aside < e.def.hurt.r + spec.width && e.rig.root.visible;
    const len = inBeam ? Math.max(0.8, ahead - muzzle - e.def.hurt.r * 0.5) : 110;
    this.fx.setBeam(_a, _b, len, bt, spec.width);
    this.fx.shake(0.05);

    const due = Math.min(spec.ticks, Math.floor((bt / spec.dur) * spec.ticks) + 1);
    while (this.beamTicks < due) {
      this.beamTicks += 1;
      if (!fighting || !inBeam) continue;
      const h = this.beamTicks === spec.ticks ? spec.finish : spec.hit;
      const res = e.takeHit(o, h);
      if (res !== 'miss') this.onHit(o, e, h, res, _c.copy(_a).addScaledVector(_b, len));
    }
  }

  onCollapse(b, shake) {
    this.stats.buildings += 1;
    this.fx.dust(b.x, 0.4, b.z, 12, Math.max(b.hw, b.hd) * 1.3, 4);
    this.fx.debris(b.x, b.h * 0.5, b.z, 10);
    this.audio.play('collapse', { vol: 0.8 });
    if (shake) this.fx.shake(shake);
  }

  /** Looping cosmetic effects tied to what the fighters are doing. */
  ambientFx(dt) {
    const k = this.kaiju;
    // energy streaming in while a fighter winds up something that glows
    for (const f of [this.hero, k]) {
      if (f.state !== 'attack' || f.glowTarget < 0.9) continue;
      const m = f.move;
      const shot = m.events?.find((ev) => ev.type === 'projectile');
      if (m.hold) {
        f.rig.world('core', _a);
        _a.addScaledVector(_b.set(Math.sin(f.yaw), 0, Math.cos(f.yaw)), 1.6);
        for (let i = 0; i < 4; i++) this.fx.gather(_a, f.def.spark, 5);
      } else if (shot) {
        f.rig.world(shot.spec.from, _a);
        for (let i = 0; i < 2; i++) this.fx.gather(_a, f.def.spark, 3.5);
      }
    }
    // heavy footfalls
    if (k.state === 'idle' && k.moving) {
      const s = Math.sin(k.walkPhase) > 0;
      if (s !== this.stepSign) {
        this.stepSign = s;
        this.audio.play('step', { vol: 0.55 });
        this.fx.shake(0.07);
        k.rig.world(s ? 'footL' : 'footR', _a);
        this.fx.dust(_a.x, 0.2, _a.z, 4, 1, 2.2);
      }
    }
    k.rig.world('core', _a);
    if (k.enraged && k.alive && Math.random() < dt * 14) {
      const c = k.def.spark;
      this.fx.sparks.emit(_a.x + rand(-2.5, 2.5), _a.y + rand(-3, 3), _a.z + rand(-2.5, 2.5), 0, rand(3, 8), 0, 0.7, 0.9, 0.1, c[0], c[1], c[2], 0.9);
    }
    // the monster's glow, carried by the one light that never leaves the scene
    const reach = k.def.hurt.r * 1.5;
    this.kaijuAura.position.set(_a.x + Math.sin(k.yaw) * reach, _a.y, _a.z + Math.cos(k.yaw) * reach);
    this.kaijuAura.intensity = k.rig.root.visible ? k.aura : 0;
  }

  /* ------------------------------ camera + HUD ------------------------------ */

  updateCamera(dt) {
    const c = this.cam;
    const hero = this.hero;
    const k = this.kaiju;
    let rate = 4.5;
    let fov = BASE_FOV;

    if (this.state === 'title' || !k) {
      const a = this.time * 0.14 + 0.6;
      _want.set(hero.pos.x + Math.sin(a) * 23, 3.6, hero.pos.z + Math.cos(a) * 23);
      _look.set(hero.pos.x, 6.4, hero.pos.z);
      rate = 2;
    } else if (this.state === 'intro' && this.stateT < 2.0) {
      // low hero shot of the monster roaring
      const a = k.yaw + 0.55 - this.stateT * 0.12;
      const s = k.def.hurt.h / 11; // how big it is next to the monsters the shot was framed for
      _want.set(k.pos.x + Math.sin(a) * 21 * s, 2.6, k.pos.z + Math.cos(a) * 21 * s);
      _look.set(k.pos.x, 6.6 * s, k.pos.z);
      rate = 3;
    } else {
      const dx = k.pos.x - hero.pos.x;
      const dz = k.pos.z - hero.pos.z;
      const d = Math.hypot(dx, dz);
      // sit perpendicular to the line between the fighters, on whichever side is closer to where we already are
      const axis = Math.atan2(dz, dx);
      const a1 = axis + Math.PI / 2;
      const a2 = axis - Math.PI / 2;
      const target = Math.abs(angDiff(c.angle, a1)) <= Math.abs(angDiff(c.angle, a2)) ? a1 : a2;
      c.angle += angDiff(c.angle, target) * (c.snap ? 1 : damp(3.2, dt));

      let mx = (hero.pos.x + k.pos.x) / 2;
      let mz = (hero.pos.z + k.pos.z) / 2;
      // back off until both fighters fit across the frame, whatever the window's shape
      const fit = Math.tan((BASE_FOV * Math.PI) / 360) * this.camera.aspect * 0.86;
      const span = d / 2 + 5;
      let dist = clamp(span / fit, 23, 62);
      if (this.state === 'ko' && this.loser) {
        mx += (this.loser.pos.x - mx) * 0.5;
        mz += (this.loser.pos.z - mz) * 0.5;
        dist *= 0.85;
      }
      let x = mx + Math.cos(c.angle) * dist;
      let z = mz + Math.sin(c.angle) * dist;
      // stay inside the low-rise district so no tower ever blocks the view
      const r = Math.hypot(x, z);
      if (r > 56) {
        x *= 56 / r;
        z *= 56 / r;
      }
      _want.set(x, 5.6 + d * 0.06, z);
      _look.set(mx, 5.7, mz);
      // where the camera cannot back off that far (edge of the district, a very wide gap),
      // widen the lens instead of losing a fighter off the side
      const actual = Math.hypot(x - mx, z - mz);
      fov = clamp((Math.atan(span / (actual * this.camera.aspect * 0.86)) * 360) / Math.PI, BASE_FOV, 78);
    }

    c.fov = c.snap ? fov : c.fov + (fov - c.fov) * damp(4, dt);
    if (Math.abs(this.camera.fov - c.fov) > 0.01) {
      this.camera.fov = c.fov;
      this.camera.updateProjectionMatrix();
    }

    if (c.snap) {
      c.pos.copy(_want);
      c.look.copy(_look);
      c.snap = false;
    } else {
      c.pos.lerp(_want, damp(rate, dt));
      c.look.lerp(_look, damp(rate * 1.3, dt));
    }
    const s = this.fx.trauma * this.fx.trauma * 1.1;
    this.camera.position.set(c.pos.x + rand(-s, s), c.pos.y + rand(-s, s), c.pos.z + rand(-s, s));
    this.camera.lookAt(c.look.x + rand(-s, s) * 0.5, c.look.y + rand(-s, s) * 0.5, c.look.z);
  }

  updateHud(dt) {
    const hud = this.hud;
    hud.update(dt);
    if (!this.kaiju) return;
    const h = this.hero;
    const k = this.kaiju;
    hud.hp('p1', h.hp / h.def.maxHp);
    hud.hp('p2', k.hp / k.def.maxHp);
    hud.bar('p1en', h.energy / 100);
    hud.bar('p1gd', h.guardMeter / 100);
    hud.bar('p1st', h.state === 'dizzy' ? 1 : h.stunMeter / 100);
    hud.bar('p2st', k.state === 'dizzy' ? 1 : k.stunMeter / 100);
    hud.text('timer', String(Math.ceil(this.timer)));
    hud.flag('timer', 'low', this.timer < 15);

    // the beam prompt: what is ready, or what the current charge has reached
    const fighting = this.state === 'fight';
    const levels = h.def.moves[h.def.inputs.beam].hold.levels;
    const charging = h.state === 'attack' && !!h.move.hold;
    let label = '';
    let level = 0;
    if (charging) {
      level = levels.indexOf(h.chargeLevel()) + 1;
      label = level ? `极光炮 蓄力 Lv.${level} · 松开发射` : '极光炮 蓄力中…';
    } else if (fighting) {
      const best = levels.filter((l) => h.energy >= l.cost).length;
      if (best) label = `极光炮 Lv.${best} 可用 · 按住 I 蓄力`;
    }
    if (level > this.chargeLv) this.audio.play('level', { pitch: 1 + (level - 1) * 0.25 });
    this.chargeLv = level;
    hud.text('ready', label);
    hud.flag('ready', 'hidden', !label);
    const full = fighting && h.energy >= 100;
    hud.flag('enBar', 'full', full);
    if (full && !this.wasFull) this.audio.play('ready');
    this.wasFull = full;
    hud.combo(this.combo);
  }

  /* ------------------------------ debugging ------------------------------ */

  /**
   * Freeze a fighter at time t of a move or of a state (authoring aid):
   * game.debugPose('hero', 'jab', 0.1), game.debugPose('kaiju', 'down', 0.6)
   */
  debugPose(who, id, t = 0) {
    const f = who === 'hero' ? this.hero : this.kaiju;
    const move = f.def.moves[id];
    f.state = move ? 'attack' : id;
    f.move = move ?? null;
    f.t = t;
    this.paused = true;
    f.animate(100, t);
    this.composer.render();
  }
}
