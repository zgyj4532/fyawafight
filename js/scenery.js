// 区块 6f · 体量层（林线、岩群、枯树、湖、灌木）
//
// 前五层解决的是「路上有什么」：草、土路、路旁道具、叙事陈设。
// 这一层补的是画面的**上沿和路外**：路的另一侧有没有东西，世界是不是只有这条路。
//
// 说清楚一件事，因为它决定了这一层的全部做法：
//
//   **这套相机没有远景。** height 16 / pitch 58° / fov 45，玩家前方约 12.4 m 处
//   视线就切到画面上沿。实测（地面点投到 NDC）：
//
//     前方  0 m  ndcY −0.06     前方 12 m  ndcY 0.90
//     前方  8 m  ndcY  0.64     前方 16 m  ndcY 1.12  ← 出画
//
//   所以"远处有一座山"这种设计在这里是无效的 —— 山一个像素都不会出现。
//   山脊（hill_ridge）已经因为这个原因从方案里**去掉**，不再等相机改。
//
// 有效的做法是**近景竖向量**：把树摆到 lateral 9–11 m，让树冠刚好被画面上沿切掉。
// 玩家跑起来的时候，树从上方滚过去，读作"路外面是一片林子"。
//
// ---
//
// 四个做法是有意的：
//
// **一、全部走 InstancedMesh，不 clone。** 同一件资产出现 1–426 次，
// clone 就是几百次 draw call（现在是 20 出头，全 clone 会翻到 400+）。
// 实例化之后 6 种资产一共 6 次 draw call、加一片合并阴影 1 次。
// 代价是包围球覆盖整个世界、永远不被剔除，所以这几次的三角数是"全量"的。
//
// **二、摆位分三档密度，不是一视同仁。**
//   · 叙事陈设旁边（路旁 3–9 m）只有 7 株单树、6 组岩群、3 株枯树 ——
//     这一档是"看点"，必须能一件一件看清；
//   · 路外 4.2–12.5 m 是一条**灌木散射带**（BUSHES），把整片平草地切成前后几层；
//   · 地图边界是一圈**贴地灌木**（BORDER_BUSHES），挡的是"世界到此为止"。
//     原来那圈 6.4 m 的林块已经撤掉 —— 树在边界这个距离上没有"合适的大小"，
//     只有"太大"和"看不见"两档，理由见 §边界。
//
// **三、只有 −z 一侧有东西。** 相机永远在玩家 +z 侧、视线水平分量是 (0, −1)，
// +z 侧永远在镜头背后 —— 那边放东西是纯浪费三角。
//
// **四、抖动全部是确定的（seeded）**，不用 Math.random：同一套摆位每次刷新都一样，
// 否则没法用同一机位复现截图，也没法做 A/B 对照。

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { loadAndNormalizeGLB, createToonGradientMap } from './pipeline.js';
import { pathCenterZ, pathSlope, terrainY } from './path.js';
import { LAKES, LAKE_SPOTS, lakeScale, lakeSink } from './lake.js';
import { CONFIG } from './config.js';
import { createDeadTreeGeometry } from './deadtree.js';
import { createBushGeometry } from './bush.js';
import { NARRATIVE_FOOTPRINTS } from './narrative.js';
import { evidenceFootprints } from './evidence.js';
import { COLLIDERS } from './collision-data.js';
import { registerAsset } from './collision.js';

const ASSET_ROOT = 'models/env/body/';

