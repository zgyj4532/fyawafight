// 区块 · 地面分区（2026-11-17 夜）
//
// 四角原本只有"道具 + 成团灌木"，站在里面仍然是一块通铺的草地 —— 因为你脚下
// 和地图中心是同一张 env_base_grass.jpg。这是"不够奇幻"的最大来源：**物件变了，
// 地面没变**，眼睛读到的还是同一块地，道具就只是摆上去的。
//
// 所以这一层做的事只有一件：**给四个角各染一片自己的地。**
//
// 为什么用着色器染色，不铺贴图、不铺第二个平面：
// - 铺贴图：69 px/m 的机位下 mipmap 会把细节抹平，只剩一个偏色（这是土路那一轮
//   已经踩过的坑，见 js/path.js 顶部注释），而且要多一张 2048 贴图、一次采样。
// - 铺第二个平面：会和主地面 z-fighting，还得沿边缘做 alpha 过渡，边界会露边。
// - 染色：零 draw call、零采样，直接改已经算出来的 diffuseColor。地面和草叶是
//   同一套 GLSL（都在 vStainWorld 上取世界坐标），所以**草也跟着变色**，
//   这是关键 —— 草没跟着变，色块会像一张铺在地上的桌布。
//
// 边界的做法：半径不取常数，叠三条不同频率的正弦当"轮廓抖动"，再加一层
// 斑驳乘子让色量在内部起伏。圆规画的圆会被一眼看成 UI，抖动 + 斑驳才像植被/土质
// 自然过渡。抖动的相位取自分区中心，四个角不会长成一个模子。

import * as THREE from 'three';

// 四个角的中心取自 js/props.js 的 WILDS 与 js/scenery.js 的 WILD_CLUSTERS，
// 是那批陈设的实际重心，不是地图几何中心 —— 色块要盖住东西，不能盖在空地上。
//
// amt 是最终混色比例的上限。土壤类的（营地 / 农舍）给低一点：那里的草是被踩秃的，
// 不是换了一种土；沼泽和战场给高一点，那两处要读成"这块地坏了"。
export const GROUND_ZONES = [
  { name: '西北 · 古战场', cx: -44, cz: -44, r: 16.5, amt: 0.68, color: '#6A5743' },
  { name: '东北 · 伐木营地', cx: 44, cz: -43, r: 15.0, amt: 0.70, color: '#7B5E2E' },
  { name: '西南 · 沼泽枯林', cx: -43, cz: 44, r: 16.5, amt: 0.78, color: '#38503C' },
  { name: '东南 · 废弃农舍', cx: 43, cz: 43, r: 15.0, amt: 0.80, color: '#6E5220' },
];

// GLSL 里数组长度必须是常量（ES 1.0 不允许非常量上界），所以按 4 个槽写死。
// 想加第五个分区时，改这里、改 FILL 里的长度，别用 count + break 的写法：
// 那个写法在不同驱动上行为不一致，本项目已经为它吃过一次亏（见 js/grass.js 的 uLakes）。
const ZONE_SLOTS = 4;

export const ZONE_GLSL = `
uniform vec4 uZoneA[ ${ZONE_SLOTS} ];   // cx, cz, radius, amount
uniform vec3 uZoneColor[ ${ZONE_SLOTS} ];

// 轮廓抖动：同一个半径上按方位角抖，读作"这片地的边缘本来就不齐"。
// 三条频率互质，避免出现肉眼可见的重复花瓣。
float zoneWobble(float a, float seed) {
  return 0.085 * sin(a * 3.0 + seed * 1.7)
       + 0.055 * sin(a * 5.0 - seed * 2.3)
       + 0.035 * sin(a * 8.0 + seed * 0.9 + 1.6);
}

// 内部斑驳：色量不是常数，而是一片深一片浅。只用低频，不做高频噪声 ——
// 地面在画面上占 30 m 见方，高频会被 mipmap 化成脏点。
float zoneDapple(vec2 p) {
  float n = sin(p.x * 0.31 + 1.7) * sin(p.y * 0.27 - 0.9);
  n += 0.55 * sin(p.x * 0.67 - 2.3) * sin(p.y * 0.59 + 1.1);
  return clamp(0.74 + 0.30 * n, 0.40, 1.0);
}

float zoneMask(vec2 p, vec4 z) {
  vec2 d = p - z.xy;
  float r = max(z.z, 1.0);
  float a = atan(d.y, d.x);
  float rr = r * (1.0 + zoneWobble(a, z.x * 0.13 + z.y * 0.21));
  // 内圈 62% 满量，外圈 38% 过渡。过渡带按半径比例给，大分区不会被拉成一条虚边。
  return 1.0 - smoothstep(rr * 0.62, rr, length(d));
}
`;

/**
 * 把地面分区染到材质上。
 *
 * **依赖**：材质必须已经提供 `varying vec3 vStainWorld`（世界坐标）。
 * 地面走 `bindGroundStain()`，草地自己就在顶点里写了，两边都满足。
 * 所以调用顺序有约束：地面材质要先 `bindGroundStain()`，再 `bindGroundZones()`。
 * 万一没有这个 varying（新加的材质忘了），这里会自己补一个 —— 补出来的那个
 * 用 modelMatrix 算，对 InstancedMesh 是错的（拿不到实例偏移），所以只当兜底。
 */
export function bindGroundZones(material) {
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;

  material.onBeforeCompile = (shader) => {
    if (prev) prev(shader);

    const slots = [];
    for (let i = 0; i < ZONE_SLOTS; i += 1) {
      const z = GROUND_ZONES[i];
      if (z) slots.push(new THREE.Vector4(z.cx, z.cz, z.r, z.amt));
      else slots.push(new THREE.Vector4(1e5, 1e5, 1.0, 0));
    }
    shader.uniforms.uZoneA = { value: slots };
    shader.uniforms.uZoneColor = {
      value: Array.from({ length: ZONE_SLOTS }, (_, i) => {
        const z = GROUND_ZONES[i];
        return new THREE.Color(z ? z.color : '#000000');
      }),
    };

    if (!shader.fragmentShader.includes('varying vec3 vStainWorld')) {
      shader.vertexShader = `varying vec3 vStainWorld;\n${shader.vertexShader}`;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vStainWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );
      shader.fragmentShader = `varying vec3 vStainWorld;\n${shader.fragmentShader}`;
    }

    shader.fragmentShader = `${ZONE_GLSL}${shader.fragmentShader}`;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <alphamap_fragment>',
      `#include <alphamap_fragment>
// 四个槽都算一遍再累加，不提前 break：常量上界的小循环在 GPU 上本来就展开，
// 省下的这几次 smoothstep 换不来什么，可读性反而差。
{
  float dap = zoneDapple(vStainWorld.xz);
  for (int i = 0; i < ${ZONE_SLOTS}; i++) {
    float k = zoneMask(vStainWorld.xz, uZoneA[i]) * uZoneA[i].w * dap;
    diffuseColor.rgb = mix(diffuseColor.rgb, uZoneColor[i], k);
  }
}`,
    );
  };

  // prevKey 是 three 的原型方法，必须带 this 调用，否则 this 变 undefined，
  // 整个 boot 直接抛错（bindGroundStain 里踩过同一个坑）。
  material.customProgramCacheKey = () =>
    `ground-zones:${prevKey ? prevKey.call(material) : 'base'}`;
}
