// 区块 7 · 纹章贴片
// 给 Boss 胸甲挂一件 18 mm 厚的浮雕纹章，运行时生成，不改 GLB。
//
// 用法（等 Boss 渲染就绪后调用一次）：
//   const emblem = await attachEmblem(bossRoot);
//   // bossRoot = 加载归一化后的 GLB scene，需包含 SkinnedMesh 与名为 Chest 的骨骼
//   // Boss 死亡 / 换场时：emblem.dispose();
//
// 参数与三次失败记录见 docs/剧情_小刻与骑士团.md §9.1。

import * as THREE from 'three';
import { preloadedImage } from './pipeline.js';

export const EMBLEM_DEFAULTS = {
  url: 'assets/emblem_knight.png',

  // 尺寸按 1.8 m 身高标定，运行时会按 Boss 实际包围盒等比换算
  refHeight: 1.8,
  width: 0.15,
  height: 0.175,
  liftY: 0.012,

  // 壳体
  thickness: 0.018,
  innerOffset: 0.0015,
  chamferCells: 2.5,   // 边缘厚度收拢所需的格数，越小边缘越陡、越容易出现阶梯

  // 采样
  cols: 64,
  rows: 74,
  alphaMin: 40,        // 盾形外不生成几何
  rayDepth: 0.75,
  normalMinZ: 0.15,    // 只取正面朝外的面

  // 拟合：残差取该分位后整体抬升，把整块纹章压到最凸甲片之外
  liftPercentile: 0.90,
  liftPad: 0.0012,

  // 骨骼与材质
  chestBone: 'chest',
  faceRoughness: 0.72,
  faceMetalness: 0.06,
  shellColor: 0x9aa0a5,
  shellRoughness: 0.48,
  shellMetalness: 0.46,
};

// ---------- 贴图与 alpha ----------

async function loadEmblemImage(url) {
  const cached = preloadedImage(url);
  let image = null;
  if (cached) {
    try {
      image = await cached;
    } catch {
      image = null;
    }
  }
  if (!image) image = await new THREE.ImageLoader().loadAsync(url);
  const tex = new THREE.Texture(image);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;

  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

  // three 默认 flipY，UV 的 v 向上、图像 y 向下
  const alphaAt = (u, v) => {
    const x = Math.min(canvas.width - 1, Math.max(0, Math.round(u * (canvas.width - 1))));
    const y = Math.min(canvas.height - 1, Math.max(0, Math.round((1 - v) * (canvas.height - 1))));
    return data[(y * canvas.width + x) * 4 + 3];
  };

  return { tex, alphaAt };
}

// ---------- 定位宿主 ----------

function findHost(root, chestBoneName) {
  let mesh = null;
  let chest = null;
  root.traverse(o => {
    if (!mesh && o.isSkinnedMesh) mesh = o;
    if (!chest && o.isBone && o.name.toLowerCase() === chestBoneName) chest = o;
  });
  return { mesh, chest };
}

// ---------- 采样：沿 -Z 打射线到实际渲染表面 ----------
//
// 不用 SkinnedMesh.raycast：它每条射线都要重新算一遍蒙皮，4736 条射线要 20 秒。
// 这里把胸甲附近的三角形一次性烘成世界坐标缓存，按 X/Y 分桶，射线沿 -Z 只查一个格子。
// 实测从 21.5 s 降到个位数毫秒。

const MT_EPS = 1e-9;

function hitTriangle(tr, ox, oy, oz, dx, dy, dz) {
  const ax = tr.a[0], ay = tr.a[1], az = tr.a[2];
  const e1x = tr.b[0] - ax, e1y = tr.b[1] - ay, e1z = tr.b[2] - az;
  const e2x = tr.c[0] - ax, e2y = tr.c[1] - ay, e2z = tr.c[2] - az;

  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < MT_EPS) return null;

  const inv = 1 / det;
  const tx = ox - ax, ty = oy - ay, tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return null;

  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return null;

  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  if (t <= 0) return null;
  return t;
}