// tint 是按贴图实测均色反算的，不是估的：
//   rocks_cluster (96,109,60) 带苔的橄榄 → 0xffffff × 1.47 → (115,130,73)
//   forest_tree   (76,75,41) 暗橄榄     → 0xa8f5c0 × 2.30 → (72,107,46)
//   forest_grove  (83,98,49) 暗橄榄     → 0xe8f8e0 × 1.32 → (86,108,49)
//   lake_pond     (99,94,73) 浑橄榄     → 0x5f9bff × 2.55 → 偏灰的青
// 这批贴图都比叙事层那批更暗，所以 gain 全部大于 1（乘子只能压不能提，见 narrative.js）。
// 树的绿色要靠乘子把 G 通道顶上去 —— 原贴图 R≈G，不顶的话是一片枯黄。
//
// 湖是唯一一个**改色相**的：贴图本身是浑橄榄，不改成青蓝就只是一块泥地。
// 三个通道分别乘 1.0 / 1.7 / 2.9（线性空间），乘完是偏灰的青，不会变成塑料蓝。
const ASSETS = {
  // 林块：5.67 × 5.00 × 5.60 → 7.3 宽 × 6.4 高
  grove: { file: 'forest_grove.glb', height: 6.40, tint: { color: 0xe8f8e0, gain: 1.32 }, shadow: [3.10, 0.76], ...COLLIDERS.grove },
  // 单树：4.05 × 5.00 × 3.72 → 4.5 宽 × 5.6 高
  tree: { file: 'forest_tree.glb', height: 5.60, tint: { color: 0xa8f5c0, gain: 2.30 }, shadow: [1.85, 0.68], ...COLLIDERS.tree },
  // 岩群：2.28 × 1.50 × 2.28 → 2.4 宽 × 1.6 高
  rocks: { file: 'rocks_cluster.glb', height: 1.60, tint: { color: 0xffffff, gain: 1.47 }, shadow: [1.45, 0.72], ...COLLIDERS.rocks },
  // 枯树：**不再走 GLB**，改 js/deadtree.js 代码生成。
  // 生成的两版都是扇片拓扑（深度 0.32 m、枝从同一节点放射），58° 俯视读成星形，
  // 引擎侧拉伸救不回来 —— 理由写在 deadtree.js 文件头。这里只留高度和阴影。
  dead: {
    build: () => createDeadTreeGeometry(4.40),
    shadow: [1.05, 0.48],
    ...COLLIDERS.dead,
  },
  // 湖：2.00 × 0.23 × 2.00，放大 4 倍 → 8 m 宽 × 0.92 高
  lake: { file: 'lake_pond.glb', height: 0.92, tint: { color: 0x5f9bff, gain: 2.55 } },
  // 灌木：**不走 GLB**，js/bush.js 代码生成。理由见那个文件头：
  // 这套相机里"用树把画面上沿填满"几何上做不到（越远能看到的越矮），
  // 能填层次的是贴地这一档 —— 0.45–1.05 m，不挡视线。
  bush: {
    build: () => createBushGeometry(1.45),
    shadow: [0.82, 0.84],
    ...COLLIDERS.bush,
  },
};

// --- 摆位 ---------------------------------------------------------------
//
// 单树、岩群、枯树：贴路走，用「里程 + lateral」，公式与 narrative.js / props.js
// 逐字一致。lateral 9–10.6 是量出来的：再近就压到叙事陈设（那批在 3–9 m），
// 再远就被画面上沿切光。
//
// 间距：单树之间 13–16 m，岩群 14–20 m，枯树只放 3 株（它是"这里死过人"的信号，
// 多了就成了"这里是树林"，反而把叙事的重量摊薄）。
const TREES = [
  { x: -50, lateral: 9.2, yaw: 0.4, scale: 1.00 },
  { x: -36, lateral: 10.4, yaw: -0.7, scale: 0.92 },
  { x: -20, lateral: 8.8, yaw: 1.1, scale: 1.06 },
  { x: 20, lateral: 9.4, yaw: -0.3, scale: 0.96 },
  { x: 30, lateral: 10.6, yaw: 0.8, scale: 1.10 },
  { x: 42, lateral: 10.2, yaw: -1.0, scale: 0.90 },
  { x: 54, lateral: 9.4, yaw: 0.2, scale: 1.04 },
];

// 岩群摆在树的内侧一档（7.2–9.4），在"路边石头"和"林子边"之间做一层过渡。
const ROCKS = [
  { x: -46, lateral: 7.6, yaw: 0.2, scale: 1.15 },
  { x: -26, lateral: 9.4, yaw: -0.6, scale: 0.90 },
  { x: 1, lateral: 7.6, yaw: 1.3, scale: 1.35 },
  { x: 24, lateral: 9.0, yaw: -0.9, scale: 1.00 },
  { x: 36, lateral: 7.4, yaw: 0.5, scale: 1.50 },
  { x: 50, lateral: 8.6, yaw: -0.2, scale: 1.05 },
];

// 林块（7.3 m 宽）只放 3 处，摆在最外侧（10.2–10.8），
// 让它成为"树线后面的更密的树"，被上沿切掉大半是预期效果。
// −12 那一处已撤，位置让给西潭（见 js/lake.js）：林块宽 7.3 m，
// 是这一带占地方最大的一件，只有它能腾出够放一潭水的空。
const GROVES = [
  { x: -56, lateral: 10.2, yaw: 0.3, scale: 1.00 },
  { x: 45, lateral: 10.4, yaw: -0.8, scale: 1.02 },
];

