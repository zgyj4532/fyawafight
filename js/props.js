// 区块 6d · 路旁陈设
//
// 全部道具在构建期烘成一个合并的 BufferGeometry（顶点色 + 单一 toon 材质），
// 运行时只加两次 draw call：实体一次、贴地阴影一次。
// 位置按「里程点」排在路肩上，横向 2.4–3.2 m，在加速带（半宽 2.1 m）之外。
// 碰撞按构建参数登记在 PROP_COLLIDERS，不从合并后的网格反推。

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createToonGradientMap } from './pipeline.js';
import { pathCenterZ, pathSlope, terrainY } from './path.js';
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
const LAYOUT = [
  // 出生点四周：玩家一睁眼就能看到栅栏、路标和里程碑
  { x: -8.0, side: -1, kind: 'fence', sections: 4, lateral: 2.95 },
  { x: -2.0, side: -1, kind: 'signpost', lateral: 2.85 },
  { x: 3.0, side: 1, kind: 'milestone', lateral: 2.55 },
  { x: 9.0, side: 1, kind: 'cart', lateral: 2.75 },
  { x: 10.6, side: 1, kind: 'barrel', lateral: 2.60 },
  { x: 12.2, side: 1, kind: 'crate', lateral: 3.05 },
  { x: 16.0, side: -1, kind: 'cairn', lateral: 3.05 },
  { x: 22.0, side: 1, kind: 'fence', sections: 3, lateral: 2.90 },
  { x: 26.0, side: -1, kind: 'hay', lateral: 3.40 },
  { x: 28.5, side: -1, kind: 'crate', lateral: 2.80 },
  { x: 34.0, side: 1, kind: 'wall', lateral: 3.15 },
  { x: 36.5, side: 1, kind: 'milestone', lateral: 2.55 },
  { x: 44.0, side: -1, kind: 'barrel', lateral: 2.65 },
  { x: 48.0, side: -1, kind: 'cairn', lateral: 3.00 },
  { x: -14.0, side: 1, kind: 'cart', lateral: 2.80 },
  { x: -16.2, side: 1, kind: 'crate', lateral: 3.10 },
  { x: -22.0, side: -1, kind: 'fence', sections: 3, lateral: 2.95 },
  { x: -26.0, side: -1, kind: 'hay', lateral: 3.35 },
  { x: -32.0, side: 1, kind: 'wall', lateral: 3.10 },
  { x: -38.0, side: 1, kind: 'barrel', lateral: 2.60 },
  { x: -44.0, side: -1, kind: 'signpost', lateral: 2.80 },
  { x: -52.0, side: -1, kind: 'milestone', lateral: 2.60 },
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

  LAYOUT.forEach((item) => {
    const s0 = pathSlope(item.x);
    const len0 = Math.sqrt(1 + s0 * s0);
    const lateral = item.lateral * item.side;
    const sections = item.sections || 1;

    const [shadowR, shadowS] = SHADOW[item.kind] || [0.8, 0.82];
    const shadow = shadowDisc(shadowR, shadowS);

    for (let i = 0; i < sections; i += 1) {
      // 栅栏要顺着路铺开：按弧长一段一段往前走，不能沿 x 简单平移。
      const x = item.x + (i * 2.6) / len0;
      const s = pathSlope(x);
      const len = Math.sqrt(1 + s * s);
      const cx = x + (-s / len) * lateral;
      const cz = pathCenterZ(x) + (1 / len) * lateral;
      const yawI = -Math.atan(s);
      const prop = PROP_COLLIDERS[item.kind];
      if (prop) registerAsset(item.kind, cx, cz, yawI, prop);

      const local = [];
      BUILDERS[item.kind](local);
      euler.set(0, yawI, 0);
      matrix.makeRotationFromEuler(euler);
      // 路基被小山丘垫起来了，道具必须踩在同一层地面上。
      matrix.setPosition(cx, terrainY(cx, cz), cz);
      local.forEach((g) => {
        g.applyMatrix4(matrix);
        solids.push(g);
      });

      if (i === 0) {
        const quad = shadow.clone();
        quad.translate(0, SHADOW_Y, 0);
        quad.applyMatrix4(matrix);
        shadows.push(quad);
      }
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
