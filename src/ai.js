import { pickWeighted, rand } from './util.js';

/**
 * Monster brain. Every `think` interval it picks a plan from its distance to the hero,
 * then steers by that plan until the next decision. It only talks to the fighter through
 * `intent` and `queueAttack`, exactly like the player's controller.
 *
 * Which moves suit which range is data on the moves themselves (`move.ai` in beasts.js):
 * { melee, mid, far } weights, scaled by aggression or (`by: 'ranged'`) by the stage's
 * taste for ranged attacks. Adding a move to a stage needs no change here.
 */
export class KaijuAI {
  constructor(fighter, profile) {
    this.f = fighter;
    this.p = profile;
    this.think = 0.8;
    this.cd = {};
    this.pending = null; // move we asked for and have not yet seen start
    this.mode = 'approach';
    this.strafe = 1;
    this.guardT = 0;
    this.roared = false;
  }

  can(id) {
    return (this.cd[id] ?? 0) <= 0;
  }

  use(id) {
    this.f.queueAttack(id);
    this.pending = id;
    this.mode = 'wait';
  }

  update(dt) {
    const f = this.f;
    const o = f.opponent;
    const p = this.p;
    for (const k in this.cd) this.cd[k] -= dt;
    f.intent.mx = f.intent.mz = 0;
    f.intent.guard = false;

    // A request only counts once the move has really started; one that expired in the
    // queue (blocked, staggered) costs no cooldown and may be asked for again.
    if (this.pending) {
      if (f.moveId === this.pending) {
        this.cd[this.pending] = f.move.cd ?? 1;
        this.pending = null;
      } else if (!f.queued) {
        this.pending = null;
      }
    }

    // below 40% health the monster flies into a rage; keep asking until the roar comes out
    const enraged = f.hp < f.def.maxHp * 0.4;
    if (enraged && !this.roared && f.alive) {
      if (f.moveId === 'roar') {
        this.roared = true;
        f.enraged = true;
        f.emit(f, { type: 'enrage' });
      } else if (f.ready) {
        f.queueAttack('roar');
      }
      return;
    }

    if (f.state !== 'idle' && f.state !== 'guard') return;

    const dx = o.pos.x - f.pos.x;
    const dz = o.pos.z - f.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    const nx = dx / d;
    const nz = dz / d;

    // react to what the hero is doing
    if (this.guardT <= 0 && o.state === 'attack') {
      const beam = !!o.move.beam || !!o.move.hold;
      const threat = beam ? p.beamGuard : d < 9 ? p.guard : 0;
      if (threat > 0 && Math.random() < threat * dt * 12) this.guardT = beam ? 1.6 : rand(0.4, 0.8);
    }
    if (this.guardT > 0) {
      this.guardT -= dt;
      if (f.guardMeter > 12) {
        f.intent.guard = true;
        return;
      }
      this.guardT = 0;
    }

    this.think -= dt;
    if (this.think <= 0) {
      this.think = rand(p.think[0], p.think[1]) / (enraged ? 1.35 : 1);
      this.decide(d, enraged);
    }

    switch (this.mode) {
      case 'approach':
        if (d > p.melee * 0.78) {
          f.intent.mx = nx;
          f.intent.mz = nz;
        }
        break;
      case 'circle':
        f.intent.mx = -nz * this.strafe + nx * (d > p.melee ? 0.5 : -0.1);
        f.intent.mz = nx * this.strafe + nz * (d > p.melee ? 0.5 : -0.1);
        break;
      case 'retreat':
        f.intent.mx = -nx;
        f.intent.mz = -nz;
        break;
      default:
        break;
    }
  }

  decide(d, enraged) {
    const p = this.p;
    const aggr = p.aggr * (enraged ? 1.3 : 1);
    const band = d < p.melee ? 'melee' : d < p.melee * 2.2 ? 'mid' : 'far';
    // a reeling hero is an open target: press the attack
    const press = this.f.opponent.state === 'dizzy' ? 2.5 : 1;

    const opts = [];
    for (const [id, m] of Object.entries(this.f.def.moves)) {
      const w = m.ai?.[band];
      if (w && this.can(id)) opts.push([w * press * (m.ai.by === 'ranged' ? p.ranged : aggr), id]);
    }
    if (band === 'melee') opts.push([1.2, '@circle'], [0.5, '@retreat']);
    else if (band === 'mid') opts.push([3.2, '@approach'], [0.8, '@circle']);
    else opts.push([2.6, '@approach'], [0.5, '@circle']);

    const choice = pickWeighted(opts);
    if (choice[0] === '@') {
      this.mode = choice.slice(1);
      this.strafe = Math.random() < 0.5 ? 1 : -1;
    } else {
      this.use(choice);
      this.think = Math.max(this.think, 0.25);
    }
  }
}
