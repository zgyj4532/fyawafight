// 静态场景碰撞。只在 XZ 上解：人是圆，大件是圆或有向盒。
// 不读视觉网格，不建 Three.js 对象。热路径 resolve / clipVelocity 不分配。
// 规格：docs/场景_实体碰撞箱方案.md。

import { CONFIG } from './config.js';

const circles = [];
const boxes = [];
const openings = [];
const out = { x: 0, z: 0, pushX: 0, pushZ: 0 };
const vel = { x: 0, z: 0 };
const frame = { x: 0, z: 0 };

let minR = Infinity;
let warnedStuck = false;
let warnedPush = false;
let warnedStep = false;

function fail(message) {
  throw new Error(`[collision] ${message}`);
}

// θ 只绕 Y。局部 +x 转到 (cosθ, −sinθ)，局部 +z 转到 (sinθ, cosθ)。
export function localToWorld(cx, cz, theta, lx, lz) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  frame.x = cx + lx * c + lz * s;
  frame.z = cz - lx * s + lz * c;
  return frame;
}

export function worldToLocal(theta, dx, dz) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  frame.x = dx * c - dz * s;
  frame.z = dx * s + dz * c;
  return frame;
}

export function assertFrame() {
  const a = localToWorld(0, 0, 0, 1, 0);
  if (Math.abs(a.x - 1) > 1e-9 || Math.abs(a.z) > 1e-9) fail(`θ=0 应得 (1,0)，得到 (${a.x},${a.z})`);
  const bx = localToWorld(0, 0, Math.PI / 2, 1, 0).x;
  const bz = frame.z;
  if (Math.abs(bx) > 1e-9 || Math.abs(bz + 1) > 1e-9) fail(`θ=π/2 应得 (0,−1)，得到 (${bx},${bz})`);
  const back = worldToLocal(Math.PI / 2, bx, bz);
  if (Math.abs(back.x - 1) > 1e-9 || Math.abs(back.z) > 1e-9) fail(`逆变换应得 (1,0)，得到 (${back.x},${back.z})`);
}

function requiredGap(rule) {
  const r = CONFIG.player.radius;
  if (rule === 'arch') return 2.05;
  if (rule === 'gallows') return r * 2 + 0.3;
  if (rule === 'archLow') return r * 2;
  return 0;
}

function openingGap(shapes) {
  if (!shapes || shapes.length !== 2) return null;
  const a = shapes[0];
  const b = shapes[1];
  if (a.kind !== 'circle' || b.kind !== 'circle') return null;
  return Math.hypot(a.x - b.x, a.z - b.z) - a.r - b.r;
}

function centerInside(fit, x, z) {
  return x >= fit[0] - 0.2 && x <= fit[1] + 0.2 && z >= fit[2] - 0.2 && z <= fit[3] + 0.2;
}

/**
 * 把一件资产的局部形状注册到世界坐标。
 * 门洞不够、或圆心落在点云外面时不注册，并在控制台留下名字。
 * @returns {boolean}
 */
export function registerAsset(tag, cx, cz, theta, def, scale = 1) {
  const shapes = def && def.collider;
  if (!shapes || !shapes.length) return false;
  const k = scale || 1;
  if (def.opening) {
    const gap = openingGap(shapes);
    const need = requiredGap(def.opening);
    const worldGap = gap === null ? null : gap * k;
    if (worldGap === null || worldGap < need) {
      console.error('[collision] 不注册', tag, '门洞净空', worldGap === null ? '不是两根柱' : worldGap.toFixed(3), '需要', need.toFixed(3));
      return false;
    }
  }
  if (def.fit) {
    for (let i = 0; i < shapes.length; i += 1) {
      const shape = shapes[i];
      if (!centerInside(def.fit, shape.x, shape.z)) {
        console.error('[collision] 不注册', tag, '形状中心不在点云里', shape.x, shape.z);
        return false;
      }
    }
  }

  const c = Math.cos(theta);
  const s = Math.sin(theta);
  for (let i = 0; i < shapes.length; i += 1) {
    const shape = shapes[i];
    const lx = shape.x * k;
    const lz = shape.z * k;
    const x = cx + lx * c + lz * s;
    const z = cz - lx * s + lz * c;
    if (shape.kind === 'circle') {
      const r = shape.r * k;
      circles.push({ x, z, r, tag });
      if (r < minR) minR = r;
    } else {
      boxes.push({
        x, z, hx: shape.hx * k, hz: shape.hz * k, c, s, tag,
      });
    }
  }
  if (def.opening) {
    const a = shapes[0];
    const b = shapes[1];
    const mx = (a.x + b.x) / 2 * k;
    const mz = (a.z + b.z) / 2 * k;
    openings.push({
      x: cx + mx * c + mz * s,
      z: cz - mx * s + mz * c,
      need: CONFIG.player.radius,
      tag,
    });
  }
  return true;
}