// --- 边界 ---------------------------------------------------------------
//
// 边界这一圈换了两次，过程写在这里，因为它反过来推翻了"用树挡边界"的直觉。
//
// 第一版（已删）：沿矩形摆 22 个林块，站在 z = −59.5。**一棵都看不见** ——
//   玩家 z 只到 −11.7，相机在 +10，上沿只看 29 m，南边界在 45 m 外。
// 第二版（已删）：退到地图之外 x = ±63…78，三排 16 m 深，46 个林块。
//   能看见，但只在玩家贴到 13.9 m 内才进画面；一进画面就在 5–8 m 处，
//   6.4 m 的树占掉半屏，读作一坨巨大的绿球（图 docs/shots/border_bush_ab.png 左格）。
//
// 结论：**树在边界这个距离上没有"合适的大小"，只有"太大"和"看不见"两档。**
// 所以这一圈交给贴地灌木，见下面 BORDER_BUSHES。

// 抖动是**确定的**（seeded），不用 Math.random：同一次摆位每次刷新都一样，
// 否则没法用同一机位复现截图、也没法做 A/B 对照。
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// --- 灌木带 -------------------------------------------------------------
//
// 上一版这里是「背景林线」：路外 5–7.6 m 摆一排 6.4 m 高的林块，想挡住画面上沿。
// 那个思路错了两次，写下来免得再犯：
//
//   一、**画面上沿不是地图边界。** 实测（tools/probe_edgespot.mjs）：
//       玩家在路中间时，上沿视线与地面交于 z ≈ −14.4、x 从 −20 到 +20；
//       地图边界在 z = −60。中间差四十多米。所以那一排树既不在边界上，
//       也不是上沿 —— 它就是在路外侧竖了一排会挡视线的圆球。
//   二、**"用树把上沿填满"几何上做不到。** 距离 d 处的可见高度上限是
//       `16.3 − 0.673·d`：20 m 处只剩 2.8 m、24 m 处是 0。上沿那条线本身
//       就是地面，在那里立任何东西都会立刻出画 —— 所以越远只能越贴地。
//
// 于是这一层换成贴地灌木：1.45 m 高，路外 4.2–12.5 m 的一片散射带。
// 不挡视线（顶部俯角远低于上沿），但在 58° 俯视下能读出
// 「近处草叶 → 灌木 → 远处草地」三层关系，把一整片平草地切开。
//
// 避让：灌木会正好长在火塘、井、绞刑架、兽骨上。半径直接用叙事层导出的
// NARRATIVE_FOOTPRINTS（阴影半径 × 1.05），不另抄一份坐标 ——
// 那边摆位改一次，这边自动跟。
const BUSHES = (() => {
  const rnd = seeded(48271);
  const spots = [];
  // 证据链里有几件大件（目前只有石槽）会占掉两三米见方，灌木撒进去会从
  // 槽里、箱子中间长出来。这些占位由 evidence.js 直接给出，不另抄一份坐标。
  const EVIDENCE_CLEAR = evidenceFootprints();

  const blocked = (cx, cz) => {
    for (const lake of LAKE_SPOTS) {
      if (Math.hypot(cx - lake.cx, cz - lake.cz) < lake.radius + 1.2) return true;
    }
    for (const f of EVIDENCE_CLEAR) {
      if (Math.hypot(cx - f.x, cz - f.z) < f.r) return true;
    }
    for (const f of NARRATIVE_FOOTPRINTS) {
      if (Math.hypot(cx - f.x, cz - f.z) < f.r + 0.85) return true;
    }
    return false;
  };

  const push = (mileage, lateral) => {
    const s = pathSlope(mileage);
    const len = Math.sqrt(1 + s * s);
    const cx = mileage + (-s / len) * (-lateral);
    const cz = pathCenterZ(mileage) + (1 / len) * (-lateral);
    const jx = (rnd() - 0.5) * 1.1;
    const jz = (rnd() - 0.5) * 1.1;
    if (blocked(cx + jx, cz + jz)) return;
    spots.push({
      wx: cx + jx,
      wz: cz + jz,
      yaw: rnd() * Math.PI * 2,
      scale: 0.62 + rnd() * 0.66,
    });
  };

  // 不是两排，是一片 4.2–12.5 m 的散射带。
  // 只用两排会读成"路边两条绿化带"，而随机的横向深度才能把草地切成前后几层。
  // 横向用 sqrt 偏置（`u*u` 会偏近、`sqrt` 偏远的反意），这里要**偏近**：
  // 近处能看清形状，远处本来就只剩轮廓，铺太密是浪费。
  let x = -58;
  while (x <= 58) {
    const u = rnd();
    const lateral = 4.2 + u * u * 8.3; // 4.2–12.5，偏向近处
    if (rnd() < 0.95) push(x, lateral);
    // 补一丛，打散等距感 —— 一丛 176 三角，加密的代价可以忽略。
    if (rnd() < 0.42) push(x + 0.8, 4.4 + rnd() * 7.6);
    const s = pathSlope(x);
    x += 1.7 / Math.sqrt(1 + s * s);
  }
  return spots;
})();

