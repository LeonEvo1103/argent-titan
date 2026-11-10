import * as THREE from 'three';
import { clamp, damp, TAU } from './util.js';

const _v = new THREE.Vector3();
const ease = (k) => k * k * (3 - 2 * k);

/**
 * A monster built from a rigged, animated glTF.
 *
 * Unlike the hero (posed joint by joint by our own clips), a beast plays the animation clips
 * its model shipped with. This class picks the clip and clip time for whatever the Fighter is
 * doing, cross-fades between clips, and layers a few whole-body transforms on top for the
 * things no model animates (flinching, being thrown, rolling over, a spinning tail sweep).
 *
 * It offers the same surface a Rig does (`root`, `world(name)`), so Fighter and Game treat
 * hero and monsters alike; `drive()` replaces the pose pipeline.
 *
 * Gameplay points (mouth, weapon head, tail tip...) are vertices of the model, followed
 * through the skinning each frame. Bones would be cheaper, but exporters disagree about bone
 * space (one of our models keeps its skeleton 100x smaller than its mesh); a vertex is always
 * where the player sees it.
 */
export class BeastBody {
  /** @param asset { scene, animations } from loadModel(); @param spec one entry of BEASTS (beasts.js) */
  constructor(asset, spec) {
    this.spec = spec;
    this.root = new THREE.Group();
    this.tilt = new THREE.Group(); // whole-body overlay: flinch, roll, spin
    this.holder = new THREE.Group(); // scale + placement of the raw model
    this.root.add(this.tilt);
    this.tilt.add(this.holder);
    this.holder.add(asset.scene);
    this.holder.rotation.y = spec.fit.turn ?? 0; // for models that do not face +Z

    this.meshes = [];
    this.materials = new Set();
    asset.scene.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.frustumCulled = false; // bounds are those of the bind pose
      this.meshes.push(o);
      this.materials.add(o.material);
      if (o.material.transparent) {
        // hair cards and the like: cut-out instead of blended, so they sort and shadow properly
        o.material.transparent = false;
        o.material.alphaTest = 0.5;
        o.material.depthWrite = true;
      }
    });
    this.glowColor = new THREE.Color(spec.glow);

    this.mixer = new THREE.AnimationMixer(asset.scene);
    this.actions = {};
    for (const clip of asset.animations) {
      // Morph-target tracks are dropped: in one export their deltas are in the wrong space and
      // blow the mesh up, and none of our models needs them.
      clip.tracks = clip.tracks.filter((t) => !t.name.endsWith('.morphTargetInfluences'));
      // exporters often leave every clip at its offset on one shared timeline
      let start = Infinity;
      for (const t of clip.tracks) start = Math.min(start, t.times[0]);
      if (start > 0) for (const t of clip.tracks) for (let i = 0; i < t.times.length; i++) t.times[i] -= start;
      clip.resetDuration();
      const action = this.mixer.clipAction(clip);
      action.play();
      action.weight = 0;
      this.actions[clip.name] = action;
    }

    // measure the model standing in its idle pose, then scale and place it
    const idle = this.action(spec.states.idle.clip);
    idle.weight = 1;
    idle.time = spec.states.idle.from ?? 0;
    this.mixer.update(0);
    this.root.updateMatrixWorld(true);
    const cloud = this.vertexCloud();
    const box = new THREE.Box3();
    for (const c of cloud) for (let i = 0; i < c.points.length; i += 3) box.expandByPoint(_v.fromArray(c.points, i));
    const size = box.getSize(new THREE.Vector3());
    const scale = spec.fit.size / size[spec.fit.axis];
    // the spot of its footprint that stands on the fighter's position (a long beast is
    // better pivoted under its shoulders than under its belly)
    const [px, pz] = spec.fit.pivot ?? [0.5, 0.5];
    this.holder.scale.setScalar(scale);
    this.holder.position.set(-(box.min.x + size.x * px) * scale, -box.min.y * scale, -(box.min.z + size.z * pz) * scale);

    // named points: the vertex nearest to a spot given as fractions of the idle bounding box
    this.anchors = {};
    for (const [name, at] of Object.entries(spec.points)) {
      const target = new THREE.Vector3(box.min.x + size.x * at[0], box.min.y + size.y * at[1], box.min.z + size.z * at[2]);
      let best = null;
      let bestD = Infinity;
      for (const c of cloud) {
        for (let i = 0; i < c.points.length; i += 3) {
          const d = _v.fromArray(c.points, i).distanceToSquared(target);
          if (d < bestD) {
            bestD = d;
            best = { mesh: c.mesh, index: i / 3 };
          }
        }
      }
      this.anchors[name] = best;
    }

    this.phase = {}; // where each free-running loop has got to
    this.over = { rx: 0, rz: 0, y: 0, z: 0 };
  }

  action(name) {
    const a = this.actions[name];
    if (!a) throw new Error(`${this.spec.url}: no clip named "${name}" (have: ${Object.keys(this.actions).join(', ')})`);
    return a;
  }

  /** World position of every vertex in the current pose, per mesh. */
  vertexCloud() {
    return this.meshes.map((mesh) => {
      const n = mesh.geometry.attributes.position.count;
      const points = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        mesh.getVertexPosition(i, _v).applyMatrix4(mesh.matrixWorld);
        points[i * 3] = _v.x;
        points[i * 3 + 1] = _v.y;
        points[i * 3 + 2] = _v.z;
      }
      return { mesh, points };
    });
  }

  world(name, out) {
    const a = this.anchors[name];
    if (!a) throw new Error(`${this.spec.url}: no point named "${name}"`);
    return a.mesh.getVertexPosition(a.index, out).applyMatrix4(a.mesh.matrixWorld);
  }

  /**
   * Which animation fits what the fighter is doing:
   * { clip, from?, to?, speed?, blend?, loop?, stride?, offset?, reverse?, shift?, roll?, rest? } (see beasts.js)
   */
  animFor(f) {
    const S = this.spec.states;
    if (f.state === 'attack') return f.move.anim;
    if (f.state === 'idle') return f.moving ? S.walk : S.idle;
    if (f.state === 'ko') return S.ko ?? S.down;
    return S[f.state] ?? S.idle;
  }

  /** Called by Fighter.animate in place of the pose pipeline. */
  drive(f, dt, time) {
    const a = this.animFor(f);
    const act = this.action(a.clip);
    const from = a.from ?? 0;
    const to = a.to ?? act.getClip().duration;
    const speed = a.speed ?? 1;
    let clipTime;
    if (a.stride) {
      // walking is tied to the ground covered, so the feet do not slide: the clip holds
      // `stride` strides, and walkPhase turns once per stride
      clipTime = from + (((f.walkPhase / TAU + (a.offset ?? 0)) / a.stride) % 1) * (to - from);
    } else if (a.loop) {
      this.phase[a.clip] = ((this.phase[a.clip] ?? 0) + dt * speed) % (to - from);
      clipTime = from + this.phase[a.clip];
    } else if (a.reverse) {
      clipTime = to - f.t * speed;
    } else {
      clipTime = from + f.t * speed;
    }
    // (an action sitting exactly on its clip's end would wrap round to the start)
    clipTime = clamp(clipTime, from, to - 1e-3);

    const k = damp(a.blend ?? 12, dt);
    for (const other of Object.values(this.actions)) {
      const want = other === act ? 1 : 0;
      other.weight += (want - other.weight) * k;
      if (want === 0 && other.weight < 0.002) other.weight = 0;
    }
    act.time = clipTime;
    this.mixer.update(0);

    // whole-body overlay: smoothed, except the spin which must not unwind when it completes
    const o = this.overlay(f, a, time);
    const s = damp(14, dt);
    const cur = this.over;
    cur.rx += (o.rx - cur.rx) * s;
    cur.rz += (o.rz - cur.rz) * s;
    cur.y += (o.y - cur.y) * s;
    cur.z += (o.z - cur.z) * s;
    this.tilt.rotation.set(cur.rx, o.ry, cur.rz);
    this.tilt.position.set(0, cur.y, cur.z);
    this.root.updateMatrixWorld(true);
  }

  /** Whole-body motion for things the model has no clip for. rx > 0 pitches the nose down. */
  overlay(f, a, time) {
    // `shift`: slide the body along its facing as the clip plays (a fall that would land it
    // far from where the fighter is counted to be)
    const o = { rx: 0, ry: 0, rz: 0, y: 0, z: a.shift ? a.shift * ease(clamp((a.reverse ? 1 - f.t / f.def.getupTime : f.t / 0.6), 0, 1)) : 0 };
    const R = this.spec.react ?? {};
    const t = f.t;
    switch (f.state) {
      case 'hit': {
        const k = Math.max(0, 1 - t / 0.32) * (f.heavy ? 1.8 : 1);
        o.rx = -(R.flinch ?? 0.1) * k;
        o.z -= 0.5 * k;
        o.rz = Math.sin(t * 46) * 0.03 * k;
        break;
      }
      case 'dizzy':
        o.rz = Math.sin(time * 3.1) * 0.07;
        o.rx = 0.07 + Math.sin(time * 4.3) * 0.04;
        break;
      case 'guard':
        o.rx = R.guard ?? 0.12;
        break;
      case 'held': {
        const k = Math.min(1, (f.holder?.t ?? 0) / 0.5);
        o.y = (R.hoist ?? 2.2) * k;
        o.rx = -(R.heldPitch ?? 0.45) * k;
        break;
      }
      case 'down':
      case 'ko':
        if (a.roll) {
          const k = ease(Math.min(1, t / 0.45));
          o.rz = a.roll * k;
          o.y = (a.rest ?? 0) * k;
        }
        break;
      case 'getup':
        if (a.roll) {
          const k = 1 - ease(Math.min(1, t / f.def.getupTime));
          o.rz = a.roll * k;
          o.y = (a.rest ?? 0) * k;
        }
        break;
      case 'attack': {
        const m = f.move;
        if (m.spin) o.ry = TAU * ease(clamp((t - m.spin[0]) / (m.spin[1] - m.spin[0]), 0, 1));
        if (m.lean) {
          // [[time, pitch, lift?], ...] : a hand-keyed lunge for models without an attack clip
          const L = m.lean;
          let i = 1;
          while (i < L.length - 1 && t > L[i][0]) i++;
          const k = ease(clamp((t - L[i - 1][0]) / (L[i][0] - L[i - 1][0]), 0, 1));
          o.rx = L[i - 1][1] + (L[i][1] - L[i - 1][1]) * k;
          o.y = (L[i - 1][2] ?? 0) + ((L[i][2] ?? 0) - (L[i - 1][2] ?? 0)) * k;
        }
        break;
      }
      default:
        break;
    }
    return o;
  }

  /** Per-frame cosmetics: the hide glows while it winds up a special, and pulses when enraged. */
  visual(f, dt, time) {
    const alive = f.state === 'ko' ? Math.max(0, 1 - f.t * 0.6) : 1;
    const rage = f.enraged ? 0.5 + 0.5 * Math.sin(time * 9) : 0;
    // the tint covers the whole textured hide, so a little goes a long way
    const glow = (f.glow * 0.14 + rage * 0.06) * alive;
    for (const m of this.materials) m.emissive.copy(this.glowColor).multiplyScalar(glow);
    f.aura = (5 + rage * 16 + f.glow * 80) * alive;
  }
}

/** Fighter definition for one stage's monster. `stage` is a STAGES entry, `beast` its BEASTS entry. */
export function makeBeastDef(stage, beast) {
  return {
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
}