function buildTriCache(mesh, origin, w, h, k) {
  const geo = mesh.geometry;
  const posAttr = geo.attributes.position;
  const index = geo.index;
  const triCount = index ? index.count / 3 : posAttr.count / 3;

  const pad = 0.06 * k;
  const xmin = origin.x - w / 2 - pad, xmax = origin.x + w / 2 + pad;
  const ymin = origin.y - h / 2 - pad, ymax = origin.y + h / 2 + pad;

  const vcache = new Map();
  const getV = (i) => {
    let v = vcache.get(i);
    if (!v) {
      v = mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
      vcache.set(i, v);
    }
    return v;
  };

  const BNX = 16, BNY = 18;
  const buckets = Array.from({ length: BNX * BNY }, () => []);
  const cellW = (xmax - xmin) / BNX, cellH = (ymax - ymin) / BNY;

  let kept = 0;
  for (let t = 0; t < triCount; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    const A = getV(i0), B = getV(i1), C = getV(i2);

    const maxX = Math.max(A.x, B.x, C.x), minX = Math.min(A.x, B.x, C.x);
    if (maxX < xmin || minX > xmax) continue;
    const maxY = Math.max(A.y, B.y, C.y), minY = Math.min(A.y, B.y, C.y);
    if (maxY < ymin || minY > ymax) continue;

    const tr = {
      a: [A.x, A.y, A.z],
      b: [B.x, B.y, B.z],
      c: [C.x, C.y, C.z],
      i: [i0, i1, i2],
    };
    kept++;

    const i0x = Math.max(0, Math.min(BNX - 1, Math.floor((minX - xmin) / cellW)));
    const i1x = Math.max(0, Math.min(BNX - 1, Math.floor((maxX - xmin) / cellW)));
    const i0y = Math.max(0, Math.min(BNY - 1, Math.floor((minY - ymin) / cellH)));
    const i1y = Math.max(0, Math.min(BNY - 1, Math.floor((maxY - ymin) / cellH)));
    for (let by = i0y; by <= i1y; by++) {
      for (let bx = i0x; bx <= i1x; bx++) buckets[by * BNX + bx].push(tr);
    }
  }

  const pick = (x, y) => {
    const bx = Math.floor((x - xmin) / cellW);
    const by = Math.floor((y - ymin) / cellH);
    if (bx < 0 || bx >= BNX || by < 0 || by >= BNY) return null;
    return buckets[by * BNX + bx];
  };

  return { pick, triCount, kept };
}

function sampleChest(mesh, origin, cfg, k, cache) {
  const geo = mesh.geometry;
  const JOINTS = geo.attributes.skinIndex;
  const WEIGHTS = geo.attributes.skinWeight;
  const cols = cfg.cols, rows = cfg.rows;
  const w = cfg.width * k, h = cfg.height * k;
  const depth = cfg.rayDepth * k;
  const cells = new Array(cols * rows).fill(null);

  let rays = 0, misses = 0;

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const u = i / (cols - 1), v = j / (rows - 1);
      const a = cfg.alphaAt(u, v);
      if (a < cfg.alphaMin) continue;

      const ox = origin.x + (u - 0.5) * w;
      const oy = origin.y + (v - 0.5) * h;
      const oz = origin.z + depth;

      const bucket = cache.pick(ox, oy);
      if (!bucket) { misses++; continue; }
      rays++;

      let bestT = Infinity, bestTri = null;
      for (let b = 0; b < bucket.length; b++) {
        const t = hitTriangle(bucket[b], ox, oy, oz, 0, 0, -1);
        if (t !== null && t < bestT) { bestT = t; bestTri = bucket[b]; }
      }
      if (!bestTri) { misses++; continue; }

      const A = bestTri.a, B = bestTri.b, C = bestTri.c;
      // 三角形法线（未归一化先判朝向）
      const e1x = B[0] - A[0], e1y = B[1] - A[1], e1z = B[2] - A[2];
      const e2x = C[0] - A[0], e2y = C[1] - A[1], e2z = C[2] - A[2];
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const nlen = Math.hypot(nx, ny, nz) || 1;
      nx /= nlen; ny /= nlen; nz /= nlen;
      if (nz < cfg.normalMinZ) continue;

      const px = ox, py = oy, pz = oz - bestT;

      // 重心坐标：点 = (1-u-v)A + uB + vC，重算一次保证与求交一致
      const bary = barycentric(A, B, C, px, py, pz);

      const jidx = [0, 0, 0, 0], wsum = [0, 0, 0, 0];
      const bw = bary;
      const vs = bestTri.i;
      const acc = new Map();
      for (let t = 0; t < 3; t++) {
        if (bw[t] <= 0) continue;
        for (let s = 0; s < 4; s++) {
          const jj = JOINTS.getComponent(vs[t], s);
          const ww = WEIGHTS.getComponent(vs[t], s) * bw[t];
          if (ww <= 0) continue;
          acc.set(jj, (acc.get(jj) || 0) + ww);
        }
      }
      const top = [...acc.entries()].sort((x, y) => y[1] - x[1]).slice(0, 4);
      const sum = top.reduce((x, y) => x + y[1], 0) || 1;
      top.forEach(([jj, ww], t) => { jidx[t] = jj; wsum[t] = ww / sum; });

      cells[j * cols + i] = {
        p: new THREE.Vector3(px, py, pz),
        n: new THREE.Vector3(nx, ny, nz),
        uv: [u, v], j: jidx, w: wsum, a,
      };
    }
  }
  cells.rays = rays;
  cells.misses = misses;
  return cells;
}