// --- 边界灌木带 -----------------------------------------------------------
//
// 上一版边界只有林块（BORDER，6.4 m），它是"墙"：玩家走近时确实是树冠收边，
// 但只在 13.9 m 内成立 —— 再远，树冠就顶出画面上沿了（见下面那条公式）。
// 而地图边界离玩家的距离在 2–60 m 之间摆动，大半时间超出这个范围，
// 那堵墙在画面上其实是**断开**的。
//
// 灌木反过来：1.45 m 高，可见到 **20.8 m**。
//
//   距离 d 处的可见高度上限 h = 16.3 − 0.713·d
//   → 高 h 的物体最远可见距离 d = (16.3 − h) / 0.713
//     1.45 m 灌木 → 20.8 m      2.0 m → 20.0 m      6.4 m 林块 → 13.9 m
//
// 越矮反而看得越远，这是俯视相机特有的：高的东西先把画面上沿顶穿。
// 所以边界这一圈真正该铺的是贴地的东西 —— 它不挡视线，但能在画面上把
// "世界到此为止"那条硬边磨成一条绿边。
//
// 摆位：四排，不是一个 z 循环里推三次。
//
//   内 59.0 站在主地面上，正好盖住主地面（±60）与远地面那 10 cm 的接缝；
//   中 62.6、外 67.2 站在远地面上（dy = −0.10 对齐远地面）；
//   最内 55.0 是一条**稀疏散点**，专门用来化开边界带的硬边 ——
//   没有它的话，玩家贴边时画面就是"左边一堵绿篱、右边空草地"。
//
// 三排共用一个 z 循环是第一版的错：z 相位对齐，从斜侧看就是三条等距直线。
// 现在每排各自走 `起点随机 + 步长 1.7–3.6 随机`，排与排互相咬合，看不出行。
// 路口留 ±5.2（路半宽 2.1 + 坡脚），不能再宽 —— 给到 ±8 时玩家正站在口子里，
// 右侧整片是空的，那是"站在路口看见界外"的破绽。
// +z 那条边不铺：相机永远在玩家 +z 侧，那条边永远在镜头背后。
const BORDER_BUSHES = (() => {
  const rnd = seeded(90210);
  const spots = [];

  const push = (wx, wz, dy) => {
    spots.push({ wx, wz, dy, yaw: rnd() * Math.PI * 2, scale: 0.72 + rnd() * 0.66 });
  };

  // 一排：沿一条边界线走，起点和步长都随机。
  // along 是"沿墙的坐标"（侧墙是 z，南墙是 x），out 是"离墙的距离"。
  const row = (from, to, outMin, outMax, stepMin, stepMax, dy, place) => {
    for (let t = from + rnd() * stepMax; t <= to; t += stepMin + rnd() * (stepMax - stepMin)) {
      place(t + (rnd() - 0.5) * 1.6, outMin + rnd() * (outMax - outMin), dy);
    }
  };

  for (const sign of [-1, 1]) {
    const cz = pathCenterZ(sign * CONFIG.arena.half);
    const skipMouth = (z) => Math.abs(z - cz) < 5.2;
    const place = (z, out, dy) => {
      if (skipMouth(z)) return;
      push(sign * out, z, dy);
    };
    // z 从 −60 铺到 +10：玩家能自由走到 z = ±60，之前的树墙只铺到 −36…+8，
    // 是照"沿路走"那一段排的，走到地图两端就空了。
    //
    // 内排从 58.6 退到 62.2：边界上现在立了全息力场（js/borderfx.js），
    // 带子占 58.2–61.8。灌木长在里面会把光带切成碎片，
    // 退到带子外侧之后，界内 58–62 是一条净空 —— 读作"力场清出的通道"，
    // 比灌木直接压在光带上干净得多。
    row(-60, 10, 62.2, 65.0, 1.7, 2.6, -0.10, place);
    row(-60, 10, 66.4, 69.8, 1.8, 3.0, -0.10, place);
    row(-60, 10, 70.4, 74.0, 2.0, 3.4, -0.10, place);
    row(-60, 10, 53.4, 57.4, 3.8, 6.4, 0, place); // 散点，化开硬边
  }

  // 南侧。玩家 z 到 −60 会 wrap，相机 z 被钳在 −52，
  // 所以 z = −60 这排在眼前 8 m、−68 那排在 16 m —— 四排全在可见带内。
  const south = (x, out, dy) => push(x, -out, dy);
  row(-60, 60, 62.2, 65.0, 1.7, 2.6, -0.10, south);
  row(-60, 60, 66.4, 69.8, 1.8, 3.0, -0.10, south);
  row(-60, 60, 70.4, 74.0, 2.0, 3.4, -0.10, south);
  row(-60, 60, 53.4, 57.4, 3.8, 6.4, 0, south);

  return spots;
})();

