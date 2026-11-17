// 区块 6c · 土路层
//
// 世界是 120 m 的环面，路必须自己闭合：中心线两个频率在地图长度上都是整数倍，
// 于是 x = ±60 处首尾相接，玩家穿门之后仍然站在路上，不会出现「路在边界断掉」。
//
// 路面不贴写实土贴图。69 px/m 的机位下贴图细节会被 mipmap 抹平，剩下的只有它
// 偏橄榄的色相 —— 那正是前几轮「脏」的来源。所以路面只由三样东西构成：
// 低频斑驳（提色）、两道车辙（形体）、路肩碎石（几何）。和草地同一套逻辑。

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { createToonGradientMap } from './pipeline.js';

// 冲刺预警不另画一块板。草地、路面、路堤共用这一组量，在自己的片元里把地面色染红，
// 颜色就长在地形上，不会悬在坡上面。
export const GROUND_STAIN = {
  uStainOn: { value: 0 },
  uStainOrigin: { value: new THREE.Vector2() },
  uStainDir: { value: new THREE.Vector2(0, 1) },
  uStainHalf: { value: 1.5 },
  uStainLen: { value: 14 },
  uStainColor: { value: new THREE.Color('#E8455C') },
  uStainAmt: { value: 0 },
};

export const STAIN_GLSL = `
uniform float uStainOn;
uniform vec2 uStainOrigin;
uniform vec2 uStainDir;
uniform float uStainHalf;
uniform float uStainLen;
uniform vec3 uStainColor;
uniform float uStainAmt;
float stainMask(vec2 p) {
  if (uStainOn < 0.5) return 0.0;
  vec2 d = p - uStainOrigin;
  float along = dot(d, uStainDir);
  float across = d.x * uStainDir.y - d.y * uStainDir.x;
  float alongK = smoothstep(0.0, 0.28, along) * (1.0 - smoothstep(uStainLen - 0.28, uStainLen, along));
  float acrossK = 1.0 - smoothstep(uStainHalf - 0.18, uStainHalf, abs(across));
  return alongK * acrossK;
}
`;

export function bindGroundStain(material) {
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader) => {
    if (prev) prev(shader);
    Object.assign(shader.uniforms, GROUND_STAIN);
    shader.vertexShader = `varying vec3 vStainWorld;\n${shader.vertexShader}`;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
vStainWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
    );
    shader.fragmentShader = `varying vec3 vStainWorld;\n${STAIN_GLSL}${shader.fragmentShader}`;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <alphamap_fragment>',
      `#include <alphamap_fragment>
diffuseColor.rgb = mix(diffuseColor.rgb, uStainColor, stainMask(vStainWorld.xz) * uStainAmt);`,
    );
  };
  // prevKey 是 three 的原型方法，必须带 this 调用：
  // 它内部读的是 this.onBeforeCompile，裸调用会让 this 变成 undefined，整个 boot 直接抛错。
  material.customProgramCacheKey = () => `ground-stain:${prevKey ? prevKey.call(material) : 'base'}`;
}

const SIZE = CONFIG.arena.size;

// 中心线：z = A1·sin(K1·x) + A2·(cos(K2·x) − 1)
// f(0) = 0，出生点正好落在路中央；K1 对应 2 个波长、K2 对应 1 个波长，
// 在 ±60 处都回到原值。z 摆幅约 −11.7…+6.5 m，路宽 4.2 m。
// 曲率半径 ~12 m，大于半宽 2.1 m，内侧边缘不会自交。
export const PATH = Object.freeze({
  a1: 6.5,
  a2: 2.6,
  k1: (4 * Math.PI) / SIZE,
  k2: (2 * Math.PI) / SIZE,
  half: 2.1,
  fade: 0.85,
  // 路要铺到竞技场（±60）之外一大截。原来铺到 ±62，玩家走到 x≈58 时
  // 那条"整齐的垂直断面"正好落在画面里 —— 一条路被一刀切断，比黑边更跳。
  // ±88 的依据：画面上沿最远看到相机前方 35 m，而相机最多到 x≈68，
  // 所以路面尽头永远在画框外，读作"路一直往前"。
  from: -88,
  to: 88,
  step: 0.5,
  y: 0.006,
});

// --- 横路（2026-11-17）---------------------------------------------------
//
// 主路只有一条，走完一圈看到的都是"沿路"的东西 —— 地图南北两侧（世界 z 的
// 两端）是三百多平方米的空草地。补一条横穿主路的土路，形成十字路口，
// 顺便让"上下"那两片有东西可看。
//
// 为什么横路不垫高：主路的路基是 pathHeight(x) 的小山丘，横路如果也垫，
// 两条路堤在交叉点会互相穿模（两套 ramp 在路口叠在一起，谁压谁看深度排序）。
// 横路的做法是**平铺在地形上**：高度直接取 terrainY，只铺一层薄土 + 一条路肩带。
// 于是交叉点读作"一条土路爬上主路的堤"，几何上永远不打架。
//
// 中心线 x = x0 + amp·sin(k·z)，k 取 120 m 上的整数波，z = ±60 处首尾相接。
// x0 选 −24 是按数据挑的：那是主路高程的最低点之一（pathHeight = 0.40），
// 路口不会坐在坡顶；同一里程上主路的陈设也最稀（冲突清单见
// docs/地形_十字路口.md）。
export const CROSS = Object.freeze({
  x0: -24,
  amp: 1.6,
  k: (2 * Math.PI) / SIZE,
  half: 2.1,
  fade: 0.85,
  from: -88,
  to: 88,
  step: 0.5,
  // 比主路的 0.006 低 2 mm：透明面不写深度，靠 renderOrder 决定谁在上。
  // 交叉点那一段两条路面重合，主路永远要压在上面。
  y: 0.004,
  shoulder: 3.5,
});

