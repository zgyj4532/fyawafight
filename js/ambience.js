// 区块 · 四角氛围层（2026-11-17 夜）
//
// 第二层。第一层（js/zones.js）只改了「地的颜色」，四个角看起来还是同一个
// 世界。这一层给每个角补一种**只有进到那里才出现的氛围**：
//
//   西北 · 古战场  →  飘灰（烧过的地方，余烬在风里）
//   东北 · 伐木营地 →  暖点光（一堆篝火，夜里唯一的光）
//   西南 · 沼泽枯林 →  湿地积水（一滩一滩的反光，不是雾）
//   东南 · 废弃农舍 →  暖点光（堂屋里还点着一盏灯，人早不在了）
//
// 三样东西的取舍（有一条是美术红线，必须说明）：
// - **不做体积雾。** 项目美术总则明确「不做体积雾、景深」。所以沼泽的"湿气"
//   改成**积水反光**：一片片贴地的浅水面，边缘不规则，只反环境天光 ——
//   它读作"这块地是湿的"，但不靠任何雾气。
// - 点光是真实光照，不违反总则。白天固定光照下它偏弱，但夜里/暗处走进角里，
//   暗面上会翻出暖色阶，读作"有火"。
// - 飘灰是 Points 粒子：几十个点绕在战场角，缓慢上飘 + 水平漂移 + 淡入淡出。
//   这是灰烬，不是雾，不违反总则。
//
// 所有氛围都按「玩家离角心多远」做平滑权重：离得越近越浓，30 m 外归零。

import * as THREE from 'three';
import { CONFIG } from './config.js';

// 四个角的中心，和 js/zones.js 的 GROUND_ZONES 同一套数。氛围要盖在染过色的
// 那块地上，中心不能各写各的。
const ZONE_CENTERS = [
  { name: 'nw', cx: -44, cz: -44, kind: 'ash' },
  { name: 'ne', cx: 44, cz: -43, kind: 'fire' },
  { name: 'sw', cx: -43, cz: 44, kind: 'water' },
  { name: 'se', cx: 43, cz: 43, kind: 'fire' },
];

const FADE = 30; // 从 30 m 外开始衰减，到角心最浓

// 粒子池大小。飘灰几十个就够 —— 它要的是"空气里有东西"，不是下一场雪。
const ASH_COUNT = 60;

// --- 营地 / 农舍的点光 ------------------------------------------------
// 点光颜色偏火、偏灯。营地用篝火的暖橙，农舍用更冷一点的烛黄（室内光源）。
// 强度按"比环境亮一点点"来，不抢主角。
function buildFire() {
  const light = new THREE.PointLight(0xff9a45, 0, 14, 2);
  light.position.set(44, 2.2, -43);
  return light;
}

function buildFireSe() {
  const light = new THREE.PointLight(0xffc06a, 0, 12, 2);
  light.position.set(43, 2.0, 43);
  return light;
}