// 枯树：代码生成，有真实厚度，yaw 可以随便转。
// 三株的朝向故意错开 —— 扇片时代三棵必须朝同一个方向才不散架，
// 那种"三棵一样朝向"本身就是破绽。现在错开反而说明路边的枯树不是复制粘贴。
//
// lateral 压在 9.8–10.6：树高 4.4 m，从 58° 俯视看，超过 11 m 的枝梢会被画面上沿
// 切掉（实测 12 m 那一株只剩半截）。绿树被切是预期的"林线"，枯树是独立看点，
// 得让人看全轮廓。
const DEADS = [
  { x: -30, lateral: 10.5, yaw: 0.55, scale: 1.05 },
  { x: -2, lateral: 10.2, yaw: -1.15, scale: 0.94 },
  { x: 33.5, lateral: 9.8, yaw: 2.40, scale: 1.00 },
];

// 湖：一件，8 m 宽，摆在水面能露出来的位置（见 js/lake.js 里的理由）。
// dy 把水盆压到地面以下 —— 否则它是一只摆在草地上的澡盆。
// 三潭水：位置、大小、沉入深度全在 js/lake.js 里，这里只负责摆。
// dy 把水盆压到地面以下 —— 否则它是一只摆在草地上的澡盆。
const LAKE_MESH = LAKES.map((lake) => ({
  x: lake.x,
  lateral: lake.lateral,
  yaw: lake.yaw,
  scale: lakeScale(lake),
  dy: -lakeSink(lake),
}));

// 路面相对坐标 → 世界坐标。和 narrative.js 的 spotTransform 同一个公式，
// 注意 lateral 会带动 x（`cx = x − s/len · lateral`），所以两件东西"隔几米"
// 必须用世界坐标量，不能看 x。
function alongPath(spot) {
  // 世界坐标直摆（边界林线用）：不需要再换算。
  if (spot.wx !== undefined) return { cx: spot.wx, cz: spot.wz };
  const s = pathSlope(spot.x);
  const len = Math.sqrt(1 + s * s);
  const lateral = -spot.lateral; // 只放 −z 侧
  return {
    cx: spot.x + (-s / len) * lateral,
    cz: pathCenterZ(spot.x) + (1 / len) * lateral,
  };
}

const SHADOW_Y = 0.012;

function tintMaterial(material, tint) {
  const c = new THREE.Color(tint.color);
  material.color.multiply(c);
  if (tint.gain !== 1) material.color.multiplyScalar(tint.gain);
}

// 加载一件资产，把它烘成「可以直接摆的几何」。
// loadAndNormalizeGLB 已经把缩放、水平居中、贴地写进了 model 的 matrix，
// 所以这里必须把 matrixWorld 乘进几何 —— 否则每个实例都会各自带着偏移。
function bakeGeometry(pivot) {
  pivot.updateMatrixWorld(true);
  let mesh = null;
  pivot.traverse((obj) => {
    if (obj.isMesh && !mesh) mesh = obj;
  });
  if (!mesh) return null;
  const geo = mesh.geometry.clone();
  geo.applyMatrix4(mesh.matrixWorld);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return { geo, material: mesh.material };
}

function shadowDisc(radius, stretch) {
  const g = new THREE.CircleGeometry(radius, 12);
  g.rotateX(-Math.PI / 2);
  g.scale(1, 1, stretch);
  return g;
}