export function crossCenterX(z) {
  return CROSS.x0 + CROSS.amp * Math.sin(CROSS.k * z);
}

export function crossSlope(z) {
  return CROSS.amp * CROSS.k * Math.cos(CROSS.k * z);
}

// 到横路中心线的垂距。和 pathDistance 同一套近似，只是把 x / z 的角色换过来。
export function crossDistance(x, z) {
  const s = crossSlope(z);
  return Math.abs(x - crossCenterX(z)) / Math.sqrt(1 + s * s);
}

// 交叉点。迭代 4 次就收敛（主路坡度 0.29，横向偏移不到 0.5 m）。
export const CROSS_JUNCTION = (() => {
  let z = pathCenterZ(CROSS.x0);
  for (let i = 0; i < 4; i += 1) z = pathCenterZ(crossCenterX(z));
  return { x: crossCenterX(z), z };
})();

export function pathCenterZ(x) {
  return PATH.a1 * Math.sin(PATH.k1 * x) + PATH.a2 * (Math.cos(PATH.k2 * x) - 1);
}

export function pathSlope(x) {
  return PATH.a1 * PATH.k1 * Math.cos(PATH.k1 * x) - PATH.a2 * PATH.k2 * Math.sin(PATH.k2 * x);
}

// 到中心线的垂距。用切线近似：路是缓弯，误差远小于一个像素。
export function pathDistance(x, z) {
  const s = pathSlope(x);
  return Math.abs(z - pathCenterZ(x)) / Math.sqrt(1 + s * s);
}

// 0…1。路面正中为 1，到路缘羽化到 0。速度加成和脚下高光共用这一个权重。
// 两条路取较大值：站在路口时两条都算"在路上"，不会出现加成忽然掉一半。
//
// 2026-11-17 起两条路的速度乘数不再相同（主路 1.18、横路 1.25），所以权重也要
// 分开给。pathFactor 仍返回较大值 —— 脚下高光只要"在路上"这一个判断，
// 而 speedMul 要分开算，见 speedMulFromBlend。
export function pathFactors(x, z) {
  return {
    main: pathEdgeWeight(pathDistance(x, z)),
    cross: pathEdgeWeight(crossDistance(x, z)),
  };
}

export function pathFactor(x, z) {
  const f = pathFactors(x, z);
  return f.main > f.cross ? f.main : f.cross;
}

// 两条路各按自己的乘数算，取较大值。**不叠乘**：路口两权重都接近 1，
// 叠乘会得到 1.18×1.25 = 1.475，那不是设计值。
export function speedMulFromBlend(mainBlend, crossBlend) {
  const a = 1 + (CONFIG.movement.path.speedMul - 1) * mainBlend;
  const b = 1 + (CONFIG.movement.path.crossSpeedMul - 1) * crossBlend;
  return a > b ? a : b;
}

// --- 路面高程 -----------------------------------------------------------
//
// 路不是一条平带子。这一层把路垫在小山丘的顶上，让路面沿着丘顶上下起伏 ——
// 这是 58° 俯视下唯一还能读出"地面有高低"的办法：远处的山看不见（视锥只到
// 前方 12.4 m），但脚下的坡会从画面上沿一路滚下来。
//
// 高度只和 x 有关（路本身是 z = f(x) 的一条曲线），所以它是一个一元函数。
// 周期必须是地图长度 120 m 的整数分之一，否则 x = ±60 处接不上。
//
// **波的个数不能少。** 这张定稿图可见的地面只有前方 12–18 m，取 3 个波（40 m 一个丘）
// 时，一屏里最多看到三分之一个波 —— 局部坡度几乎是常数，看上去就是一块平地，
// 第一版就是这么白做的。取 5 个波（24 m 一个丘）之后，一屏里能同时看到丘顶和丘谷，
// 起伏才成立。代价是每 4 秒过一个丘，不算快。
//
// base 不为 0 是有意的：路基永远高出草地 0.35 m，路堤不会退化成和地面共面
// （共面就会 z-fighting，而且"路浮在草地上"这件事需要一圈可见的侧坡才成立）。
// 剖面用 (1−u)² 而不是 smoothstep：smoothstep 两端斜率都是 0，
// 整个坡面最高只有 8°，54° 的太阳打上去几乎不变档，俯视下就是一块平地。
// (1−u)² 在路缘处的斜率是 2h/skirt，1.8 m 的丘顶接近 43° ——
// 卡通光照会在这道坡上分出一条明显的暗带，"路翻过一座小丘"才读得出来。
export const TERRAIN = Object.freeze({
  base: 0.40,
  amp: 2.20,
  waves: 5,
  skirt: 5.20,
  bank: 1.7,
});

