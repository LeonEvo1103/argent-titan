/**
 * Pose helpers. A pose is { jointName: [rx, ry, rz], ..., y: liftAboveGround }.
 * Poses built from the same base stance always share the same keys.
 */

/** How a keyframe is approached: 'io' settles at both ends (default), 'in' accelerates into it
 *  (a strike landing), 'out' decelerates (a recovery), 'snap' gets there fast then eases. */
const EASE = {
  io: (k) => k * k * (3 - 2 * k),
  in: (k) => k * k,
  out: (k) => 1 - (1 - k) * (1 - k),
  snap: (k) => 1 - (1 - k) ** 3,
  lin: (k) => k,
};

export function mix(a, b, k) {
  const out = {};
  for (const j in a) {
    const p = a[j];
    if (typeof p === 'number') {
      out[j] = p + ((b[j] ?? 0) - p) * k;
      continue;
    }
    const q = b[j] || p;
    out[j] = [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k, p[2] + (q[2] - p[2]) * k];
  }
  return out;
}

/** Keyframed clip: frames = [[time, pose, ease?], ...] sorted by time; `ease` shapes the approach to that frame. */
export function kf(frames) {
  const last = frames[frames.length - 1];
  return (t) => {
    if (t <= frames[0][0]) return frames[0][1];
    for (let i = 1; i < frames.length; i++) {
      if (t < frames[i][0]) {
        const [t0, p0] = frames[i - 1];
        const [t1, p1, ease] = frames[i];
        return mix(p0, p1, (EASE[ease] ?? EASE.io)((t - t0) / (t1 - t0)));
      }
    }
    return last[1];
  };
}

/** Add per-joint offsets on top of a pose (procedural overlays like breathing). */
export function add(pose, delta) {
  const out = { ...pose };
  for (const j in delta) {
    const d = delta[j];
    if (typeof d === 'number') {
      out[j] = (pose[j] ?? 0) + d;
    } else {
      const p = pose[j] || [0, 0, 0];
      out[j] = [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
    }
  }
  return out;
}

/** Swap left/right joints and flip the sideways components. */
export function mirror(pose) {
  const out = {};
  for (const j in pose) {
    const p = pose[j];
    if (typeof p === 'number') {
      out[j] = p;
      continue;
    }
    const last = j[j.length - 1];
    const name = last === 'L' ? j.slice(0, -1) + 'R' : last === 'R' ? j.slice(0, -1) + 'L' : j;
    out[name] = [p[0], -p[1], -p[2]];
  }
  return out;
}
