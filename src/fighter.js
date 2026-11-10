import * as THREE from 'three';
import { angDiff, clamp, damp } from './util.js';

const CHAIN_LIMIT = 5; // consecutive hits before a forced knockdown (no infinite stun-lock)
const QUEUE_TIME = 0.24; // how long a buffered attack or dash input stays valid
const BLOCK_LOCK = 0.2; // block-stun
const GUARD_BREAK_TIME = 1.5;
const STUN_TIME = 3.0; // dizzy after the stun gauge fills: the opening for a big finisher
const STUN_IMMUNITY = 4.0; // gauge does not fill again right after waking up

/** One rule for "does this hit read as heavy" (sound, sparks, hit-stop and stagger pose all use it). */
export const isHeavy = (h) => !!h.kd || !!h.heavy || h.dmg >= 60;

/**
 * One combatant. Hero and monsters share this class; everything that differs lives in `def`
 * (stats, moves) and in the body `rig` (a Rig or a BeastBody: `root`, `world(name, out)`,
 * `drive(fighter, dt, time)`). Controllers only write `intent` and call queueAttack / queueDash.
 * Things the outside world should react to are reported through `emit(fighter, event)`.
 */
export class Fighter {
  constructor(def, rig, emit, isHero) {
    this.def = def;
    this.rig = rig;
    this.emit = emit;
    this.isHero = isHero;
    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.intent = { mx: 0, mz: 0, guard: false, charge: false };
    this.opponent = null;
    this.visual = null;
    this.reset();
  }

  reset() {
    this.hp = this.def.maxHp;
    this.energy = 0;
    this.guardMeter = 100;
    this.stunMeter = 0;
    this.stunCool = 0;
    this.stunImmune = 0;
    this.state = 'idle';
    this.t = 0;
    this.move = null;
    this.moveId = null;
    this.hitDone = {};
    this.swung = {};
    this.evDone = 0;
    this.dashCd = 0;
    this.dashX = 0;
    this.dashZ = 0;
    this.invuln = 0;
    this.lock = 0;
    this.stun = 0;
    this.dizzyTime = 0;
    this.heavy = false;
    this.chain = 0;
    this.chainT = 0;
    this.kvx = 0;
    this.kvz = 0;
    this.walkPhase = 0;
    this.stepFwd = 0; // -1..1: stepping backward..forward relative to the facing
    this.stepSide = 0; // -1..1: stepping to its right..left
    this.moving = false;
    this.glow = 0;
    this.glowTarget = 0;
    this.enraged = false;
    this.holder = null;
    this.released = false;
    this.aura = 0;
    this.clearInput();
    this.rig.root.visible = true;
  }

  /** Forget everything the controller asked for (round over, cutscene, new stage). */
  clearInput() {
    this.intent.mx = this.intent.mz = 0;
    this.intent.guard = false;
    this.intent.charge = false;
    this.queued = null;
    this.queuedT = 0;
    this.dashQ = 0;
  }

  get alive() {
    return this.state !== 'ko';
  }

  /** Can be struck right now (not lying down, not held, not in i-frames). */
  get targetable() {
    return this.invuln <= 0 && this.state !== 'down' && this.state !== 'getup' && this.state !== 'ko' && this.state !== 'held';
  }

  /** Free to start something new. */
  get ready() {
    return (this.state === 'idle' || this.state === 'guard') && this.lock <= 0;
  }

  setState(s) {
    this.state = s;
    this.t = 0;
    if (s !== 'attack') {
      this.move = null;
      this.moveId = null;
      this.glowTarget = 0;
    }
    if (s !== 'held') this.holder = null;
  }

  /** `kind` is either a move id or an abstract input ('light', 'heavy', ...). */
  queueAttack(kind) {
    this.queued = kind;
    this.queuedT = QUEUE_TIME;
  }

  queueDash() {
    this.dashQ = QUEUE_TIME;
  }

  startMove(id) {
    const m = this.def.moves[id];
    if (!m) return false;
    const need = m.cost ?? m.minEnergy ?? 0;
    if (this.energy < need) {
      this.emit(this, { type: 'deny' });
      return false;
    }
    if (m.cost) this.energy -= m.cost;
    this.state = 'attack';
    this.t = 0;
    this.move = m;
    this.moveId = id;
    this.hitDone = {};
    this.swung = {};
    this.evDone = 0;
    this.glowTarget = 0;
    this.holder = null;
    this.released = false;
    this.emit(this, { type: 'move', id });
    return true;
  }

