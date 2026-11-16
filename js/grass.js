// 区块 6b · 草丛层
// 地面贴图在 69 px/m 的机位下只剩色温，草的形体必须由几何承担。
// 单簇 18 叶 144 三角，用 InstancedMesh 复用，在顶点着色器里做环形包裹，
// 使草场对世界坐标静止、随相机无限平铺，不需要 CPU 每帧更新实例矩阵。
// 土路经过的地方草按 pathDist 压平，路肩留 0.85 m 的渐变带 —— 见 js/path.js。

import * as THREE from 'three';
import { createToonGradientMap } from './pipeline.js';
import { PATH_GLSL, createPathUniforms } from './path.js';
import { LAKE_SPOTS } from './lake.js';

// 草场是一个 56 m 的重复瓦片。视野约 28×16 m，边界永远在画面外。
export const GRASS_FIELD = 40;
export const GRASS_TUFTS = 5600;
const BLADES = 14;
const SEGMENTS = 4;
const TUFT_RADIUS = 0.38;

// 定稿色板。顶点色按 linear 写入，直接塞 sRGB 值会整体发白。
const PALETTE = [
  [0x3e, 0x6d, 0x2a],
  [0x60, 0x9c, 0x33],
  [0x8c, 0xc2, 0x46],
  [0xa8, 0xce, 0x5c],
];

function toLinear(rgb) {
  return rgb.map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
}

const LINEAR = PALETTE.map(toLinear);
const ROOT = LINEAR[0];
const LEAF = LINEAR[1];
const BRIGHT = LINEAR[2];
const TIP = LINEAR[3];

// 确定性随机，保证每次启动草场布局一致。
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

