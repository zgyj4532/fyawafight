// 区块 8 · Boss 单体视图
// 只做一件事：把 CONFIG.boss 里的模型立起来、按状态播动作、挂上胸甲纹章。
//
// **不参与 AI、碰撞、伤害、刷怪与血条** —— 那些属于 ai.js / combat.js / spawning.js。
// 本模块不知道 Boss 有几滴血，也不判断该不该出场，只负责"长得对、动得对"。
//
// 用法：
//   const boss = await createBossView();
//   boss.group.position.set(x, y, z);
//   scene.add(boss.group);
//   boss.setFacing(Math.PI);            // 0 = 朝向 +Z（模型正面）
//   boss.setState('attack', { once: true });
//   // 每帧
//   boss.update(dt);
//   // 换场 / 死亡回收
//   boss.dispose();
//
// 一条必须遵守的顺序：**先 attach 纹章，再播动作。** 纹章是在参考姿势下用射线量出
// 胸甲形状的（见 js/emblem.js），摆过姿势再量会量到变形的甲面上。

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { createFallbackMesh, findClip, loadAndNormalizeGLB } from './pipeline.js';
import { attachEmblem } from './emblem.js';

// 模型里的片段名是 Idle / Walk / Attack / Hit / Death（Block 暂不接入）。
// 用正则而不是全等，是为了上游换一版带前缀的命名时不至于整段失效。
export const BOSS_CLIP_PATTERNS = {
  idle: 'idle|stand',
  walk: 'walk|move|run',
  attack: 'attack|charge|dash|slice',
  hit: 'hit|damage|impact',
  death: 'death|die',
};

// 只播一次的状态。攻击、受击、死亡都不该循环，否则会读成"卡住不动"。
const ONESHOT = new Set(['attack', 'hit', 'death']);

const DEFAULT_FADE = 0.16;

function countTriangles(root) {
  let tris = 0;
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    const geo = obj.geometry;
    const n = geo.index ? geo.index.count : geo.attributes.position.count;
    tris += n / 3;
  });
  return Math.round(tris);
}

function makeFallback(targetHeight) {
  const mesh = createFallbackMesh('boss');
  const box = new THREE.Box3().setFromObject(mesh);
  const size = box.getSize(new THREE.Vector3());
  if (size.y > 0.01) mesh.scale.multiplyScalar(targetHeight / size.y);
  return mesh;
}