  tryQueued() {
    if (!this.queued) return false;
    const kind = this.queued;
    this.queued = null;
    const id = this.def.resolve?.(this, kind) ?? (this.def.moves[kind] ? kind : this.def.inputs?.[kind]);
    return id ? this.startMove(id) : false;
  }

  face(dt, rate) {
    const o = this.opponent;
    if (!o) return;
    const target = Math.atan2(o.pos.x - this.pos.x, o.pos.z - this.pos.z);
    const step = rate * dt;
    this.yaw += clamp(angDiff(this.yaw, target), -step, step);
  }

  startDash() {
    let mx = this.intent.mx;
    let mz = this.intent.mz;
    const len = Math.hypot(mx, mz);
    if (len < 0.1) {
      // no direction held: backstep
      mx = -Math.sin(this.yaw);
      mz = -Math.cos(this.yaw);
    } else {
      mx /= len;
      mz /= len;
    }
    this.dashX = mx;
    this.dashZ = mz;
    this.setState('dash');
    this.invuln = Math.max(this.invuln, 0.2);
    this.dashCd = 0.55;
    this.dashQ = 0;
    this.emit(this, { type: 'dash' });
  }

  /** Dash wins over a buffered attack so "dash, then attack" pressed together gives a dash attack. */
  tryDash() {
    if (this.dashQ > 0 && this.dashCd <= 0 && this.def.dashSpeed) {
      this.startDash();
      return true;
    }
    return false;
  }

  update(dt) {
    const d = this.def;
    this.t += dt;
    // Buffered inputs only age while the fighter could act on them: a press made during a
    // dash, block-stun, or before a move's cancel window opens must still be there when the
    // moment to use it arrives.
    const early = this.state === 'attack' && this.move.cancel && this.t < this.move.cancel[0];
    const waiting = this.state === 'dash' || this.lock > 0 || early;
    if (!waiting) {
      if (this.queuedT > 0 && (this.queuedT -= dt) <= 0) this.queued = null;
      if (this.dashQ > 0) this.dashQ -= dt;
    }
    if (this.dashCd > 0) this.dashCd -= dt;
    if (this.invuln > 0) this.invuln -= dt;
    if (this.lock > 0) this.lock -= dt;
    if (this.stunImmune > 0) this.stunImmune -= dt;
    if (this.chainT > 0 && (this.chainT -= dt) <= 0) this.chain = 0;
    if (this.stunCool > 0) this.stunCool -= dt;
    else this.stunMeter = Math.max(0, this.stunMeter - 9 * dt);
    this.glow += (this.glowTarget - this.glow) * damp(6, dt);
    this.moving = false;

    switch (this.state) {
      case 'idle': {
        this.face(dt, d.turn);
        if (this.tryDash()) break;
        if (this.tryQueued()) break;
        if (this.intent.guard && this.guardMeter > 8) {
          this.setState('guard');
          break;
        }
        this.walk(dt, 1);
        break;
      }
      case 'guard': {
        this.face(dt, d.turn);
        if (this.lock > 0) break;
        if (this.tryDash()) break;
        if (this.tryQueued()) break;
        if (!this.intent.guard) {
          this.setState('idle');
          break;
        }
        this.walk(dt, 0.35);
        break;
      }
      case 'dash': {
        const k = 1 - this.t / d.dashTime;
        const sp = d.dashSpeed * (0.45 + 0.55 * k);
        this.pos.x += this.dashX * sp * dt;
        this.pos.z += this.dashZ * sp * dt;
        this.face(dt, d.turn * 0.5);
        if (this.queued && d.dashAttack && this.t > 0.05) {
          const forward = this.dashX * Math.sin(this.yaw) + this.dashZ * Math.cos(this.yaw);
          if (forward > 0.3 && (this.queued === 'light' || this.queued === 'heavy')) {
            this.queued = null;
            if (this.startMove(d.dashAttack)) break;
          }
        }
        if (this.t >= d.dashTime) this.setState('idle');
        break;
      }
      case 'attack':
        this.updateAttack(dt);
        break;
      case 'hit':
        if (this.t >= this.stun) this.setState('idle');
        break;
      case 'held':
        // the holder's throw decides when this ends; bail out if they let go
        if (!this.holder || this.holder.state !== 'attack' || !this.holder.move.throws) this.setState('idle');
        break;
      case 'down':
        if (this.t >= d.downTime) this.setState('getup');
        break;
      case 'getup':
        if (this.t >= d.getupTime) {
          this.setState('idle');
          this.invuln = 0.3;
          this.chain = 0;
        }
        break;
      case 'dizzy':
        if (this.t >= this.dizzyTime) {
          this.guardMeter = Math.max(this.guardMeter, 60);
          this.stunImmune = STUN_IMMUNITY;
          this.setState('idle');
        }
        break;
      default:
        break; // ko / win: hold the pose
    }

    // knockback: integrate the decaying velocity exactly, so the slide is the same at any frame rate
    const friction = Math.exp(-7 * dt);
    const slide = (1 - friction) / 7;
    this.pos.x += this.kvx * slide;
    this.pos.z += this.kvz * slide;
    this.kvx *= friction;
    this.kvz *= friction;
    if (this.state !== 'guard' && this.state !== 'dizzy') this.guardMeter = Math.min(100, this.guardMeter + 12 * dt);
  }

