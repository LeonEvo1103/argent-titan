import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clamp, damp, TAU } from './util.js';

const _v = new THREE.Vector3();
const ease = (k) => k * k * (3 - 2 * k);
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

/** How quickly each fighter state cross-fades into its animation (higher = snappier). */
const BLEND = { idle: 10, guard: 18, dash: 18, attack: 20, hit: 26, held: 20, down: 14, getup: 10, dizzy: 9, ko: 14, win: 6 };

/** Load a glTF: its scene and the animation clips it carries. */
export async function loadModel(url) {
  const gltf = await loader.loadAsync(url);
  return { scene: gltf.scene, animations: gltf.animations };
}

/** Find a node by its base name, ignoring exporter suffixes such as "_042". */
export function findNode(root, base) {
  const re = new RegExp(`^${base}(_\\d+)?$`);
  let found = null;
  root.traverse((o) => {
    if (!found && re.test(o.name)) found = o;
  });
  if (!found) throw new Error(`node not found: ${base}`);
  return found;
}

/**
 * A fighter's body: a rigged model that plays skeletal animation clips.
 *
 * It picks the clip and clip time for whatever its Fighter is doing, cross-fades between
 * clips, and layers a few whole-body transforms on top for things a model has no clip for
 * (flinching, being hoisted, rolling over, a spinning tail sweep). The giant and the monsters
 * are both one of these; what differs is the `spec`:
 *
 * fit     how the model is scaled and placed. Either `scale` (the model's origin stands on the
 *         fighter's position), or `size` world units along `axis` measured in its idle pose,
 *         with `pivot` [x, z] the spot of its footprint (fractions of the idle bounding box)
 *         that stands on the fighter's position; `turn` yaws a model that does not face +Z.
 * points  named spots that gameplay follows (fists, mouth, tail tip...). A string names a bone.
 *         An [x, y, z] in fractions of the idle bounding box (x: its right to its left,
 *         y: ground to top, z: back to front) picks the nearest vertex of the model, followed
 *         through the skinning from then on - for models whose skeleton cannot be trusted
 *         (one of ours keeps its bones 100x smaller than its mesh).
 * states  animation per fighter state: { clip, from, to, speed, blend } plays a stretch of a
 *         clip once from the moment the state begins and holds its end; `loop` keeps cycling
 *         it; `stride: n` says the clip holds n walking strides, played as ground is covered
 *         (`rate` scales that for a gait with a shorter or longer stride than the forward
 *         walk); `reverse` plays it backwards (getting up = falling down, reversed); `shift`
 *         slides the body along its facing as it plays; `roll` / `rest` tip a beast with no
 *         fall animation onto its side. Optional variants: walkBack, strafeL, strafeR,
 *         dashBack, dashL, dashR, hitHeavy.
 * react   sizes of the whole-body overlays: flinch, guard, hoist, heldPitch.
 *
 * A move's animation is its `anim` (same fields as a state), plus `spin: [t0, t1]` (one full
 * turn of the whole body) and `lean: [[t, pitch, lift], ...]` (keyed pitch and lift).
 */
