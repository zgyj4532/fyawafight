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
export function pathFactor(x, z) {
  return pathEdgeWeight(pathDistance(x, z));
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
  return 1 + (CONFIG.movement.path.speedMul - 1) * pathFactor(x, z);
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

    shader.fragmentShader = `
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
diffuseColor.a *= 1.0 - smoothstep(0.90, 1.0, av);
`,
    );
  };

  material.customProgramCacheKey = () => 'dirt-path';
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
  const texture = new THREE.TextureLoader().load('models/env/textures/env_base_grass.jpg');
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return new THREE.MeshToonMaterial({
    map: texture,
    // 路基不是草坪：踩实的路肩上草长不住，露出来的是土。
    // 用同一个草地贴图乘一层暖灰，比换一套贴图省事，也不会和草地断成两块。
    color: 0xdccdb2,
    vertexColors: true,
    gradientMap: createToonGradientMap(),
  });
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

  const group = new THREE.Group();
  const pebbles = buildPebbles();
  const ramp = new THREE.Mesh(buildRamp(), rampMaterial());
  ramp.name = 'path-ramp';
  const ribbon = new THREE.Mesh(buildRibbon(), buildRibbonMaterial(uniforms));
  // 路堤在路面之下，路面略高于地面，压在地面贴图之上、草丛之下。
  group.add(ramp, ribbon, pebbles);

  const segments = Math.round((PATH.to - PATH.from) / PATH.step);
  const rampStations = Math.round((PATH.to - PATH.from) / 1.0);
  return {
    group,
    triangles: segments * 2 + 380 * 20 + rampStations * 2 * 7 * 2,
    update(x, z, active) {
      uniforms.uPlayerXZ.value.set(x, z);
      uniforms.uActive.value = active;
    },
  };
}