// --- 沼泽积水（替代体积雾）--------------------------------------------
// 湿地要读成"低洼处积了水"，靠的是水面比周围地面**更深更冷**，不是更浅。
// 第一版把水面做成浅灰绿，结果被读成"阳光透过树冠"——因为浅色贴片和亮草地
// 混在一起，没有明度反差。改成深冷色水面 + 更小更多的水洼，和沼泽的地
// （#38503C）拉开明度差，才像积水。这不是雾 —— 是地面上的水，不违反总则。
function buildWater() {
  const group = new THREE.Group();
  const n = 10;
  const mats = [];
  for (let i = 0; i < n; i += 1) {
    // 每片水面不同大小、不同位置，错落在沼泽角里。片更小、更多。
    const a = i / n * Math.PI * 2;
    const r = 3.5 + (i % 4) * 2.2;
    const x = -43 + Math.cos(a) * r + (i % 3) * 1.1;
    const z = 44 + Math.sin(a) * r + (i % 5) * 0.8;
    const size = 1.4 + (i % 3) * 1.1;
    const geo = new THREE.PlaneGeometry(size, size);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uAmp: { value: 0 },
        uTime: { value: 0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 vUv;
        uniform float uAmp;
        uniform float uTime;
        void main() {
          vec2 c = vUv - 0.5;
          float r = length(c) * 2.0;
          // 不规则边缘：多正弦扰动，读作水洼的边缘不齐。
          float wob = 0.5 + 0.5 * sin(c.x * 18.0 + c.y * 12.0 + uTime * 0.5);
          float edge = smoothstep(1.0, 0.50 + 0.3 * wob, r);
          // 中心一小条天光高光，像水面反着光；其余是深色水。
          float glint = smoothstep(0.35, 0.05, abs(r - 0.35)) * (0.5 + 0.5 * sin(uTime * 1.1 + c.x * 22.0));
          float a = edge * uAmp;
          // 深冷色水面（比周围地暗），混一点点高光。
          vec3 deep = vec3(0.16, 0.22, 0.20);
          vec3 sheen = vec3(0.62, 0.70, 0.64);
          vec3 col = mix(deep, sheen, glint * 0.45);
          gl_FragColor = vec4(col, a * (0.82 + 0.18 * glint));
        }
      `,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.12, z);
    mesh.renderOrder = 2;
    group.add(mesh);
    mats.push(mat);
  }
  return { group, mats };
}

// --- 战场飘灰 ---------------------------------------------------------
// 60 个点，均匀散在战场角 24 m 见方里。每个点有相位，往上飘 + 慢速水平漂移，
// 到顶就回到底。alpha 随生命周期正弦起伏，读作"灰烬明明灭灭"。
function buildAsh() {
  const n = ASH_COUNT;
  const pos = new Float32Array(n * 3);
  const seed = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const a = Math.random();
    pos[i * 3] = -44 + (a * 24 - 12);
    pos[i * 3 + 1] = Math.random() * 4;
    pos[i * 3 + 2] = -44 + (Math.sin(a * 40) * 24 - 12);
    seed[i] = Math.random();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uAmp: { value: 0 },
      uTime: { value: 0 },
      uCenter: { value: new THREE.Vector2(-44, -44) },
    },
    vertexShader: `
      attribute float aSeed;
      uniform float uAmp;
      uniform float uTime;
      uniform vec2 uCenter;
      varying float vA;
      void main() {
        vec3 p = position;
        // 上飘：一周期 6 s，速度随 seed 微差，避免同步。
        float cyc = 4.0 + aSeed * 3.0;
        p.y = mod(position.y + uTime * (0.22 + aSeed * 0.2), cyc) + 0.15;
        // 水平漂移：绕中心慢转，读作"被风带"。
        float ang = uTime * (0.08 + aSeed * 0.05) + aSeed * 6.28;
        float rad = 0.6 + aSeed * 1.4;
        p.x += sin(ang) * rad;
        p.z += cos(ang) * rad;
        // 只在玩家靠近时出现。
        float d = length(vec2(p.x, p.z) - uCenter);
        vA = uAmp * smoothstep(30.0, 12.0, d) * (0.5 + 0.5 * sin(uTime * 1.4 + aSeed * 20.0));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = (3.0 + aSeed * 3.0) * (300.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      varying float vA;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c);
        if (d > 0.5) discard;
        float a = smoothstep(0.5, 0.1, d) * vA;
        gl_FragColor = vec4(vec3(0.72, 0.70, 0.66), a);
      }
    `,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 3;
  return { points, mat };
}

export function createZoneAmbience() {
  const fireNe = buildFire();
  const fireSe = buildFireSe();
  const water = buildWater();
  const ash = buildAsh();

  return {
    // 暴露内部对象，交给 render.js 挂进场景。update 只写 uniform 和强度。
    _fireNe: fireNe,
    _fireSe: fireSe,
    _waterGroup: water.group,
    _ashPoints: ash.points,
    update(playerX, playerZ, time) {
      // 每片氛围的权重：离角心越近越大。
      const w = (cx, cz) => {
        const d = Math.hypot(playerX - cx, playerZ - cz);
        return Math.max(0, 1 - d / FADE);
      };

      const waterW = w(-43, 44);
      for (const mat of water.mats) {
        mat.uniforms.uAmp.value = waterW;
        mat.uniforms.uTime.value = time;
      }

      const ashW = w(-44, -44);
      ash.mat.uniforms.uAmp.value = ashW;
      ash.mat.uniforms.uTime.value = time;

      fireNe.intensity = w(44, -43) * 1.6;
      fireSe.intensity = w(43, 43) * 1.3;
    },
  };
}
