// 区块 6 · updateSpawning
// 环面距离校验、时间轴波次、精英与宝箱。只从对象池点亮 enemies / chests。

import { CONFIG } from './config.js';
import { nextUnit } from './state.js';

const CREDIT_CAP = 3;
const RING_TRIES = 8;
const TRAP_SPREAD = 1.5;

function torusDelta(x1, z1, x2, z2, size) {
  let dx = x2 - x1, dz = z2 - z1;
  const half = size * 0.5;
  if (dx > half) dx -= size;
  if (dx < -half) dx += size;
  if (dz > half) dz -= size;
  if (dz < -half) dz += size;
  return { dx, dz, dist: Math.hypot(dx, dz) };
}

function foldAxis(v) {
  const size = CONFIG.arena.size;
  const half = size * 0.5;
  let x = (v + half) % size;
  if (x < 0) x += size;
  return x - half;
}

function waveFor(elapsed) {
  const waves = CONFIG.waves;
  for (let i = 0; i < waves.length; i++) {
    const wave = waves[i];
    if (elapsed >= wave.start && (wave.end === null || elapsed < wave.end)) return wave;
  }
  return waves[waves.length - 1];
}

function bossAt() {
  const waves = CONFIG.waves;
  for (let i = 0; i < waves.length; i++) {
    if (waves[i].boss === 'hese') return waves[i].start;
  }
  return 300;
}

function prepSpec() {
  const waves = CONFIG.waves;
  for (let i = 0; i < waves.length; i++) {
    if (waves[i].forceChest) return waves[i];
  }
  return null;
}

function placeRing(state) {
  const size = CONFIG.arena.size;
  const minR = CONFIG.spawn.ringMin;
  const maxR = CONFIG.spawn.ringMax;
  const reject = CONFIG.spawn.rejectWithin;
  const player = state.player;
  for (let n = 0; n < RING_TRIES; n++) {
    const ang = nextUnit(state) * Math.PI * 2;
    const radius = minR + (maxR - minR) * nextUnit(state);
    const x = foldAxis(player.x + Math.sin(ang) * radius);
    const z = foldAxis(player.z + Math.cos(ang) * radius);
    const dist = torusDelta(x, z, player.x, player.z, size).dist;
    if (dist >= reject) return { x, z };
  }
  return null;
}

function placeNear(state, ox, oz, spread) {
  const ang = nextUnit(state) * Math.PI * 2;
  const dist = nextUnit(state) * spread;
  return {
    x: foldAxis(ox + Math.sin(ang) * dist),
    z: foldAxis(oz + Math.cos(ang) * dist),
  };
}

function placeChest(state) {
  const half = CONFIG.arena.size * 0.5;
  const minR = CONFIG.chests.placeMin;
  const maxR = CONFIG.chests.placeMax;
  const player = state.player;
  const ang = nextUnit(state) * Math.PI * 2;
  const radius = minR + (maxR - minR) * nextUnit(state);
  let x = player.x + Math.sin(ang) * radius;
  let z = player.z + Math.cos(ang) * radius;
  if (nextUnit(state) < CONFIG.chests.oppositeChance) {
    x += Math.sin(ang) * half;
    z += Math.cos(ang) * half;
  }
  return { x: foldAxis(x), z: foldAxis(z) };
}

// 普通怪：id>=1 的第一个空位。没有就立刻收回环面上离玩家最远的一只。绝不碰 enemies[0]。
function acquireEnemy(state) {
  const enemies = state.enemies;
  for (let i = 0; i < enemies.length; i++) {
    const enemy = enemies[i];
    if (enemy.id >= 1 && enemy.alive === false) return enemy;
  }
  let far = null;
  let farDist = -1;
  const size = CONFIG.arena.size;
  const px = state.player.x;
  const pz = state.player.z;
  for (let i = 0; i < enemies.length; i++) {
    const enemy = enemies[i];
    if (enemy.id < 1 || enemy.alive !== true) continue;
    const dist = torusDelta(enemy.x, enemy.z, px, pz, size).dist;
    if (dist > farDist) {
      farDist = dist;
      far = enemy;
    }
  }
  if (!far) return null;
  far.alive = false;
  return far;
}

