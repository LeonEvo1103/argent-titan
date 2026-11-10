import * as THREE from 'three';
import { damp, TAU } from './util.js';

const ZERO = [0, 0, 0];
const _v = new THREE.Vector3();

/** How quickly each fighter state's pose is chased (higher = snappier). */
const POSE_RATE = { idle: 10, guard: 20, dash: 18, attack: 24, hit: 26, held: 22, down: 13, getup: 11, dizzy: 9, ko: 13, win: 6 };

/**
 * A tiny forward-kinematics rig: named joints (Groups) posed by Euler triples.
 *
 * Conventions (model faces +Z, Y up, "L" side is +X):
 *  - limbs hang down -Y from their joint; rx < 0 swings them forward, rx > 0 backward
 *  - upward segments (spine, neck) lean forward with rx > 0
 *  - rz > 0 swings a hanging limb toward +X
 *  - ry > 0 turns toward +X (left)
 *
 * After each pose the rig is dropped onto the ground by its lowest contact point,
 * so crouches, kicks and lying poses all rest on y = 0 without any IK.
 */
export class Rig {
  constructor() {
    this.root = new THREE.Group();
    this.body = new THREE.Group();
    this.root.add(this.body);
    this.joints = { body: this.body };
    this.cur = { body: [0, 0, 0] };
    this.points = {};
    this.contacts = [];
    this.lift = 0;
    /** Called at the end of every apply(), e.g. to make a skinned model follow the joints. */
    this.onPosed = null;
  }

  joint(name, parent, x = 0, y = 0, z = 0) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    parent.add(g);
    this.joints[name] = g;
    this.cur[name] = [0, 0, 0];
    return g;
  }

  /** A named marker. With a contact radius it also takes part in grounding. */
  point(name, parent, x = 0, y = 0, z = 0, contactRadius) {
    const o = new THREE.Object3D();
    o.position.set(x, y, z);
    parent.add(o);
    this.points[name] = o;
    if (contactRadius !== undefined) this.contacts.push({ o, r: contactRadius });
    return o;
  }

  /** Blend the current pose toward `pose` by factor k (1 = snap), then re-ground. */
  apply(pose, k) {
    for (const name in this.joints) {
      const target = pose[name] || ZERO;
      const cur = this.cur[name];
      if (name === 'body') {
        // full-body spins end a whole turn away from rest: unwrap instead of unwinding
        while (target[1] - cur[1] > Math.PI) cur[1] += TAU;
        while (target[1] - cur[1] < -Math.PI) cur[1] -= TAU;
      }
      cur[0] += (target[0] - cur[0]) * k;
      cur[1] += (target[1] - cur[1]) * k;
      cur[2] += (target[2] - cur[2]) * k;
      this.joints[name].rotation.set(cur[0], cur[1], cur[2]);
    }
    this.lift += ((pose.y || 0) - this.lift) * k;

    const s = this.root.scale.y;
    this.body.position.y = 0;
    this.root.updateMatrixWorld(true);
    let minY = Infinity;
    for (const c of this.contacts) {
      const y = c.o.getWorldPosition(_v).y - c.r * s;
      if (y < minY) minY = y;
    }
    if (minY === Infinity) minY = 0;
    this.body.position.y = (this.root.position.y - minY) / s + this.lift;
    this.root.updateMatrixWorld(true);
    this.onPosed?.();
  }

  world(name, out) {
    return (this.points[name] || this.joints[name]).getWorldPosition(out);
  }

  /**
   * Pose the rig for whatever fighter `f` is doing, from the pose clips in its definition
   * (`def.clips` for states, `move.clip` for attacks). Fighter.animate calls this on any body.
   */
  drive(f, dt, time) {
    const c = f.def.clips;
    let fn;
    let t = f.t;
    let rate = POSE_RATE[f.state] ?? 12;
    switch (f.state) {
      case 'idle':
        fn = f.moving ? c.walk : c.idle;
        t = time;
        break;
      case 'attack':
        fn = f.move.clip;
        rate = f.move.rate ?? rate;
        break;
      case 'hit':
        fn = f.heavy ? c.hitHeavy : c.hit;
        break;
      case 'held':
        fn = c.held ?? c.hitHeavy;
        break;
      case 'ko':
        fn = c.down;
        break;
      default:
        fn = c[f.state]; // guard, dash, down, getup, dizzy, win
    }
    this.apply(fn(t, f), damp(rate, dt));
  }
}
