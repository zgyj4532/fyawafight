// 区块 6d · 路旁陈设
//
// 全部道具在构建期烘成一个合并的 BufferGeometry（顶点色 + 单一 toon 材质），
// 运行时只加两次 draw call：实体一次、贴地阴影一次。
// 位置按「里程点」排在路肩上，横向 2.4–3.2 m，在加速带（半宽 2.1 m）之外。
// 碰撞按构建参数登记在 PROP_COLLIDERS，不从合并后的网格反推。

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createToonGradientMap } from './pipeline.js';
import { pathCenterZ, pathSlope, crossCenterX, crossSlope, terrainY } from './path.js';
import { PROP_COLLIDERS } from './collision-data.js';
import { registerAsset } from './collision.js';

const WOOD = 0x7d5834;
const WOOD_DARK = 0x4a3220;
const WOOD_LIGHT = 0x9c7442;
const STONE = 0x8a857a;
const STONE_DARK = 0x5c584e;
const IRON = 0x3a3a38;
const STRAW = 0xc4a765;

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

const rng = makeRandom(4471);

// uv 全部删掉、全部转非索引：mergeGeometries 要求属性表一致。
function paint(geometry, hex) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  g.deleteAttribute('uv');
  const count = g.attributes.position.count;
  const color = new THREE.Color(hex);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

// 先转再移，顺序固定，写错就是道具飘在半空。
function place(geometry, hex, o = {}) {
  const g = paint(geometry, hex);
  if (o.rx) g.rotateX(o.rx);
  if (o.ry) g.rotateY(o.ry);
  if (o.rz) g.rotateZ(o.rz);
  g.translate(o.x || 0, o.y || 0, o.z || 0);
  return g;
}

function box(list, hex, w, h, d, o) {
  list.push(place(new THREE.BoxGeometry(w, h, d), hex, o));
}

function cyl(list, hex, rTop, rBottom, h, seg, o) {
  list.push(place(new THREE.CylinderGeometry(rTop, rBottom, h, seg), hex, o));
}

function ico(list, hex, r, o) {
  list.push(place(new THREE.IcosahedronGeometry(r, 0), hex, o));
}

// ---- 道具。局部坐标：原点在脚下正中，+x 顺着路，+y 向上 ----

function fenceSection(list) {
  const lean = (rng() - 0.5) * 0.10;
  box(list, WOOD, 0.13, 1.38, 0.13, { x: 0, y: 0.66, rz: lean });
  box(list, WOOD, 0.13, 1.28, 0.13, { x: 2.6, y: 0.61, rz: -lean * 0.8 });
  box(list, WOOD_LIGHT, 2.72, 0.09, 0.07, { x: 1.3, y: 1.06, rz: 0.014 });
  box(list, WOOD_LIGHT, 2.72, 0.085, 0.065, { x: 1.3, y: 0.58, rz: -0.010 });
}

function milestone(list) {
  cyl(list, STONE_DARK, 0.34, 0.31, 0.12, 5, { y: 0.05 });
  cyl(list, STONE, 0.20, 0.25, 0.95, 5, { y: 0.54, rz: 0.05 });
  box(list, STONE_DARK, 0.40, 0.075, 0.34, { y: 1.05, rx: 0.03, rz: 0.05 });
}

function signpost(list) {
  cyl(list, WOOD, 0.062, 0.085, 2.45, 6, { y: 1.22, rz: 0.05 });
  // 两块牌都往同一侧伸出，做成单手伸出的指路牌。
  // 第一版是左右对称挂的，从俯视角看就是一个十字架。
  box(list, WOOD_LIGHT, 0.74, 0.20, 0.055, { x: 0.46, y: 2.06, rz: -0.07 });
  box(list, WOOD, 0.56, 0.17, 0.055, { x: 0.42, y: 1.70, ry: 0.26, rz: 0.05 });
  box(list, WOOD_LIGHT, 0.16, 0.20, 0.055, { x: 0.86, y: 2.05, rz: -0.07 });
  cyl(list, IRON, 0.04, 0.04, 0.06, 6, { y: 0.03 });
}