function pickFamily(state, weights) {
  const slime = weights.slime > 0 ? weights.slime : 0;
  const hound = weights.hound > 0 ? weights.hound : 0;
  const ogre = weights.ogre > 0 ? weights.ogre : 0;
  const total = slime + hound + ogre;
  if (total <= 0) return '';
  let r = nextUnit(state) * total;
  if (slime > 0) {
    if (r < slime) return 'slime';
    r -= slime;
  }
  if (hound > 0) {
    if (r < hound) return 'hound';
    r -= hound;
  }
  if (ogre > 0) return 'ogre';
  return '';
}

function pickEliteKind(state, weights) {
  const slime = weights.slime > 0 ? weights.slime : 0;
  const hound = weights.hound > 0 ? weights.hound : 0;
  const total = slime + hound;
  if (total <= 0) return '';
  let r = nextUnit(state) * total;
  if (slime > 0) {
    if (r < slime) return 'slime';
    r -= slime;
  }
  if (hound > 0) return 'hound';
  return '';
}

function pickVariant(state) {
  const table = CONFIG.slimeVariants;
  const red = table.red.weight > 0 ? table.red.weight : 0;
  const blue = table.blue.weight > 0 ? table.blue.weight : 0;
  const green = table.green.weight > 0 ? table.green.weight : 0;
  const total = red + blue + green;
  if (total <= 0) return '';
  let r = nextUnit(state) * total;
  if (red > 0) {
    if (r < red) return 'red';
    r -= red;
  }
  if (blue > 0) {
    if (r < blue) return 'blue';
    r -= blue;
  }
  if (green > 0) return 'green';
  return '';
}

function baseStats(kind, variantId) {
  if (kind === 'hese') {
    const boss = CONFIG.boss;
    return {
      hp: boss.hp,
      speed: boss.speed,
      contact: boss.contact,
      radius: boss.radius,
      xp: 0,
      scale: 1,
      variantId: '',
    };
  }
  if (kind === 'slime') {
    const variant = CONFIG.slimeVariants[variantId];
    return {
      hp: variant.hp,
      speed: variant.speed,
      contact: variant.contact,
      radius: variant.radius,
      xp: variant.xp,
      scale: 1,
      variantId: variant.id,
    };
  }
  const table = CONFIG.enemies[kind];
  return {
    hp: table.hp,
    speed: table.speed,
    contact: table.contact,
    radius: table.radius,
    xp: table.xp,
    scale: 1,
    variantId: '',
  };
}

function applyElite(stats) {
  const elite = CONFIG.elite;
  stats.hp *= elite.hp;
  stats.contact *= elite.contact;
  stats.xp *= elite.xp;
  stats.speed *= elite.speed;
  stats.scale *= elite.scale;
  stats.radius *= elite.scale;
}

function lightEnemy(slot, state, pos, kind, stats, elite, trap) {
  const boss = kind === 'hese';
  const x = pos.x;
  const z = pos.z;
  const toPlayer = torusDelta(x, z, state.player.x, state.player.z, CONFIG.arena.size);
  slot.kind = kind;
  slot.variantId = stats.variantId;
  slot.elite = elite;
  slot.trap = trap;
  slot.x = x;
  slot.z = z;
  slot.vx = 0;
  slot.vz = 0;
  slot.facing = Math.atan2(toPlayer.dx, toPlayer.dz);
  slot.hpMax = stats.hp;
  slot.hp = stats.hp;
  slot.radius = stats.radius;
  slot.contact = stats.contact;
  slot.speed = stats.speed;
  slot.xp = stats.xp;
  slot.scale = stats.scale;
  slot.anim = boss ? 'idle' : 'walk';
  slot.state = boss ? 'idle' : 'chase';
  slot.stateT = 0;
  slot.hitFlash = 0;
  slot.portalSlow = 0;
  slot.hopT = 0;
  slot.telegraph = 0;
  slot.dashDirX = 0;
  slot.dashDirZ = 1;
  slot.hits = 0;
  slot.contactCd = 0;
  slot.dashHit = false;
  slot.portalCd = 0;
  slot.recoverNeed = 0;
  // 复活的槽不能带着上一条命的碰撞记忆出生，否则一落地就往旁边滑。
  slot.nX = 0;
  slot.nZ = 0;
  slot.blockT = 0;
  slot.wedgeT = 0;
  slot.detourT = 0;
  slot.detourX = 0;
  slot.detourZ = 0;
  // 复用槽不能留下上一只的落点。
  slot.leapCd = 0;
  slot.lockX = 0;
  slot.lockZ = 0;
  slot.arcX = 0;
  slot.arcZ = 0;
  slot.arcDx = 0;
  slot.arcDz = 0;
  slot.leapH = 0;
  slot.leapShow = 0;
  slot.impactLatched = 0;
  slot.rigged = false;
  slot.alive = true;
}

