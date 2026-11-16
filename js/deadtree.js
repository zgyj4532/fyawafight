// 区块 6g · 枯树（代码生成，不走 GLB）
//
// 为什么不用生成资产了：
//
//   生成的那两版（batch6 / batch7）都是**扇片拓扑** —— 包围盒 1.80 × 2.67 × 0.32，
//   深度只有 32 cm。五根粗细相近的枝从**同一个节点**放射出来，正对镜头勉强像树，
//   转 30° 就开始散架，58° 俯视下竖直方向被压到 0.53，屏幕上变成一朵星。
//   引擎侧加 stretchY 只能把星拉长成竖着的星，改不动拓扑。
//
//   所以这一棵改成手写：主干四段带偏折、枝干着生高度**错开**、每根枝都过一道
//   折点、末梢一路收到 2 cm。这四件事恰好是俯视角下"看得出是一棵树"的全部线索。
//
// 从 58° 上方看一棵树，能读到的只有三样东西，代码就围着这三样写：
//
//   **一、主干得是一根连续的斜线，而且比所有枝都粗。** 所以主干 4 段、半径
//       0.22 → 0.03，明显收细；顶端收到 0.03 当成断头，这是"死了"的信号。
//   **二、枝不能从同一个点出来。** 着生高度取 0.80 / 1.38 / 1.85 / 2.45 /
//       2.90 / 3.35，最下最长（1.35 m）、最上最短（0.70 m）。
//   **三、方位角不能成对。** 0.45 / 2.30 / 4.05 / 1.35 / 3.35 / 5.35 ——
//       相邻差 0.9–2.0 rad，任意两根都不接近 π，否则俯视就是一个十字。
//
// 三角数约 1.4 k，三株实例一共 4 k 出头，相对现在的 1.8 M 可以忽略。

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const UP = new THREE.Vector3(0, 1, 0);

// 枯木的三档色：根部受潮发黑、主干灰褐、末梢被晒白。
// 和 props.js 的木色（0x7d5834 系）拉开花，枯树才不像"一棵去掉叶子的木栅栏"。
const WOOD_BASE = 0x503a28;
const WOOD_MAIN = 0x73563c;
const WOOD_TIP = 0x94764f;

// 主干节点：x 左右摆、z 前后摆，整体朝 +x 微倾。
// 半径逐段收细，最后一段 0.078 → 0.030，收成断头。
const NODES = [
  { p: [0.00, 0.00, 0.00], r: 0.220 },
  { p: [0.11, 1.45, 0.06], r: 0.165 },
  { p: [-0.05, 2.60, 0.13], r: 0.118 },
  { p: [0.07, 3.55, -0.03], r: 0.078 },
  { p: [0.02, 4.28, 0.02], r: 0.030 },
];

// 枝：seg 是挂在主干的第几段上、t 是段内比例（着生高度），
// az 方位角、el 相对水平线的仰角、len 长度、kink 折点转角、twig 有没有二级小枝。
const BRANCHES = [
  { seg: 0, t: 0.62, az: 0.45, el: 0.26, len: 1.36, kink: 0.30, twig: true },
  { seg: 0, t: 0.98, az: 2.30, el: 0.44, len: 1.14, kink: -0.26, twig: true },
  { seg: 1, t: 0.34, az: 4.05, el: 0.55, len: 1.02, kink: 0.22, twig: false },
  { seg: 1, t: 0.86, az: 1.35, el: 0.34, len: 1.08, kink: -0.30, twig: true },
  { seg: 2, t: 0.30, az: 3.35, el: 0.62, len: 0.86, kink: 0.24, twig: false },
  { seg: 2, t: 0.78, az: 5.35, el: 0.52, len: 0.68, kink: -0.20, twig: false },
];

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

