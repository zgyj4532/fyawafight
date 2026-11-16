// 一次性测量：归一化到游戏里的高度/缩放之后，取 y∈[0.40,1.50] 的顶点，
// 看占地是一团还是两根柱。只读 glTF 的 POSITION，不走贴图加载。
import fs from 'fs';
import * as THREE from '../models/hero/viewer/node_modules/three/build/three.module.js';

const ROOT = 'models/env/body/';
const Y0 = 0.40;
const Y1 = 1.50;

const JOBS = [
  { key: 'well', file: 'stone_well.glb', height: 1.69 },
  { key: 'pillar', file: 'ruins_pillar.glb', height: 2.50 },
  { key: 'stones', file: 'standing_stones.glb', height: 2.78 },
  { key: 'archLow', file: 'ruins_arch_low.glb', height: 3.00 },
  { key: 'gallows', file: 'gallows.glb', height: 3.85 },
  { key: 'arch', file: 'ruins_arch.glb', height: 4.95, reshape: [1.25, 1, 0.60] },
  { key: 'tower', file: 'watchtower_ruin.glb', height: 6.00 },
  { key: 'cart', file: 'overturned_handcart.glb', height: 1.30 },
  { key: 'cage', file: 'cage_cart.glb', scale: 1.20, yaw: Math.PI },
  { key: 'sealCrate', file: 'sealed_crate.glb', scale: 2.00 },
  { key: 'trough', file: 'cultivation_trough.glb', scale: 1.80, yaw: 0.10 },
];

function readGltf(file) {
  const buf = fs.readFileSync(file);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
  const binStart = 20 + jsonLen + 8;
  const bin = buf.subarray(binStart);
  return { json, bin };
}

function nodeMatrix(node) {
  const m = new THREE.Matrix4();
  if (node.matrix) return m.fromArray(node.matrix);
  const t = node.translation || [0, 0, 0];
  const r = node.rotation || [0, 0, 0, 1];
  const s = node.scale || [1, 1, 1];
  const pos = new THREE.Vector3(t[0], t[1], t[2]);
  const quat = new THREE.Quaternion(r[0], r[1], r[2], r[3]);
  const scl = new THREE.Vector3(s[0], s[1], s[2]);
  return m.compose(pos, quat, scl);
}

function positionsOf(json, bin) {
  const out = [];
  const scenes = json.scenes || [];
  const scene = scenes[json.scene || 0] || scenes[0];
  const walk = (index, parent) => {
    const node = json.nodes[index];
    const world = new THREE.Matrix4().multiplyMatrices(parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      const mesh = json.meshes[node.mesh];
      for (const prim of mesh.primitives) {
        const acc = json.accessors[prim.attributes.POSITION];
        const view = json.bufferViews[acc.bufferView];
        const stride = view.byteStride || 12;
        const start = (view.byteOffset || 0) + (acc.byteOffset || 0);
        const v = new THREE.Vector3();
        for (let i = 0; i < acc.count; i++) {
          const o = start + i * stride;
          v.set(bin.readFloatLE(o), bin.readFloatLE(o + 4), bin.readFloatLE(o + 8));
          v.applyMatrix4(world);
          out.push(v.x, v.y, v.z);
        }
      }
    }
    for (const child of node.children || []) walk(child, world);
  };
  const ident = new THREE.Matrix4();
  for (const root of scene.nodes || []) walk(root, ident);
  return out;
}

