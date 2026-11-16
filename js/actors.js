// 战斗外观。开局把猎狗、食人魔、赫塞做好藏起来，出场时再拿。
// 史莱姆、子弹、宝石各用一个批次。

import * as THREE from 'three';
import { SkeletonUtils } from 'three/addons/utils/SkeletonUtils.js';
import { CONFIG } from './config.js';
import { terrainY } from './path.js';
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

function firstGeometry(root) {
  let geo = null;
  root.traverse((obj) => {
    if (!geo && obj.isMesh && obj.geometry) geo = obj.geometry;
  });
  return geo;
}

async function loadTemplate(url, legacy) {
  try {
    return await loadAndNormalizeGLB(url, { autoScale: false });
  } catch (primary) {
    if (!legacy) return null;
    try {
      return await loadAndNormalizeGLB(legacy, { autoScale: false });
    } catch (err) {
      console.warn('[actors] 模型没载入', url, primary, err);
      return null;
    }
  }
}

function makeRig(template, clips, scene) {
  const group = SkeletonUtils.clone(template);
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
  const slimeSrc = await loadTemplate(CONFIG.enemies.slime.glb, CONFIG.enemies.slime.legacyGlb);
  const slimeGeo = slimeSrc ? firstGeometry(slimeSrc.pivot) : new THREE.SphereGeometry(0.45, 12, 8);
  const slimeMat = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: gradient });
  const slimes = new THREE.InstancedMesh(slimeGeo, slimeMat, CONFIG.spawn.maxAlive);
  slimes.count = CONFIG.spawn.maxAlive;
  slimes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  slimes.frustumCulled = false;
  scene.add(slimes);

  const houndSrc = await loadTemplate(CONFIG.enemies.hound.glb, CONFIG.enemies.hound.legacyGlb);
  const ogreSrc = await loadTemplate(CONFIG.enemies.ogre.glb, CONFIG.enemies.ogre.legacyGlb);
  const hounds = [];
  const ogres = [];
  if (houndSrc) {
    for (let i = 0; i < HOUND_POOL; i += 1) hounds.push(makeRig(houndSrc.pivot, houndSrc.clips, scene));
  }
  if (ogreSrc) {
    for (let i = 0; i < OGRE_POOL; i += 1) ogres.push(makeRig(ogreSrc.pivot, ogreSrc.clips, scene));
  }

  const boss = await createBossView();
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
  scene.add(bullets);

  const gems = new THREE.InstancedMesh(
    new THREE.OctahedronGeometry(0.18, 0),
    new THREE.MeshBasicMaterial({ color: 0x1e9be8 }),
    CONFIG.gems.pool,
  );
  gems.frustumCulled = false;
  scene.add(gems);

  const chestRoot = new THREE.Group();
  const chestMat = [];
  const chestMesh = [];
  for (let i = 0; i < CONFIG.chests.max; i += 1) {
    const mat = new THREE.MeshToonMaterial({ color: 0x1e9be8, gradientMap: gradient });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.45, 0.5), mat);
    mesh.visible = false;
    chestMat.push(mat);
    chestMesh.push(mesh);
    chestRoot.add(mesh);
  }
  scene.add(chestRoot);

  const tel = CONFIG.boss.telegraph;
  const telegraph = new THREE.Mesh(
    new THREE.PlaneGeometry(tel.width, tel.length),
    new THREE.MeshBasicMaterial({
      color: tel.color,
      transparent: true,
      opacity: tel.alphaStart,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  telegraph.geometry.translate(0, 0, -tel.length / 2);
  telegraph.rotation.x = -Math.PI / 2;
  telegraph.visible = false;
  scene.add(telegraph);

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

  return {
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
        const s = (e.scale || 1) * (1 + hop * 0.18);
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
        telegraph.visible = !!warn;
        if (warn) {
          telegraph.position.set(hese.x, terrainY(hese.x, hese.z) + tel.y, hese.z);
          telegraph.rotation.y = Math.atan2(hese.dashDirX, hese.dashDirZ);
          const left = hese.state === 'warn' ? (1 - hese.stateT / (halfWarn(hese))) : hese.telegraph / 0.2;
          telegraph.material.opacity = tel.alphaStart + (tel.alphaFill - tel.alphaStart) * (1 - Math.max(0, Math.min(1, left)));
        }
      } else {
        telegraph.visible = false;
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
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        bullets.setMatrixAt(i, dummy.matrix);
      }
      bullets.instanceMatrix.needsUpdate = true;

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

      for (let i = 0; i < chestMesh.length; i += 1) {
        const chest = state.chests[i];
        const mesh = chestMesh[i];
        if (!chest || !chest.alive) {
          mesh.visible = false;
          continue;
        }
        const type = CONFIG.chests.types[chest.type] || CONFIG.chests.types.xp;
        chestMat[i].color.set(type.color);
        mesh.visible = true;
        mesh.position.set(chest.x, terrainY(chest.x, chest.z) + 0.28, chest.z);
        const pulse = 1 + Math.sin(state.time.elapsed * (6.28 / (type.pulse || 1.4))) * 0.06;
        mesh.scale.setScalar(pulse);
      }

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