// 手推车。车轮平躺时从俯视角看只是一个深色椭圆，读不出是什么，
// 立起来才有轮廓：两个圈 + 一块车斗 + 两根车把。
function handCart(list) {
  box(list, WOOD, 1.60, 0.10, 1.00, { y: 0.70 });
  box(list, WOOD_LIGHT, 1.60, 0.28, 0.07, { y: 0.88, z: 0.46 });
  box(list, WOOD_LIGHT, 1.60, 0.28, 0.07, { y: 0.88, z: -0.46 });
  box(list, WOOD_LIGHT, 0.07, 0.28, 0.86, { y: 0.88, x: -0.76 });

  [-0.56, 0.56].forEach((z) => {
    list.push(place(new THREE.TorusGeometry(0.44, 0.055, 4, 12), WOOD_DARK, { x: -0.34, y: 0.48, z }));
    for (let i = 0; i < 3; i += 1) {
      box(list, WOOD, 0.80, 0.05, 0.05, { x: -0.34, y: 0.48, z, rz: (i * Math.PI) / 3 });
    }
    cyl(list, IRON, 0.09, 0.09, 0.10, 6, { x: -0.34, y: 0.48, z, rz: Math.PI / 2 });
  });

  box(list, WOOD, 1.20, 0.075, 0.075, { x: 0.98, y: 0.64, z: 0.34, rz: 0.07 });
  box(list, WOOD, 1.20, 0.075, 0.075, { x: 0.98, y: 0.64, z: -0.34, rz: 0.07 });
}

function barrel(list) {
  cyl(list, WOOD, 0.30, 0.35, 0.86, 10, { y: 0.43 });
  cyl(list, IRON, 0.352, 0.358, 0.055, 10, { y: 0.21 });
  cyl(list, IRON, 0.325, 0.330, 0.055, 10, { y: 0.65 });
}

function crate(list) {
  box(list, WOOD, 0.62, 0.55, 0.62, { y: 0.275 });
  box(list, WOOD_LIGHT, 0.66, 0.06, 0.66, { y: 0.55 });
}

function cairn(list) {
  const stones = [[0.34, 0.17], [0.28, 0.47], [0.21, 0.72], [0.14, 0.88]];
  stones.forEach(([r, y]) => {
    ico(list, rng() < 0.4 ? STONE : STONE_DARK, r, {
      y, rx: rng() * 1.2, ry: rng() * 3.1,
    });
  });
}

function haystack(list) {
  cyl(list, STRAW, 0.66, 0.78, 0.70, 8, { y: 0.35 });
  cyl(list, WOOD_DARK, 0.79, 0.79, 0.08, 8, { y: 0.30 });
  list.push(place(new THREE.ConeGeometry(0.82, 0.72, 8), 0xd8bb7a, { y: 1.04 }));
  cyl(list, WOOD_DARK, 0.035, 0.035, 1.15, 5, { y: 0.55, x: 0.62, rz: 0.25 });
}

function ruinedWall(list) {
  let x = -1.9;
  for (let i = 0; i < 6; i += 1) {
    const w = 0.58 + rng() * 0.22;
    const h = 0.5 + rng() * 0.62;
    box(list, rng() < 0.5 ? STONE : STONE_DARK, w, h, 0.46, {
      x, y: h / 2, rz: (rng() - 0.5) * 0.07,
    });
    x += w * 0.94;
  }
}

const BUILDERS = {
  fence: (list) => fenceSection(list),
  milestone,
  signpost,
  cart: handCart,
  barrel,
  crate,
  cairn,
  hay: haystack,
  wall: ruinedWall,
};