  updateAttack(dt) {
    const d = this.def;
    const m = this.move;
    if (this.t < (m.track ?? 0.15)) this.face(dt, d.turn * (m.trackRate ?? 0.7));
    if (m.lunge) {
      for (const [a, b, v] of m.lunge) {
        if (this.t >= a && this.t < b) {
          this.pos.x += Math.sin(this.yaw) * v * dt;
          this.pos.z += Math.cos(this.yaw) * v * dt;
        }
      }
    }
    if (m.events) {
      while (this.move === m && this.evDone < m.events.length && this.t >= m.events[this.evDone].t) {
        this.emit(this, m.events[this.evDone++]);
      }
      if (this.move !== m) return;
    }
    // charge moves: hold the button to climb levels, let go (or max out) to release.
    // A quick tap still fires the first level once its wind-up has played.
    if (m.hold) {
      if (!this.intent.charge) this.released = true;
      if ((this.released && this.t >= m.hold.levels[0].t) || this.t >= m.hold.max) {
        const level = this.chargeLevel();
        if (!level || !this.startMove(level.next)) this.setState('idle');
        return;
      }
    }
    if (this.queued && m.next && m.cancel && this.t >= m.cancel[0] && this.t <= m.cancel[1]) {
      const next = m.next[this.queued];
      if (next) {
        this.queued = null;
        if (this.startMove(next)) return;
      }
    }
    if (this.t >= m.dur) this.setState('idle');
  }

  /** The highest charge level reached (and affordable) in the current charge move, or null. */
  chargeLevel() {
    const hold = this.move?.hold;
    if (!hold) return null;
    let level = null;
    for (const l of hold.levels) if (this.t >= l.t && this.energy >= l.cost) level = l;
    return level;
  }

  walk(dt, factor) {
    const { mx, mz } = this.intent;
    const len = Math.hypot(mx, mz);
    if (len < 0.05) return;
    const k = Math.min(1, len);
    // retreating is slower than advancing
    const dot = (mx * Math.sin(this.yaw) + mz * Math.cos(this.yaw)) / len;
    const sp = this.def.speed * factor * (dot < -0.3 ? 0.72 : 1) * k;
    this.pos.x += (mx / len) * sp * dt;
    this.pos.z += (mz / len) * sp * dt;
    this.walkPhase += sp * dt * this.def.stride;
    const blend = damp(10, dt);
    this.stepFwd += (dot - this.stepFwd) * blend;
    this.stepSide += ((mx * Math.cos(this.yaw) - mz * Math.sin(this.yaw)) / len - this.stepSide) * blend;
    this.moving = true;
  }

  /**
   * Place the body and let it animate itself for the current state. Call after positions are
   * final for the frame. How a body animates is its own business: the hero's Rig blends our
   * pose clips, a monster's BeastBody plays the clips its model shipped with.
   */
  animate(dt, time) {
    this.rig.root.position.set(this.pos.x, 0, this.pos.z);
    this.rig.root.rotation.y = this.yaw;
    this.rig.drive(this, dt, time);
    this.visual?.(this, dt, time);
  }

  /** Grabbed by `holder`: frozen until their throw releases us. */
  hold(holder) {
    this.setState('held');
    this.holder = holder;
    this.kvx = this.kvz = 0;
  }

