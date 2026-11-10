// Packs the city kit models the game uses into one GLB, and marks their windows.
//
//   node tools/pack-city.mjs <raw-assets dir> public/models/city.glb [--stats]
//
// Input: Kenney's City Kit (Commercial, Industrial, Suburban, Roads) and Car Kit, unzipped as
// <raw-assets>/kenney-<kit>/files/. Each kit model is a few hundred to a few thousand
// triangles coloured from one small palette texture per kit.
//
// Output: one mesh per model, named "<kit>_<model>", its nodes flattened into a single
// primitive, with the kit's palette embedded. Normals, texture coordinates and `_LIT` are
// stored quantized (KHR_mesh_quantization), which roughly halves the file.
//
// Building meshes get a `_LIT` vertex attribute: 0 everywhere except on window glass, where
// every vertex of one pane carries the same random number - in (0, 0.5) for an ordinary
// window, in (0.5, 1] for a large sheet of glass (a tower's curtain wall), which the game
// divides into storeys itself. The game turns that into windows lit or dark one by one (see
// arena.js). Street lights record where their lamps are in the node's `extras.lamps`.
//
// --stats prints, per model, its size, triangle count and which palette cells it uses.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const [srcDir, outFile] = process.argv.slice(2);
const STATS = process.argv.includes('--stats');
if (!srcDir || !outFile) {
  console.error('usage: node tools/pack-city.mjs <raw-assets dir> <out.glb> [--stats]');
  process.exit(1);
}

/**
 * What goes into the pack. `windows`: look for window glass (buildings only). `lamps`: the
 * palette cell that street-light lamps are coloured from. `skip`: nodes left out - a car's
 * wheels are half its triangles, and at the size cars are drawn nobody can see them.
 */
const KITS = [
  {
    kit: 'commercial',
    windows: true,
    models: [...'abcdefghijklmn'.split('').map((c) => `building-${c}`), ...'abcde'.split('').map((c) => `building-skyscraper-${c}`)],
  },
  { kit: 'industrial', windows: true, models: 'abdghijkopst'.split('').map((c) => `building-${c}`) },
  { kit: 'suburban', windows: false, models: ['tree-large', 'tree-small'] },
  { kit: 'roads', windows: false, lamps: '4,2', models: ['road-straight', 'road-crossroad', 'light-curved'] },
  {
    kit: 'cars',
    windows: false,
    skip: /^wheel/,
    models: ['sedan', 'taxi', 'police', 'suv', 'hatchback-sports', 'van', 'delivery', 'truck', 'firetruck', 'ambulance', 'garbage-truck'],
  },
];

/* ------------------------------- reading ------------------------------- */

function readGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: not a GLB`);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const binStart = 20 + jsonLen + 8;
  const bin = buf.subarray(binStart, binStart + buf.readUInt32LE(20 + jsonLen));
  return { json, bin };
}

const COMPONENTS = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function accessor({ json, bin }, index) {
  const acc = json.accessors[index];
  const view = json.bufferViews[acc.bufferView];
  const Type = COMPONENTS[acc.componentType];
  const width = WIDTH[acc.type];
  const stride = view.byteStride ?? Type.BYTES_PER_ELEMENT * width;
  const start = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const out = new Type(acc.count * width);
  const data = new DataView(bin.buffer, bin.byteOffset + start);
  const read = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' }[acc.componentType];
  for (let i = 0; i < acc.count; i++) {
    for (let k = 0; k < width; k++) out[i * width + k] = data[read](i * stride + k * Type.BYTES_PER_ELEMENT, true);
  }
  return out;
}

/* 4x4 matrices, column-major like glTF */
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function multiply(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}
function local(node) {
  if (node.matrix) return node.matrix;
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

/** Every triangle of a model, node transforms applied: { position, normal, uv, index }. */
function flatten(glb, skip) {
  const { json } = glb;
  const position = [];
  const normal = [];
  const uv = [];
  const index = [];
  const visit = (i, parent) => {
    const node = json.nodes[i];
    const m = multiply(parent, local(node));
    if (node.mesh !== undefined && !skip?.test(node.name)) {
      for (const prim of json.meshes[node.mesh].primitives) {
        const p = accessor(glb, prim.attributes.POSITION);
        const n = accessor(glb, prim.attributes.NORMAL);
        const t = accessor(glb, prim.attributes.TEXCOORD_0);
        const base = position.length / 3;
        for (let v = 0; v < p.length; v += 3) {
          const [x, y, z] = [p[v], p[v + 1], p[v + 2]];
          position.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
          // (the kits only translate and turn their parts, so normals transform like directions)
          const [a, b, c] = [n[v], n[v + 1], n[v + 2]];
          const nx = m[0] * a + m[4] * b + m[8] * c;
          const ny = m[1] * a + m[5] * b + m[9] * c;
          const nz = m[2] * a + m[6] * b + m[10] * c;
          const len = Math.hypot(nx, ny, nz) || 1;
          normal.push(nx / len, ny / len, nz / len);
        }
        uv.push(...t);
        for (const k of accessor(glb, prim.indices)) index.push(base + k);
      }
    }
    for (const child of node.children ?? []) visit(child, m);
  };
  for (const root of json.scenes[json.scene ?? 0].nodes) visit(root, IDENTITY);
  return { position, normal, uv, index };
}

/** A PNG's pixels as RGBA bytes (8-bit, non-interlaced: all the kit palettes are). */
function decodePng(buf) {
  let at = 8;
  let header = null;
  let palette = null;
  const data = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString('ascii', at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') header = { w: body.readUInt32BE(0), h: body.readUInt32BE(4), depth: body[8], color: body[9], interlace: body[12] };
    else if (type === 'PLTE') palette = body;
    else if (type === 'IDAT') data.push(body);
    at += 12 + len;
  }
  const { w, h, depth, color, interlace } = header;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  if (depth !== 8 || interlace || !channels) throw new Error('unsupported PNG variant');
  const raw = zlib.inflateSync(Buffer.concat(data));
  const stride = w * channels;
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const left = x >= channels ? px[y * stride + x - channels] : 0;
      const up = y ? px[(y - 1) * stride + x] : 0;
      const corner = y && x >= channels ? px[(y - 1) * stride + x - channels] : 0;
      let pred = 0;
      if (filter === 1) pred = left;
      else if (filter === 2) pred = up;
      else if (filter === 3) pred = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner;
        const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - corner)];
        pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      }
      px[y * stride + x] = (v + pred) & 255;
    }
  }
  const rgba = Buffer.alloc(w * h * 4, 255);
  for (let i = 0; i < w * h; i++) {
    const s = i * channels;
    if (color === 3) palette.copy(rgba, i * 4, px[s] * 3, px[s] * 3 + 3);
    else if (color === 0 || color === 4) rgba.fill(px[s], i * 4, i * 4 + 3);
    else px.copy(rgba, i * 4, s, s + 3);
  }
  return { w, h, rgba };
}

/* ------------------------------- windows ------------------------------- */

/**
 * The palettes are laid out in 64 x 128 pixel cells, one colour each (a flat half and a shaded
 * half). Window glass is the pale blue and the mid blue: tell them by the hue of the flat half.
 */
const CELL_W = 64;
const CELL_H = 128;
function glassCells(png) {
  const cells = new Set();
  for (let row = 0; row < png.h / CELL_H; row++) {
    for (let col = 0; col < png.w / CELL_W; col++) {
      const i = ((row * CELL_H + CELL_H / 2) * png.w + col * CELL_W + CELL_W / 4) * 4;
      const [r, g, b] = [png.rgba[i], png.rgba[i + 1], png.rgba[i + 2]];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max !== b || max - min < 30 || b < 190) continue;
      const hue = 60 * (4 + (r - g) / (max - min));
      if (hue > 195 && hue < 224) cells.add(`${col},${row}`);
    }
  }
  return cells;
}

const cellOf = (png, u, v) => `${Math.min(png.w / CELL_W - 1, Math.floor((u * png.w) / CELL_W))},${Math.min(png.h / CELL_H - 1, Math.floor((v * png.h) / CELL_H))}`;

function hash(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Groups of triangles coloured from the palette cells in `cells` that touch each other (the
 * kits do not share vertices between faces, so "touch" means "have a corner at the same
 * place"). Returns one list of vertex indices per group.
 */
function islands(soup, png, cells) {
  const parent = new Map();
  const find = (k) => {
    while (parent.get(k) !== k) {
      parent.set(k, parent.get(parent.get(k)));
      k = parent.get(k);
    }
    return k;
  };
  const key = (v) => `${Math.round(soup.position[v * 3] * 1e4)},${Math.round(soup.position[v * 3 + 1] * 1e4)},${Math.round(soup.position[v * 3 + 2] * 1e4)}`;
  const tris = [];
  for (let t = 0; t < soup.index.length; t += 3) {
    const tri = [soup.index[t], soup.index[t + 1], soup.index[t + 2]];
    const u = (soup.uv[tri[0] * 2] + soup.uv[tri[1] * 2] + soup.uv[tri[2] * 2]) / 3;
    const v = (soup.uv[tri[0] * 2 + 1] + soup.uv[tri[1] * 2 + 1] + soup.uv[tri[2] * 2 + 1]) / 3;
    if (!cells.has(cellOf(png, u, v))) continue;
    const keys = tri.map(key);
    for (const k of keys) if (!parent.has(k)) parent.set(k, k);
    parent.set(find(keys[1]), find(keys[0]));
    parent.set(find(keys[2]), find(keys[0]));
    tris.push(tri);
  }
  const groups = new Map();
  for (const tri of tris) {
    const root = find(key(tri[0]));
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(...tri);
  }
  return [...groups.values()];
}

/** Smallest and largest corner of a set of vertices. */
function bounds(soup, vertices) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const v of vertices) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], soup.position[v * 3 + k]);
      max[k] = Math.max(max[k], soup.position[v * 3 + k]);
    }
  }
  return { min, max };
}

/** One byte per vertex: 0, or for window glass a value shared by the whole pane (see the top of this file). */
function bakeWindows(soup, panes, seed) {
  const lit = new Uint8Array(soup.position.length / 3);
  panes.forEach((pane, i) => {
    const { min, max } = bounds(soup, pane);
    const large = max[1] - min[1] > 0.35 || Math.hypot(max[0] - min[0], max[2] - min[2]) > 0.5;
    const value = (large ? 0.52 : 0.02) + (large ? 0.48 : 0.46) * hash(seed * 31 + i);
    for (const v of pane) lit[v] = Math.round(value * 255);
  });
  return lit;
}

/* ------------------------------- packing ------------------------------- */

const chunks = [];
let byteLength = 0;
const out = {
  asset: { version: '2.0', generator: 'argent-titan tools/pack-city.mjs', extras: { source: 'Kenney City Kit (Commercial, Industrial, Suburban, Roads) and Car Kit, www.kenney.nl, CC0' } },
  scene: 0,
  scenes: [{ nodes: [] }],
  nodes: [],
  meshes: [],
  materials: [],
  textures: [],
  images: [],
  extensionsUsed: ['KHR_mesh_quantization'],
  extensionsRequired: ['KHR_mesh_quantization'],
  samplers: [{ magFilter: 9729, minFilter: 9729 }],
  accessors: [],
  bufferViews: [],
  buffers: [],
};

function view(bytes, target) {
  const pad = (4 - (byteLength % 4)) % 4;
  if (pad) {
    chunks.push(Buffer.alloc(pad));
    byteLength += pad;
  }
  out.bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.length, ...(target ? { target } : {}) });
  chunks.push(bytes);
  byteLength += bytes.length;
  return out.bufferViews.length - 1;
}

const COMPONENT_OF = new Map([[Float32Array, 5126], [Uint32Array, 5125], [Uint16Array, 5123], [Uint8Array, 5121], [Int8Array, 5120]]);

/** Store a typed array as an accessor. `extra` adds accessor fields (min/max, normalized). */
function attribute(array, type, extra = {}, isIndex = false) {
  out.accessors.push({
    bufferView: view(Buffer.from(array.buffer, array.byteOffset, array.byteLength), isIndex ? 34963 : 34962),
    componentType: COMPONENT_OF.get(array.constructor),
    count: array.length / WIDTH[type],
    type,
    ...extra,
  });
  return out.accessors.length - 1;
}

/** Vertex data needs each element to start on a 4-byte boundary: pad 3-wide bytes out to 4. */
function padded(values, Type, width, scale) {
  const o = new Type((values.length / width) * 4);
  for (let i = 0; i < values.length / width; i++) for (let k = 0; k < width; k++) o[i * 4 + k] = Math.round(values[i * width + k] * scale);
  return o;
}

let total = 0;
for (const { kit, windows, lamps, skip, models } of KITS) {
  const dir = path.join(srcDir, `kenney-${kit}`, 'files', 'Models', 'GLB format');
  const pngBytes = fs.readFileSync(path.join(dir, 'Textures', 'colormap.png'));
  const png = decodePng(pngBytes);
  const glass = windows ? glassCells(png) : new Set();

  out.images.push({ bufferView: view(pngBytes), mimeType: 'image/png', name: kit });
  out.textures.push({ sampler: 0, source: out.images.length - 1 });
  out.materials.push({ name: kit, doubleSided: true, pbrMetallicRoughness: { baseColorTexture: { index: out.textures.length - 1 }, metallicFactor: 0, roughnessFactor: 0.85 } });
  const material = out.materials.length - 1;
  if (STATS) console.log(`\n== ${kit}  glass cells: ${[...glass].join(' ') || '-'}`);

  for (const model of models) {
    const soup = flatten(readGlb(path.join(dir, `${model}.glb`)), skip);
    const count = soup.position.length / 3;
    const { min, max } = bounds(soup, Array.from({ length: count }, (_, i) => i));
    const panes = islands(soup, png, glass);
    const attributes = {
      POSITION: attribute(new Float32Array(soup.position), 'VEC3', { min, max }),
      NORMAL: attribute(padded(soup.normal, Int8Array, 3, 127), 'VEC3', { normalized: true, count }), // (4 bytes per normal, 3 used)
      TEXCOORD_0: attribute(new Uint16Array(soup.uv.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 65535))), 'VEC2', { normalized: true }),
    };
    if (windows) attributes._LIT = attribute(bakeWindows(soup, panes, out.meshes.length + 1), 'SCALAR', { normalized: true });
    out.bufferViews[out.accessors[attributes.NORMAL].bufferView].byteStride = 4;
    const indices = attribute(count < 65536 ? new Uint16Array(soup.index) : new Uint32Array(soup.index), 'SCALAR', {}, true);
    out.meshes.push({ name: `${kit}_${model}`, primitives: [{ attributes, indices, material }] });

    const node = { name: `${kit}_${model}`, mesh: out.meshes.length - 1 };
    if (lamps && model.startsWith('light-')) {
      // where each lamp is: the middle of each patch of lamp-coloured faces
      node.extras = {
        lamps: islands(soup, png, new Set([lamps])).map((lamp) => {
          const b = bounds(soup, lamp);
          return b.min.map((v, k) => +((v + b.max[k]) / 2).toFixed(4));
        }),
      };
    }
    out.nodes.push(node);
    out.scenes[0].nodes.push(out.nodes.length - 1);
    total += soup.index.length / 3;

    if (STATS) {
      const used = new Map();
      for (let t = 0; t < soup.index.length; t += 3) {
        const a = soup.index[t];
        const c = cellOf(png, soup.uv[a * 2], soup.uv[a * 2 + 1]);
        used.set(c, (used.get(c) ?? 0) + 1);
      }
      const size = max.map((v, i) => (v - min[i]).toFixed(2)).join(' x ');
      const cells = [...used].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}:${n}`).join(' ');
      console.log(`${model.padEnd(28)} ${size.padEnd(20)} tris=${String(soup.index.length / 3).padEnd(5)} panes=${String(panes.length).padEnd(4)} ${node.extras ? JSON.stringify(node.extras) : ''} cells ${cells}`);
    }
  }
}

const bin = Buffer.concat(chunks);
out.buffers.push({ byteLength: bin.length });
let json = Buffer.from(JSON.stringify(out), 'utf8');
json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
const binPad = Buffer.alloc((4 - (bin.length % 4)) % 4);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length + binPad.length, 8);
const chunkHead = (len, type) => {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(len, 0);
  b.writeUInt32LE(type, 4);
  return b;
};
fs.writeFileSync(outFile, Buffer.concat([header, chunkHead(json.length, 0x4e4f534a), json, chunkHead(bin.length + binPad.length, 0x004e4942), bin, binPad]));
console.log(`${outFile}: ${out.meshes.length} models, ${total} triangles, ${(fs.statSync(outFile).size / 1024).toFixed(0)} KB`);