// 里程点。x 沿路，side 决定左右（+1 是靠近镜头那一侧），lateral 是离中心线的横向距离。
// 尺寸按机位反推过：俯角 58° 把竖直方向压到约 0.53，1 m 高的东西只有半米观感高度，
// 所以低于 1 m 的道具在这次改版里全部抬高了。
//
// 2026-11-17 按「道具之间的净空」重新排过一次。怪物没有寻路，撞到挡块的解法是
// 沿切向滑开（js/ai.js 的 moveBody + clipVelocity）——两件挡块之间留 1 m 的缝，
// 体型 1.4 m 的史莱姆会卡在缝口、来回被两边推开，看上去就是"卡位"。
// 所以同一侧相邻道具的净空一律拉到 1.6 m 以上，实测最窄的一处（断墙与里程碑）
// 原来是 0.12 m，等于两件东西焊成一件。间距清单见 docs/地形_十字路口.md。
const LAYOUT = [
  // 出生点四周：玩家一睁眼就能看到栅栏、路标和里程碑
  { x: -8.0, side: -1, kind: 'fence', sections: 4, lateral: 2.95 },
  // 路标原来在 −2.0，正好戳在栅栏（−8…+2.5）中间。挪到栅栏东头之外。
  { x: 5.2, side: -1, kind: 'signpost', lateral: 2.85 },
  { x: 3.0, side: 1, kind: 'milestone', lateral: 2.55 },
  // 车、桶、箱原来挤在 9.0 / 10.6 / 12.2：桶整个落在车的碰撞盒里。
  { x: 8.8, side: 1, kind: 'cart', lateral: 2.75 },
  { x: 12.4, side: 1, kind: 'barrel', lateral: 2.60 },
  { x: 15.2, side: 1, kind: 'crate', lateral: 3.05 },
  { x: 16.0, side: -1, kind: 'cairn', lateral: 3.05 },
  { x: 22.0, side: 1, kind: 'fence', sections: 3, lateral: 2.90 },
  { x: 26.4, side: -1, kind: 'hay', lateral: 3.40 },
  { x: 29.4, side: -1, kind: 'crate', lateral: 2.80 },
  // 断墙的碰撞盒向 +x 伸出 2.1 m，所以它自己往西挪，里程碑留在原位。
  { x: 31.8, side: 1, kind: 'wall', lateral: 3.15 },
  { x: 36.5, side: 1, kind: 'milestone', lateral: 2.55 },
  { x: 44.0, side: -1, kind: 'barrel', lateral: 2.65 },
  { x: 48.0, side: -1, kind: 'cairn', lateral: 3.00 },
  { x: -14.0, side: 1, kind: 'cart', lateral: 2.80 },
  { x: -18.6, side: 1, kind: 'crate', lateral: 3.10 },
  { x: -19.4, side: -1, kind: 'fence', sections: 3, lateral: 2.95 },
  { x: -28.0, side: -1, kind: 'hay', lateral: 3.35 },
  { x: -29.2, side: 1, kind: 'wall', lateral: 3.10 },
  { x: -38.0, side: 1, kind: 'barrel', lateral: 2.60 },
  { x: -44.0, side: -1, kind: 'signpost', lateral: 2.80 },
  { x: -52.0, side: -1, kind: 'milestone', lateral: 2.60 },
];

