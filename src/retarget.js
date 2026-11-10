import * as THREE from 'three';

const FPS = 30;
const _q = new THREE.Quaternion();
const _p = new THREE.Quaternion();
const _v = new THREE.Vector3();

/**
 * Re-key an animation clip made for one humanoid skeleton onto another.
 *
 * Both skeletons must rest in the same pose (ours: a T-pose, upright, facing +Z); their bone
 * axes, proportions and bone counts may differ. For every linked bone, the rotation the
 * source bone has gone through since its rest pose - measured in world space, so the two
 * rigs' bone axes never meet - is applied to the target bone's rest orientation. The hips
 * also follow the source hips' travel, scaled by how much taller the target stands, and with
 * any travel of the source's root taken out, so every clip plays on the spot.
 *
 * With `mirror`, the motion is flipped left to right (a right-handed punch becomes a
 * left-handed one): each source bone then drives the target bone on the other side.
 *
 * @param source  root of the source skeleton, in its rest pose
 * @param clip    a clip for that skeleton
 * @param links   [{ from, to, twin }] source bone -> target bone (and that bone's opposite
 *                number, itself for the spine), parents before children; the hips first
 * @param root    the source bone that carries root motion, if any
 * @returns a clip for the target skeleton (which is left in its rest pose)
 */
export function retargetClip(source, clip, links, root, { name = clip.name, mirror = false } = {}) {
  source.updateMatrixWorld(true);
  if (mirror) links = links.map(({ from, twin }) => ({ from, to: twin }));
  const rest = links.map(({ from, to }) => ({
    from: from.getWorldQuaternion(new THREE.Quaternion()).invert(),
    to: to.getWorldQuaternion(new THREE.Quaternion()),
    local: to.quaternion.clone(),
  }));
  const hips = links[0];
  const hipsFrom = hips.from.getWorldPosition(new THREE.Vector3());
  const hipsTo = hips.to.getWorldPosition(new THREE.Vector3());
  const hipsLocal = hips.to.position.clone();
  const rootRest = root ? root.getWorldPosition(new THREE.Vector3()) : null;
  const scale = hipsTo.y / hipsFrom.y;

  const mixer = new THREE.AnimationMixer(source);
  const action = mixer.clipAction(clip);
  action.play();
  const frames = Math.max(2, Math.round(clip.duration * FPS) + 1);
  const times = new Float32Array(frames);
  const turns = links.map(() => new Float32Array(frames * 4));
  const travel = new Float32Array(frames * 3);

  for (let i = 0; i < frames; i++) {
    times[i] = (i / (frames - 1)) * clip.duration;
    action.time = Math.min(times[i], clip.duration - 1e-4);
    mixer.update(0);
    source.updateMatrixWorld(true);
    links.forEach(({ from, to }, k) => {
      from.getWorldQuaternion(_q).multiply(rest[k].from); // how far it has turned from rest, in world space
      if (mirror) _q.set(_q.x, -_q.y, -_q.z, _q.w);
      _q.multiply(rest[k].to);
      to.quaternion.copy(to.parent.getWorldQuaternion(_p).invert().multiply(_q));
      to.quaternion.toArray(turns[k], i * 4);
    });
    hips.from.getWorldPosition(_v).sub(hipsFrom);
    if (root) {
      // on the spot: drop whatever ground the root itself covers
      const drift = root.getWorldPosition(new THREE.Vector3()).sub(rootRest);
      _v.x -= drift.x;
      _v.z -= drift.z;
    }
    if (mirror) _v.x = -_v.x;
    _v.multiplyScalar(scale).add(hipsTo);
    hips.to.parent.updateWorldMatrix(true, false);
    hips.to.parent.worldToLocal(_v).toArray(travel, i * 3);
  }

  mixer.stopAllAction();
  mixer.uncacheRoot(source);
  links.forEach(({ to }, k) => to.quaternion.copy(rest[k].local));
  hips.to.position.copy(hipsLocal);

  const tracks = links.map(({ to }, k) => new THREE.QuaternionKeyframeTrack(`${to.name}.quaternion`, times, turns[k]));
  tracks.push(new THREE.VectorKeyframeTrack(`${hips.to.name}.position`, times, travel));
  return new THREE.AnimationClip(name, clip.duration, tracks);
}

/**
 * A clip that takes some bones from one clip and the rest from another: legs that walk under
 * a guard that stays up. `upper` is looped to cover the length of `base`.
 * @param bones names of the bones to take from `upper`
 */
export function layerClips(name, base, upper, bones) {
  const take = new Set(bones.map((b) => `${b}.quaternion`));
  const tracks = base.tracks.filter((t) => !take.has(t.name));
  for (const track of upper.tracks) {
    if (!take.has(track.name)) continue;
    const frames = Math.max(2, Math.round(base.duration * FPS) + 1);
    const times = new Float32Array(frames);
    const values = new Float32Array(frames * 4);
    const sample = track.createInterpolant();
    for (let i = 0; i < frames; i++) {
      times[i] = (i / (frames - 1)) * base.duration;
      values.set(sample.evaluate(times[i] % upper.duration), i * 4);
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(track.name, times, values));
  }
  return new THREE.AnimationClip(name, base.duration, tracks);
}