function buildTuftGeometry() {
  const rows = SEGMENTS + 1;
  const vertCount = BLADES * rows * 2;
  const positions = new Float32Array(vertCount * 3);
  const colors = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const indices = new Uint16Array(BLADES * SEGMENTS * 12);
  const rng = makeRandom(20261111);

  let v = 0;
  let idx = 0;

  for (let blade = 0; blade < BLADES; blade += 1) {
    const az = rng() * Math.PI * 2;
    const lean = 0.06 + rng() * 0.34;
    const wind = 0.34 * Math.cos(az - 0.6);
    const length = 0.15 + rng() * 0.15;
    const width = 0.042 + rng() * 0.030;
    const dist = rng() * TUFT_RADIUS;

    const rx = Math.cos(az) * dist;
    const rz = Math.sin(az) * dist;
    const sideX = -Math.sin(az);
    const sideZ = Math.cos(az);
    const outX = Math.cos(az);
    const outZ = Math.sin(az);

    const first = v;
    for (let s = 0; s <= SEGMENTS; s += 1) {
      const t = s / SEGMENTS;
      const bend = (lean + wind) * t + 0.85 * t * t * t;
      const reach = length * t;
      const height = reach * Math.cos(bend);
      const spread = reach * Math.sin(bend);
      const w = width * Math.max(0.04, 1 - t ** 1.15) * 0.5;

      const cx = rx + outX * spread;
      const cz = rz + outZ * spread;

      // 根暗尖亮：整片草的体积感来自这道垂直渐变，不是来自光照。
      let col;
      if (t < 0.22) {
        const k = t / 0.22;
        col = [
          ROOT[0] + (LEAF[0] - ROOT[0]) * k,
          ROOT[1] + (LEAF[1] - ROOT[1]) * k,
          ROOT[2] + (LEAF[2] - ROOT[2]) * k,
        ];
      } else if (t < 0.66) {
        const k = (t - 0.22) / 0.44;
        col = [
          LEAF[0] + (BRIGHT[0] - LEAF[0]) * k,
          LEAF[1] + (BRIGHT[1] - LEAF[1]) * k,
          LEAF[2] + (BRIGHT[2] - LEAF[2]) * k,
        ];
      } else {
        const k = (t - 0.66) / 0.34;
        col = [
          BRIGHT[0] + (TIP[0] - BRIGHT[0]) * k,
          BRIGHT[1] + (TIP[1] - BRIGHT[1]) * k,
          BRIGHT[2] + (TIP[2] - BRIGHT[2]) * k,
        ];
      }

      // 叶片法线统一朝上。竖直面按真实法线算会整片压在暗部，
      // 草就会比地面暗一档；这是植被渲染的常规处理。
      for (let s2 = 0; s2 < 2; s2 += 1) {
        const sign = s2 === 0 ? 1 : -1;
        const p = v * 3;
        positions[p] = cx + sideX * w * sign;
        positions[p + 1] = height;
        positions[p + 2] = cz + sideZ * w * sign;
        normals[p] = 0;
        normals[p + 1] = 1;
        normals[p + 2] = 0;
        const shade = s2 === 0 ? 1 : 0.92;
        colors[p] = col[0] * shade;
        colors[p + 1] = col[1] * shade;
        colors[p + 2] = col[2] * shade;
        v += 1;
      }
    }

    for (let s = 0; s < SEGMENTS; s += 1) {
      const a = first + s * 2;
      // 正面
      indices[idx] = a;
      indices[idx + 1] = a + 1;
      indices[idx + 2] = a + 3;
      indices[idx + 3] = a;
      indices[idx + 4] = a + 3;
      indices[idx + 5] = a + 2;
      // 反面：反向绕序，配合恒朝上的法线，任何一侧受光一致
      indices[idx + 6] = a + 3;
      indices[idx + 7] = a + 1;
      indices[idx + 8] = a;
      indices[idx + 9] = a + 2;
      indices[idx + 10] = a + 3;
      indices[idx + 11] = a;
      idx += 12;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return geometry;
}

function buildMaterial(uniforms) {
  const material = new THREE.MeshToonMaterial({
    vertexColors: true,
    gradientMap: createToonGradientMap(),
    side: THREE.FrontSide,
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uCamXZ = uniforms.uCamXZ;
    shader.uniforms.uHalf = uniforms.uHalf;
    shader.uniforms.uField = uniforms.uField;
    shader.uniforms.uLakes = uniforms.uLakes;
    Object.assign(shader.uniforms, uniforms.path);

    shader.vertexShader = `
uniform float uTime;
uniform vec2 uCamXZ;
uniform float uHalf;
uniform float uField;
// 四个槽固定开满：GLSL ES 1.0 的循环上界必须是常量，用 count + break
// 在不同驱动上会出岔子。没用到的那几个槽填一个极远的坐标，
// smoothstep 会直接返回 1，等于没有遮罩。
uniform vec3 uLakes[ 4 ];
` + PATH_GLSL + shader.vertexShader;

    // 草叶的法线原本统一朝上（那是"草不能比地面暗"的老处理）。路面被垫成小丘之后，
    // 这一条必须改：坡面上的草如果还是朝上，整道坡会被照成和草地一样亮，
    // 俯视下就看不出有坡 —— 起伏会彻底消失。所以按地形的梯度换成坡面法线。
    shader.vertexShader = shader.vertexShader.replace(
      '#include <beginnormal_vertex>',
      `
#include <beginnormal_vertex>
vec2 nRel = vec2( 0.0 );
#ifdef USE_INSTANCING
  nRel = mod( instanceMatrix[3].xz - uCamXZ + uHalf, uField ) - uHalf + uCamXZ;
#endif
float nH = terrainY( nRel );
float nE = 0.42;
objectNormal = normalize( vec3(
  nH - terrainY( nRel + vec2( nE, 0.0 ) ),
  nE,
  nH - terrainY( nRel + vec2( 0.0, nE ) )
) );
`,
    );

    // 环形包裹：把每个实例平移回相机附近，世界坐标因此保持静止。
    // 同时按顶点高度加风摆动，相位取自实例位置，相邻簇不同步。
    // 土路穿过草场时把草压平：路缘 0.6 m 的过渡带里草逐渐变矮，
    // 视觉上就是一条被踩秃的路肩，不需要额外的遮罩贴图。
    // 带子必须压到路面内侧一点，否则路缘会露出一条没草也没土的亮边。
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      `
vec4 mvPosition = vec4( transformed, 1.0 );
float pathK = 1.0;
#ifdef USE_INSTANCING
  vec3 iPos = instanceMatrix[3].xyz;
  vec2 rel = mod(iPos.xz - uCamXZ + uHalf, uField) - uHalf + uCamXZ;
  // 路肩留出 1.7 m 的裸土带：路基被垫起来之后，这一段是坡面最陡的地方，
  // 不长草才说得通，也顺手把路堤的明暗交代清楚。
  pathK = smoothstep( uPathHalf - 0.60, uPathHalf + 1.00, pathDist( rel ) );
  // 湖里不长草。水盆是沉到地面以下的，草留在 y=0 会从水面戳出来，
  // 一片水里全是绿色的点。每一个水盆都压一遍（和路基是同一套办法）。
  for ( int i = 0; i < 4; i++ ) {
    pathK *= smoothstep( uLakes[i].z * 0.84, uLakes[i].z * 1.04, distance( rel, uLakes[i].xy ) );
  }
  // 瓦片边缘的草要收掉。草场是 40 m 的重复瓦片、跟着玩家走，边缘离玩家 20 m，
  // 换算到相机就是 30 m 上下 —— 正好压在画面上沿。不收的话那里会露出一条
  // 干净的直线，读成"地换了个材质"，而不是"草长不到那么远"。
  // 用圆形而不是方形衰减：方形的角会伸到 28 m，那条直线反而留在画面上。
  float edgeK = 1.0 - smoothstep( uHalf - 5.0, uHalf - 0.5, distance( rel, uCamXZ ) );
  pathK *= edgeK;
  vec3 tv = transformed;
  tv.y *= pathK;
  tv.xz *= mix( 0.05, 1.0, pathK );
  float bladeH = clamp( position.y / 0.30, 0.0, 1.0 );
  float phase = iPos.x * 0.7 + iPos.z * 0.9;
  float sway = sin( uTime * 1.6 + phase ) * 0.055
             + sin( uTime * 2.3 + phase * 1.7 ) * 0.028;
  mvPosition = instanceMatrix * vec4( tv, 1.0 );
  mvPosition.xz += vec2( rel.x - iPos.x, rel.y - iPos.z );
  // 草跟着路基抬起来：路堤（js/path.js 的 buildRamp）只是一块素色几何，
  // 坡面上的草全靠这里。terrainY 必须和 JS 侧逐字一致，否则草会浮在坡上。
  mvPosition.y += terrainY( rel );
  mvPosition.xz += vec2( sway, sway * 0.6 ) * bladeH * bladeH * pathK;
#endif
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;
`,
    );
  };

  material.customProgramCacheKey = () => 'grass-ring';
  return material;
}

export function createGrassField() {
  const geometry = buildTuftGeometry();
  // 四个槽：三潭水 + 一个空槽。空槽放 (1e5, 1e5, 0.01)，
  // 任何点到它的距离都远超半径，遮罩恒等于 1。
  const lakeSlots = LAKE_SPOTS.map((l) => new THREE.Vector3(l.cx, l.cz, l.radius));
  while (lakeSlots.length < 4) lakeSlots.push(new THREE.Vector3(1e5, 1e5, 0.01));
  const uniforms = {
    uTime: { value: 0 },
    uCamXZ: { value: new THREE.Vector2() },
    uHalf: { value: GRASS_FIELD * 0.5 },
    uField: { value: GRASS_FIELD },
    // 世界坐标 + 半径：湖里不长草（见顶点着色器里的 pathK）。
    uLakes: { value: lakeSlots },
    path: createPathUniforms(),
  };
  const material = buildMaterial(uniforms);
  // 抖动网格必须整行整列填满，否则最后一行留缺口，在画面里就是一块无草区。
  const perSide = Math.round(Math.sqrt(GRASS_TUFTS));
  const count = perSide * perSide;
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.position.y = 0.012;

  const rng = makeRandom(77013);
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  const cell = GRASS_FIELD / perSide;
  // 宏观起伏：频率取瓦片长度的整数分之一，包裹时边界处连续，
  // 整片草地才有高低与明暗的层次，否则只是一张均匀的草毯。
  const macro = (x, z) => {
    const t = (Math.PI * 2) / GRASS_FIELD;
    return Math.sin(t * x) * Math.cos(t * z * 2) * 0.55
      + Math.sin(t * (x + z) * 3) * 0.30
      + Math.cos(t * (x - z) * 5) * 0.15;
  };
  let placed = 0;

  for (let gy = 0; gy < perSide; gy += 1) {
    for (let gx = 0; gx < perSide; gx += 1) {
      const x = -GRASS_FIELD / 2 + (gx + 0.5 + (rng() - 0.5) * 0.85) * cell;
      const z = -GRASS_FIELD / 2 + (gy + 0.5 + (rng() - 0.5) * 0.85) * cell;
      const wave = macro(x, z);
      const scale = (0.82 + rng() * 0.46) * (0.90 + 0.18 * wave);
      dummy.position.set(x, 0, z);
      dummy.rotation.y = rng() * Math.PI * 2;
      dummy.scale.set(scale, scale * (0.84 + rng() * 0.38) * (0.94 + 0.12 * wave), scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(placed, dummy.matrix);
      tint.setScalar(0.90 + 0.16 * wave + rng() * 0.05);
      mesh.setColorAt(placed, tint);
      placed += 1;
    }
  }

  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  return {
    mesh,
    triangles: placed * BLADES * SEGMENTS * 4,
    update(cameraX, cameraZ, time) {
      uniforms.uTime.value = time;
      uniforms.uCamXZ.value.set(cameraX, cameraZ);
    },
  };
}