export function substepLimit() {
  return minR * 0.5;
}

// 步长超过最小柱半径的一半就拆开，避免从柱子中间穿过去。封顶 8 步。
export function substepCount(distance) {
  const limit = substepLimit();
  if (!(distance > limit)) return 1;
  let n = Math.ceil(distance / limit);
  if (n > 8) {
    if (!warnedStep) {
      warnedStep = true;
      console.warn('[collision] 子步超过 8，最小圆柱半径过小');
    }
    return 8;
  }
  return n;
}

export function resolve(x, z, radius) {
  let px = x;
  let pz = z;
  let hit = false;
  for (let iter = 0; iter < 4; iter += 1) {
    hit = false;
    for (let i = 0; i < circles.length; i += 1) {
      const item = circles[i];
      let dx = px - item.x;
      let dz = pz - item.z;
      const reach = radius + item.r;
      const d2 = dx * dx + dz * dz;
      if (d2 >= reach * reach) continue;
      const d = Math.sqrt(d2);
      let nx = 1;
      let nz = 0;
      let pen = reach;
      if (d >= 1e-4) {
        nx = dx / d;
        nz = dz / d;
        pen = reach - d;
      }
      // 贴在表面上时浮点会留下零点几毫米，再推就会每帧报「仍重叠」。
      if (pen < 1e-4) continue;
      px += nx * pen;
      pz += nz * pen;
      hit = true;
    }
    for (let i = 0; i < boxes.length; i += 1) {
      const item = boxes[i];
      const dx = px - item.x;
      const dz = pz - item.z;
      const reach2 = (item.hx + radius) * (item.hx + radius) + (item.hz + radius) * (item.hz + radius);
      if (dx * dx + dz * dz >= reach2) continue;
      const lx = dx * item.c - dz * item.s;
      const lz = dx * item.s + dz * item.c;
      let clx = lx;
      let clz = lz;
      if (clx < -item.hx) clx = -item.hx;
      else if (clx > item.hx) clx = item.hx;
      if (clz < -item.hz) clz = -item.hz;
      else if (clz > item.hz) clz = item.hz;
      const ddx = lx - clx;
      const ddz = lz - clz;
      if (ddx !== 0 || ddz !== 0) {
        const d2 = ddx * ddx + ddz * ddz;
        if (d2 >= radius * radius) continue;
        const d = Math.sqrt(d2);
        const pen = radius - d;
        if (pen < 1e-4) continue;
        const nx = ddx / d;
        const nz = ddz / d;
        px += (nx * item.c + nz * item.s) * pen;
        pz += (-nx * item.s + nz * item.c) * pen;
        hit = true;
        continue;
      }
      const left = lx + item.hx;
      const right = item.hx - lx;
      const down = lz + item.hz;
      const up = item.hz - lz;
      let best = right;
      let axis = 0;
      let sign = 1;
      if (left < best) {
        best = left;
        sign = -1;
      }
      if (up < best) {
        best = up;
        axis = 1;
        sign = 1;
      }
      if (down < best) {
        best = down;
        axis = 1;
        sign = -1;
      }
      if (lx === 0 && axis === 0) sign = 1;
      const pen = best + radius;
      const nx = axis === 0 ? sign : 0;
      const nz = axis === 1 ? sign : 0;
      px += (nx * item.c + nz * item.s) * pen;
      pz += (-nx * item.s + nz * item.c) * pen;
      hit = true;
    }
    if (!hit) break;
  }
  if (hit && !warnedStuck) {
    warnedStuck = true;
    console.warn('[collision] 4 轮后仍重叠', px.toFixed(2), pz.toFixed(2));
  }
  const netX = px - x;
  const netZ = pz - z;
  const net = Math.hypot(netX, netZ);
  if (net > 1.5) {
    const k = 1.5 / net;
    px = x + netX * k;
    pz = z + netZ * k;
    if (!warnedPush) {
      warnedPush = true;
      console.warn('[collision] 单次推出超过 1.5 m，已截断', net.toFixed(2));
    }
  }
  out.x = px;
  out.z = pz;
  out.pushX = px - x;
  out.pushZ = pz - z;
  return out;
}

