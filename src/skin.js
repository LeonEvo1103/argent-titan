import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clamp } from './util.js';

const DOWN = new THREE.Vector3(0, -1, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const _q = new THREE.Quaternion();
const _p = new THREE.Quaternion();
const _r = new THREE.Quaternion();
const _v = new THREE.Vector3();

/** Load a rigged glTF: its scene, the (first) skinned mesh and any baked animation clips. */
export async function loadModel(url) {
  const gltf = await new GLTFLoader().loadAsync(url);
  let mesh = null;
  gltf.scene.traverse((o) => {
    if (o.isSkinnedMesh && !mesh) mesh = o;
  });
  if (!mesh) throw new Error(`${url}: no skinned mesh`);
  return { scene: gltf.scene, mesh, animations: gltf.animations };
}

/** Find a bone by its base name, ignoring exporter suffixes such as "_042". */
export function findBone(scene, base) {
  const re = new RegExp(`^${base}(_\\d+)?$`);
  let found = null;
  scene.traverse((o) => {
    if (!found && o.isBone && re.test(o.name)) found = o;
  });
  if (!found) throw new Error(`bone not found: ${base}`);
  return found;
}

/**
 * Makes a skinned model follow a proxy Rig.
 *
 * The game animates a simple FK rig (rig.js) whose joints rest at identity with limbs hanging
 * straight down. A real model's bones have arbitrary bind orientations (arms out in a T-pose,
 * bone axes along the bone, ...). For every linked bone we record, once, how its bind
 * orientation relates to the proxy joint's orientation in the pose where the two skeletons
 * line up; afterwards the bone simply copies whatever world rotation the joint has gone
 * through since. The pose library never needs to know what model it is driving.
 *
 * Link kinds (list parents before children):
 *  - { joint, bone }                 the bone keeps its bind orientation while the joint is at rest
 *  - { joint, bone, child }          limb segment: the joint's hanging-down rest direction is
 *                                    matched to the direction bone -> child
 *  - { joint, toward, mix, bone }    in-between bone (mid spine, neck): part-way from one joint's
 *                                    rotation to another's, so a bend is shared along the chain
 *  - { shoulder, chest, bone }       collarbone: lifts and rolls forward as the arm joint
 *                                    `shoulder` raises, like a real shoulder girdle
 *
 * Construct it while the proxy rig is in its zero pose with an identity root transform and
 * the model is in its bind pose.
 */
export class SkinDriver {
  /** @param hip { joint, bone } the bone whose position follows the proxy (the model's root of motion) */
  constructor(links, hip) {
    this.links = links.map((link) => {
      const { bone, child } = link;
      const bind = bone.getWorldQuaternion(new THREE.Quaternion());
      if (link.shoulder) {
        const side = Math.sign(bone.getWorldPosition(new THREE.Vector3()).x - link.chest.getWorldPosition(new THREE.Vector3()).x) || 1;
        return { ...link, side, offset: bind };
      }
      const reference = new THREE.Quaternion();
      if (child) {
        const dir = child.getWorldPosition(new THREE.Vector3()).sub(bone.getWorldPosition(new THREE.Vector3()));
        reference.setFromUnitVectors(DOWN, dir.normalize());
      }
      return { ...link, offset: reference.invert().multiply(bind) };
    });
    this.hip = hip;
  }

  sync() {
    for (const l of this.links) {
      if (l.shoulder) {
        // where the arm points, seen from the chest: +y up, +z forward
        l.chest.getWorldQuaternion(_q);
        l.shoulder.getWorldQuaternion(_p);
        _v.copy(DOWN).applyQuaternion(_p).applyQuaternion(_r.copy(_q).invert());
        const lift = clamp((Math.asin(clamp(_v.y, -1, 1)) + 0.55) * 0.36, 0, 0.55);
        const reach = clamp(_v.z, 0, 1) * 0.28;
        _r.setFromAxisAngle(AXIS_Z, l.side * lift);
        _q.multiply(_r).multiply(_r.setFromAxisAngle(AXIS_Y, -l.side * reach));
      } else {
        l.joint.getWorldQuaternion(_q);
        if (l.toward) _q.slerp(l.toward.getWorldQuaternion(_p), l.mix);
      }
      _q.multiply(l.offset);
      l.bone.parent.getWorldQuaternion(_p).invert();
      l.bone.quaternion.copy(_p.multiply(_q));
    }
    const { joint, bone } = this.hip;
    joint.getWorldPosition(_v);
    bone.parent.updateWorldMatrix(true, false);
    bone.position.copy(bone.parent.worldToLocal(_v));
  }
}