function barycentric(A, B, C, px, py, pz) {
  const v0x = B[0] - A[0], v0y = B[1] - A[1], v0z = B[2] - A[2];
  const v1x = C[0] - A[0], v1y = C[1] - A[1], v1z = C[2] - A[2];
  const v2x = px - A[0], v2y = py - A[1], v2z = pz - A[2];

  const d00 = v0x * v0x + v0y * v0y + v0z * v0z;
  const d01 = v0x * v1x + v0y * v1y + v0z * v1z;
  const d11 = v1x * v1x + v1y * v1y + v1z * v1z;
  const d20 = v2x * v0x + v2y * v0y + v2z * v0z;
  const d21 = v2x * v1x + v2y * v1y + v2z * v1z;
  const den = d00 * d11 - d01 * d01;
  if (Math.abs(den) < MT_EPS) return [1, 0, 0];
  const vv = (d11 * d20 - d01 * d21) / den;
  const ww = (d00 * d21 - d01 * d20) / den;
  return [1 - vv - ww, vv, ww];
}

// ---------- 清理：剔除打到别的甲片上的离群点，去掉孤立毛刺 ----------

function refineCells(cells, cols, rows, k) {
  const out = cells.slice();

  const zs = cells.filter(Boolean).map(c => c.p.z).sort((a, b) => a - b);
  if (zs.length > 16) {
    const med = zs[Math.floor(zs.length / 2)];
    const tol = 0.055 * k;
    for (let i = 0; i < out.length; i++) {
      if (out[i] && Math.abs(out[i].p.z - med) > tol) out[i] = null;
    }
  }

  const snap = out.slice();
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const kk = j * cols + i;
      if (!snap[kk]) continue;
      let ok = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!dj && !di) continue;
          const jj = j + dj, ii = i + di;
          if (jj < 0 || jj >= rows || ii < 0 || ii >= cols) continue;
          if (snap[jj * cols + ii]) ok++;
        }
      }
      if (ok < 3) out[kk] = null;
    }
  }
  return out;
}

// ---------- 拟合：二维二次曲面，抹平甲片叠压台阶 ----------

