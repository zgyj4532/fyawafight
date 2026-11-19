// 战斗外观。开局把猎狗、食人魔、赫塞做好藏起来，出场时再拿。
// 史莱姆、子弹、宝石各用一个批次。

import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { CONFIG } from './config.js';
import { GROUND_STAIN, terrainY } from './path.js';
import { createBossView } from './bossview.js';
import { createToonGradientMap, findClip, loadAndNormalizeGLB } from './pipeline.js';

const NEAR = 16;
const HOUND_POOL = 20;
const OGRE_POOL = 6;
const CLIPS = {
  idle: 'idle|stand',
  walk: 'walk|run|jog|move',
  attack: 'attack|charge|dash',
  hit: 'hit|damage',
  death: 'death|die',
};

const dummy = new THREE.Object3D();
const color = new THREE.Color();

function largestGeometry(root) {
  let geo = null;
  let best = 0;
  let skinned = null;
  let skinnedBest = 0;
  root.traverse((obj) => {
    const count = obj.isMesh && obj.geometry && obj.geometry.attributes.position
      ? obj.geometry.attributes.position.count
      : 0;
    if (count > best) {
      best = count;
      geo = obj.geometry;
    }
    if (obj.isSkinnedMesh && count > skinnedBest) {
      skinnedBest = count;
      skinned = obj.geometry;
    }
  });
  return skinned || geo;
}

function sourceMap(root, geo) {
  let map = null;
  root.traverse((obj) => {
    if (obj.isMesh && obj.geometry === geo && obj.material && obj.material.map) map = obj.material.map;
  });
  return map;
}

function fitGround(geo, height) {
  geo.computeBoundingBox();
  const box = geo.boundingBox;
  const h = box.max.y - box.min.y;
  geo.translate(
    -((box.min.x + box.max.x) * 0.5),
    -box.min.y,
    -((box.min.z + box.max.z) * 0.5),
  );
  return h > 1e-4 ? height / h : 1;
}

async function loadTemplate(url, legacy, opts) {
  const config = opts || { autoScale: false };
  try {
    return await loadAndNormalizeGLB(url, config);
  } catch (primary) {
    if (!legacy) return null;
    try {
      return await loadAndNormalizeGLB(legacy, config);
    } catch (err) {
      console.warn('[actors] 模型没载入', url, primary, err);
      return null;
    }
  }
}

function makeRig(template, clips, scene) {
  const group = cloneSkeleton(template);
  const mixer = new THREE.AnimationMixer(group);
  const actions = {};
  Object.entries(CLIPS).forEach(([name, pattern]) => {
    const clip = findClip(clips, pattern);
    if (clip) actions[name] = mixer.clipAction(clip);
  });
  group.visible = false;
  scene.add(group);
  return { group, mixer, actions, enemyId: -1, anim: '' };
}

function playRig(slot, name, dt) {
  const next = slot.actions[name] || slot.actions.walk || slot.actions.idle;
  if (next && next !== slot.current) {
    next.reset().fadeIn(0.08).play();
    if (slot.current) slot.current.fadeOut(0.08);
    slot.current = next;
    slot.anim = name;
  }
  slot.mixer.update(dt);
}

function assignPool(pool, enemies, kind, player) {
  const want = [];
  for (let i = 0; i < enemies.length; i += 1) {
    const e = enemies[i];
    if (!e.alive || e.kind !== kind) continue;
    const d = Math.hypot(e.x - player.x, e.z - player.z);
    if (d > NEAR) continue;
    want.push(e);
  }
  want.sort((a, b) => (
    Math.hypot(a.x - player.x, a.z - player.z) - Math.hypot(b.x - player.x, b.z - player.z)
  ));
  const keep = new Set();
  for (let i = 0; i < pool.length; i += 1) {
    const slot = pool[i];
    if (slot.enemyId < 0) continue;
    if (!want.some((e) => e.id === slot.enemyId)) {
      slot.enemyId = -1;
      slot.group.visible = false;
    } else keep.add(slot.enemyId);
  }
  for (let i = 0; i < want.length; i += 1) {
    if (keep.has(want[i].id)) continue;
    const free = pool.find((slot) => slot.enemyId < 0);
    if (!free) break;
    free.enemyId = want[i].id;
    free.group.visible = true;
    keep.add(want[i].id);
  }
}

function horizontalRadius(root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) return 0;
  return Math.max(box.max.x, -box.min.x, box.max.z, -box.min.z);
}