// 横路（十字路口那条，见 js/path.js 的 CROSS）的陈设。
// 里程是 z，side 决定在路的哪一侧（+1 是 +x 侧），lateral 是离横路中心线的米数。
//
// 为什么横路也要摆东西：主路的陈设全部贴着主路，地图南北两端（世界 z 的两头）
// 是三百多平方米什么都没有的草地。玩家试探着往那边走，看到的只有草。
// 这条横路把"空白"变成"还有一条路可以走"，路边自然就该有东西。
//
// 路口两侧各留 6 m 不放：那是十字路口本身，放什么都挡视线。
// 同一侧沿 z 的间距 ≥ 3 m —— 理由同主路，怪物没有寻路。
//
// **横路上不放栅栏和断墙。** 这两件是沿局部 +x 展开的长条（2.7 m / 4.1 m），
// 而横路的方向是世界 z、和视线平行：栅栏顺着路摆就是一排柱子对着镜头，
// 栏杆退化成一条 1 px 的线，远看只剩几根杵在地上的木棍（第一版就是这样）。
// 长条道具只在主路上用 —— 那是横着看的。横路这一档只放团块状的：
// 桶、箱、石堆、干草、里程碑、路标、手推车。
const CROSS_LAYOUT = [
  // 南段（z < −12）。按「每 10–14 m 一处小站」组织，左右交错，
  // 每一处 2–4 件围成一个小景（货堆 / 路标 / 车 / 石堆），不再是一件一件散着摆。
  //
  // 间距不是随手写的：同侧的净空要 ≥ 两件自身的半长之和 + 一点缝。
  // 上一版把 cart（2.5 m 长）和旁边的桶放在 z 差 1.6 m 处，实测边到边只剩
  // **0.029 m** —— 视觉上粘成一坨，tank 的碰撞盒还互相嵌。所以凡是 cart 旁边，
  // 同侧一律留到 3.5 m；hay（半径 1.1）旁边留 1.8 m；小件之间 1.5–1.8 m。
  { z: -55.0, side: -1, kind: 'milestone', lateral: 2.65 },
  { z: -53.2, side: 1, kind: 'crate', lateral: 2.90 },
  { z: -51.4, side: 1, kind: 'barrel', lateral: 3.40 },
  { z: -48.0, side: -1, kind: 'hay', lateral: 3.40 },
  { z: -46.2, side: -1, kind: 'barrel', lateral: 2.80 },
  { z: -42.5, side: 1, kind: 'cart', lateral: 3.00 },
  { z: -39.0, side: 1, kind: 'crate', lateral: 2.80 },
  { z: -36.5, side: -1, kind: 'signpost', lateral: 2.90 },
  { z: -35.0, side: -1, kind: 'milestone', lateral: 2.60 },
  { z: -31.5, side: 1, kind: 'cairn', lateral: 3.10 },
  { z: -29.8, side: 1, kind: 'barrel', lateral: 2.80 },
  { z: -26.0, side: -1, kind: 'hay', lateral: 3.40 },
  { z: -24.2, side: -1, kind: 'crate', lateral: 3.00 },
  { z: -20.5, side: 1, kind: 'cart', lateral: 3.10 },
  { z: -17.0, side: 1, kind: 'barrel', lateral: 2.80 },
  { z: -14.0, side: -1, kind: 'cairn', lateral: 3.10 },
  { z: -12.4, side: -1, kind: 'crate', lateral: 2.90 },
  // 北段（z > +2）
  { z: 4.0, side: -1, kind: 'barrel', lateral: 2.75 },
  { z: 6.5, side: 1, kind: 'crate', lateral: 2.95 },
  { z: 8.2, side: 1, kind: 'barrel', lateral: 3.35 },
  { z: 11.0, side: -1, kind: 'hay', lateral: 3.40 },
  { z: 12.8, side: 1, kind: 'milestone', lateral: 2.60 },
  { z: 14.5, side: 1, kind: 'signpost', lateral: 2.90 },
  { z: 18.0, side: -1, kind: 'cart', lateral: 3.05 },
  { z: 21.5, side: -1, kind: 'crate', lateral: 2.85 },
  { z: 24.5, side: 1, kind: 'cairn', lateral: 3.10 },
  { z: 26.2, side: 1, kind: 'barrel', lateral: 2.80 },
  { z: 29.0, side: -1, kind: 'hay', lateral: 3.40 },
  { z: 30.8, side: -1, kind: 'crate', lateral: 2.95 },
  { z: 34.5, side: 1, kind: 'cart', lateral: 3.10 },
  { z: 38.0, side: 1, kind: 'barrel', lateral: 2.80 },
  { z: 41.0, side: -1, kind: 'cairn', lateral: 3.10 },
  { z: 42.8, side: -1, kind: 'barrel', lateral: 2.85 },
  { z: 46.0, side: 1, kind: 'milestone', lateral: 2.60 },
  { z: 47.5, side: 1, kind: 'signpost', lateral: 2.90 },
  { z: 51.0, side: -1, kind: 'cart', lateral: 3.05 },
  { z: 54.5, side: -1, kind: 'hay', lateral: 3.40 },
  { z: 56.5, side: 1, kind: 'crate', lateral: 2.90 },
];

// 路面上的货：**撤掉了**（2026-11-17 晚第二版）。
//
// 上一版在这里放了 9 件，横向 1.15–1.50 m，想读作「运输队掉下来的货」。
// 实测下来它两边不讨好：
//   · 通行带体检（tools/probe_cross_walk.mjs）显示，路心点到最近的箱边只剩
//     **0.82 m** —— 玩家半径 0.45，实际余量 0.37 m。沿路心还能走，但两侧被挤死，
//     第一眼就是「路上堆着东西挡道」；
//   · 9 件撒在 111 m 的路上，平均 12 m 一件，仍然读不出「有货」，只读得出「乱」。
//
// 结论：路面应该**干净**，丰富度交给两侧。人群靠密度和成组，不靠占道。
// 想留「出过事」的味道，就把这件事做成一整组（车 + 散箱 + 桶），放在路肩，
// 而不是把单件撒到路中间。这一版先按干净的运输大道处理。