function solveLin(A, B, n) {
  const M = A.map(r => Array.from(r));
  const v = Array.from(B);
  for (let i = 0; i < n; i++) {
    let piv = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[piv][i])) piv = r;
    [M[i], M[piv]] = [M[piv], M[i]];
    [v[i], v[piv]] = [v[piv], v[i]];
    const d = M[i][i];
    if (Math.abs(d) < 1e-12) continue;
    for (let r = i + 1; r < n; r++) {
      const f = M[r][i] / d;
      if (!f) continue;
      for (let c = i; c < n; c++) M[r][c] -= f * M[i][c];
      v[r] -= f * v[i];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = v[i];
    for (let c = i + 1; c < n; c++) s -= M[i][c] * x[c];
    x[i] = Math.abs(M[i][i]) < 1e-12 ? 0 : s / M[i][i];
  }
  return x;
}

function fitSurface(cells, cfg) {
  const pts = [];
  cells.forEach(c => { if (c) pts.push(c.p); });
  if (pts.length < 60) return { ok: false };

  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= pts.length; my /= pts.length;

  const NF = 6;
  const A = Array.from({ length: NF }, () => new Float64Array(NF));
  const B = new Float64Array(NF);
  for (const p of pts) {
    const dx = p.x - mx, dy = p.y - my;
    const f = [1, dx, dx * dx, dy, dy * dy, dx * dy];
    for (let i = 0; i < NF; i++) {
      B[i] += f[i] * p.z;
      for (let j = 0; j < NF; j++) A[i][j] += f[i] * f[j];
    }
  }
  const q = solveLin(A, B, NF);
  const [c0, a1, b2, d1, e2, f1] = q;
  const zAt = (dx, dy) => c0 + a1 * dx + b2 * dx * dx + d1 * dy + e2 * dy * dy + f1 * dx * dy;

  const res = pts.map(p => p.z - zAt(p.x - mx, p.y - my)).sort((a, b) => a - b);
  const lift = res[Math.floor(res.length * cfg.liftPercentile)] + cfg.liftPad;

  const out = cells.map(c => {
    if (!c) return null;
    const dx = c.p.x - mx, dy = c.p.y - my;
    return {
      p: new THREE.Vector3(mx + dx, my + dy, zAt(dx, dy) + lift),
      n: new THREE.Vector3(
        -(a1 + 2 * b2 * dx + f1 * dy),
        -(d1 + 2 * e2 * dy + f1 * dx),
        1
      ).normalize(),
      uv: c.uv, j: c.j, w: c.w, a: c.a,
    };
  });
  out.lift = lift;
  return out;
}

// ---------- 到轮廓的格距：厚度靠边收拢，边缘才没有阶梯齿 ----------

function edgeDistance(cells, cols, rows) {
  const INF = 1e9;
  const d = cells.map(c => (c ? INF : 0));
  for (let pass = 0; pass < 3; pass++) {
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * cols + i;
        if (!d[k]) continue;
        let m = d[k];
        if (i > 0) m = Math.min(m, d[k - 1] + 1);
        if (j > 0) m = Math.min(m, d[k - cols] + 1);
        d[k] = m;
      }
    }
    for (let j = rows - 1; j >= 0; j--) {
      for (let i = cols - 1; i >= 0; i--) {
        const k = j * cols + i;
        if (!d[k]) continue;
        let m = d[k];
        if (i < cols - 1) m = Math.min(m, d[k + 1] + 1);
        if (j < rows - 1) m = Math.min(m, d[k + cols] + 1);
        d[k] = m;
      }
    }
  }
  return d;
}

// ---------- 建壳：外表面 + 内表面 + 侧壁，共用蒙皮 ----------