// 史莱姆的贴图是**紫色**（config 里那句 referenceColor: '#6E4AA8' 就是它）。
// 变体色走 InstancedMesh.instanceColor，在着色器里是**乘法**：
//   屏幕颜色 = 贴图（紫）× 变体色 × 光
// 紫 × 绿 ≈ 泥，紫 × 红 ≈ 褐 —— 所以三个变体一直是「脏」的，绿的尤其像墨绿。
//
// 这里的解法不是继续调乘法系数（调不出来，紫的蓝通道乘什么都是灰的），
// 而是先把贴图**去色**：只留明暗（眼睛变暗、身子亮起来），色相交给变体色。
// 一份贴图去一次色即可，三个变体共用。
function desaturateMap(map) {
  const img = map && map.image;
  const w = img && (img.width | 0);
  const h = img && (img.height | 0);
  if (!w || !h) return map;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    // 减 25 再乘 2.6：眼睛那种暗块（lum≈30）落到 10 上下，身体（lum≈100）抬到 200。
    // 系数小一点的话身体只有 70 左右，变体色一乘还是暗绿 —— 量过：
    // (lum-40)*1.45 出来的本体是 RGB(101,137,59)，还是橄榄绿，不是浅绿。
    const v = Math.min(255, Math.max(0, (lum - 25) * 2.6));
    px[i] = v;
    px[i + 1] = v;
    px[i + 2] = v;
  }
  ctx.putImageData(data, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = map.colorSpace;
  tex.flipY = map.flipY;
  tex.wrapS = map.wrapS;
  tex.wrapT = map.wrapT;
  tex.needsUpdate = true;
  return tex;
}

function placePool(pool, enemies, dt) {
  for (let i = 0; i < pool.length; i += 1) {
    const slot = pool[i];
    if (slot.enemyId < 0) continue;
    const e = enemies[slot.enemyId];
    if (!e || !e.alive) {
      slot.enemyId = -1;
      slot.group.visible = false;
      continue;
    }
    const y = terrainY(e.x, e.z);
    slot.group.position.set(e.x, y, e.z);
    slot.group.rotation.y = e.facing;
    const s = e.scale || 1;
    slot.group.scale.set(s, s, s);
    slot.group.visible = true;
    playRig(slot, e.anim || 'walk', dt);
  }
}

