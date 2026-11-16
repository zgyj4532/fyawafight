// 区块 6i · 边界全息力场
//
// 这一层只做一件事：**把地图边界画出来，而且一眼能认出来。**
//
// 原来的做法是四块平躺在地上的紫色符纹贴片（`makePortal`），宽 120、深 3，
// 摆在边界内侧 1.5 m。它在 58° 俯视下只是一条**颜色略深的横带** ——
// 玩家跑过去的时候根本注意不到自己越界了，直到被传送走才反应过来。
//
// 这一版换成六层结构，全部写在自定义着色器里，不引任何贴图，也不引外部库：
//
//   一、**地面轨道**（宽 3.6 m）：两条边线 + 每 6 m 一道横杠 + 中央虚线，
//       逐顶点贴地形（路口那一段被路堤垫高 1.4 m）。俯视下平躺的东西读得最准，
//       所以它是整层唯一的"骨"。
//   二、**外发光**（宽 5.8 m、几乎全透明）：这个项目没有后处理，加色混合的
//       细线在绿草地上不够"耀"，用一层宽面把光散开 —— 廉价 bloom。
//   三、**全息门环**（每 6 m 一道，共 84 道）：顶点着色器里按视图矩阵的右/上
//       向量展开成永远正对相机的方片，任何机位都是正圆。它是"传送门"的识别点。
//   四、**立柱 + 顶杆**（1.75 m）：给边界一条"上沿"，让一排门环被连成一道围栏。
//   五、**上升粒子**（2400 个）：沿边界飘，慢而小，科技感主要来自它。
//   六、**节点喷流**（84 × 40 = 3360 个）：绕每根柱子旋着往上，竖直方向的
//       "高度感"靠粒子而不是靠几何 —— 几何一旦竖起来就会被透视拉成光条。
//
// 四个技术选择：
//
//   **一、四条边合并成一个 mesh。** 六层各 1 次 draw call，整层 +8。
//       如果按边拆开就是 30 次，为了"靠近哪条边哪条亮"不值得。
//       方向性改在着色器里做：每个片元按自己到玩家的距离算亮度，效果一样。
//
//   **二、全部 AdditiveBlending + depthWrite false。** 力场不该遮挡任何东西，
//       只往画面上加光；被树挡住的时候（depthTest 仍开着）会自然地绕过去。
//
//   **三、亮度随距离衰减。** 玩家离边界 44 m 外时几乎不可见，走近才拉满。
//       这也是唯一的性能手段 —— 它一直在画，只是远处看不见。
//
//   **四、所有竖直元素共用一个高度常量 `BARRIER_HEIGHT`。**
//       高度不统一时画面上是三种互相打架的高度，读不出"一道围栏"。
//
// 时间源用 `state.time.elapsed`（秒），不用 performance.now()：暂停时
// 扫描和粒子也应该停住，否则暂停画面里还有东西在动。

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { terrainY } from './path.js';
import { CONFIG } from './config.js';

// 障碍物的**唯一高度基准**：墙顶、柱顶、顶杆都落在这一条线上。
//
// 上一版是墙 3.2 m / 柱 4.2 m / 粒子 3.8 m 三个数各写各的，画面上三种高度
// 互相打架，读不出"这是一道围栏"。统一之后整个边界是一个 1.75 m 高的
// 装置，从任何角度看都是同一个东西。
//
// 1.75 m 不是随便取的，是**透视约束反解出来的**：相机 pitch 58°、fov 45、
// 900 px 视口，5 m 处竖直物的屏幕投影 ≈ h·sin58°·217 px/m。
//   4.2 m → 775 px（占满画面 86%，读作一束探照灯）
//   1.75 m → 323 px（占 36%，读作一根标桩）
// 玩家能走到离边界 0.5 m 以内，所以"近处会不会变成激光束"是硬约束，
// 不是审美偏好。
const BARRIER_HEIGHT = 1.75;
// 墙脚压到地面以下。路口那一段被路堤垫到 1.4 m，墙不往下扎会被土埋掉半截。
const WALL_BOTTOM = -0.9;
const WALL_HEIGHT = BARRIER_HEIGHT - WALL_BOTTOM;
const BAND_WIDTH = 3.6;
const DUST_PER_EDGE = 600;

