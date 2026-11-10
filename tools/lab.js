/**
 * Authoring aid for monsters (dev server only). In the browser console:
 *
 *   const lab = await import('/tools/lab.js');
 *   lab.sheet(0, [['sweep', 0.3], ['sweep', 0.5], ['down', 0.6]], { views: ['side', 'front'] });
 *   lab.clip(0, 'attack1', [0, 0.2, 0.4, 0.6]);   // a raw clip, by clip time
 *   lab.box(0);                 // idle bounding box, overall and per mesh
 *   lab.frac(0, [-3.4, 1.3, 4]) // a spot in world units -> the fractions `points` wants
 *
 * `sheet` freezes the game and draws stage N's monster once per [moveOrState, time] entry, in
 * a grid, with its named points marked; it returns where those points were in each cell.
 */
const g = window.__game;
const T = window.__THREE;

const VIEWS = {
  front: [[0, 6, 50], [0, 5.5, 0]],
  side: [[54, 6, 0], [0, 5.5, 0]],
  back: [[0, 6, -50], [0, 5.5, 0]],
  top: [[0, 70, 0], [0, 0, 0]],
  quarter: [[30, 10, 40], [0, 5.5, 0]],
};
const COLORS = [0xff2020, 0x20ff20, 0x3060ff, 0xffff20, 0xff20ff, 0x20ffff, 0xffffff];
const markers = [];
const round = (v) => [v.x, v.y, v.z].map((n) => +n.toFixed(1));

function summon(stage) {
  document.querySelectorAll('.overlay, #hud, #banner').forEach((e) => (e.style.display = 'none'));
  if (g.kaiju !== g.roster[stage]) g.startStage(stage, true);
  g.paused = true;
  g.dirty = false;
  return g.kaiju;
}

function freeze(f, id, t) {
  const move = f.def.moves[id];
  f.state = move ? 'attack' : id === 'walk' ? 'idle' : id;
  f.move = move ?? null;
  f.t = t;
  f.moving = id === 'walk';
  if (id === 'walk') f.walkPhase = t * Math.PI * 2; // for walking, `t` counts strides
  f.animate(100, t);
}

/** opts: { views: names or [[camera], [lookAt]] pairs, cycled per cell; cols; fov; yaw; hero: [x, z]; marks } */
export function sheet(stage, frames, opts = {}) {
  const k = summon(stage);
  k.pos.set(0, 0, 0);
  k.yaw = opts.yaw ?? 0;
  const hero = g.hero;
  hero.rig.root.visible = !!opts.hero;
  if (opts.hero) {
    hero.pos.set(opts.hero[0], 0, opts.hero[1]);
    hero.yaw = Math.atan2(-hero.pos.x, -hero.pos.z);
    freeze(hero, 'idle', 0);
  }

  const r = g.renderer;
  const size = r.getSize(new T.Vector2());
  const cols = opts.cols ?? Math.min(frames.length, 6);
  const rows = Math.ceil(frames.length / cols);
  const cw = size.x / cols;
  const ch = size.y / rows;
  const cam = new T.PerspectiveCamera(opts.fov ?? 30, cw / ch, 0.5, 500);
  const views = (opts.views ?? ['side']).map((v) => VIEWS[v] ?? v);
  const names = Object.keys(k.rig.anchors);
  const out = [];

  r.setScissorTest(true);
  frames.forEach(([id, t], i) => {
    freeze(k, id, t);
    for (const m of markers) m.visible = false;
    const at = {};
    names.forEach((name, j) => {
      const m = (markers[j] ??= new T.Mesh(new T.SphereGeometry(0.3, 8, 6), new T.MeshBasicMaterial({ color: COLORS[j % COLORS.length], depthTest: false })));
      m.renderOrder = 999;
      m.visible = opts.marks !== false;
      g.scene.add(m);
      at[name] = round(k.rig.world(name, m.position));
    });
    out.push(at);
    const [from, look] = views[i % views.length];
    cam.up.set(0, from[0] === 0 && from[2] === 0 ? 0 : 1, from[0] === 0 && from[2] === 0 ? 1 : 0);
    cam.position.fromArray(from);
    cam.lookAt(look[0], look[1], look[2]);
    const x = (i % cols) * cw;
    const y = size.y - (Math.floor(i / cols) + 1) * ch;
    r.setViewport(x, y, cw, ch);
    r.setScissor(x, y, cw, ch);
    r.render(g.scene, cam);
  });
  r.setScissorTest(false);
  r.setViewport(0, 0, size.x, size.y);
  for (const m of markers) m.visible = false;
  hero.rig.root.visible = true;
  return out;
}

/** Draw the raw clip `name` at the given clip times, to find the stretches worth using. */
export function clip(stage, name, times, opts) {
  const k = summon(stage);
  k.def.moves.__clip = { anim: { clip: name } };
  const out = sheet(stage, times.map((t) => ['__clip', t]), opts);
  delete k.def.moves.__clip;
  return out;
}

function idleBox(stage) {
  const k = summon(stage);
  k.pos.set(0, 0, 0);
  k.yaw = 0;
  k.rig.phase = {};
  freeze(k, 'idle', 0);
  const all = new T.Box3();
  const per = {};
  const v = new T.Vector3();
  for (const c of k.rig.vertexCloud()) {
    const b = new T.Box3();
    for (let i = 0; i < c.points.length; i += 3) b.expandByPoint(v.fromArray(c.points, i));
    all.union(b);
    per[c.mesh.name] = [round(b.min), round(b.max)];
  }
  return { all, per };
}

export function box(stage) {
  const { all, per } = idleBox(stage);
  return { all: [round(all.min), round(all.max)], per };
}

export function frac(stage, p) {
  const { all } = idleBox(stage);
  const s = all.getSize(new T.Vector3());
  return [(p[0] - all.min.x) / s.x, (p[1] - all.min.y) / s.y, (p[2] - all.min.z) / s.z].map((n) => +n.toFixed(2));
}

/**
 * Measure the walk clip on point `foot`: how many strides the clip holds (`stride` in the walk
 * state), the ground one stride covers (`strideLength`), and where in a stride that foot comes
 * down (`offset`, so footfall dust lands with the left foot).
 */
export function stride(stage, foot = 'footL', steps = 240) {
  const k = summon(stage);
  k.pos.set(0, 0, 0);
  k.yaw = 0;
  const walk = k.rig.spec.states.walk;
  const saved = { stride: walk.stride, offset: walk.offset };
  walk.stride = 1; // sample the whole clip as if it were one stride
  walk.offset = 0;
  const v = new T.Vector3();
  const pts = [];
  for (let i = 0; i < steps; i++) {
    freeze(k, 'walk', i / steps);
    pts.push(k.rig.world(foot, v).clone());
  }
  Object.assign(walk, saved);
  const lo = Math.min(...pts.map((p) => p.y));
  const hi = Math.max(...pts.map((p) => p.y));
  const up = pts.map((p) => p.y > lo + (hi - lo) * 0.4);
  const plants = [];
  for (let i = 0; i < steps; i++) if (up[(i + steps - 1) % steps] && !up[i]) plants.push(i / steps);
  const zs = pts.map((p) => p.z);
  const strides = plants.length;
  return {
    strides,
    strideLength: +(Math.max(...zs) - Math.min(...zs)).toFixed(2),
    offset: +((plants[0] ?? 0) * strides).toFixed(2),
    lift: +(hi - lo).toFixed(2),
  };
}