// 落点失败返回 false，调用方决定退 credit 还是不写标志。成功后才改槽。
function lightFrom(state, kind, opts) {
  const variantId = kind === 'slime' ? (opts.variantId || pickVariant(state)) : '';
  if (kind === 'slime' && !variantId) return false;
  const pos = opts.pos || placeRing(state);
  if (!pos) return false;
  const slot = opts.slot || acquireEnemy(state);
  if (!slot) return false;
  const stats = baseStats(kind, variantId);
  if (opts.elite) applyElite(stats);
  if (opts.xpZero) stats.xp = 0;
  lightEnemy(slot, state, pos, kind, stats, opts.elite === true, opts.trap === true);
  return true;
}

function spawnSummons(state) {
  while (state.boss.summon > 0) {
    const pos = placeRing(state);
    if (!pos) return;
    const slot = acquireEnemy(state);
    if (!slot) {
      state.boss.summon = 0;
      return;
    }
    const stats = baseStats('slime', 'green');
    lightEnemy(slot, state, pos, 'slime', stats, false, false);
    state.boss.summon -= 1;
  }
}

function spawnTrapHounds(state) {
  const count = state.spawn.trapHounds;
  if (!(count > 0)) return;
  for (let i = 0; i < count; i++) {
    const pos = placeNear(state, state.spawn.trapX, state.spawn.trapZ, TRAP_SPREAD);
    if (!lightFrom(state, 'hound', { pos, xpZero: true, trap: true })) break;
  }
  state.spawn.trapHounds = 0;
}

function accrueRandom(state, step, elapsed, wave) {
  const spawn = state.spawn;
  const perSec = Math.min(
    CONFIG.spawn.capPerSec,
    CONFIG.spawn.basePerSec + CONFIG.spawn.perMinute * Math.floor(elapsed / 60),
  ) * wave.rateScale;
  spawn.credit += perSec * step;
  if (spawn.credit > CREDIT_CAP) spawn.credit = CREDIT_CAP;
  let guard = 0;
  while (spawn.credit >= 1 && guard < CREDIT_CAP) {
    guard += 1;
    spawn.credit -= 1;
    const kind = pickFamily(state, wave.weights);
    if (!kind || !lightFrom(state, kind, {})) {
      spawn.credit += 1;
      return;
    }
  }
}

function spawnElite(state, elapsed, wave) {
  const spawn = state.spawn;
  if (spawn.bossSpawned || wave.elite !== true || elapsed < spawn.eliteNext) return;
  const kind = pickEliteKind(state, wave.weights);
  if (!kind) return;
  const opts = { elite: true };
  if (kind === 'slime') {
    opts.variantId = pickVariant(state);
    if (!opts.variantId) return;
  }
  if (lightFrom(state, kind, opts)) spawn.eliteNext += CONFIG.elite.every;
}

function spawnScripted(state, elapsed) {
  const spawn = state.spawn;
  const hounds = CONFIG.scripted.hounds;
  if (hounds[0] && !spawn.hound30 && elapsed >= hounds[0].t) {
    if (lightFrom(state, 'hound', {})) spawn.hound30 = true;
  }
  if (hounds[1] && !spawn.hound60 && elapsed >= hounds[1].t) {
    if (lightFrom(state, 'hound', {})) spawn.hound60 = true;
  }
  if (elapsed >= spawn.ogreNext) {
    if (lightFrom(state, 'ogre', {})) spawn.ogreNext += CONFIG.scripted.ogre.every;
  }
  if (!spawn.bossSpawned && elapsed >= bossAt()) {
    if (lightFrom(state, 'hese', { slot: state.enemies[0] })) spawn.bossSpawned = true;
  }
}