// 和 props.js 的 paint 同一套：删 uv、转非索引、写顶点色。
// 三份几何要 merge，属性表必须完全一致，少一个属性就会 merge 失败。
//
// 这里的 hex 允许传函数 `(x, y, z) => hex`。主干需要按高度渐变，
// 整段刷一个色会在段与段之间留一条横着的硬边 —— 上一版树干就是下半截
// 深巧克力、上半截灰褐，中间齐刷刷一刀，像被浸过漆。
// 传函数时按**变换后**的坐标取色，所以 limb() 里的 paint 要放在转/挪之后。
function paint(geometry, hex) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  g.deleteAttribute('uv');
  const pos = g.attributes.position;
  const count = pos.count;
  const colors = new Float32Array(count * 3);
  const solid = new THREE.Color();
  const dynamic = typeof hex === 'function';
  if (!dynamic) solid.set(hex);
  for (let i = 0; i < count; i += 1) {
    if (dynamic) solid.set(hex(pos.getX(i), pos.getY(i), pos.getZ(i)));
    colors[i * 3] = solid.r;
    colors[i * 3 + 1] = solid.g;
    colors[i * 3 + 2] = solid.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

function dirFrom(az, el) {
  const c = Math.cos(el);
  return new THREE.Vector3(Math.cos(az) * c, Math.sin(el), Math.sin(az) * c).normalize();
}

// 一根枝条：从 from 沿 dir 长 len，半径 r0（根）→ r1（梢）。
// CylinderGeometry 默认沿 +y、以几何中心为原点，所以要先转再挪半根长度。
// 5 边足够 —— 枝最粗也就 0.082 m，多两个边在屏幕上一个像素都不差。
function limb(list, hex, from, dir, len, r0, r1) {
  // 注意：paint() 内部会 toNonIndexed() 出来一个新几何，**必须接住它的返回值**。
  // 丢掉的话后面转的、挪的都是没有顶点色的那一份，着色器取到 0，整棵树是纯黑。
  //
  // 顺序是「转 → 挪 → 上色」，和 props.js 的 place() 相反。
  // 原因只有一个：主干要按世界高度渐变，颜色必须在坐标定下来之后才能取。
  const raw = new THREE.CylinderGeometry(r1, r0, len, 5, 1, false);
  const g = raw.index ? raw.toNonIndexed() : raw;
  if (g !== raw) raw.dispose();
  g.deleteAttribute('uv');
  const q = new THREE.Quaternion().setFromUnitVectors(UP, dir);
  g.applyQuaternion(q);
  const mid = from.clone().addScaledVector(dir, len * 0.5);
  g.translate(mid.x, mid.y, mid.z);
  list.push(paint(g, hex));
  return from.clone().addScaledVector(dir, len);
}

function trunkAt(seg, t) {
  const a = NODES[seg];
  const b = NODES[seg + 1];
  const pa = new THREE.Vector3(...a.p);
  const pb = new THREE.Vector3(...b.p);
  return {
    p: pa.clone().lerp(pb, t),
    r: a.r + (b.r - a.r) * t,
  };
}

// 主干按高度渐变：0 → 0.95 m 从贴地的深褐洗到主色，再往上慢慢泛白。
// 用函数而不是三档常量，就是为了消掉段与段之间的那条硬边。
const C_BASE = new THREE.Color(WOOD_BASE);
const C_MAIN = new THREE.Color(WOOD_MAIN);
const C_TOP = new THREE.Color(0x8a6f4e);
const scratch = new THREE.Color();

function trunkShade(x, y) {
  if (y < 0.95) return scratch.copy(C_BASE).lerp(C_MAIN, Math.max(0, Math.min(1, y / 0.95)));
  return scratch.copy(C_MAIN).lerp(C_TOP, Math.max(0, Math.min(1, (y - 0.95) / 3.0)));
}

/**
 * 生成一棵枯树的合并几何。原点在脚下正中，+y 向上，最高点归一到 targetHeight。
 * 返回 { geometry, triangles }。
 */
export function createDeadTreeGeometry(targetHeight = 4.40, seed = 20261112) {
  const rnd = makeRandom(seed);
  const list = [];

  // --- 主干 -------------------------------------------------------------
  for (let i = 0; i < NODES.length - 1; i += 1) {
    const a = new THREE.Vector3(...NODES[i].p);
    const b = new THREE.Vector3(...NODES[i + 1].p);
    const dir = b.clone().sub(a);
    const len = dir.length();
    dir.normalize();
    limb(list, trunkShade, a, dir, len, NODES[i].r, NODES[i + 1].r);
  }

  // --- 枝 ---------------------------------------------------------------
  BRANCHES.forEach((b) => {
    const from = trunkAt(b.seg, b.t);
    // 枝根半径跟着主干的粗细走：主干粗的地方枝也粗，收细的逻辑才连贯。
    const r0 = from.r * 0.46;
    const rMid = r0 * 0.42;

    // 第一段占 62%，第二段在折点处偏一度方位、抬一点仰角 —— 直线枝条是
    // "星形"的来源，只要每根枝都过一道折点，轮廓立刻就散了。
    const d1 = dirFrom(b.az, b.el);
    const knee = limb(list, WOOD_MAIN, from.p, d1, b.len * 0.62, r0, rMid);

    const az2 = b.az + b.kink * 0.55 + (rnd() - 0.5) * 0.30;
    const el2 = b.el + b.kink * 0.60;
    const d2 = dirFrom(az2, el2);
    const tip = limb(list, WOOD_TIP, knee, d2, b.len * 0.38, rMid, 0.022);

    // 二级小枝：只挂在下面三根粗枝的折点上，位置高、量少，
    // 多了俯视就是一团乱线，反而看不出主轮廓。
    if (b.twig) {
      const az3 = az2 + (rnd() > 0.5 ? 0.85 : -0.85);
      const el3 = Math.max(0.15, b.el - 0.10);
      const d3 = dirFrom(az3, el3);
      limb(list, WOOD_TIP, knee, d3, b.len * 0.42, rMid * 0.78, 0.018);

      // 折点本身也往下坠一小截，枝才不像"被掰直的铁丝"。
      const d4 = dirFrom(az2 + 1.7, -0.12);
      limb(list, WOOD_TIP, tip, d4, b.len * 0.20, 0.020, 0.014);
    }
  });

  const merged = mergeGeometries(list, false);
  list.forEach((g) => g.dispose());

  // 归一到目标高度，并让脚底正好在 y=0（实例是按地面高度摆的）。
  merged.computeBoundingBox();
  const box = merged.boundingBox;
  const k = targetHeight / (box.max.y - box.min.y);
  merged.scale(k, k, k);
  merged.computeBoundingBox();
  merged.translate(0, -merged.boundingBox.min.y, 0);
  merged.computeVertexNormals();
  merged.computeBoundingSphere();

  const triangles = merged.attributes.position.count / 3;
  return { geometry: merged, triangles };
}
