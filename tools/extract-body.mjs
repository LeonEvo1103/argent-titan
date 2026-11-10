#!/usr/bin/env node
/**
 * Derive the hero's base body from a rigged character GLB.
 *
 *   node tools/extract-body.mjs <source.glb> public/models/titan-body.glb [--cut-above=0.862]
 *
 * Keeps ONE skinned mesh (the body) and the skeleton it is bound to, and drops everything
 * else: other meshes (mask, eyes, chest lamp), materials, textures, images, cameras and
 * animations. The game supplies its own materials, helmet and markings at runtime, so the
 * output carries geometry and bind data only.
 *
 * --cut-above=R removes every triangle that lies entirely above R x body height in the bind
 * pose, together with the vertices only those triangles used. With the arms out in a T-pose
 * only the head is up there, so this decapitates the mesh at the neck; the game puts its own
 * helmet on the stump.
 *
 * It also bakes a per-vertex `_CAVITY` attribute (-1 ridge .. +1 crease) from the bind-pose
 * surface curvature. The game's suit shader darkens creases and lifts ridges with it, which
 * brings out the muscle definition that flat colour would hide.
 *
 * The source's attribution (asset.extras from Sketchfab exports) is copied into the output
 * so the CC-BY credit travels with the file.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const [src, out] = args.filter((a) => !a.startsWith('--'));
const cutArg = args.find((a) => a.startsWith('--cut-above='));
const cutAbove = cutArg ? Number(cutArg.split('=')[1]) : null;
if (!src || !out || (cutArg && !(cutAbove > 0 && cutAbove < 1))) {
  console.error('usage: node tools/extract-body.mjs <source.glb> <output.glb> [--cut-above=0..1]');
  process.exit(1);
}

const KEEP_ATTRIBUTES = ['POSITION', 'NORMAL', 'TEXCOORD_0', 'JOINTS_0', 'WEIGHTS_0'];
const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/* ---- read ---- */
const file = readFileSync(src);
if (file.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB file');
const jsonLen = file.readUInt32LE(12);
const doc = JSON.parse(file.subarray(20, 20 + jsonLen).toString('utf8'));
const binStart = 20 + jsonLen + 8;
const bin = file.subarray(binStart, binStart + file.readUInt32LE(20 + jsonLen));

/** Copy an accessor's elements out of the source buffer, tightly packed. */
function readAccessor(index) {
  const a = doc.accessors[index];
  const view = doc.bufferViews[a.bufferView];
  const size = COMPONENT_BYTES[a.componentType] * TYPE_COUNT[a.type];
  const stride = view.byteStride || size;
  const base = (view.byteOffset || 0) + (a.byteOffset || 0);
  const data = Buffer.alloc(a.count * size);
  for (let i = 0; i < a.count; i++) bin.copy(data, i * size, base + i * stride, base + i * stride + size);
  return { a, data, size };
}

/* ---- pick the body: the skinned mesh with the most vertices ---- */
let bodyNode = -1;
let sourceVerts = 0;
doc.nodes.forEach((n, i) => {
  if (n.mesh === undefined || n.skin === undefined) return;
  const count = doc.accessors[doc.meshes[n.mesh].primitives[0].attributes.POSITION].count;
  if (count > sourceVerts) {
    sourceVerts = count;
    bodyNode = i;
  }
});
if (bodyNode < 0) throw new Error('no skinned mesh found');
const skin = doc.skins[doc.nodes[bodyNode].skin];
const prim = doc.meshes[doc.nodes[bodyNode].mesh].primitives[0];

/* ---- triangles: optionally cut the head off ---- */
const idx = readAccessor(prim.indices);
const readIndex = {
  5121: (i) => idx.data.readUInt8(i),
  5123: (i) => idx.data.readUInt16LE(i * 2),
  5125: (i) => idx.data.readUInt32LE(i * 4),
}[idx.a.componentType];
let tris = [];
for (let i = 0; i < idx.a.count; i++) tris.push(readIndex(i));

const position = readAccessor(prim.attributes.POSITION);
if (cutAbove !== null) {
  const y = (v) => position.data.readFloatLE(v * 12 + 4);
  const limit = position.a.min[1] + (position.a.max[1] - position.a.min[1]) * cutAbove;
  const kept = [];
  for (let i = 0; i < tris.length; i += 3) {
    if (y(tris[i]) > limit && y(tris[i + 1]) > limit && y(tris[i + 2]) > limit) continue;
    kept.push(tris[i], tris[i + 1], tris[i + 2]);
  }
  console.log(`cut above ${cutAbove}: removed ${(tris.length - kept.length) / 3} triangles`);
  tris = kept;
}

/* ---- drop vertices nothing references any more ---- */
const remap = new Int32Array(sourceVerts).fill(-1);
const order = [];
for (const v of tris) {
  if (remap[v] < 0) {
    remap[v] = order.length;
    order.push(v);
  }
}
tris = tris.map((v) => remap[v]);
const vertCount = order.length;

/* ---- repack into a fresh, tightly packed buffer ---- */
const chunks = [];
const accessors = [];
const bufferViews = [];
let offset = 0;

function addAccessor(def, data, target) {
  const pad = (4 - (data.length % 4)) % 4;
  const view = { buffer: 0, byteOffset: offset, byteLength: data.length };
  if (target) view.target = target;
  bufferViews.push(view);
  chunks.push(data, Buffer.alloc(pad));
  offset += data.length + pad;
  accessors.push({ ...def, bufferView: bufferViews.length - 1 });
  return accessors.length - 1;
}

const attributes = {};
for (const name of KEEP_ATTRIBUTES) {
  if (prim.attributes[name] === undefined) continue;
  const { a, data, size } = name === 'POSITION' ? position : readAccessor(prim.attributes[name]);
  const packed = Buffer.alloc(vertCount * size);
  order.forEach((v, i) => data.copy(packed, i * size, v * size, (v + 1) * size));
  const def = { componentType: a.componentType, count: vertCount, type: a.type };
  if (a.normalized) def.normalized = true;
  if (name === 'POSITION') {
    // glTF requires exact bounds on POSITION
    def.min = [Infinity, Infinity, Infinity];
    def.max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < vertCount; i++) {
      for (let c = 0; c < 3; c++) {
        const v = packed.readFloatLE(i * 12 + c * 4);
        def.min[c] = Math.min(def.min[c], v);
        def.max[c] = Math.max(def.max[c], v);
      }
    }
  }
  attributes[name] = addAccessor(def, packed, 34962);
}