// 唯一的剖面函数。JS 和 GLSL 两处都必须用它，改一处就要改另一处。
// u 是"离路缘多远 / skirt"，1.7 次方介于圆锥和圆顶之间：
// 路缘处陡（约 40°），坡脚处缓，读起来是一道土坡而不是一圈锥面。
function bankProfile(u) {
  return Math.pow(1 - u, TERRAIN.bank);
}

const K_H = (2 * Math.PI * TERRAIN.waves) / SIZE;

export function pathHeight(x) {
  // x = 0 处正好落谷底：出生点站在平处，第一个丘在 20 m 外露头。
  return TERRAIN.base + TERRAIN.amp * 0.5 * (1 - Math.cos(K_H * x));
}

// 任意一点的地面高度。路肩上满高，往外 skirt 米用 smoothstep 落回 0，
// 两端斜率都是 0 —— 丘面因此是圆钝的，不是一道折线。
// 所有摆在地面上的东西（草、道具、陈设、主角、相机）都必须过这个函数，
// 否则会浮在半空或者陷进坡里。
export function terrainY(x, z) {
  const u = (pathDistance(x, z) - PATH.half) / TERRAIN.skirt;
  if (u <= 0) return pathHeight(x);
  if (u >= 1) return 0;
  return pathHeight(x) * bankProfile(u);
}

// 敌人用的速度乘数。ai.js 的移动循环落地时，把 cfg.speed 乘上它就行：
//   const mul = pathSpeedMul(e.x, e.z);
// 敌人不存 pathBlend，路面本身的连续值已经够平滑，不需要再缓一步。
export function pathSpeedMul(x, z) {
  const f = pathFactors(x, z);
  return speedMulFromBlend(f.main, f.cross);
}

function pathEdgeWeight(d) {
  const inner = PATH.half - PATH.fade;
  if (d <= inner) return 1;
  if (d >= PATH.half) return 0;
  const t = (d - inner) / PATH.fade;
  return 1 - t * t * (3 - 2 * t);
}

// 顶点着色器要用的同一套函数。草在路面上的密度由它裁掉，
// 数值必须和上面三个 JS 函数逐字一致，否则草会长在路中间。
export const PATH_GLSL = `
uniform float uPathA1;
uniform float uPathA2;
uniform float uPathK1;
uniform float uPathK2;
uniform float uPathHalf;
uniform float uCrossX0;
uniform float uCrossAmp;
uniform float uCrossK;
uniform float uCrossHalf;
uniform float uTerrBase;
uniform float uTerrAmp;
uniform float uTerrK;
uniform float uTerrSkirt;

float pathCenterZ(float x) {
  return uPathA1 * sin(uPathK1 * x) + uPathA2 * (cos(uPathK2 * x) - 1.0);
}

float pathSlope(float x) {
  return uPathA1 * uPathK1 * cos(uPathK1 * x) - uPathA2 * uPathK2 * sin(uPathK2 * x);
}

float pathDist(vec2 p) {
  float s = pathSlope(p.x);
  return abs(p.y - pathCenterZ(p.x)) * inversesqrt(1.0 + s * s);
}

// 横路：x = x0 + amp·sin(k·z)。里程是 p.y，横向是 p.x，和主路正好换了个轴。
float crossCenterX(float z) {
  return uCrossX0 + uCrossAmp * sin(uCrossK * z);
}

float crossSlopeZ(float z) {
  return uCrossAmp * uCrossK * cos(uCrossK * z);
}

float crossDist(vec2 p) {
  float s = crossSlopeZ(p.y);
  return abs(p.x - crossCenterX(p.y)) * inversesqrt(1.0 + s * s);
}

float pathHeight(float x) {
  return uTerrBase + uTerrAmp * 0.5 * (1.0 - cos(uTerrK * x));
}

// 必须和 JS 的 terrainY() 逐字一致，否则草会浮在坡上或者陷进去。
float terrainY(vec2 p) {
  float u = (pathDist(p) - uPathHalf) / uTerrSkirt;
  if (u <= 0.0) return pathHeight(p.x);
  if (u >= 1.0) return 0.0;
  return pathHeight(p.x) * pow( 1.0 - u, 1.7 );
}
`;

// 多个材质共享同一份 uniform 对象，路宽之类的参数只改一处。
export function createPathUniforms() {
  return {
    uPathA1: { value: PATH.a1 },
    uPathA2: { value: PATH.a2 },
    uPathK1: { value: PATH.k1 },
    uPathK2: { value: PATH.k2 },
    uPathHalf: { value: PATH.half },
    uCrossX0: { value: CROSS.x0 },
    uCrossAmp: { value: CROSS.amp },
    uCrossK: { value: CROSS.k },
    uCrossHalf: { value: CROSS.half },
    uTerrBase: { value: TERRAIN.base },
    uTerrAmp: { value: TERRAIN.amp },
    uTerrK: { value: K_H },
    uTerrSkirt: { value: TERRAIN.skirt },
  };
}