export function clipVelocity(vx, vz, pushX, pushZ) {
  vel.x = vx;
  vel.z = vz;
  const len = Math.hypot(pushX, pushZ);
  if (len < 1e-8) return vel;
  const nx = pushX / len;
  const nz = pushZ / len;
  const vn = vx * nx + vz * nz;
  if (vn < 0) {
    vel.x = vx - vn * nx;
    vel.z = vz - vn * nz;
  }
  return vel;
}

function clearanceAt(px, pz) {
  let best = Infinity;
  for (let i = 0; i < circles.length; i += 1) {
    const item = circles[i];
    const d = Math.hypot(px - item.x, pz - item.z) - item.r;
    if (d < best) best = d;
  }
  for (let i = 0; i < boxes.length; i += 1) {
    const item = boxes[i];
    const dx = px - item.x;
    const dz = pz - item.z;
    const lx = dx * item.c - dz * item.s;
    const lz = dx * item.s + dz * item.c;
    const ax = Math.abs(lx) - item.hx;
    const az = Math.abs(lz) - item.hz;
    let d;
    if (ax <= 0 && az <= 0) d = Math.max(ax, az);
    else if (ax > 0 && az > 0) d = Math.hypot(ax, az);
    else d = Math.max(ax, az);
    if (d < best) best = d;
  }
  return best;
}

export function assertClearances() {
  const failed = [];
  for (let i = 0; i < openings.length; i += 1) {
    const gate = openings[i];
    const gap = clearanceAt(gate.x, gate.z);
    if (gap < gate.need) failed.push(gate.tag);
  }
  if (failed.length) console.error('[collision] 门洞中点被挡住', failed.join(','));
  return { ok: failed.length === 0, failed };
}

export function debugSegmentCount() {
  return circles.length * 16 + boxes.length * 4;
}

export function writeDebugXZ(target) {
  let o = 0;
  for (let i = 0; i < circles.length; i += 1) {
    const item = circles[i];
    for (let k = 0; k < 16; k += 1) {
      const a0 = (k / 16) * Math.PI * 2;
      const a1 = ((k + 1) / 16) * Math.PI * 2;
      target[o] = item.x + Math.cos(a0) * item.r;
      target[o + 1] = item.z + Math.sin(a0) * item.r;
      target[o + 2] = item.x + Math.cos(a1) * item.r;
      target[o + 3] = item.z + Math.sin(a1) * item.r;
      o += 4;
    }
  }
  const cornerX = [1, 1, -1, -1];
  const cornerZ = [1, -1, -1, 1];
  for (let i = 0; i < boxes.length; i += 1) {
    const item = boxes[i];
    for (let k = 0; k < 4; k += 1) {
      const n = (k + 1) % 4;
      const lx0 = cornerX[k] * item.hx;
      const lz0 = cornerZ[k] * item.hz;
      const lx1 = cornerX[n] * item.hx;
      const lz1 = cornerZ[n] * item.hz;
      target[o] = item.x + lx0 * item.c + lz0 * item.s;
      target[o + 1] = item.z - lx0 * item.s + lz0 * item.c;
      target[o + 2] = item.x + lx1 * item.c + lz1 * item.s;
      target[o + 3] = item.z - lx1 * item.s + lz1 * item.c;
      o += 4;
    }
  }
  return o;
}

export function colliderStats() {
  return {
    circles: circles.length,
    boxes: boxes.length,
    openings: openings.length,
    minR,
    limit: substepLimit(),
  };
}

export function debugShapes() {
  return { circles, boxes, openings };
}

export function clear() {
  circles.length = 0;
  boxes.length = 0;
  openings.length = 0;
  minR = Infinity;
  warnedStuck = false;
  warnedPush = false;
  warnedStep = false;
}

assertFrame();