/* ---- bake surface curvature: creases (+) and ridges (-) ---- */
{
  const P = (i, c) => position.data.readFloatLE(order[i] * 12 + c * 4);
  const normalAcc = readAccessor(prim.attributes.NORMAL);
  const N = (i, c) => normalAcc.data.readFloatLE(order[i] * 12 + c * 4);
  // vertices are duplicated along UV seams: weld by position so curvature crosses the seams
  const weld = new Map();
  const canon = new Int32Array(vertCount);
  const members = [];
  for (let i = 0; i < vertCount; i++) {
    const key = `${Math.round(P(i, 0) * 20)},${Math.round(P(i, 1) * 20)},${Math.round(P(i, 2) * 20)}`;
    if (!weld.has(key)) {
      weld.set(key, members.length);
      members.push([]);
    }
    canon[i] = weld.get(key);
    members[canon[i]].push(i);
  }
  const count = members.length;
  const neighbours = Array.from({ length: count }, () => new Set());
  for (let i = 0; i < tris.length; i += 3) {
    const a = canon[tris[i]];
    const b = canon[tris[i + 1]];
    const c = canon[tris[i + 2]];
    neighbours[a].add(b).add(c);
    neighbours[b].add(a).add(c);
    neighbours[c].add(a).add(b);
  }
  // how far the neighbourhood's centre sits above the tangent plane, relative to edge length
  let curve = new Float32Array(count);
  for (let v = 0; v < count; v++) {
    const i = members[v][0];
    const n = [0, 0, 0];
    for (const m of members[v]) for (let c = 0; c < 3; c++) n[c] += N(m, c);
    const nl = Math.hypot(n[0], n[1], n[2]) || 1;
    const mean = [0, 0, 0];
    let edge = 0;
    for (const w of neighbours[v]) {
      const j = members[w][0];
      const d = [P(j, 0) - P(i, 0), P(j, 1) - P(i, 1), P(j, 2) - P(i, 2)];
      edge += Math.hypot(d[0], d[1], d[2]);
      for (let c = 0; c < 3; c++) mean[c] += d[c];
    }
    const k = neighbours[v].size || 1;
    curve[v] = ((mean[0] * n[0] + mean[1] * n[1] + mean[2] * n[2]) / nl / k) / (edge / k || 1);
  }
  // a wider, softer copy for broad shading on top of the sharp local term
  let soft = Float32Array.from(curve);
  for (let pass = 0; pass < 8; pass++) {
    const next = new Float32Array(count);
    for (let v = 0; v < count; v++) {
      let sum = 0;
      for (const w of neighbours[v]) sum += soft[w];
      next[v] = soft[v] * 0.4 + (sum / (neighbours[v].size || 1)) * 0.6;
    }
    soft = next;
  }
  const cavity = Buffer.alloc(vertCount * 4);
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < vertCount; i++) {
    const v = canon[i];
    const value = Math.max(-1, Math.min(1, curve[v] * 2.4 + soft[v] * 9));
    lo = Math.min(lo, value);
    hi = Math.max(hi, value);
    cavity.writeFloatLE(value, i * 4);
  }
  attributes._CAVITY = addAccessor({ componentType: 5126, count: vertCount, type: 'SCALAR' }, cavity, 34962);
  console.log(`cavity: ${count} welded vertices, range ${lo.toFixed(2)} .. ${hi.toFixed(2)}`);
}