export async function createActors(scene) {
  const gradient = createToonGradientMap();
  // 史莱姆、猎狗、食人魔、Boss、宝箱同时下。原先一个 await 接一个，
  // 后面的模型要等前面解析完才开始要字节。
  const slimeTask = loadTemplate(CONFIG.enemies.slime.glb, CONFIG.enemies.slime.legacyGlb);
  const houndTask = loadTemplate(CONFIG.enemies.hound.glb, CONFIG.enemies.hound.legacyGlb);
  const ogreTask = loadTemplate(CONFIG.enemies.ogre.glb, CONFIG.enemies.ogre.legacyGlb);
  const chestTask = loadTemplate(CONFIG.chests.glb, CONFIG.chests.legacyGlb, {
    autoScale: true,
    targetHeight: CONFIG.chests.modelHeight,
  });
  const bossTask = createBossView();
  const slimeSrc = await slimeTask;
  const slimeGeo = (slimeSrc && largestGeometry(slimeSrc.pivot)) || new THREE.SphereGeometry(0.45, 12, 8);
  const slimeFit = fitGround(slimeGeo, 1.15);
  slimeGeo.computeBoundingBox();
  const slimeBox = slimeGeo.boundingBox;
  const bodyRadius = {
    slime: Math.max(slimeBox.max.x, -slimeBox.min.x, slimeBox.max.z, -slimeBox.min.z) * slimeFit,
  };
  const slimeMat = new THREE.MeshToonMaterial({
    color: 0xffffff,
    // 贴图先过一遍去色（见 desaturateMap）：变体色是乘上去的，
    // 留着色相的话紫 × 绿永远是泥绿。
    map: slimeSrc ? desaturateMap(sourceMap(slimeSrc.pivot, slimeGeo)) : null,
    gradientMap: gradient,
  });
  const slimes = new THREE.InstancedMesh(slimeGeo, slimeMat, CONFIG.spawn.maxAlive);
  slimes.count = CONFIG.spawn.maxAlive;
  slimes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  slimes.frustumCulled = false;
  scene.add(slimes);

  const houndSrc = await houndTask;
  const ogreSrc = await ogreTask;
  const hounds = [];
  const ogres = [];
  if (houndSrc) {
    bodyRadius.hound = horizontalRadius(houndSrc.pivot);
    for (let i = 0; i < HOUND_POOL; i += 1) hounds.push(makeRig(houndSrc.pivot, houndSrc.clips, scene));
  }
  if (ogreSrc) {
    bodyRadius.ogre = horizontalRadius(ogreSrc.pivot);
    for (let i = 0; i < OGRE_POOL; i += 1) ogres.push(makeRig(ogreSrc.pivot, ogreSrc.clips, scene));
  }

  const boss = await bossTask;
  bodyRadius.hese = horizontalRadius(boss.group);
  boss.group.visible = false;
  scene.add(boss.group);
  let bossAnim = '';

  const bulletGeo = new THREE.CapsuleGeometry(CONFIG.weapon.visualRadius, CONFIG.weapon.length, 2, 6);
  bulletGeo.rotateX(Math.PI / 2);
  const bullets = new THREE.InstancedMesh(
    bulletGeo,
    new THREE.MeshBasicMaterial({ color: 0xf4f7fb }),
    CONFIG.weapon.pool,
  );
  bullets.frustumCulled = false;
  for (let i = 0; i < bullets.count; i += 1) bullets.setColorAt(i, color.set(0xf4f7fb));
  scene.add(bullets);

  const gems = new THREE.InstancedMesh(
    new THREE.OctahedronGeometry(0.18, 0),
    new THREE.MeshBasicMaterial({ color: 0x1e9be8 }),
    CONFIG.gems.pool,
  );
  gems.frustumCulled = false;
  scene.add(gems);

  // --- 宝箱（2026-11-17 换成真模型）--------------------------------------
  //
  // 上一版是三只 0.7×0.45×0.5 的方盒，靠材质换成类型色。它只能说明
  // "这里有个盒子可以开"，读不出"这是宝箱"。现在用 rigged_v1 的模型：
  // 木箱 + 银白包角 + 正面菱形宝石，14172 面，带 Open / Close 两段两骨动画。
  //
  // 类型色不能再靠给箱体染色 —— 模型只有一份材质、一份贴图，
  // 染成蓝色就成了"蓝色的箱子"，不是"蓝色宝石的箱子"。所以信息层拆成两件
  // 贴在箱子上方的部件：一颗浮起来的菱形宝石 + 地上一圈同色微光。
  // 宝石对应美术稿里"可换色菱形宝石"，微光对应"光缝"；宝石只做旋转和上下浮动，
  // 微光只做呼吸，两者都随 type.pulse 走 —— 陷阱箱 0.6 s 的急促呼吸仍然成立。
  const chestSrc = await chestTask;
  // 贴图是灰的（实测均色 95,96,91，R=G=B），进场景就是一块灰石头。
  // 乘一层暖色把它拉回"旧木箱"：0xEFD9BE 只压蓝通道，木色回棕、包角仍是浅灰，
  // 比直接给整个箱子染类型色温和得多（类型色交给宝石和地面微光）。
  if (chestSrc) {
    const warm = new THREE.Color(0xefd9be);
    chestSrc.pivot.traverse((obj) => {
      if (!obj.isMesh) return;
      const list = Array.isArray(obj.material) ? obj.material : [obj.material];
      list.forEach((mat) => { if (mat && mat.color) mat.color.multiply(warm); });
    });
  }
  const chestSlots = [];
  const chestBoxGeo = new THREE.BoxGeometry(0.7, 0.45, 0.5);

  const gemMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 });
  const chestGems = new THREE.InstancedMesh(
    new THREE.OctahedronGeometry(0.17, 0),
    gemMat,
    CONFIG.chests.max,
  );
  chestGems.frustumCulled = false;
  scene.add(chestGems);

  const glowMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.30,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const glowGeo = new THREE.CircleGeometry(0.62, 24);
  glowGeo.rotateX(-Math.PI / 2);
  const chestGlows = new THREE.InstancedMesh(glowGeo, glowMat, CONFIG.chests.max);
  chestGlows.frustumCulled = false;
  scene.add(chestGlows);

  const chestRoot = new THREE.Group();
  scene.add(chestRoot);

  for (let i = 0; i < CONFIG.chests.max; i += 1) {
    const group = new THREE.Group();
    group.visible = false;
    chestRoot.add(group);
    let mixer = null;
    let openAction = null;
    if (chestSrc) {
      const model = cloneSkeleton(chestSrc.pivot);
      group.add(model);
      mixer = new THREE.AnimationMixer(model);
      const clip = findClip(chestSrc.clips, 'open');
      if (clip) {
        openAction = mixer.clipAction(clip);
        // 静止姿势就是"关着"。clip 不播的时候骨头停在绑定姿势，正好是关上。
        openAction.play();
        openAction.paused = true;
        openAction.time = 0;
        mixer.update(0);
      }
    } else {
      const box = new THREE.Mesh(chestBoxGeo, new THREE.MeshToonMaterial({ color: 0x1e9be8, gradientMap: gradient }));
      box.position.y = 0.225;
      group.add(box);
    }
    chestSlots.push({
      group,
      mixer,
      openAction,
      ghostT: 0,
      wasAlive: false,
      opened: false,
      x: 0,
      z: 0,
    });
  }

  // 打开动作固定在 0.45 s 内放完（clip 本身 30 帧，按 24 fps 是 1.25 s，
  // 玩家听到音效到看见箱盖翻起来之间不该隔一秒多）。
  function beginOpen(slot) {
    if (!slot.openAction) return;
    const action = slot.openAction;
    const dur = action.getClip().duration || 1;
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.timeScale = dur / CONFIG.chests.openAnimVisual;
    action.play();
  }

  function resetClosed(slot) {
    if (!slot.openAction) return;
    slot.openAction.paused = false;
    slot.openAction.reset();
    slot.openAction.play();
    slot.openAction.paused = true;
    slot.openAction.time = 0;
    slot.mixer.update(0);
  }

  const tel = CONFIG.boss.telegraph;
  GROUND_STAIN.uStainHalf.value = tel.width * 0.5;
  GROUND_STAIN.uStainLen.value = tel.length;
  GROUND_STAIN.uStainColor.value.set(tel.color);

  const warnR = CONFIG.chests.types.trap.warnRadius;
  const trapRing = new THREE.Mesh(
    new THREE.RingGeometry(Math.max(0.2, warnR - 0.18), warnR, 40),
    new THREE.MeshBasicMaterial({
      color: CONFIG.chests.types.trap.color,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  trapRing.rotation.x = -Math.PI / 2;
  trapRing.visible = false;
  scene.add(trapRing);

  const rings = new THREE.InstancedMesh(
    new THREE.RingGeometry(0.9, 1.05, 20),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, side: THREE.DoubleSide }),
    16,
  );
  rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  rings.frustumCulled = false;
  scene.add(rings);

  function hideInstance(mesh, index) {
    dummy.position.set(0, -20, 0);
    dummy.scale.set(0, 0, 0);
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    mesh.setMatrixAt(index, dummy.matrix);
  }

  for (let i = 0; i < slimes.count; i += 1) hideInstance(slimes, i);
  for (let i = 0; i < bullets.count; i += 1) hideInstance(bullets, i);
  for (let i = 0; i < gems.count; i += 1) hideInstance(gems, i);
  for (let i = 0; i < rings.count; i += 1) hideInstance(rings, i);
  for (let i = 0; i < chestGems.count; i += 1) hideInstance(chestGems, i);
  for (let i = 0; i < chestGlows.count; i += 1) hideInstance(chestGlows, i);
  slimes.instanceMatrix.needsUpdate = true;
  bullets.instanceMatrix.needsUpdate = true;
  gems.instanceMatrix.needsUpdate = true;
  rings.instanceMatrix.needsUpdate = true;

  return {
    bodyRadius,
    // 调试钩子：宝箱模型有没有载入、三个槽位各自在放什么动作。
    chestSlots,
    chestLoaded: !!chestSrc,
    update(state, dt) {
      const step = dt * (state.time.scale || 1);
      const enemies = state.enemies;
      const player = state.player;
      const variants = CONFIG.slimeVariants;
      let shown = 0;
      for (let i = 0; i < enemies.length; i += 1) {
        const e = enemies[i];
        if (!e.alive || e.kind !== 'slime') continue;
        const variant = variants[e.variantId] || variants.green;
        const hop = e.hopT && CONFIG.enemies.slime.hopEvery
          ? Math.sin((e.hopT / CONFIG.enemies.slime.hopEvery) * Math.PI)
          : 0;
        const s = slimeFit * (e.scale || 1) * (1 + hop * 0.18);
        dummy.position.set(e.x, terrainY(e.x, e.z), e.z);
        dummy.rotation.set(0, e.facing, 0);
        dummy.scale.set(s, s * (1 + hop * 0.35), s);
        dummy.updateMatrix();
        slimes.setMatrixAt(shown, dummy.matrix);
        color.set(variant.color || '#659B4A');
        slimes.setColorAt(shown, color);
        shown += 1;
      }
      for (let i = shown; i < slimes.count; i += 1) hideInstance(slimes, i);
      slimes.instanceMatrix.needsUpdate = true;
      if (slimes.instanceColor) slimes.instanceColor.needsUpdate = true;

      assignPool(hounds, enemies, 'hound', player);
      assignPool(ogres, enemies, 'ogre', player);
      placePool(hounds, enemies, step);
      placePool(ogres, enemies, step);

      const hese = enemies[0];
      const showBoss = hese && hese.kind === 'hese' && (hese.alive || hese.anim === 'death');
      boss.group.visible = !!showBoss;
      if (showBoss) {
        boss.group.position.set(hese.x, terrainY(hese.x, hese.z), hese.z);
        boss.setFacing(hese.facing);
        if (hese.anim && hese.anim !== bossAnim) {
          boss.setState(hese.anim, { once: hese.anim === 'death' || hese.anim === 'attack' || hese.anim === 'hit' });
          bossAnim = hese.anim;
        }
        boss.update(step);
        const warn = hese.state === 'warn' || (hese.state === 'dash' && hese.telegraph > 0);
        if (warn) {
          const span = Math.hypot(hese.dashDirX, hese.dashDirZ) || 1;
          GROUND_STAIN.uStainOn.value = 1;
          GROUND_STAIN.uStainOrigin.value.set(hese.x, hese.z);
          GROUND_STAIN.uStainDir.value.set(hese.dashDirX / span, hese.dashDirZ / span);
          const left = hese.state === 'warn' ? (1 - hese.stateT / halfWarn(hese)) : hese.telegraph / 0.2;
          const fill = 1 - Math.max(0, Math.min(1, left));
          GROUND_STAIN.uStainAmt.value = 0.72 + 0.2 * fill;
        } else {
          GROUND_STAIN.uStainOn.value = 0;
          GROUND_STAIN.uStainAmt.value = 0;
        }
      } else {
        GROUND_STAIN.uStainOn.value = 0;
        GROUND_STAIN.uStainAmt.value = 0;
        bossAnim = '';
      }

      const bulletPool = state.bullets;
      for (let i = 0; i < bulletPool.count; i += 1) {
        if (!bulletPool.alive[i]) {
          hideInstance(bullets, i);
          continue;
        }
        dummy.position.set(bulletPool.x[i], terrainY(bulletPool.x[i], bulletPool.z[i]) + 0.7, bulletPool.z[i]);
        dummy.rotation.set(0, Math.atan2(bulletPool.vx[i], bulletPool.vz[i]), 0);
        const charged = bulletPool.charge[i] === 1;
        const scale = charged ? 1.8 : 1;
        dummy.scale.set(scale, scale, charged ? 2.4 : 1);
        dummy.updateMatrix();
        bullets.setMatrixAt(i, dummy.matrix);
        bullets.setColorAt(i, color.set(charged ? 0xf5b63c : 0xf4f7fb));
      }
      bullets.instanceMatrix.needsUpdate = true;
      if (bullets.instanceColor) bullets.instanceColor.needsUpdate = true;

      const gemPool = state.gems;
      for (let i = 0; i < gemPool.count; i += 1) {
        if (!gemPool.alive[i]) {
          hideInstance(gems, i);
          continue;
        }
        const bob = 0.45 + Math.sin(state.time.elapsed * 6 + i) * 0.06;
        dummy.position.set(gemPool.x[i], terrainY(gemPool.x[i], gemPool.z[i]) + bob, gemPool.z[i]);
        dummy.rotation.set(0, state.time.elapsed, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        gems.setMatrixAt(i, dummy.matrix);
      }
      gems.instanceMatrix.needsUpdate = true;

      // 宝箱：模型 + 悬浮宝石 + 地面微光。三个槽位各自一套动作。
      for (let i = 0; i < chestSlots.length; i += 1) {
        const slot = chestSlots[i];
        const chest = state.chests[i];
        const alive = !!(chest && chest.alive);
        if (alive) {
          if (!slot.wasAlive) {
            resetClosed(slot);
            slot.opened = false;
            slot.ghostT = 0;
          }
          slot.x = chest.x;
          slot.z = chest.z;
          slot.group.visible = true;
          slot.group.position.set(chest.x, terrainY(chest.x, chest.z), chest.z);
          // 陷阱箱在"开盖之前"先合着：红环在抖，箱盖翻起来是狗出来那一刻。
          if (!slot.opened && chest.opening && chest.type !== 'trap') {
            beginOpen(slot);
            slot.opened = true;
          }
        } else if (slot.wasAlive) {
          // 这一帧刚消失。留一点时间把开盖放完，否则箱子是"啪"一下没的。
          slot.ghostT = CONFIG.chests.openAnimVisual + 0.15;
          slot.group.visible = true;
          beginOpen(slot);
        }
        if (slot.ghostT > 0) {
          slot.ghostT -= step;
          if (slot.ghostT <= 0) slot.group.visible = false;
        }
        slot.wasAlive = alive;
        if (slot.mixer) slot.mixer.update(step);

        if (alive) {
          const type = CONFIG.chests.types[chest.type] || CONFIG.chests.types.xp;
          const pulse = 1 + Math.sin(state.time.elapsed * (6.28 / (type.pulse || 1.4))) * 0.10;
          const gy = terrainY(chest.x, chest.z);
          // 宝石浮在箱盖上方 0.86 m：58° 俯视下箱体只有 42 px，宝石 10 px，
          // 再加上下面那圈同色微光，类型才在"看一眼"的尺度上读得出来。
          dummy.position.set(chest.x, gy + 0.86 + Math.sin(state.time.elapsed * 1.8 + i) * 0.05, chest.z);
          dummy.rotation.set(0, state.time.elapsed * 1.6 + i, 0);
          dummy.scale.set(1, 1.35, 1);
          dummy.updateMatrix();
          chestGems.setMatrixAt(i, dummy.matrix);
          color.set(type.color);
          chestGems.setColorAt(i, color);

          dummy.position.set(chest.x, gy + 0.018, chest.z);
          dummy.rotation.set(0, 0, 0);
          dummy.scale.set(pulse, 1, pulse);
          dummy.updateMatrix();
          chestGlows.setMatrixAt(i, dummy.matrix);
          chestGlows.setColorAt(i, color);
        } else {
          hideInstance(chestGems, i);
          hideInstance(chestGlows, i);
        }
      }
      chestGems.instanceMatrix.needsUpdate = true;
      if (chestGems.instanceColor) chestGems.instanceColor.needsUpdate = true;
      chestGlows.instanceMatrix.needsUpdate = true;
      if (chestGlows.instanceColor) chestGlows.instanceColor.needsUpdate = true;
      const trap = state.chests.find((chest) => chest.alive && chest.opening && chest.type === 'trap');
      trapRing.visible = !!trap;
      if (trap) trapRing.position.set(trap.x, terrainY(trap.x, trap.z) + 0.08, trap.z);

      let ring = 0;
      for (let i = 0; i < enemies.length && ring < 16; i += 1) {
        const e = enemies[i];
        if (!e.alive || !e.elite) continue;
        dummy.position.set(e.x, terrainY(e.x, e.z) + 0.05, e.z);
        dummy.rotation.set(-Math.PI / 2, 0, 0);
        dummy.scale.set(e.radius, e.radius, 1);
        dummy.updateMatrix();
        rings.setMatrixAt(ring, dummy.matrix);
        color.set((CONFIG.slimeVariants[e.variantId] && CONFIG.slimeVariants[e.variantId].color) || CONFIG.enemies[e.kind].color);
        rings.setColorAt(ring, color);
        ring += 1;
      }
      for (let i = ring; i < 16; i += 1) hideInstance(rings, i);
      rings.instanceMatrix.needsUpdate = true;
      if (rings.instanceColor) rings.instanceColor.needsUpdate = true;
    },
  };
}

function halfWarn(boss) {
  const line = CONFIG.boss.p2.hpBelow;
  const phase = boss.hpMax > 0 && boss.hp < boss.hpMax * line ? CONFIG.boss.p2 : CONFIG.boss.p1;
  return phase.warn || CONFIG.boss.p1.warn;
}