  /**
   * Resolve an incoming hit.
   * Returns 'miss' | 'block' | 'break' | 'armor' | 'grab' | 'otg' | 'hit' | 'stun' | 'ko'.
   * `h`: { dmg, knock, stun?, kd?, heavy?, guardDmg?, stunDmg?, pierce?, beam?, grab?, otg?, unblockable? }
   */
  takeHit(att, h) {
    let nx = this.pos.x - att.pos.x;
    let nz = this.pos.z - att.pos.z;
    const len = Math.hypot(nx, nz) || 1;
    nx /= len;
    nz /= len;
    const dmgBase = h.dmg * (att.def.dmgScale ?? 1);

    // pursuit attacks reach a fighter who is flat on the ground
    if (h.otg && this.state === 'down' && this.t > 0.45 && this.invuln <= 0) {
      this.hp -= dmgBase;
      if (this.hp <= 0) return this.die(nx, nz, 0);
      return 'otg';
    }
    if (!this.targetable) return 'miss';

    // a grab only catches someone who is standing still or guarding
    if (h.grab) return this.state === 'attack' || this.state === 'dash' ? 'miss' : 'grab';

    const facing = -(Math.sin(this.yaw) * nx + Math.cos(this.yaw) * nz) > 0.1;
    if (this.state === 'guard' && facing && !h.unblockable) {
      // chip damage never finishes a fighter off (and never raises a sliver of health either)
      this.hp = Math.max(Math.min(this.hp, 1), this.hp - dmgBase * 0.12);
      this.guardMeter -= h.guardDmg ?? h.dmg * 0.35;
      this.kvx = nx * h.knock * 0.5;
      this.kvz = nz * h.knock * 0.5;
      this.lock = BLOCK_LOCK;
      this.energy = Math.min(100, this.energy + dmgBase * 0.05);
      if (this.guardMeter <= 0) {
        this.guardMeter = 0;
        this.dizzyTime = GUARD_BREAK_TIME;
        this.setState('dizzy');
        return 'break';
      }
      return 'block';
    }

    const dizzy = this.state === 'dizzy';
    const dmg = dmgBase * Math.max(0.5, 1 - this.chain * 0.1) * (dizzy && h.beam ? 1.25 : 1);
    this.hp -= dmg;
    this.energy = Math.min(100, this.energy + dmg * 0.08);
    if (this.hp <= 0) return this.die(nx, nz, h.knock);

    const armor = this.state === 'attack' ? this.move.armor ?? 0 : 0;
    if (!h.pierce && armor >= (h.kd ? 2 : 1)) return 'armor';

    // beam ticks are one sustained attack: they neither build nor trip the stagger limit
    if (!h.beam) this.chain += 1;
    this.chainT = 1.1;
    this.kvx = nx * h.knock;
    this.kvz = nz * h.knock;
    if (h.kd || (!h.beam && this.chain >= CHAIN_LIMIT)) {
      this.knockDown(nx, nz, h.knock);
      return 'hit';
    }

    // stun gauge: fill it and the fighter is left reeling, wide open
    if (!dizzy && this.stunImmune <= 0) {
      this.stunMeter += h.stunDmg ?? h.dmg * 0.34;
      this.stunCool = 2.2;
      if (this.stunMeter >= 100) {
        this.stunMeter = 0;
        this.chain = 0;
        this.dizzyTime = STUN_TIME;
        this.setState('dizzy');
        return 'stun';
      }
    }
    if (dizzy) return 'hit'; // keep reeling, do not reset the timer with a flinch

    this.stun = (h.stun ?? 0.35) * Math.max(0.55, 1 - Math.max(0, this.chain - 1) * 0.12);
    this.heavy = isHeavy(h);
    this.setState('hit');
    return 'hit';
  }

  knockDown(nx, nz, knock) {
    this.kvx = nx * Math.max(knock, 16);
    this.kvz = nz * Math.max(knock, 16);
    this.chain = 0;
    this.setState('down');
  }

  die(nx, nz, knock) {
    this.hp = 0;
    this.kvx = nx * Math.max(knock, 14);
    this.kvz = nz * Math.max(knock, 14);
    this.setState('ko');
    return 'ko';
  }

  /** The end of a throw: always lands, always knocks down. */
  takeThrow(att, h) {
    const nx = Math.sin(att.yaw);
    const nz = Math.cos(att.yaw);
    this.hp -= h.dmg * (att.def.dmgScale ?? 1);
    if (this.hp <= 0) return this.die(nx, nz, h.knock);
    if (this.stunImmune <= 0) this.stunMeter = Math.min(95, this.stunMeter + (h.stunDmg ?? 0));
    this.stunCool = 2.2;
    this.knockDown(nx, nz, h.knock);
    return 'hit';
  }
}