// --- 四角 ---------------------------------------------------------------
//
// 玩家说「地图左上、右上、左下、右下都没有障碍物，不够丰富」。
// 之前所有陈设都沿着两条路铺，四个角是三百多平方米的纯草地 —— 站在路口斜看，
// 画面四角就是一片什么都没有的绿。
//
// 四角各给一个**不同的主题**，用现有的道具搭（不新增 GLB）：
//   西北 · 古战场残迹 —— 断墙成 L 形，石堆当坟，枯树补轮廓
//   东北 · 伐木营地   —— 车、木堆、围栏，读作有人在这里干过活
//   西南 · 沼泽枯林   —— 枯树 + 石堆，最荒的一角
//   东南 · 废弃农舍   —— 两段墙 + 干草 + 车，是被丢下的院子
//
// 坐标系：这里直接用世界坐标（wx / wz），不走「里程 + lateral」——
// 四角不在任何一条路上，硬套路的坐标系只会让数字变得看不懂。
// 道具朝向 yaw 是绕 Y 轴的角度，长条件（墙 / 围栏）要自己定，别让它们
// 顺着视线摆（理由同横路不放栅栏：顺着视线会退化成一根柱子）。
const WILDS = [
  // 西北 · 古战场残迹（约 −44, −44）
  { wx: -47.0, wz: -44.0, kind: 'wall', yaw: 0.35, shadow: true },
  { wx: -44.5, wz: -46.8, kind: 'wall', yaw: 1.92, shadow: true },
  { wx: -43.0, wz: -42.2, kind: 'cairn', yaw: 0.0, shadow: true },
  { wx: -46.8, wz: -40.6, kind: 'cairn', yaw: 1.1, shadow: true },
  { wx: -41.2, wz: -45.4, kind: 'barrel', yaw: 0.0, shadow: true },
  { wx: -42.4, wz: -39.4, kind: 'crate', yaw: 0.6, shadow: true },

  // 东北 · 伐木营地（约 44, −42）
  { wx: 41.5, wz: -44.5, kind: 'cart', yaw: 0.9, shadow: true },
  { wx: 44.2, wz: -42.0, kind: 'crate', yaw: 0.0, shadow: true },
  { wx: 45.0, wz: -40.4, kind: 'crate', yaw: 0.55, shadow: true },
  { wx: 46.4, wz: -44.0, kind: 'barrel', yaw: 0.0, shadow: true },
  { wx: 43.0, wz: -47.2, kind: 'hay', yaw: 0.3, shadow: true },
  { wx: 39.6, wz: -41.2, kind: 'fence', yaw: -0.42, sections: 2, shadow: true },

  // 西南 · 沼泽枯林（约 −42, 44）
  { wx: -45.5, wz: 42.0, kind: 'cairn', yaw: 0.8, shadow: true },
  { wx: -43.0, wz: 45.6, kind: 'cairn', yaw: 0.0, shadow: true },
  { wx: -40.2, wz: 41.4, kind: 'barrel', yaw: 0.0, shadow: true },
  { wx: -46.4, wz: 46.8, kind: 'crate', yaw: 0.9, shadow: true },

  // 东南 · 废弃农舍（约 42, 42）
  { wx: 43.5, wz: 41.0, kind: 'wall', yaw: 0.18, shadow: true },
  { wx: 45.2, wz: 44.6, kind: 'wall', yaw: 1.75, shadow: true },
  { wx: 41.2, wz: 44.2, kind: 'hay', yaw: 0.5, shadow: true },
  { wx: 46.4, wz: 42.4, kind: 'barrel', yaw: 0.0, shadow: true },
  { wx: 38.6, wz: 39.4, kind: 'cart', yaw: -0.7, shadow: true },
  { wx: 44.0, wz: 47.4, kind: 'crate', yaw: 0.25, shadow: true },
];

const SHADOW_Y = 0.010;

// 每种道具的贴地阴影尺寸：[半径, 纵向压扁]
const SHADOW = {
  fence: [1.45, 0.32],
  wall: [2.00, 0.24],
  cart: [1.25, 0.78],
  hay: [1.10, 0.85],
  crate: [0.84, 0.84],
  barrel: [0.72, 0.84],
  cairn: [0.78, 0.82],
  milestone: [0.78, 0.82],
  signpost: [0.62, 0.72],
};
// 贴地阴影片。没有 shadowMap，用一块压扁的暗片把道具「钉」在地上，
// 否则它们看着像浮在草面上。
function shadowDisc(radius, stretch) {
  const g = paint(new THREE.CircleGeometry(radius, 10), 0xffffff);
  g.rotateX(-Math.PI / 2);
  g.scale(1, 1, stretch);
  return g;
}