function buildShell(mesh, cells, cols, rows, cfg, k) {
  const n = cols * rows;
  const dist = edgeDistance(cells, cols, rows);
  const innerOff = cfg.innerOffset * k;
  const T = Math.max(cfg.thickness * k, innerOff);
  const chamfer = Math.max(cfg.chamferCells, 0.001);

  const ramp = dd => {
    const t = Math.min(1, Math.max(0, (dd - 1) / chamfer));
    return t * t * (3 - 2 * t);
  };

  const innerL = new Array(n).fill(null);
  const outerL = new Array(n).fill(null);
  let maxThick = 0;

  for (let i = 0; i < n; i++) {
    const c = cells[i];
    if (!c) continue;
    const tOut = innerOff + (T - innerOff) * ramp(dist[i]);
    maxThick = Math.max(maxThick, tOut);
    innerL[i] = mesh.worldToLocal(c.p.clone().addScaledVector(c.n, innerOff));
    outerL[i] = mesh.worldToLocal(c.p.clone().addScaledVector(c.n, tOut));
  }

  const posIn = [], posOut = [], uvIn = [], uvOut = [];
  const siIn = [], swIn = [], siOut = [], swOut = [];
  const vIn = new Array(n).fill(-1), vOut = new Array(n).fill(-1);

  for (let i = 0; i < n; i++) {
    const c = cells[i];
    if (!c) continue;
    vIn[i] = posIn.length / 3;
    posIn.push(innerL[i].x, innerL[i].y, innerL[i].z);
    uvIn.push(c.uv[0], c.uv[1]);
    siIn.push(...c.j); swIn.push(...c.w);
    vOut[i] = posOut.length / 3;
    posOut.push(outerL[i].x, outerL[i].y, outerL[i].z);
    uvOut.push(c.uv[0], c.uv[1]);
    siOut.push(...c.j); swOut.push(...c.w);
  }

  const quadOk = (j, i) => {
    if (j < 0 || i < 0 || j >= rows - 1 || i >= cols - 1) return false;
    const a = j * cols + i;
    return cells[a] && cells[a + 1] && cells[a + cols] && cells[a + cols + 1];
  };

  const idxOut = [], idxIn = [];
  let quads = 0;
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      if (!quadOk(j, i)) continue;
      const a = vOut[j * cols + i], b = vOut[j * cols + i + 1];
      const d = vOut[(j + 1) * cols + i + 1], c = vOut[(j + 1) * cols + i];
      idxOut.push(a, b, c, b, d, c);
      const ai = vIn[j * cols + i], bi = vIn[j * cols + i + 1];
      const di = vIn[(j + 1) * cols + i + 1], ci = vIn[(j + 1) * cols + i];
      idxIn.push(ai, ci, bi, bi, ci, di);
      quads++;
    }
  }

  const wallPos = [], wallUv = [], wallSi = [], wallSw = [], idxWall = [];
  const pushV = (p, uv, j, w) => {
    const id = wallPos.length / 3;
    wallPos.push(p.x, p.y, p.z);
    wallUv.push(uv[0], uv[1]);
    wallSi.push(...j); wallSw.push(...w);
    return id;
  };
  let wallSegs = 0;
  const addWall = (k1, k2) => {
    if (vOut[k1] < 0 || vOut[k2] < 0) return;
    const a = pushV(outerL[k1], cells[k1].uv, cells[k1].j, cells[k1].w);
    const b = pushV(outerL[k2], cells[k2].uv, cells[k2].j, cells[k2].w);
    const c = pushV(innerL[k2], cells[k2].uv, cells[k2].j, cells[k2].w);
    const d = pushV(innerL[k1], cells[k1].uv, cells[k1].j, cells[k1].w);
    idxWall.push(a, b, c, a, c, d);
    wallSegs++;
  };

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const kk = j * cols + i;
      if (!cells[kk]) continue;
      if (i < cols - 1 && cells[kk + 1]) {
        if (!quadOk(j - 1, i) || !quadOk(j, i)) addWall(kk, kk + 1);
      }
      if (j < rows - 1 && cells[kk + cols]) {
        if (!quadOk(j, i - 1) || !quadOk(j, i)) addWall(kk, kk + cols);
      }
    }
  }

  const mk = (pos, uv, si, sw, idx) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  };

  const shellPos = posIn.concat(wallPos);
  const shellUv = uvIn.concat(wallUv);
  const shellSi = siIn.concat(wallSi);
  const shellSw = swIn.concat(wallSw);
  const off = posIn.length / 3;

  return {
    faceGeo: mk(posOut, uvOut, siOut, swOut, idxOut),
    shellGeo: mk(shellPos, shellUv, shellSi, shellSw, idxIn.concat(idxWall.map(v => v + off))),
    quads, wallSegs, thickness: maxThick, cells: cells.filter(Boolean).length,
  };
}