export class ClipBody {
  /** @param asset { scene, animations } @param spec see above */
  constructor(asset, spec) {
    this.spec = spec;
    this.root = new THREE.Group();
    this.tilt = new THREE.Group(); // whole-body overlay: flinch, roll, spin
    this.holder = new THREE.Group(); // scale + placement of the raw model
    this.root.add(this.tilt);
    this.tilt.add(this.holder);
    this.holder.add(asset.scene);
    this.holder.rotation.y = spec.fit.turn ?? 0;

    this.meshes = [];
    asset.scene.traverse((o) => {
      if (!o.isMesh) return;
      o.frustumCulled = false; // bounds are those of the bind pose
      this.meshes.push(o);
    });

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
    const idle = this.action(spec.states.idle.clip);
    idle.weight = 1;
    idle.time = spec.states.idle.from ?? 0;
    this.mixer.update(0);

    this.anchors = {};
    const spots = Object.entries(spec.points).filter(([name, at]) => {
      if (typeof at === 'string') this.anchors[name] = findNode(asset.scene, at);
      return typeof at !== 'string';
    });
    if (spec.fit.scale) {
      this.holder.scale.setScalar(spec.fit.scale);
    }
    if (!spec.fit.scale || spots.length) {
      // measure the model standing in its idle pose
      this.root.updateMatrixWorld(true);
      const cloud = this.vertexCloud();
      const box = new THREE.Box3();
      for (const c of cloud) for (let i = 0; i < c.points.length; i += 3) box.expandByPoint(_v.fromArray(c.points, i));
      const size = box.getSize(new THREE.Vector3());
      if (!spec.fit.scale) {
        const scale = spec.fit.size / size[spec.fit.axis];
        const [px, pz] = spec.fit.pivot ?? [0.5, 0.5];
        this.holder.scale.setScalar(scale);
        this.holder.position.set(-(box.min.x + size.x * px) * scale, -box.min.y * scale, -(box.min.z + size.z * pz) * scale);
      }
      for (const [name, at] of spots) {
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
    }

    this.phase = {}; // where each free-running loop has got to
    this.over = { rx: 0, rz: 0, y: 0, z: 0 };
  }

  action(name) {
    const a = this.actions[name];
    if (!a) throw new Error(`${this.spec.file}: no clip named "${name}" (have: ${Object.keys(this.actions).join(', ')})`);
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
    if (!a) throw new Error(`${this.spec.file}: no point named "${name}"`);
    if (a.isObject3D) return a.getWorldPosition(out);
    return a.mesh.getVertexPosition(a.index, out).applyMatrix4(a.mesh.matrixWorld);
  }

  /** Which animation fits what the fighter is doing. */
  animFor(f) {
    const S = this.spec.states;
    switch (f.state) {
      case 'attack':
        return f.move.anim;
      case 'idle':
        if (!f.moving) return S.idle;
        // which way it is stepping, relative to where it faces
        if (Math.abs(f.stepSide) > Math.abs(f.stepFwd)) return (f.stepSide > 0 ? S.strafeL : S.strafeR) ?? S.walk;
        return (f.stepFwd < -0.2 && S.walkBack) || S.walk;
      case 'dash': {
        const fwd = f.dashX * Math.sin(f.yaw) + f.dashZ * Math.cos(f.yaw);
        const side = f.dashX * Math.cos(f.yaw) - f.dashZ * Math.sin(f.yaw);
        if (Math.abs(side) > Math.abs(fwd)) return (side > 0 ? S.dashL : S.dashR) ?? S.dash;
        return (fwd < 0 && S.dashBack) || S.dash;
      }
      case 'hit':
        return (f.heavy && S.hitHeavy) || S.hit || S.idle;
      case 'ko':
        return S.ko ?? S.down;
      default:
        return S[f.state] ?? S.idle;
    }
  }

  /** Animate for the fighter's current state. Fighter.animate calls this once positions are final. */
  drive(f, dt, time) {
    const a = this.animFor(f);
    const act = this.action(a.clip);
    const from = a.from ?? 0;
    const to = a.to ?? act.getClip().duration;
    const speed = a.speed ?? 1;
    let clipTime;
    if (a.stride) {
      // walking is tied to the ground covered, so the feet do not slide: the clip holds
      // `stride` strides, and walkPhase turns once per stride of the forward walk
      clipTime = from + ((((f.walkPhase / TAU) * (a.rate ?? 1) + (a.offset ?? 0)) / a.stride) % 1) * (to - from);
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

    const k = damp(a.blend ?? BLEND[f.state] ?? 12, dt);
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
    const o = { rx: 0, ry: 0, rz: 0, y: 0, z: a.shift ? a.shift * ease(clamp(a.reverse ? 1 - f.t / f.def.getupTime : f.t / 0.6, 0, 1)) : 0 };
    const R = this.spec.react ?? {};
    const t = f.t;
    switch (f.state) {
      case 'hit': {
        const k = Math.max(0, 1 - t / 0.32) * (f.heavy ? 1.8 : 1);
        o.rx = -(R.flinch ?? 0.1) * k;
        o.z -= (R.recoil ?? 0.5) * k;
        o.rz = Math.sin(t * 46) * 0.03 * k;
        break;
      }
      case 'dizzy':
        o.rz = Math.sin(time * 3.1) * (R.sway ?? 0.07);
        o.rx = (R.sway ?? 0.07) * (1 + 0.6 * Math.sin(time * 4.3));
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
}