// Color 构造时按 sRGB 解释再转到线性工作空间，正好是着色器要的量。
function linearRGB(hex, scale = 1) {
  const c = new THREE.Color(hex);
  return new THREE.Vector3(c.r * scale, c.g * scale, c.b * scale);
}

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

function buildRibbon() {
  const { from, to, step, half, y } = PATH;
  const segments = Math.round((to - from) / step);
  const vertCount = (segments + 1) * 2;
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const pathUv = new Float32Array(vertCount * 2);
  const indices = new Uint32Array(segments * 6);

  let arc = 0;
  for (let i = 0; i <= segments; i += 1) {
    const x = from + i * step;
    const s = pathSlope(x);
    const len = Math.sqrt(1 + s * s);
    const nx = -s / len;
    const nz = 1 / len;
    const cz = pathCenterZ(x);
    if (i > 0) arc += len * step;

    const base = i * 6;
    // 路面跟着路基起伏。法线按 h'(x) 倾斜，否则整条路会被照成一块平的亮带，
    // 上坡那段和下坡段的明暗一模一样，"起伏"就白做了。
    const ry = pathHeight(x) + y;
    const dh = TERRAIN.amp * 0.5 * K_H * Math.sin(K_H * x);
    const nl = Math.hypot(dh, 1);
    positions[base] = x + nx * half;
    positions[base + 1] = ry;
    positions[base + 2] = cz + nz * half;
    positions[base + 3] = x - nx * half;
    positions[base + 4] = ry;
    positions[base + 5] = cz - nz * half;
    normals[base] = -dh / nl;
    normals[base + 1] = 1 / nl;
    normals[base + 4] = -dh / nl;
    normals[base + 5] = 1 / nl;

    const uv = i * 4;
    pathUv[uv] = arc;
    pathUv[uv + 1] = 1;
    pathUv[uv + 2] = arc;
    pathUv[uv + 3] = -1;
  }

  for (let i = 0; i < segments; i += 1) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    const k = i * 6;
    // 绕序按 +y 朝上的正面排，FrontSide 就够，不需要双面。
    indices[k] = a;
    indices[k + 1] = c;
    indices[k + 2] = b;
    indices[k + 3] = b;
    indices[k + 4] = c;
    indices[k + 5] = d;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('pathUv', new THREE.BufferAttribute(pathUv, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

function buildRibbonMaterial(uniforms) {
  const material = new THREE.MeshToonMaterial({
    color: 0xffffff,
    gradientMap: createToonGradientMap(),
    transparent: true,
    depthWrite: false,
  });

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, GROUND_STAIN);
    shader.uniforms.uPlayerXZ = uniforms.uPlayerXZ;
    shader.uniforms.uActive = uniforms.uActive;
    shader.uniforms.uDirtDeep = uniforms.uDirtDeep;
    shader.uniforms.uDirtDark = uniforms.uDirtDark;
    shader.uniforms.uDirtMid = uniforms.uDirtMid;
    shader.uniforms.uDirtLight = uniforms.uDirtLight;
    shader.uniforms.uSheen = uniforms.uSheen;

    // 自定义属性名而不是 uv：材质没开 USE_UV，声明 attribute vec2 uv 会撞车。
    shader.vertexShader = `
attribute vec2 pathUv;
varying vec3 vPathPos;
varying vec2 vPathUv;
` + shader.vertexShader;

    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
vPathPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vPathUv = pathUv;`,
    );

    shader.fragmentShader = STAIN_GLSL + `
varying vec3 vPathPos;
varying vec2 vPathUv;
uniform vec2 uPlayerXZ;
uniform float uActive;
uniform vec3 uDirtDeep;
uniform vec3 uDirtDark;
uniform vec3 uDirtMid;
uniform vec3 uDirtLight;
uniform vec3 uSheen;
const float PATH_HALF = ${PATH.half.toFixed(2)};
// 高程参数按常量写死：这个着色器已经用了同一套写法（PATH_HALF），
// 多两个 uniform 反而要额外维护绑定。
const float TERR_AMP = ${TERRAIN.amp.toFixed(2)};
const float TERR_K = ${K_H.toFixed(6)};
` + shader.fragmentShader;

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `
float pv = vPathUv.y;              // 横向 -1…1
float pu = vPathUv.x;              // 沿路弧长，单位米
float av = abs(pv);

// 细节尺寸必须 ≥ 4 px，否则就是噪点而不是质感。39–69 px/m 下，
// 4 px 约等于 6 cm。比这更细的东西只会闪，不会「清楚」。
// 12 m 走向漂移（只做色温起伏，不加阈值——两个正弦一硬切就咬成棋盘格）。
float nBig = sin(pu * 0.31 + sin(pv * 1.7) * 0.9) * 0.5 + 0.5;
float nMid = sin(pu * 1.60 + pv * 2.30 + 0.7) * 0.5 + 0.5;
float drift = nMid * 0.65 + nBig * 0.35;

vec3 dirt = mix(uDirtMid, uDirtLight, drift * 0.48);
dirt = mix(dirt, uDirtDark, (1.0 - nBig) * 0.16);

// 横向坐标换成米。v 的 -1…1 对应 4.2 m，直接用 v 做格子会得到 2:1 的
// 长条——第一版散土块全成了横着躺的“虫”，就是这个原因。
vec2 metric = vec2(pu, pv * PATH_HALF);

// 两道车辙。位置定死，边缘收窄，才像车轮压出来的沟，而不是一团阴影。
float rut = 1.0 - smoothstep(0.10, 0.17, abs(av - 0.50));
dirt = mix(dirt, uDirtDeep, rut * 0.62 * (0.78 + 0.22 * nBig));

// 车辙外侧被挤出来的土埂。亮一线，路面才有起伏，不然是块平板。
float ridge = 1.0 - smoothstep(0.0, 0.055, abs(av - 0.73));
dirt = mix(dirt, uDirtLight, ridge * 0.20 * (0.35 + 0.65 * nBig));

// 路缘压暗，和草地之间才有一条明确的分界；最后 10% 交给 alpha 淡出。
dirt = mix(dirt, uDirtDark, smoothstep(0.82, 0.94, av) * 0.55);

// 散土块：30 cm 一格。尺寸与密度都随机，密度还跟着中频噪声走——
// 均匀撒一遍是「胡椒面」，会显得整块地是图案；一簇一簇才像翻起来的土。
vec2 cell30 = metric * 3.3;
vec2 cellId = floor(cell30);
float ch = fract(sin(dot(cellId, vec2(91.4, 47.2))) * 2137.1);
vec2 cellF = fract(cell30) - vec2(fract(ch * 13.7), fract(ch * 7.3));
float rad = 0.15 + 0.20 * fract(ch * 5.3);                 // 4.5–10 cm
float crowded = smoothstep(0.30, 0.72, nMid);
// 顺路方向拉长一点，圆点像巧克力豆，扁一点才像被车轮蹭起来的土
float clod = (1.0 - smoothstep(rad, rad + 0.12, length(cellF * vec2(1.0, 1.55))))
           * step(0.78 - crowded * 0.26, ch);
dirt = mix(dirt, uDirtDeep, clod * (0.16 + 0.22 * ch));

// 颗粒：14 cm 与 7 cm 两档，分别是 6–10 px 和 3–5 px。
vec2 g1 = floor(metric * 7.0);
vec2 g2 = floor(metric * 15.0);
float k1 = fract(sin(dot(g1, vec2(41.7, 289.3))) * 43758.5);
float k2 = fract(sin(dot(g2, vec2(17.3, 113.9))) * 43758.5);
dirt *= 0.89 + k1 * 0.13 + k2 * 0.08;

// 环境光是冷色的（0xd2dae4），落在这块暖土上会把色相拉灰。
// 补 12% 饱和，土才不会被衬成水泥。
float lum = dot(dirt, vec3(0.2126, 0.7152, 0.0722));
dirt = max(vec3(0.0), lum + (dirt - lum) * 1.12);

// 坡向明暗。卡通光照是分档的，15° 以内的坡基本不换档 —— 路面明明是斜的，
// 看上去却是一块平板，这就是"起伏做完了却看不见"的直接原因。
// 这里按路基坡度补一道连续的明暗（朝光的一面略亮、背光的一面略暗），
// 幅度只 ±7%，不动色相，只负责把"路在爬坡"这件事标出来。
float dhdx = TERR_AMP * 0.5 * TERR_K * sin( TERR_K * vPathPos.x );
dirt *= 1.0 + clamp( dhdx, -0.32, 0.32 ) * 0.22;

// 玩家站在路上时，脚下这一截路面轻轻亮起来。这是加速的唯一提示，
// 不做 UI 飘字，也不改镜头。
float near = 1.0 - smoothstep(0.0, 3.2, length(vPathPos.xz - uPlayerXZ));
dirt += uSheen * near * uActive;

diffuseColor.rgb *= dirt;
diffuseColor.rgb = mix(diffuseColor.rgb, uStainColor, stainMask(vPathPos.xz) * uStainAmt);
diffuseColor.a *= 1.0 - smoothstep(0.90, 1.0, av);
`,
    );
  };

  material.customProgramCacheKey = () => 'dirt-path-stain';
  return material;
}

// 路肩碎石。土路上唯一有体积的东西，也是路缘和草地之间唯一可信的过渡。
// 亮度必须压在土色附近：InstanceColor 是线性值，0.6 已经是接近白的灰。
function buildPebbles() {
  // 按里程给密度（每米 3.1 颗），不要把数量写死 ——
  // 路一延长，固定数量就会把碎石摊薄。
  const count = Math.round((PATH.to - PATH.from) * 3.1);
  const geometry = new THREE.IcosahedronGeometry(1, 0);
  const material = new THREE.MeshToonMaterial({
    color: 0xffffff,
    gradientMap: createToonGradientMap(),
  });
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.castShadow = false;
  mesh.receiveShadow = false;

  const rng = makeRandom(9137);
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  const half = PATH.half;

  for (let i = 0; i < count; i += 1) {
    const x = PATH.from + rng() * (PATH.to - PATH.from);
    const s = pathSlope(x);
    const len = Math.sqrt(1 + s * s);
    const nx = -s / len;
    const nz = 1 / len;

    // 三成嵌在路面（小、暗、被踩过），七成堆在路肩（大、带棱角）。
    // 路肩横向只放到 1.14 倍半宽，再往外就是草地，撒进去像垃圾。
    const onLane = rng() < 0.3;
    const lateral = onLane
      ? (rng() * 2 - 1) * half * 0.8
      : (rng() < 0.5 ? -1 : 1) * half * (0.86 + rng() * 0.28);
    const px = x + nx * lateral;
    const pz = pathCenterZ(x) + nz * lateral;

    const size = onLane ? 0.022 + rng() * 0.040 : 0.040 + rng() * 0.115;
    dummy.position.set(px, terrainY(px, pz) + PATH.y + size * 0.30, pz);
    dummy.rotation.set((rng() - 0.5) * 0.9, rng() * Math.PI * 2, (rng() - 0.5) * 0.9);
    dummy.scale.set(size, size * (0.5 + rng() * 0.35), size * (0.75 + rng() * 0.4));
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);

    const tone = onLane ? 0.13 + rng() * 0.08 : 0.15 + rng() * 0.13;
    tint.setRGB(tone, tone * 0.92, tone * 0.80);
    mesh.setColorAt(i, tint);
  }

  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

// --- 横路的几何 ---------------------------------------------------------
//
// 三块：路面（薄土带）、路肩带（草皮压秃的一圈）、碎石。
// 路面和主路共用同一个着色器（buildRibbonMaterial），只是换了一套 uniform ——
// 土的斑驳、车辙、路缘压暗全部复用，横路不会变成另一种材质。
//
// 高度一律取 terrainY：横路不垫高（理由见 CROSS 的注释），
// 在交叉点它会自己爬上主路的路堤，几何上永远和主路一致。

// 地形梯度法线。横路面宽只有 4.2 m，路口那一段整体在坡上，
// 法线不跟着坡度走的话，路口会是一块平的亮片。
function groundNormal(x, z, target) {
  const e = 0.4;
  const dx = (terrainY(x - e, z) - terrainY(x + e, z)) / (2 * e);
  const dz = (terrainY(x, z - e) - terrainY(x, z + e)) / (2 * e);
  const len = Math.hypot(dx, 1, dz) || 1;
  target.set(dx / len, 1 / len, dz / len);
}

function buildCrossRibbon() {
  const { from, to, step, half, y } = CROSS;
  const segments = Math.round((to - from) / step);
  const vertCount = (segments + 1) * 2;
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const pathUv = new Float32Array(vertCount * 2);
  const indices = new Uint32Array(segments * 6);
  const n = new THREE.Vector3();

  let arc = 0;
  for (let i = 0; i <= segments; i += 1) {
    const z = from + i * step;
    const s = crossSlope(z);
    const len = Math.sqrt(1 + s * s);
    // 切线 (s, 1)/len，法线 (1, −s)/len。
    const nx = 1 / len;
    const nz = -s / len;
    const cx = crossCenterX(z);
    if (i > 0) arc += len * step;

    const ax = cx + nx * half;
    const az = z + nz * half;
    const bx = cx - nx * half;
    const bz = z - nz * half;

    const base = i * 6;
    groundNormal(ax, az, n);
    positions[base] = ax;
    positions[base + 1] = terrainY(ax, az) + y;
    positions[base + 2] = az;
    normals[base] = n.x;
    normals[base + 1] = n.y;
    normals[base + 2] = n.z;
    groundNormal(bx, bz, n);
    positions[base + 3] = bx;
    positions[base + 4] = terrainY(bx, bz) + y;
    positions[base + 5] = bz;
    normals[base + 3] = n.x;
    normals[base + 4] = n.y;
    normals[base + 5] = n.z;

    const uv = i * 4;
    pathUv[uv] = arc;
    pathUv[uv + 1] = 1;
    pathUv[uv + 2] = arc;
    pathUv[uv + 3] = -1;
  }

  for (let i = 0; i < segments; i += 1) {
    const a = i * 2;
    const b = a + 1;
    const k = i * 6;
    // 绕序按 +y 朝上排：a 在 +x 侧、b 在 −x 侧、下一个站在 +z 侧。
    indices[k] = a;
    indices[k + 1] = b;
    indices[k + 2] = a + 2;
    indices[k + 3] = b;
    indices[k + 4] = b + 2;
    indices[k + 5] = a + 2;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('pathUv', new THREE.BufferAttribute(pathUv, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

// 路肩带：从路面半宽 2.0 铺到 3.5，两侧各一条。材质与主路的路堤同一个，
// 否则横路两侧会露出一圈"没有草的草地贴图"，比土路本身还显眼。
function buildCrossShoulder() {
  const { from, to, half, shoulder } = CROSS;
  const stations = Math.round((to - from) / 1.0);
  const K = 2;
  const cols = K + 1;
  const positions = [];
  const uvs = [];
  const colors = [];
  const indices = [];
  const inner = half - 0.10;

  const at = (i, sideIdx, j) => (((i * 2) + sideIdx) * cols + j);
  const push = (px, pz, wy) => {
    positions.push(px, terrainY(px, pz) + wy, pz);
    uvs.push(px / 30, pz / 30);
    colors.push(1, 1, 1);
  };

  for (let i = 0; i <= stations; i += 1) {
    const z = from + i;
    const s = crossSlope(z);
    const len = Math.sqrt(1 + s * s);
    const nx = 1 / len;
    const nz = -s / len;
    const cx = crossCenterX(z);
    for (let sideIdx = 0; sideIdx < 2; sideIdx += 1) {
      const side = sideIdx === 0 ? 1 : -1;
      for (let j = 0; j <= K; j += 1) {
        const d = (inner + (j / K) * (shoulder - inner)) * side;
        push(cx + nx * d, z + nz * d, 0.002);
      }
    }
  }

  for (let i = 0; i < stations; i += 1) {
    for (let sideIdx = 0; sideIdx < 2; sideIdx += 1) {
      for (let j = 0; j < K; j += 1) {
        const a = at(i, sideIdx, j);
        const b = at(i, sideIdx, j + 1);
        const c = at(i + 1, sideIdx, j);
        const d = at(i + 1, sideIdx, j + 1);
        // 两侧的列方向相反，绕序跟着反，否则有一侧朝下、被背面剔除。
        if (sideIdx === 0) indices.push(a, b, c, b, d, c);
        else indices.push(a, c, b, b, c, d);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function buildCrossPebbles() {
  const count = Math.round((CROSS.to - CROSS.from) * 2.4);
  const mesh = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1, 0),
    new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: createToonGradientMap() }),
    count,
  );
  mesh.castShadow = false;
  mesh.receiveShadow = false;

  const rng = makeRandom(31771);
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  const half = CROSS.half;

  for (let i = 0; i < count; i += 1) {
    const z = CROSS.from + rng() * (CROSS.to - CROSS.from);
    const s = crossSlope(z);
    const len = Math.sqrt(1 + s * s);
    const nx = 1 / len;
    const nz = -s / len;
    const onLane = rng() < 0.3;
    const lateral = onLane
      ? (rng() * 2 - 1) * half * 0.8
      : (rng() < 0.5 ? -1 : 1) * half * (0.86 + rng() * 0.28);
    const px = crossCenterX(z) + nx * lateral;
    const pz = z + nz * lateral;

    const size = onLane ? 0.022 + rng() * 0.036 : 0.038 + rng() * 0.105;
    dummy.position.set(px, terrainY(px, pz) + CROSS.y + size * 0.30, pz);
    dummy.rotation.set((rng() - 0.5) * 0.9, rng() * Math.PI * 2, (rng() - 0.5) * 0.9);
    dummy.scale.set(size, size * (0.5 + rng() * 0.35), size * (0.75 + rng() * 0.4));
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);

    const tone = onLane ? 0.13 + rng() * 0.08 : 0.15 + rng() * 0.12;
    tint.setRGB(tone, tone * 0.92, tone * 0.80);
    mesh.setColorAt(i, tint);
  }

  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

// 路堤：垫在路下面的那个"小山丘"。
//
// 路面抬起来之后，如果下面什么都不放，路就成了一条悬空的暗带 ——
// 俯视下看得见它投在草地上的缺口。所以必须把侧坡做出来：
// 从路缘满高，用和 terrainY() 完全相同的 smoothstep 曲线落回地面。
// 曲线本身是圆钝的（两端斜率为 0），所以读起来是"路翻过一道缓丘"，
// 而不是"路架在一道土堤上"。
//
// 只有几何，没有贴图细节：细节交给草 —— 草场的顶点着色器按 terrainY 抬高，
// 草会自己长到这道坡上（见 js/grass.js）。这里只负责一个正确的底。
function buildRamp() {
  const { from, to, half } = PATH;
  const stepX = 1.0;
  const stations = Math.round((to - from) / stepX);
  const K = 7;
  const cols = K + 1;
  const vertCount = (stations + 1) * 2 * cols;
  const positions = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const colors = new Float32Array(vertCount * 3);

  const at = (i, sideIdx, j) => (((i * 2) + sideIdx) * cols + j);

  for (let i = 0; i <= stations; i += 1) {
    const x = from + i * stepX;
    const s = pathSlope(x);
    const len = Math.sqrt(1 + s * s);
    const nx = -s / len;
    const nz = 1 / len;
    const cz = pathCenterZ(x);
    const h = pathHeight(x);

    for (let sideIdx = 0; sideIdx < 2; sideIdx += 1) {
      const side = sideIdx === 0 ? 1 : -1;
      for (let j = 0; j <= K; j += 1) {
        const u = j / K;
        const d = (half + u * TERRAIN.skirt) * side;
        const px = x + nx * d;
        const pz = cz + nz * d;
        const py = h * bankProfile(u);

        const v = at(i, sideIdx, j);
        positions[v * 3] = px;
        positions[v * 3 + 1] = py;
        positions[v * 3 + 2] = pz;
        // 平面 UV，和地面贴图同一套比例（120 m / repeat 4 = 30 m 一格）。
        uvs[v * 2] = px / 30;
        uvs[v * 2 + 1] = pz / 30;
        // 顶点色只压 4%：明暗交给卡通光照分档。压多了会在坡脚留一圈暗箍，
        // 读成"路外面套了个圈"，而不是坡。
        // 沿路方向的坡向明暗：和路面着色器里那一道对齐，
        // 否则路在变亮、坡没跟着变，接缝处会露馅。
        const dh = TERRAIN.amp * 0.5 * K_H * Math.sin(K_H * x);
        const shade = (1 - 0.04 * u) * (1 + Math.max(-0.32, Math.min(0.32, dh)) * 0.18);
        colors[v * 3] = shade;
        colors[v * 3 + 1] = shade;
        colors[v * 3 + 2] = shade;
      }
    }
  }

  const indices = [];
  for (let i = 0; i < stations; i += 1) {
    for (let sideIdx = 0; sideIdx < 2; sideIdx += 1) {
      for (let j = 0; j < K; j += 1) {
        const a = at(i, sideIdx, j);
        const b = at(i, sideIdx, j + 1);
        const c = at(i + 1, sideIdx, j);
        const d = at(i + 1, sideIdx, j + 1);
        // 两侧的列方向相反（+z 侧向外是 z 增大，−z 侧向外是 z 减小），
        // 绕序必须跟着反，否则有一侧会朝下、被背面剔除。
        if (sideIdx === 0) indices.push(a, b, c, b, d, c);
        else indices.push(a, c, b, b, c, d);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function rampMaterial() {
  const texture = new THREE.TextureLoader().load('models/active/env/textures/env_base_grass.jpg');
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const material = new THREE.MeshToonMaterial({
    map: texture,
    // 路基不是草坪：踩实的路肩上草长不住，露出来的是土。
    // 用同一个草地贴图乘一层暖灰，比换一套贴图省事，也不会和草地断成两块。
    color: 0xdccdb2,
    vertexColors: true,
    gradientMap: createToonGradientMap(),
  });
  bindGroundStain(material);
  return material;
}

export function createDirtPath() {
  const uniforms = {
    uPlayerXZ: { value: new THREE.Vector2(0, 0) },
    uActive: { value: 0 },
    uDirtLight: { value: linearRGB(0x9c8661) },
    uDirtMid: { value: linearRGB(0x866b48) },
    uDirtDark: { value: linearRGB(0x63492d) },
    uDirtDeep: { value: linearRGB(0x43301a) },
    uSheen: { value: linearRGB(0xf0d6a4, 0.050) },
  };
  // 横路单独一套：同一段土色，但"脚下高光"要分开算 ——
  // 站在主路上不该把远处的横路一起点亮。
  const crossUniforms = {
    uPlayerXZ: { value: new THREE.Vector2(0, 0) },
    uActive: { value: 0 },
    uDirtLight: uniforms.uDirtLight,
    uDirtMid: uniforms.uDirtMid,
    uDirtDark: uniforms.uDirtDark,
    uDirtDeep: uniforms.uDirtDeep,
    uSheen: uniforms.uSheen,
  };

  const group = new THREE.Group();
  const pebbles = buildPebbles();
  // 路肩材质只有一份：主路的路堤和横路的路肩带共用，色温和贴图不会分家。
  const shoulderMat = rampMaterial();
  const ramp = new THREE.Mesh(buildRamp(), shoulderMat);
  ramp.name = 'path-ramp';
  const ribbon = new THREE.Mesh(buildRibbon(), buildRibbonMaterial(uniforms));
  ribbon.name = 'path-ribbon';

  const crossShoulder = new THREE.Mesh(buildCrossShoulder(), shoulderMat);
  crossShoulder.name = 'cross-shoulder';
  const crossRibbon = new THREE.Mesh(buildCrossRibbon(), buildRibbonMaterial(crossUniforms));
  crossRibbon.name = 'cross-ribbon';
  // 交叉点两条路面在 2 mm 内重合，而透明面不写深度 —— 只能靠绘制顺序定胜负。
  // -1 让横路先画，主路后画压在上面：十字路口的路面读作"主路是通的"。
  crossRibbon.renderOrder = -1;
  const crossPebbles = buildCrossPebbles();

  // 路堤在路面之下，路面略高于地面，压在地面贴图之上、草丛之下。
  group.add(ramp, crossShoulder, ribbon, crossRibbon, pebbles, crossPebbles);

  const segments = Math.round((PATH.to - PATH.from) / PATH.step);
  const rampStations = Math.round((PATH.to - PATH.from) / 1.0);
  const crossStations = Math.round((CROSS.to - CROSS.from) / CROSS.step);
  return {
    group,
    triangles: segments * 2 + 380 * 20 + rampStations * 2 * 7 * 2
      + crossStations * 2 + CROSS.to - CROSS.from,
    update(x, z, active) {
      uniforms.uPlayerXZ.value.set(x, z);
      crossUniforms.uPlayerXZ.value.set(x, z);
      // active 只表示"玩家这一帧在移动"，是不是站在路上由这里再判一次。
      uniforms.uActive.value = active && pathDistance(x, z) < PATH.half ? 1 : 0;
      crossUniforms.uActive.value = active && crossDistance(x, z) < CROSS.half ? 1 : 0;
    },
  };
}