function boundsOf(pts) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i], y = pts[i + 1], z = pts[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

// 顺序对齐 pipeline.js：先按高度缩放并贴地居中，再 reshape 顶点，再居中一次。
// 证据层的 yaw / scale 在这之后，和 pivot.rotation.y、pivot.scale 一致。
function fit(raw, job) {
  const b0 = boundsOf(raw);
  const h = b0.maxY - b0.minY;
  const modelScale = job.height && h > 0 ? job.height / h : 1;
  const heighted = [];
  for (let i = 0; i < raw.length; i += 3) {
    heighted.push(raw[i] * modelScale, raw[i + 1] * modelScale, raw[i + 2] * modelScale);
  }
  const b1 = boundsOf(heighted);
  const ox = (b1.minX + b1.maxX) / 2;
  const oz = (b1.minZ + b1.maxZ) / 2;
  const [rx, ry, rz] = job.reshape || [1, 1, 1];
  const reshaped = [];
  for (let i = 0; i < heighted.length; i += 3) {
    reshaped.push((heighted[i] - ox) * rx, (heighted[i + 1] - b1.minY) * ry, (heighted[i + 2] - oz) * rz);
  }
  const b2 = boundsOf(reshaped);
  const cx = (b2.minX + b2.maxX) / 2;
  const cz = (b2.minZ + b2.maxZ) / 2;
  const pivot = job.scale || 1;
  const yaw = job.yaw || 0;
  const c = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const band = [];
  for (let i = 0; i < reshaped.length; i += 3) {
    const x = (reshaped[i] - cx) * pivot;
    const y = (reshaped[i + 1] - b2.minY) * pivot;
    const z = (reshaped[i + 2] - cz) * pivot;
    const wx = x * c + z * sn;
    const wz = -x * sn + z * c;
    if (y < Y0 || y > Y1) continue;
    band.push(wx, wz);
  }
  return band;
}

function aabb(pts) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i], z = pts[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return {
    cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2,
    hx: (maxX - minX) / 2, hz: (maxZ - minZ) / 2,
    w: maxX - minX, d: maxZ - minZ,
  };
}

function clusters(pts, cell = 0.28) {
  const buckets = new Map();
  for (let i = 0; i < pts.length; i += 2) {
    const k = `${Math.floor(pts[i] / cell)},${Math.floor(pts[i + 1] / cell)}`;
    let b = buckets.get(k);
    if (!b) { b = []; buckets.set(k, b); }
    b.push(pts[i], pts[i + 1]);
  }
  const seen = new Set();
  const groups = [];
  for (const start of buckets.keys()) {
    if (seen.has(start)) continue;
    const stack = [start];
    seen.add(start);
    const acc = [];
    while (stack.length) {
      const k = stack.pop();
      acc.push(...buckets.get(k));
      const [ix, iz] = k.split(',').map(Number);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const n = `${ix + dx},${iz + dz}`;
          if (buckets.has(n) && !seen.has(n)) { seen.add(n); stack.push(n); }
        }
      }
    }
    if (acc.length >= 12) groups.push(acc);
  }
  return groups.sort((a, b) => b.length - a.length);
}

function circleOf(pts) {
  const box = aabb(pts);
  let max = 0;
  for (let i = 0; i < pts.length; i += 2) {
    const d = Math.hypot(pts[i] - box.cx, pts[i + 1] - box.cz);
    if (d > max) max = d;
  }
  return { n: pts.length / 2, cx: +box.cx.toFixed(3), cz: +box.cz.toFixed(3),
    hx: +box.hx.toFixed(3), hz: +box.hz.toFixed(3), r: +max.toFixed(3) };
}

for (const job of JOBS) {
  const { json, bin } = readGltf(ROOT + job.file);
  const raw = positionsOf(json, bin);
  const band = fit(raw, job);
  const box = band.length ? aabb(band) : null;
  const groups = clusters(band);
  const bins = [];
  if (band.length) {
    const box0 = aabb(band);
    const step = 0.25;
    for (let x = box0.cx - box0.hx; x < box0.cx + box0.hx; x += step) {
      let n = 0;
      for (let i = 0; i < band.length; i += 2) {
        if (band[i] >= x && band[i] < x + step) n++;
      }
      bins.push(n);
    }
  }
  console.log(JSON.stringify({
    key: job.key,
    verts: band.length / 2,
    aabb: box && {
      cx: +box.cx.toFixed(3), cz: +box.cz.toFixed(3),
      hx: +box.hx.toFixed(3), hz: +box.hz.toFixed(3),
      w: +box.w.toFixed(3), d: +box.d.toFixed(3),
    },
    clusters: groups.slice(0, 5).map(circleOf),
    xBins: bins,
  }));
}