const wide = vertCount > 65535;
const indexData = Buffer.alloc(tris.length * (wide ? 4 : 2));
tris.forEach((v, i) => (wide ? indexData.writeUInt32LE(v, i * 4) : indexData.writeUInt16LE(v, i * 2)));
const indices = addAccessor({ componentType: wide ? 5125 : 5123, count: tris.length, type: 'SCALAR' }, indexData, 34963);

const ibm = readAccessor(skin.inverseBindMatrices);
const inverseBindMatrices = addAccessor({ componentType: ibm.a.componentType, count: ibm.a.count, type: ibm.a.type }, ibm.data);

/* ---- rebuild the document ---- */
const nodes = doc.nodes.map((n, i) => {
  const copy = { ...n };
  delete copy.camera;
  delete copy.mesh;
  delete copy.skin;
  if (i === bodyNode) {
    copy.mesh = 0;
    copy.skin = 0;
  }
  return copy;
});

const source = doc.asset?.extras ?? {};
const result = {
  asset: {
    version: '2.0',
    generator: 'argent-titan tools/extract-body.mjs',
    extras: {
      title: 'Titan base body (derived work)',
      changes: 'Body mesh and skeleton only. Head, mask, eyes, chest lamp, materials, textures, cameras removed.',
      derivedFrom: { title: source.title, author: source.author, license: source.license, source: source.source },
    },
  },
  scene: 0,
  scenes: [{ nodes: doc.scenes[doc.scene ?? 0].nodes }],
  nodes,
  meshes: [{ name: 'Body', primitives: [{ attributes, indices, mode: prim.mode ?? 4 }] }],
  skins: [{ joints: skin.joints, skeleton: skin.skeleton, inverseBindMatrices }],
  accessors,
  bufferViews,
  buffers: [{ byteLength: offset }],
};

/* ---- write ---- */
let json = Buffer.from(JSON.stringify(result), 'utf8');
json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
const body = Buffer.concat(chunks);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + json.length + 8 + body.length, 8);
const jsonHead = Buffer.alloc(8);
jsonHead.writeUInt32LE(json.length, 0);
jsonHead.writeUInt32LE(0x4e4f534a, 4);
const binHead = Buffer.alloc(8);
binHead.writeUInt32LE(body.length, 0);
binHead.writeUInt32LE(0x004e4942, 4);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([header, jsonHead, json, binHead, body]));
console.log(`body: ${vertCount} of ${sourceVerts} vertices, ${tris.length / 3} triangles, ${skin.joints.length} joints`);
console.log(`wrote ${out} (${((12 + 16 + json.length + body.length) / 1024).toFixed(0)} KB)`);