function chestAliveCount(state) {
  let n = 0;
  const chests = state.chests;
  for (let i = 0; i < chests.length; i++) if (chests[i].alive === true) n += 1;
  return n;
}

function firstDeadChest(state) {
  const chests = state.chests;
  for (let i = 0; i < chests.length; i++) {
    if (chests[i].alive === false) return chests[i];
  }
  return null;
}

function oldestUnopened(state) {
  let best = null;
  const chests = state.chests;
  for (let i = 0; i < chests.length; i++) {
    const chest = chests[i];
    if (chest.alive !== true || chest.opening === true) continue;
    if (!best || chest.age > best.age || (chest.age === best.age && chest.id < best.id)) best = chest;
  }
  return best;
}

function ageChests(state, step) {
  const life = CONFIG.chests.life;
  const chests = state.chests;
  for (let i = 0; i < chests.length; i++) {
    const chest = chests[i];
    if (chest.alive !== true) continue;
    chest.age += step;
    if (chest.age > life && chest.opening !== true) chest.alive = false;
  }
}

function rollChestType(state, first) {
  if (first) {
    state.spawn.trapLast = false;
    return CONFIG.chests.firstType;
  }
  const xp = CONFIG.chests.types.xp.weight;
  const health = CONFIG.chests.types.health.weight;
  const rare = CONFIG.chests.types.rare.weight;
  const total = xp + health + rare;
  let r = nextUnit(state) * total;
  let type = 'rare';
  if (r < xp) type = 'xp';
  else if (r < xp + health) type = 'health';
  if (type !== 'rare' && state.spawn.trapLast !== true && nextUnit(state) < CONFIG.chests.trapChance) {
    type = 'trap';
  }
  state.spawn.trapLast = type === 'trap';
  return type;
}

function writeChest(state, slot, type) {
  const pos = placeChest(state);
  slot.type = type;
  slot.x = pos.x;
  slot.z = pos.z;
  slot.age = 0;
  slot.opening = false;
  slot.settled = false;
  slot.rewardXP = 0;
  slot.rewardLevel = 0;
  slot.alive = true;
}

function spawnScheduledChest(state, elapsed) {
  const spawn = state.spawn;
  if (elapsed < spawn.chestNext) return;
  if (chestAliveCount(state) < CONFIG.chests.max) {
    const slot = firstDeadChest(state);
    if (slot) {
      const first = spawn.chestNext === CONFIG.chests.firstAt;
      writeChest(state, slot, rollChestType(state, first));
    }
  }
  spawn.chestNext += CONFIG.chests.every;
}

function spawnPrepChest(state, elapsed) {
  const spawn = state.spawn;
  if (spawn.prepChest) return;
  const spec = prepSpec();
  if (!spec || elapsed < spec.start) return;
  let slot = firstDeadChest(state);
  if (!slot) {
    slot = oldestUnopened(state);
    if (!slot) return;
    slot.alive = false;
  }
  writeChest(state, slot, spec.forceChest);
  spawn.trapLast = false;
  spawn.prepChest = true;
}

export function updateSpawning(state, dt) {
  if (state.time.paused) return;
  if (state.result.hold > 0) return;
  if (state.result.ready) return;
  if (state.player.alive === false) return;

  const step = state.time.delta * state.time.scale;
  const elapsed = state.time.elapsed;
  const wave = waveFor(elapsed);
  void dt;

  spawnSummons(state);
  spawnTrapHounds(state);
  ageChests(state, step);
  accrueRandom(state, step, elapsed, wave);
  spawnElite(state, elapsed, wave);
  spawnScripted(state, elapsed);
  spawnScheduledChest(state, elapsed);
  spawnPrepChest(state, elapsed);
}