export async function createBossView(options = {}) {
  const cfg = CONFIG.boss;
  const targetHeight = options.targetHeight || cfg.targetHeight || 1.8;

  const group = new THREE.Group();
  group.name = 'boss-view';

  // ---------- 1. 载入 ----------
  // 主路径失败退到 legacyGlb，两个都失败退到几何体。三种情况都要能立起来 ——
  // 调试观测点如果因为缺文件直接抛异常，整局都进不去。
  let loaded = null;
  let loadError = null;
  const urls = [options.url || cfg.glb, cfg.legacyGlb].filter(Boolean);
  for (const url of urls) {
    if (loaded) break;
    try {
      loaded = await loadAndNormalizeGLB(url, { autoScale: true, targetHeight });
    } catch (err) {
      loadError = err;
    }
  }
  const fallback = !loaded;
  const pivot = loaded ? loaded.pivot : makeFallback(targetHeight);
  group.add(pivot);

  // 贴地阴影。Boss 比主角高、重心低，影子给大一点才不像站在地上的一张贴纸。
  const SHADOW_OPACITY = 0.3;
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry((cfg.radius || 0.9) * 0.95, 28),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: SHADOW_OPACITY, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.03;
  group.add(shadow);

  // ---------- 2. 动作 ----------
  const clips = loaded ? loaded.clips : [];
  const actions = {};
  let mixer = null;
  if (clips.length) {
    mixer = new THREE.AnimationMixer(pivot);
    Object.entries(BOSS_CLIP_PATTERNS).forEach(([state, pattern]) => {
      const clip = findClip(clips, pattern);
      if (clip) actions[state] = mixer.clipAction(clip);
    });
  }

  let current = null;
  let currentState = '';
  let dead = false;

  function setState(state, opts = {}) {
    if (dead && state !== 'death') return false;
    const action = actions[state];
    if (!action) return false;
    if (action === current && !opts.once) return true;

    const once = opts.once ?? ONESHOT.has(state);
    const fade = opts.fade ?? DEFAULT_FADE;

    // 同一个动作重播（连续攻击）：reset 就够，不需要交叉淡化
    if (action === current) {
      action.reset().play();
      return true;
    }

    action.reset();
    action.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
    action.clampWhenFinished = once;
    action.enabled = true;
    action.setEffectiveTimeScale(1);
    action.setEffectiveWeight(1);
    action.play();

    if (current) action.crossFadeFrom(current, fade, false);

    current = action;
    currentState = state;
    if (state === 'death') dead = true;
    return true;
  }

  if (mixer) {
    mixer.addEventListener('finished', (event) => {
      // 死亡停在最后一帧；其余一次性动作回到待机。
      if (event.action === actions.death) return;
      setState('idle', { fade: 0.22 });
    });
  }

  // ---------- 3. 纹章 ----------
  // 必须在摆姿势之前挂：射线量的是参考姿势下的胸甲。
  let emblem = null;
  if (options.emblem !== false) {
    try {
      emblem = await attachEmblem(pivot, options.emblemOptions || {});
    } catch (err) {
      emblem = { ok: false, reason: String((err && err.message) || err) };
    }
  }

  // ---------- 4. 调试轮播 ----------
  // 只给验收用。'attack' = 待机 + 间歇攻击；'cycle' = 五个状态走一遍。
  const CYCLES = {
    attack: [
      { state: 'idle', dur: 2.6 },
      { state: 'attack', dur: 1.3, once: true },
    ],
    cycle: [
      { state: 'idle', dur: 2.2 },
      { state: 'walk', dur: 2.4 },
      { state: 'attack', dur: 1.4, once: true },
      { state: 'idle', dur: 1.0 },
      { state: 'hit', dur: 0.9, once: true },
      { state: 'idle', dur: 1.2 },
      { state: 'death', dur: 2.8, once: true },
    ],
  };
  let cycle = null;
  let cycleAt = 0;
  let cycleStep = 0;

  function startDebugCycle(mode = 'attack') {
    const steps = CYCLES[mode] || CYCLES.attack;
    cycle = steps;
    cycleStep = 0;
    cycleAt = 0;
    setState(steps[0].state, { fade: 0.1, once: steps[0].once });
    return true;
  }

  function stopDebugCycle() {
    cycle = null;
  }

  function stepCycle(dt) {
    if (!cycle) return;
    cycleAt += dt;
    const step = cycle[cycleStep];
    if (cycleAt < step.dur) return;
    cycleAt = 0;
    cycleStep = (cycleStep + 1) % cycle.length;
    const next = cycle[cycleStep];
    // 轮播回到第一格时把死亡标记解开，否则第二圈会卡在尸体上
    if (cycleStep === 0) dead = false;
    setState(next.state, { fade: 0.18, once: next.once });
  }

  // ---------- 5. 对外 ----------
  const api = {
    group,
    pivot,
    mixer,
    clips,
    actions,
    emblem,
    fallback,
    loadError,
    get state() {
      return currentState;
    },
    get isDead() {
      return dead;
    },
    info: {
      height: targetHeight,
      triangles: countTriangles(pivot),
      clipNames: clips.map((c) => c.name),
      states: Object.keys(actions),
      emblem: emblem && emblem.ok ? emblem.stats : (emblem ? emblem.reason : 'skipped'),
    },
    setState,
    play: setState,
    // 复用/复活时清掉死亡标记。死亡是一次性动作，卡在最后一帧后只有这里能解开。
    reset() {
      dead = false;
      cycle = null;
      setState('idle', { fade: 0.1 });
    },
    setFacing(yaw) {
      group.rotation.y = yaw;
    },
    startDebugCycle,
    stopDebugCycle,
    update(dt) {
      if (mixer) mixer.update(dt);
      stepCycle(dt);
      // 倒地后身体会甩到圆盘的侧后方，那块"站着"的圆形阴影反而变成错误信息。
      // 死亡时淡出，复活（reset）时淡回。dt 大时别一步跳完，避免抽搐。
      const want = dead ? 0 : SHADOW_OPACITY;
      shadow.material.opacity += (want - shadow.material.opacity) * Math.min(1, dt * 6);
    },
    dispose() {
      cycle = null;
      if (mixer) {
        mixer.stopAllAction();
        mixer.uncacheRoot(pivot);
      }
      if (emblem && emblem.ok && emblem.dispose) emblem.dispose();
      group.traverse((obj) => {
        if (!obj.isMesh) return;
        if (obj.geometry) obj.geometry.dispose();
        const list = Array.isArray(obj.material) ? obj.material : [obj.material];
        list.forEach((m) => m && m.dispose && m.dispose());
      });
      group.parent?.remove(group);
    },
  };

  return api;
}