// ---------- 对外入口 ----------

export async function attachEmblem(bossRoot, options = {}) {
  if (!bossRoot) throw new Error('attachEmblem: 需要 Boss 根节点');

  const { mesh, chest } = findHost(bossRoot, (options.chestBone || EMBLEM_DEFAULTS.chestBone));
  if (!mesh || !chest) {
    return { ok: false, reason: mesh ? 'chest-bone-missing' : 'skinned-mesh-missing' };
  }

  bossRoot.updateMatrixWorld(true);
  mesh.skeleton.update();

  // 按实际身高换算，避免上游换了归一化尺度就整体错位
  const box = new THREE.Box3().setFromObject(bossRoot);
  const size = box.getSize(new THREE.Vector3());
  const cfg = { ...EMBLEM_DEFAULTS, ...options };
  const k = size.y > 0.1 ? size.y / cfg.refHeight : 1;

  const image = await loadEmblemImage(cfg.url);
  cfg.alphaAt = image.alphaAt;

  const chestW = new THREE.Vector3();
  chest.getWorldPosition(chestW);
  const origin = new THREE.Vector3(chestW.x, chestW.y + cfg.liftY * k, chestW.z);

  const tCache = performance.now();
  const cache = buildTriCache(mesh, origin, cfg.width * k, cfg.height * k, k);
  const tSample = performance.now();
  const raw = sampleChest(mesh, origin, cfg, k, cache);
  const tRefine = performance.now();
  const refined = refineCells(raw, cfg.cols, cfg.rows, k);
  const fitted = fitSurface(refined, cfg);
  if (!fitted) return { ok: false, reason: 'fit-failed' };
  const tShell = performance.now();
  const built = buildShell(mesh, fitted, cfg.cols, cfg.rows, cfg, k);
  const tEnd = performance.now();

  const matFace = new THREE.MeshStandardMaterial({
    map: image.tex,
    transparent: true,
    depthWrite: false,
    roughness: cfg.faceRoughness,
    metalness: cfg.faceMetalness,
    polygonOffset: true, polygonOffsetFactor: -9, polygonOffsetUnits: -9,
  });
  const matShell = new THREE.MeshStandardMaterial({
    color: cfg.shellColor,
    roughness: cfg.shellRoughness,
    metalness: cfg.shellMetalness,
    side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8,
  });

  const place = (geo, mat) => {
    const m = new THREE.SkinnedMesh(geo, mat);
    m.bind(mesh.skeleton, mesh.bindMatrix);
    m.position.copy(mesh.position);
    m.quaternion.copy(mesh.quaternion);
    m.scale.copy(mesh.scale);
    m.frustumCulled = false;
    m.name = 'emblem_' + (mat === matFace ? 'face' : 'shell');
    mesh.parent.add(m);
    return m;
  };

  // 壳先建、面后建：不透明先渲染，透明叠在上面
  const shell = place(built.shellGeo, matShell);
  const face = place(built.faceGeo, matFace);

  return {
    ok: true,
    meshes: { shell, face },
    stats: {
      scale: k,
      cells: built.cells,
      quads: built.quads,
      wallSegs: built.wallSegs,
      thicknessMm: +(built.thickness * 1000).toFixed(1),
      liftMm: +(fitted.lift * 1000).toFixed(2),
      triTotal: Math.round(cache.triCount),
      triKept: cache.kept,
      rays: raw.rays,
      misses: raw.misses,
      ms: {
        cache: +(tSample - tCache).toFixed(1),
        sample: +(tRefine - tSample).toFixed(1),
        shell: +(tEnd - tShell).toFixed(1),
        total: +(tEnd - tCache).toFixed(1),
      },
    },
    dispose() {
      for (const m of [shell, face]) {
        m.parent?.remove(m);
        m.geometry.dispose();
      }
      matFace.dispose();
      matShell.dispose();
      image.tex.dispose();
    },
  };
}
