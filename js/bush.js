// 区块 6h · 灌木（代码生成，不走 GLB）
//
// 这一层的用途和上一版完全不同，先说清楚为什么换：
//
//   上一版用的是「背景林线」——路外 5–7.6 m 摆一排 6.4 m 高的林块，
//   想挡住画面上沿。量完发现那个思路本身是错的：
//
//     画面上沿落在地图内部 z ≈ −14…−19（玩家在路中间时），
//     而地图边界在 z = ±60 —— 中间差四十多米。
//     所以那一排树既不是"边界"，也不是"上沿"，它就是在路外侧不远处
//     竖了一排会挡视线的圆球。
//
//   而且越远能看见的越矮：在距离 d 处，可见高度上限是 16.3 − 0.673·d。
//   20 m 处只剩 2.8 m，24 m 处是 0 —— 画面上沿那条线本身就是地面，
//   在那里立任何东西都会立刻出画。**"用树把上沿填满"几何上做不到。**
//
// 所以这一层改成贴地灌木：0.45–1.05 m 高，摆在路外 3.5–10 m。
// 它不挡视线（顶部俯角远低于画面上沿），但在 58° 俯视下能读出
// 「近处草叶 → 灌木 → 远处草地」三层关系，把一整片平草地切开。
//
// 几何做法（三件事，都是为俯视角写的）：
//
//   **一、必须是几团错落，不能是一颗球。** 单球从上看就是个圆点，
//       六团高低错开才读得出"一丛"。
//   **二、顶点要扰动。** 正二十面体的轮廓太规整，扰 40% 之后边缘碎，
//       才像叶子不像石头。
//   **三、颜色必须按高度分三档。** 底部压暗（草根阴影）、中段主色、
//       顶部提亮（受光）。没有这三档，toon 分档光会把它照成一坨平面。
//
// 成本：一丛约 130 三角，一百多丛全走一个 InstancedMesh。

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

function makeRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 三档叶色。比树林（0xe8f8e0 × 1.32 → 约 (86,108,49)）再深一档，
// 灌木才会读成"树下面那一层"，而不是"缩小的树"。
const LEAF_DARK = new THREE.Color(0x2a3a1c);
const LEAF_MID = new THREE.Color(0x3c5522);
const LEAF_LIT = new THREE.Color(0x64803a);
const TWIG = new THREE.Color(0x4a3a26);

const scratch = new THREE.Color();

function shadeAt(y, h) {
  const u = Math.max(0, Math.min(1, y / h));
  if (u < 0.52) return scratch.copy(LEAF_DARK).lerp(LEAF_MID, u / 0.52);
  return scratch.copy(LEAF_MID).lerp(LEAF_LIT, (u - 0.52) / 0.48);
}

// 属性表要和细枝一致（position / normal / color），否则 merge 会失败。
// uv 一律删掉：这批资产不采样贴图，留着属性反而让两条几何对不上。
function tintByHeight(g, h, jitter) {
  const pos = g.attributes.position;
  const n = pos.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    const c = shadeAt(pos.getY(i), h);
    // 再叠一层逐顶点微抖（±4%），整丛才不会是一个死色。
    const k = jitter * (0.96 + ((i * 2654435761) % 97) / 1200);
    colors[i * 3] = c.r * k;
    colors[i * 3 + 1] = c.g * k;
    colors[i * 3 + 2] = c.b * k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

function twigGeometry(from, to, r0, r1, color) {
  const dir = to.clone().sub(from);
  const len = dir.length();
  dir.normalize();
  const g = new THREE.CylinderGeometry(r1, r0, len, 4, 1, false).toNonIndexed();
  g.deleteAttribute('uv');
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  g.applyQuaternion(q);
  const mid = from.clone().addScaledVector(dir, len * 0.5);
  g.translate(mid.x, mid.y, mid.z);
  const n = g.attributes.position.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

/**
 * 生成一丛灌木的合并几何。原点在脚下正中，+y 向上，最高点归一到 targetHeight。
 * seed 不同 → 团块数、大小、朝向都不同，一百多丛才不会看出复制。
 */
export function createBushGeometry(targetHeight = 0.95, seed = 20261113) {
  const rnd = makeRandom(seed);
  const parts = [];

  const lobes = 6 + Math.floor(rnd() * 3); // 6–8 团
  let topY = 0;
  const centers = [];

  for (let i = 0; i < lobes; i += 1) {
    // 第一团压在正中偏下当"主体"，其余绕它散开。
    const ang = (i / lobes) * Math.PI * 2 + rnd() * 0.9;
    const rad = i === 0 ? 0 : 0.24 + rnd() * 0.50;
    // 主体团压在 0.34–0.50，其余往上错开到 0.92 —— 上一版团块堆得太低、
    // 又压到 0.80，从 58° 看只剩一块水平的面，读成"地皮补丁"。
    const cy = i === 0 ? 0.34 + rnd() * 0.16 : 0.34 + rnd() * 0.58;
    const r = 0.30 + rnd() * 0.28;
    centers.push(new THREE.Vector3(Math.cos(ang) * rad, cy, Math.sin(ang) * rad));

    const g = new THREE.IcosahedronGeometry(r, 0);
    const pos = g.attributes.position;
    // 每个顶点单独扰动，再整体压扁到 0.8 —— 叶团不会是个完美的球。
    for (let v = 0; v < pos.count; v += 1) {
      const k = 1 + (rnd() - 0.5) * 0.42;
      pos.setXYZ(v, pos.getX(v) * k, pos.getY(v) * k * 0.88, pos.getZ(v) * k);
    }
    g.deleteAttribute('uv');
    g.translate(centers[i].x, cy, centers[i].z);
    g.computeVertexNormals();
    // 必须在 merge 之前上色：细枝那几条带 color，叶团不带的话属性表对不上，
    // mergeGeometries 直接返回 null，整件资产加载失败。
    parts.push(tintByHeight(g, 1.05, 0.94 + rnd() * 0.10));
    topY = Math.max(topY, cy + r * 1.05);
  }

  // 细枝：从地面斜着接到两团叶的底部。俯视下只露出一点点，
  // 但侧看时能把"浮着的两团绿"钉在地上。
  for (let i = 1; i < Math.min(3, centers.length); i += 1) {
    const c = centers[i];
    const from = new THREE.Vector3(c.x * 0.18, 0.0, c.z * 0.18);
    const to = new THREE.Vector3(c.x * 0.72, c.y - 0.16, c.z * 0.72);
    parts.push(twigGeometry(from, to, 0.030, 0.016, TWIG));
  }

  const merged = mergeGeometries(parts, false);
  parts.forEach((g) => g.dispose());

  // 先归一化高度，再按最终高度写顶点色 —— 顺序反过来色阶会错位。
  merged.computeBoundingBox();
  const box = merged.boundingBox;
  const k = targetHeight / Math.max(0.001, box.max.y - box.min.y);
  merged.scale(k, k, k);
  merged.computeBoundingBox();
  merged.translate(0, -merged.boundingBox.min.y, 0);

  merged.computeVertexNormals();
  merged.computeBoundingSphere();

  const triangles = merged.attributes.position.count / 3;
  return { geometry: merged, triangles };
}