// 青 → 紫。青是"科技"、紫是叙事层一直在用的符纹色（0x8e79ba），
// 两种颜色接上，力场才不会像是从另一个游戏里搬来的。
const COLOR_LOW = new THREE.Color(0x2ee6ff);
const COLOR_HIGH = new THREE.Color(0xa98bff);

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const WALL_VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vWorld;
varying vec3 vNormalW;
void main() {
  vUv = uv;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const WALL_FRAG = /* glsl */`
uniform float uTime;
uniform vec3 uPlayer;
uniform vec3 uLow;
uniform vec3 uHigh;
uniform float uBoost;

varying vec2 vUv;
varying vec3 vWorld;
varying vec3 vNormalW;

// 周期细线：x 是"第几格"，w 是线宽（格为单位）
float lineMask(float x, float w) {
  float f = abs(fract(x) - 0.5);
  return smoothstep(0.5 - w, 0.5, f);
}

void main() {
  // 每 2.7 m 一条竖线（墙长 120 m → 44 格），横向 4 格。
  // 用 80 格那版在远处只有 3 px 一格，叠出来是摩尔纹，反而糊成一片。
  float gx = lineMask(vUv.x * 44.0, 0.035);
  float gy = lineMask(vUv.y * 4.0, 0.045);
  float grid = max(gx * 0.9, gy * 0.4);

  // 上行扫描带：一条亮带从墙脚爬到墙顶，周期约 4.5 s
  float s = fract(vUv.y * 0.5 - uTime * 0.22);
  // smoothstep(edge0, edge1, x) 要求 edge0 < edge1；写反了是**未定义行为**，
  // ANGLE 上退化成"小于阈值就返回 1"，整条遮罩会反向。全文件统一改成减法写法。
  float scan = smoothstep(0.0, 0.05, s) * (1.0 - smoothstep(0.05, 0.14, s));

  // 底部能量堆积：越靠地越亮，读作"力场从地里冒出来"
  float base = exp(-vUv.y * 7.0) * 1.35;

  // 掠射边缘光：正对着看几乎透明，斜着看边缘发亮
  vec3 V = normalize(cameraPosition - vWorld);
  float fres = pow(1.0 - abs(dot(normalize(vNormalW), V)), 2.0);

  // 顶部 38% 渐隐，避免墙顶一条硬切线
  float top = 1.0 - smoothstep(0.62, 1.0, vUv.y);

  // 按到玩家的水平距离给强度：30 m 外 0.35，4 m 内 1.0
  float d = distance(vWorld.xz, uPlayer.xz);
  float near = smoothstep(30.0, 4.0, d);

  // fresnel 权重从 0.65 收到 0.22：沿墙走时掠射角会把它拉满，
  // 120 m 长的一整面墙同时亮 + 加色混合 = 一块盖住半屏的白青色楔形。
  float a = (grid * 0.55 + scan * 1.0 + base + fres * 0.22) * top;
  a *= (0.35 + 0.65 * near) * uBoost;

  vec3 col = mix(uLow, uHigh, vUv.y * 0.85);
  col += uHigh * scan * 0.5;

  gl_FragColor = vec4(col, clamp(a, 0.0, 0.42));
}`;

const BAND_VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const BAND_FRAG = /* glsl */`
uniform float uTime;
uniform vec3 uPlayer;
uniform vec3 uColor;
uniform vec3 uColor2;
uniform float uBoost;

varying vec2 vUv;
varying vec3 vWorld;

void main() {
  // 不画实心光带。第一版是实心的，Additive 叠到 3 层就烧成一坨白，
  // 读作"地上裂了条发光的缝"，不是"边界装置"。
  //
  // 现在是两条平行轨道 + 中间的横向刻度：
  //   轨道让眼睛能一路跟着走到远处；刻度给出"每 2 m 一格"的尺度；
  //   中间留空，灌木和草从带子里透出来，它才像铺在场地上而不是盖上去的。
  float v = vUv.y;
  float railA = 1.0 - smoothstep(0.0, 0.032, abs(v - 0.16));
  float railB = 1.0 - smoothstep(0.0, 0.032, abs(v - 0.84));
  float rail = railA + railB;

  // 横向刻度：每 2 m 一道（120 m → 60 格），只连在两轨之间
  // g 在刻度线上是 0、在两刻度之间是 0.5，所以**刻度是"接近 0"的地方**。
  // 上一版写成 smoothstep(0.5, 0.468, g)：边界反了，ANGLE 算成"g 小于 0.468
  // 就是 1"，等于把整条带子填实 —— 画面上那块实心色板就是这么来的，
  // 中间每 6 m 那些暗线才是本该发光的刻度。
  float g = abs(fract(vUv.x * 20.0) - 0.5);
  float span = smoothstep(0.10, 0.16, v) * (1.0 - smoothstep(0.84, 0.90, v));
  float tick = (1.0 - smoothstep(0.0, 0.020, g)) * span;

  // 中央虚线：每 4 m 一段亮，把两轨之间填上节奏
  float dsh = fract(vUv.x * 30.0);
  float dash = smoothstep(0.0, 0.10, dsh) * (1.0 - smoothstep(0.90, 1.0, dsh));
  float core = (1.0 - smoothstep(0.0, 0.016, abs(v - 0.5))) * dash;

  // 沿轨道跑的能量块：周期 8 m，和刻度对齐
  float run = pow(0.5 + 0.5 * sin(vUv.x * 15.0 - uTime * 2.2), 10.0);

  float d = distance(vWorld.xz, uPlayer.xz);
  float near = smoothstep(34.0, 3.0, d);

  float a = rail * (0.55 + run * 0.62) + tick * 0.46 + core * 0.34 + 0.018;
  a *= (0.28 + 0.72 * near) * uBoost;

  // 紫色只用来给刻度"点一下"，不能铺开：紫叠在暖绿草地上读作一块污渍，
  // 而青是绿色的补色、加色叠加反而提成白 —— 边界整体必须是青的。
  vec3 col = uColor;
  col = mix(col, uColor2, tick * 0.34);
  col += uColor * run * 0.45;

  gl_FragColor = vec4(col, clamp(a, 0.0, 0.52));
}`;

const DUST_VERT = /* glsl */`
attribute float aPhase;
attribute float aSpeed;
attribute float aSize;

uniform float uTime;
uniform float uHeight;
uniform float uPlayerX;
uniform float uPlayerZ;
uniform float uPxScale;
uniform float uBoost;

varying float vAlpha;

void main() {
  float h = fract(aPhase + uTime * aSpeed);
  vec3 p = position;
  p.y += h * uHeight;

  vec4 mv = viewMatrix * modelMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  float d = distance(p.xz, vec2(uPlayerX, uPlayerZ));
  float near = smoothstep(34.0, 4.0, d);

  // 头部淡入、尾部淡出，循环处不会"啪"地出现
  vAlpha = smoothstep(0.0, 0.14, h) * (1.0 - smoothstep(0.6, 1.0, h));
  vAlpha *= (0.2 + 0.8 * near) * uBoost;

  gl_PointSize = aSize * (1.0 - h * 0.45) * uPxScale / max(1.0, -mv.z) * (0.75 + 0.25 * near);
}`;

const DUST_FRAG = /* glsl */`
uniform vec3 uColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c);
  float a = smoothstep(0.5, 0.05, r) * vAlpha;
  gl_FragColor = vec4(uColor, a);
}`;

// 立柱。前面三件（墙、带、粒子）都是"连续量"，画面上是一条没有节点的光带；
// 玩家能看出那里在发光，但看不出"边界有几段、我从第几根柱子旁边过"。
// 每 12 m 一根柱子就把边界变成可数的东西 —— 这是"标定"和"装饰"的区别。
const HALO_FRAG = /* glsl */`
uniform vec3 uColor;
uniform vec3 uPlayer;
uniform float uBoost;
varying vec2 vUv;
varying vec3 vWorld;
void main() {
  // 只做"面"，不做结构：中间亮、两边散开，叠在带子下面就是一层辉光
  float v = vUv.y;
  float edge = smoothstep(0.0, 0.42, v) * (1.0 - smoothstep(0.58, 1.0, v));
  float d = distance(vWorld.xz, uPlayer.xz);
  float near = smoothstep(40.0, 5.0, d);
  gl_FragColor = vec4(uColor, edge * 0.075 * (0.3 + 0.7 * near) * uBoost);
}`;

const PILLAR_VERT = /* glsl */`
attribute float aPhase;
uniform float uTime;
uniform vec3 uPlayer;
uniform float uBoost;
varying vec2 vUv;
varying float vA;
void main() {
  vUv = uv;
  vec4 world = modelMatrix * vec4(position, 1.0);
  // 底亮顶淡，读作"从地里长出来的光"
  vA = 1.0 - uv.y;
  vA *= 0.72 + 0.28 * sin(uTime * 1.7 + aPhase * 6.283);
  float d = distance(world.xz, uPlayer.xz);
  vA *= smoothstep(42.0, 4.0, d) * uBoost;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

const PILLAR_FRAG = /* glsl */`
uniform vec3 uColor;
uniform vec3 uColor2;
varying vec2 vUv;
varying float vA;
void main() {
  // 横向中间亮、两侧收：两根交叉面叠起来才像个圆柱，不是两块纸片
  float cx = 1.0 - abs(vUv.x * 2.0 - 1.0);
  float a = pow(cx, 0.75) * vA * 1.05;
  vec3 col = mix(uColor, uColor2, vUv.y);
  gl_FragColor = vec4(col, clamp(a, 0.0, 0.95));
}`;

function makeWall(size) {
  const half = size / 2;
  const parts = [];
  const seg = (rotY, tx, tz) => {
    const g = new THREE.PlaneGeometry(size, WALL_HEIGHT);
    g.rotateY(rotY);
    g.translate(tx, WALL_BOTTOM + WALL_HEIGHT / 2, tz);
    parts.push(g);
  };
  seg(0, 0, -half);
  seg(Math.PI, 0, half);
  seg(-Math.PI / 2, half, 0);
  seg(Math.PI / 2, -half, 0);
  return mergeGeometries(parts, false);
}

// 地面带要贴地形。边界不是平的：路口那一段（x = ±60、z ≈ −5）被路堤
// 抬到 1.4 m，其余是 0。所以沿墙细分 120 段，逐顶点取 terrainY。
function makeBand(size, width = BAND_WIDTH) {
  const half = size / 2;
  const parts = [];
  const seg = (rotY, tx, tz) => {
    // 横向必须细分。路口那一段是路堤的横坡（3.6 m 宽里有 1.4 m 高差），
    // 只给 2 个横向顶点时整条带子是一条直线，中间埋进土里、只剩两侧露头 ——
    // 截图里路口那道"带子断了一截"就是这么来的。
    const g = new THREE.PlaneGeometry(size, width, 120, 8);
    g.rotateX(-Math.PI / 2);
    g.rotateY(rotY);
    g.translate(tx, 0, tz);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i += 1) {
      pos.setY(i, terrainY(pos.getX(i), pos.getZ(i)) + 0.05);
    }
    g.computeVertexNormals();
    parts.push(g);
  };
  seg(0, 0, -half);
  seg(Math.PI, 0, half);
  seg(-Math.PI / 2, half, 0);
  seg(Math.PI / 2, -half, 0);
  return mergeGeometries(parts, false);
}

function makeDust(size) {
  const half = size / 2;
  const rnd = seeded(6161);
  const positions = [];
  const phases = [];
  const speeds = [];
  const sizes = [];

  const push = (x, z) => {
    positions.push(x, terrainY(x, z), z);
    // 相位铺满 0…1：不然所有粒子同时从地面升起，读作"一排节拍器"
    phases.push(rnd());
    speeds.push(0.09 + rnd() * 0.15);
    sizes.push(0.06 + rnd() * 0.075);
  };

  for (let i = 0; i < DUST_PER_EDGE; i += 1) {
    const t = (i + rnd()) / DUST_PER_EDGE;
    const along = -half + t * size;
    const off = (rnd() - 0.5) * 2.4; // 散在带子宽度内，别全挤在一条线上
    push(along, -half + off);
    push(along, half + off);
    push(-half + off, along);
    push(half + off, along);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('aPhase', new THREE.Float32BufferAttribute(phases, 1));
  geo.setAttribute('aSpeed', new THREE.Float32BufferAttribute(speeds, 1));
  geo.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 1));
  geo.computeBoundingSphere();
  return geo;
}

// 立柱的站位。柱子、节点环、粒子喷流三件必须落在同一批坐标上，
// 否则会出现"环在左边、柱子偏右"的错位。抽成一份，三处共用。
function pylonSpots(size) {
  const half = size / 2;
  const spots = [];
  const STEP = 6;
  for (let t = -half; t <= half + 1e-6; t += STEP) {
    spots.push({ x: t, z: -half });
    spots.push({ x: t, z: half });
    spots.push({ x: -half, z: t });
    spots.push({ x: half, z: t });
  }
  return spots;
}

// 节点粒子喷流。柱子是硬光，粒子是软光 —— 竖直方向上"看起来高"靠粒子，
// 不靠几何。每根柱子 40 个点，绕着柱轴往上旋，出顶就重来。
const JET_VERT = /* glsl */`
attribute float aPhase;
attribute float aSpeed;
attribute float aSize;
attribute float aAngle;
attribute float aRadius;

uniform float uTime;
uniform float uHeight;
uniform float uPlayerX;
uniform float uPlayerZ;
uniform float uPxScale;
uniform float uBoost;

varying float vAlpha;

void main() {
  float h = fract(aPhase + uTime * aSpeed);
  float ang = aAngle + h * 3.4;
  vec3 p = position;
  p.x += cos(ang) * aRadius * (0.35 + h * 1.15);
  p.z += sin(ang) * aRadius * (0.35 + h * 1.15);
  p.y += h * uHeight;

  vec4 mv = viewMatrix * modelMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  float d = distance(p.xz, vec2(uPlayerX, uPlayerZ));
  float near = smoothstep(40.0, 4.0, d);

  vAlpha = smoothstep(0.0, 0.10, h) * (1.0 - smoothstep(0.45, 1.0, h));
  vAlpha *= (0.25 + 0.75 * near) * uBoost;
  gl_PointSize = aSize * (1.0 - h * 0.35) * uPxScale / max(1.0, -mv.z) * (0.7 + 0.3 * near);
}`;

// 一根柱子 40 个点。数量要给够：少于 30 个时近距离能数出点来，
// 读作"漏光的粒子"，而不是"一束能量"。
const JET_PER_PYLON = 40;

function makeJets(size) {
  const spots = pylonSpots(size);
  const rnd = seeded(8031);
  const positions = [];
  const phases = [];
  const speeds = [];
  const sizes = [];
  const angles = [];
  const radii = [];

  for (const s of spots) {
    const y = terrainY(s.x, s.z);
    const a0 = rnd() * Math.PI * 2;
    for (let i = 0; i < JET_PER_PYLON; i += 1) {
      positions.push(s.x, y, s.z);
      phases.push(rnd());
      speeds.push(0.10 + rnd() * 0.16);
      sizes.push(0.05 + rnd() * 0.06);
      angles.push(a0 + (i / JET_PER_PYLON) * Math.PI * 2 + rnd() * 0.5);
      radii.push(0.06 + rnd() * 0.16);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('aPhase', new THREE.Float32BufferAttribute(phases, 1));
  geo.setAttribute('aSpeed', new THREE.Float32BufferAttribute(speeds, 1));
  geo.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 1));
  geo.setAttribute('aAngle', new THREE.Float32BufferAttribute(angles, 1));
  geo.setAttribute('aRadius', new THREE.Float32BufferAttribute(radii, 1));
  geo.computeBoundingSphere();
  return geo;
}

// 全息门环。俯视机位里"竖直"是稀缺的：柱子会被透视拉成光条（见 BARRIER_HEIGHT
// 那段），竖立的实心环更糟 —— 侧边界看过去就是一条直线。所以这一层不建几何，
// 而是在顶点着色器里按视图矩阵的右/上向量把四个角展开成**永远正对相机**的方片。
// 任何机位都读成正圆，且加色混合的软边不会变成硬光柱。
//
// 曾经还在每个节点下面铺过一圈平躺的地面光环。俯视下它确实读得准，但俯视下
// 它和门环叠成"环套环"，远看是一片靶纸 —— 删掉之后轨道 + 一排门环反而更清楚。
const GATE_VERT = /* glsl */`
attribute vec3 aCenter;
attribute vec2 aCorner;
attribute float aPhase;

uniform float uTime;
uniform float uRadius;
uniform vec3 uPlayer;
uniform float uBoost;

varying vec2 vCorner;
varying float vPhase;
varying float vA;

void main() {
  // viewMatrix 的旋转部分：第 0 行是相机右向、第 1 行是相机上向（世界坐标）
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 world = aCenter + (right * aCorner.x + up * aCorner.y) * uRadius;

  vCorner = aCorner;
  vPhase = aPhase;

  float d = distance(aCenter.xz, uPlayer.xz);
  vA = smoothstep(44.0, 5.0, d) * uBoost;

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}`;

const GATE_FRAG = /* glsl */`
uniform float uTime;
uniform vec3 uColor;
uniform vec3 uColor2;
varying vec2 vCorner;
varying float vPhase;
varying float vA;

void main() {
  float r = length(vCorner);
  // 环体：半径 0.86 处一条带，内外柔和收边
  float ring = 1.0 - smoothstep(0.055, 0.15, abs(r - 0.86));
  // 内圈：门环里再套一道细环，环才有"光圈"的层次，不然只是一个空心圈
  float inner = 1.0 - smoothstep(0.025, 0.06, abs(r - 0.58));
  // 环内的一层薄雾，让门"有内容"而不是一个空心圈
  float haze = (1.0 - smoothstep(0.0, 0.86, r)) * 0.06;

  // 与地面轨道同向的单条拖尾扫描。双瓣（cos 的两瓣相位差 π）在圆上会读成
  // 一个"S"，因为两瓣的亮度在视觉上连成了一条折线。
  float ang = atan(vCorner.y, vCorner.x);
  float trail = fract((ang + 6.28318 - uTime * 0.8 + vPhase * 6.283) / 6.28318);
  float sweep = pow(trail, 9.0);

  float breathe = 0.85 + 0.15 * sin(uTime * 1.7 + vPhase * 6.283);
  float a = (ring * (0.32 + sweep * 0.85) + inner * 0.26 + haze) * breathe * vA;

  vec3 col = mix(uColor2, uColor, ring * (0.5 + sweep * 0.5));
  gl_FragColor = vec4(col, clamp(a, 0.0, 0.85));
}`;

function makeGates(size) {
  const spots = pylonSpots(size);
  const rnd = seeded(9127);
  const pos = [];
  const center = [];
  const corner = [];
  const phase = [];
  const index = [];
  const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

  spots.forEach((s, i) => {
    // 半径 1.25、圆心抬到 1.28 m：下沿刚贴地、上沿 2.53 m。
    // 第一版给的是 0.95，结果门环在 3.6 m 宽的轨道里只是一圈装饰；放大到
    // 比轨道还宽之后，"一排门"才成为画面上真正的主体。
    const cy = terrainY(s.x, s.z) + 1.28;
    const ph = rnd();
    for (const [cx, cyv] of CORNERS) {
      pos.push(s.x, cy, s.z);
      center.push(s.x, cy, s.z);
      corner.push(cx, cyv);
      phase.push(ph);
    }
    const b = i * 4;
    index.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aCenter', new THREE.Float32BufferAttribute(center, 3));
  geo.setAttribute('aCorner', new THREE.Float32BufferAttribute(corner, 2));
  geo.setAttribute('aPhase', new THREE.Float32BufferAttribute(phase, 1));
  geo.setIndex(index);
  geo.computeBoundingSphere();
  return geo;
}

function makeCaps(size) {
  const half = size / 2;
  const y = BARRIER_HEIGHT;
  const t = 0.11;
  const parts = [
    new THREE.BoxGeometry(size, t, t).translate(0, y, -half),
    new THREE.BoxGeometry(size, t, t).translate(0, y, half),
    new THREE.BoxGeometry(t, t, size).translate(-half, y, 0),
    new THREE.BoxGeometry(t, t, size).translate(half, y, 0),
  ];
  return mergeGeometries(parts, false);
}

function makePillars(size) {
  const H = BARRIER_HEIGHT;
  const W = 0.28;
  const parts = [];
  const rnd = seeded(3737);

  const add = (x, z, yaw) => {
    const g = new THREE.PlaneGeometry(W, H);
    g.translate(0, H / 2, 0);
    const n = g.attributes.position.count;
    g.setAttribute('aPhase', new THREE.BufferAttribute(new Float32Array(n).fill(rnd()), 1));
    g.rotateY(yaw);
    g.translate(x, terrainY(x, z), z);
    parts.push(g);
  };

  // 两根交叉面（0° / 90°）。相机老是俯视斜看，单个面片在某些角度会薄成一条线，
  // 交叉之后任何方向都有宽度。
  for (const s of pylonSpots(size)) {
    add(s.x, s.z, 0);
    add(s.x, s.z, Math.PI / 2);
  }
  return mergeGeometries(parts, false);
}

/**
 * 边界全息力场。返回 { group, update }，update 每帧调一次。
 * 任何一步失败都只让这一层消失，不影响主场景。
 */
export function createBorderFX() {
  const group = new THREE.Group();
  group.name = 'border-fx';
  const size = CONFIG.arena.size;

  const wallMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPlayer: { value: new THREE.Vector3() },
      uLow: { value: COLOR_LOW.clone() },
      uHigh: { value: COLOR_HIGH.clone() },
      uBoost: { value: 1 },
    },
    vertexShader: WALL_VERT,
    fragmentShader: WALL_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const wall = new THREE.Mesh(makeWall(size), wallMat);
  wall.name = 'border-wall';
  wall.renderOrder = 3;
  wall.frustumCulled = false;
  group.add(wall);

  const bandMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPlayer: { value: new THREE.Vector3() },
      uColor: { value: new THREE.Color(0x55ecff) },
      uColor2: { value: new THREE.Color(0xb58cff) },
      uBoost: { value: 1 },
    },
    vertexShader: BAND_VERT,
    fragmentShader: BAND_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const band = new THREE.Mesh(makeBand(size), bandMat);
  band.name = 'border-band';
  band.renderOrder = 2;
  band.frustumCulled = false;
  group.add(band);

  // 外发光层。这个项目没有后处理，加色混合的细线在绿草地上不够"耀"，
  // 所以再铺一层 6 m 宽、几乎透明的同色面把光散开 —— 廉价 bloom。
  const haloMat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0x36d8ff) },
      uPlayer: { value: new THREE.Vector3() },
      uBoost: { value: 1 },
    },
    vertexShader: BAND_VERT,
    fragmentShader: HALO_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const halo = new THREE.Mesh(makeBand(size, 5.8), haloMat);
  halo.name = 'border-halo';
  halo.renderOrder = 1;
  halo.frustumCulled = false;
  group.add(halo);

  const dustMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uHeight: { value: BARRIER_HEIGHT + 1.0 },
      uPlayerX: { value: 0 },
      uPlayerZ: { value: 0 },
      uPxScale: { value: 1087 },
      uBoost: { value: 1 },
      uColor: { value: new THREE.Color(0xe8ffff) },
    },
    vertexShader: DUST_VERT,
    fragmentShader: DUST_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const dust = new THREE.Points(makeDust(size), dustMat);
  dust.name = 'border-dust';
  dust.renderOrder = 4;
  dust.frustumCulled = false;
  group.add(dust);

  const pillarMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPlayer: { value: new THREE.Vector3() },
      uBoost: { value: 1 },
      uColor: { value: new THREE.Color(0x7df6ff) },
      uColor2: { value: new THREE.Color(0xc7a6ff) },
    },
    vertexShader: PILLAR_VERT,
    fragmentShader: PILLAR_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const pillars = new THREE.Mesh(makePillars(size), pillarMat);
  pillars.name = 'border-pillars';
  pillars.renderOrder = 3;
  pillars.frustumCulled = false;
  group.add(pillars);

  // 顶杆。加它是为了让边界有"上沿"—— 只有一圈柱子的时候，俯视下读作
  // 一排孤立的钉子；连成横杆之后才有"围栏"的整体形状。
  const caps = new THREE.Mesh(
    makeCaps(size),
    new THREE.MeshBasicMaterial({
      color: 0xa8f4ff,
      transparent: true,
      opacity: 0.3,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  caps.name = 'border-caps';
  caps.renderOrder = 3;
  caps.frustumCulled = false;
  group.add(caps);

  const jetMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uHeight: { value: BARRIER_HEIGHT + 0.9 },
      uPlayerX: { value: 0 },
      uPlayerZ: { value: 0 },
      uPxScale: { value: 1087 },
      uBoost: { value: 1 },
      uColor: { value: new THREE.Color(0xcffcff) },
    },
    vertexShader: JET_VERT,
    fragmentShader: DUST_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const jets = new THREE.Points(makeJets(size), jetMat);
  jets.name = 'border-jets';
  jets.renderOrder = 4;
  jets.frustumCulled = false;
  group.add(jets);

  const gateMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uRadius: { value: 1.25 },
      uPlayer: { value: new THREE.Vector3() },
      uBoost: { value: 1 },
      uColor: { value: new THREE.Color(0xd8feff) },
      uColor2: { value: new THREE.Color(0x2fd0ff) },
    },
    vertexShader: GATE_VERT,
    fragmentShader: GATE_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const gates = new THREE.Mesh(makeGates(size), gateMat);
  gates.name = 'border-gates';
  gates.renderOrder = 5;
  gates.frustumCulled = false;
  group.add(gates);

  /**
   * @param {number} t      秒（state.time.elapsed，暂停时不动）
   * @param {{x:number,z:number}} player
   * @param {number} boost  1 常态；传送瞬间给到 1.6 做一次闪烁
   * @param {number} pxScale 视口高度 / (2·tan(fov/2))，粒子的像素尺寸靠它换算
   */
  function update(t, player, boost, pxScale) {
    wallMat.uniforms.uTime.value = t;
    wallMat.uniforms.uPlayer.value.set(player.x, 0, player.z);
    wallMat.uniforms.uBoost.value = boost;

    haloMat.uniforms.uPlayer.value.set(player.x, 0, player.z);
    haloMat.uniforms.uBoost.value = boost;

    bandMat.uniforms.uTime.value = t;
    bandMat.uniforms.uPlayer.value.set(player.x, 0, player.z);
    bandMat.uniforms.uBoost.value = boost;

    dustMat.uniforms.uTime.value = t;
    dustMat.uniforms.uPlayerX.value = player.x;
    dustMat.uniforms.uPlayerZ.value = player.z;
    dustMat.uniforms.uBoost.value = boost;
    if (pxScale) dustMat.uniforms.uPxScale.value = pxScale;

    pillarMat.uniforms.uTime.value = t;
    pillarMat.uniforms.uPlayer.value.set(player.x, 0, player.z);
    pillarMat.uniforms.uBoost.value = boost;

    jetMat.uniforms.uTime.value = t;
    jetMat.uniforms.uPlayerX.value = player.x;
    jetMat.uniforms.uPlayerZ.value = player.z;
    jetMat.uniforms.uBoost.value = boost;
    if (pxScale) jetMat.uniforms.uPxScale.value = pxScale;

    gateMat.uniforms.uTime.value = t;
    gateMat.uniforms.uPlayer.value.set(player.x, 0, player.z);
    gateMat.uniforms.uBoost.value = boost;
  }

  return { group, update, triangles: 4 * 2 + 4 * 2 * 120 + pylonSpots(size).length * 2 };
}
