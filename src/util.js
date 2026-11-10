export const TAU = Math.PI * 2;

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Frame-rate independent smoothing factor. */
export const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

export const rand = (a = 1, b) => (b === undefined ? Math.random() * a : a + Math.random() * (b - a));

/** Shortest signed angle from a to b. */
export function angDiff(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Deterministic PRNG so the city layout is the same every run. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick from [[weight, value], ...]. Returns undefined when the list is empty. */
export function pickWeighted(options) {
  let total = 0;
  for (const [w] of options) total += w;
  if (total <= 0) return undefined;
  let r = Math.random() * total;
  for (const [w, v] of options) {
    r -= w;
    if (r <= 0) return v;
  }
  return options[options.length - 1][1];
}