/**
 * 异步加载体量层。任何一件失败都只跳过它，不能让整个场景白屏。
 * 返回 { group, loaded, failed, instances }，instances 是总实例数，供日志与自查。
 */
export async function createScenery() {
  const group = new THREE.Group();
  group.name = 'terrain-scenery';

  const failed = [];
  const loaded = [];
  const shadowParts = [];
  let instances = 0;

  const specs = [
    // 林块只剩路外那 2 处（GROVES）。原来边界那一圈 46 个已经删掉，
    // 改由 BORDER_BUSHES 接管 —— 不是因为它挡不住，是因为它太近：
    // 6.4 m 的树只有玩家贴到 13.9 m 内才进画面，一进画面就在 5–8 m 处、
    // 占掉半屏，读作一坨巨大的绿球。换句话说，林块在边界这个距离上
    // 没有"合适的大小"，只有"太大"和"看不见"两档。细节写在 §边界。
    { key: 'grove', spots: GROVES },
    { key: 'bush', spots: BUSHES.concat(BORDER_BUSHES) },
    { key: 'tree', spots: TREES },
    { key: 'rocks', spots: ROCKS },
    { key: 'dead', spots: DEADS },
    { key: 'lake', spots: LAKE_MESH },
  ];

  await Promise.all(specs.map(async (spec) => {
    const def = ASSETS[spec.key];
    let baked;
    try {
      if (def.build) {
        // 代码生成的资产：几何里已经带顶点色，材质不再接受 tint 乘子，
        // 否则调色会盖掉 deadtree.js 里「根黑 / 干褐 / 梢白」三档。
        const built = def.build();
        baked = {
          geo: built.geometry,
          material: new THREE.MeshToonMaterial({
            vertexColors: true,
            gradientMap: createToonGradientMap(),
          }),
        };
      } else {
        const { pivot } = await loadAndNormalizeGLB(ASSET_ROOT + def.file, {
          autoScale: true,
          targetHeight: def.height,
        });
        let firstMesh = null;
        pivot.traverse((o) => { if (o.isMesh && !firstMesh) firstMesh = o; });
        if (!firstMesh) throw new Error('no mesh');
        // 调色要在烘几何之前做：实例共用同一份材质，只能整件资产一个乘子。
        tintMaterial(firstMesh.material, def.tint);
        baked = bakeGeometry(pivot);
        if (!baked) throw new Error('no mesh');
      }
    } catch (err) {
      failed.push(spec.key);
      console.warn('[scenery] 资产加载失败，跳过', def.file || spec.key, err);
      return;
    }

    const mesh = new THREE.InstancedMesh(baked.geo, baked.material, spec.spots.length);
    mesh.name = `terrain-${spec.key}`;
    const dummy = new THREE.Object3D();

    spec.spots.forEach((spot, i) => {
      const p = alongPath(spot);
      const baseY = terrainY(p.cx, p.cz) + (spot.dy || 0);
      dummy.position.set(p.cx, baseY, p.cz);
      dummy.rotation.set(0, spot.yaw, 0);
      dummy.scale.setScalar(spot.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      // 湖继续走 pushOutOfLake，这里不登记。缩放是每个实例自己的，碰撞数字按它乘。
      if (def.collider) registerAsset(spec.key, p.cx, p.cz, spot.yaw || 0, def, spot.scale || 1);

      // 贴地阴影：湖不给（水面本来就不该有一圈暗），树和岩群给，
      // 否则俯视下它们会"浮"在草上。
      if (def.shadow) {
        const r = def.shadow[0] * spot.scale;
        const g = shadowDisc(r, def.shadow[1]);
        g.rotateY(spot.yaw);
        g.translate(p.cx, terrainY(p.cx, p.cz) + SHADOW_Y, p.cz);
        shadowParts.push(g);
      }
    });

    mesh.instanceMatrix.needsUpdate = true;
    // InstancedMesh 的包围球默认只按几何算，不算实例矩阵，不重算会被视锥错误剔除。
    mesh.computeBoundingSphere();
    group.add(mesh);
    loaded.push(spec.key);
    instances += spec.spots.length;
  }));

  if (shadowParts.length) {
    const shadow = new THREE.Mesh(
      mergeGeometries(shadowParts, false),
      new THREE.MeshBasicMaterial({
        color: 0x1a1408,
        transparent: true,
        opacity: 0.26,
        depthWrite: false,
      }),
    );
    shadow.name = 'terrain-shadow';
    shadow.renderOrder = 1;
    group.add(shadow);
  }

  return { group, loaded, failed, instances };
}