export function createRoadProps() {
  const solids = [];
  const shadows = [];
  const matrix = new THREE.Matrix4();
  const euler = new THREE.Euler();

  // 先把两条路的道具摊成同一串「世界坐标 + 偏航」，后面只有一份构建代码。
  const placed = [];

  LAYOUT.forEach((item) => {
    const s0 = pathSlope(item.x);
    const len0 = Math.sqrt(1 + s0 * s0);
    const lateral = item.lateral * item.side;
    const sections = item.sections || 1;
    for (let i = 0; i < sections; i += 1) {
      // 栅栏要顺着路铺开：按弧长一段一段往前走，不能沿 x 简单平移。
      const x = item.x + (i * 2.6) / len0;
      const s = pathSlope(x);
      const len = Math.sqrt(1 + s * s);
      placed.push({
        kind: item.kind,
        cx: x + (-s / len) * lateral,
        cz: pathCenterZ(x) + (1 / len) * lateral,
        yaw: -Math.atan(s),
        shadow: i === 0,
      });
    }
  });

  CROSS_LAYOUT.forEach((item) => {
    const sections = item.sections || 1;
    const lateral = item.lateral * item.side;
    for (let i = 0; i < sections; i += 1) {
      // 横路的里程是 z，切线是 (s, 1)/len，所以「往下一段走」是把 z 加大。
      const z = item.z + (i * 2.6) / Math.sqrt(1 + crossSlope(item.z) ** 2);
      const s = crossSlope(z);
      const len = Math.sqrt(1 + s * s);
      placed.push({
        kind: item.kind,
        cx: crossCenterX(z) + (1 / len) * lateral,
        cz: z + (-s / len) * lateral,
        // 局部 +x 要对准横路的切线：θ = −π/2 + atan(s)。
        yaw: -Math.PI / 2 + Math.atan(s),
        shadow: i === 0,
      });
    }
  });

  // 四角生态：世界坐标直摆。长条件（墙 / 围栏）用 sections 沿自己的局部 +x
  // 往前走 2.6 m —— three.js 绕 Y 转 yaw 之后，局部 +x 在世界里是 (cos, −sin)。
  WILDS.forEach((item) => {
    const sections = item.sections || 1;
    for (let i = 0; i < sections; i += 1) {
      placed.push({
        kind: item.kind,
        cx: item.wx + i * 2.6 * Math.cos(item.yaw),
        cz: item.wz - i * 2.6 * Math.sin(item.yaw),
        yaw: item.yaw,
        shadow: i === 0,
      });
    }
  });

  placed.forEach((spot) => {
    const { kind, cx, cz, yaw } = spot;
    const prop = PROP_COLLIDERS[kind];
    if (prop) registerAsset(kind, cx, cz, yaw, prop);

    const local = [];
    BUILDERS[kind](local);
    euler.set(0, yaw, 0);
    matrix.makeRotationFromEuler(euler);
    // 路基被小山丘垫起来了，道具必须踩在同一层地面上。
    matrix.setPosition(cx, terrainY(cx, cz), cz);
    local.forEach((g) => {
      g.applyMatrix4(matrix);
      solids.push(g);
    });

    if (spot.shadow) {
      const [shadowR, shadowS] = SHADOW[kind] || [0.8, 0.82];
      const quad = shadowDisc(shadowR, shadowS);
      quad.translate(0, SHADOW_Y, 0);
      quad.applyMatrix4(matrix);
      shadows.push(quad);
    }
  });

  const solidGeometry = mergeGeometries(solids, false);
  const shadowGeometry = mergeGeometries(shadows, false);
  solids.forEach((g) => g.dispose());
  shadows.forEach((g) => g.dispose());

  const group = new THREE.Group();

  const solidMesh = new THREE.Mesh(
    solidGeometry,
    new THREE.MeshToonMaterial({
      vertexColors: true,
      gradientMap: createToonGradientMap(),
    }),
  );
  solidMesh.castShadow = false;
  solidMesh.receiveShadow = false;
  group.add(solidMesh);

  const shadowMesh = new THREE.Mesh(
    shadowGeometry,
    new THREE.MeshBasicMaterial({
      color: 0x1a1408,
      transparent: true,
      opacity: 0.30,
      depthWrite: false,
    }),
  );
  shadowMesh.renderOrder = 1;
  group.add(shadowMesh);

  return {
    group,
    triangles: solidGeometry.attributes.position.count / 3,
  };
}
