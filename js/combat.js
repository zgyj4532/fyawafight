// 区块 6 · updateCombat
// 10Hz 环面索敌、子弹池、伤害公式、百分比经验箱结算、宝石池。

import { CONFIG } from './config.js';
import { nextUnit } from './state.js';
import { resolve } from './collision.js';
import { pushOutOfLake } from './lake.js';

const HURT_COOLDOWN = 0.55;
const GEM_MAGNET = 2.2;
const GEM_SPEED = 14;
const GEM_PICK_PAD = 0.2;
const WIN_HOLD = 3;

const UPGRADE_TEXT = {
  atk: '攻击力 +15%',
  aspd: '攻击速度 +12%',
  spd: '移动速度 +8%',
  hp: '最大生命 +20',
  def: '防御 +5',
  dodge: '闪避 +5%',
  crit: '暴击率 +5%',
  pierce: '穿透 +1',
};

function torusDelta(x1, z1, x2, z2, size) {
  let dx = x2 - x1;
  let dz = z2 - z1;
  const half = size * 0.5;
  if (dx > half) dx -= size;
  if (dx < -half) dx += size;
  if (dz > half) dz -= size;
  if (dz < -half) dz += size;
  return { dx, dz, dist: Math.hypot(dx, dz) };
}

export function levelCost(level) {
  return CONFIG.formulas.xpBase + CONFIG.formulas.xpPerLevel * (level - 1);
}

function mitigate(amount, def, k) {
  return amount * (1 - def / (def + k));
}

function wrapCoord(value, half, size) {
  if (value > half) return value - size;
  if (value < -half) return value + size;
  return value;
}

function noteKill(player) {
  player.kills += 1;
  player.combo += 1;
  if (player.combo > player.bestCombo) player.bestCombo = player.combo;
}

function failRun(state) {
  const player = state.player;
  player.hp = 0;
  player.alive = false;
  state.result.ready = true;
  state.result.win = false;
  state.result.hold = 0;
  state.phase = 'result';
}

function killEnemy(state, enemy) {
  enemy.alive = false;
  enemy.hp = 0;
  if (enemy.id === 0) {
    enemy.anim = 'death';
    noteKill(state.player);
    state.result.win = true;
    state.result.hold = WIN_HOLD;
    state.time.scale = 0;
    return;
  }
  if (enemy.trap) return;
  noteKill(state.player);
  spawnGem(state, enemy.x, enemy.z, enemy.xp);
}

function spawnGem(state, x, z, value) {
  const gems = state.gems;
  for (let i = 0; i < gems.count; i += 1) {
    if (gems.alive[i] !== 0) continue;
    gems.alive[i] = 1;
    gems.x[i] = x;
    gems.z[i] = z;
    gems.vx[i] = 0;
    gems.vz[i] = 0;
    gems.age[i] = 0;
    gems.value[i] = value;
    return;
  }
}

function acquireTarget(state) {
  const enemies = state.enemies;
  const player = state.player;
  const size = CONFIG.arena.size;
  const seekR = CONFIG.weapon.seekRadius;
  let best = -1;
  let bestDist = 0;
  let bestHp = 0;
  for (let i = 0; i < enemies.length; i += 1) {
    const enemy = enemies[i];
    if (!enemy.alive) continue;
    const rel = torusDelta(player.x, player.z, enemy.x, enemy.z, size);
    if (rel.dist > seekR) continue;
    if (best === -1 || rel.dist < bestDist || (rel.dist === bestDist && enemy.hp < bestHp)) {
      best = i;
      bestDist = rel.dist;
      bestHp = enemy.hp;
    }
  }
  const boss = enemies[0];
  if (boss && boss.alive) {
    const rel = torusDelta(player.x, player.z, boss.x, boss.z, size);
    if (rel.dist <= CONFIG.weapon.bossLockRadius) best = 0;
  }
  state.weapon.target = best;
}

function tryFire(state) {
  const player = state.player;
  if (state.input.slow) return;
  if (player.fireCd > 0) return;
  const targetId = state.weapon.target;
  const enemies = state.enemies;
  const target = targetId >= 0 ? enemies[targetId] : null;
  if (!target || !target.alive) {
    player.fireCd = 0;
    return;
  }
  const interval = 1 / player.aspd;
  const bullets = state.bullets;
  let slot = -1;
  for (let i = 0; i < bullets.count; i += 1) {
    if (bullets.alive[i] === 0) {
      slot = i;
      break;
    }
  }
  player.fireCd += interval;
  if (slot < 0) return;

  const speed = CONFIG.weapon.speed;
  const rel = torusDelta(player.x, player.z, target.x, target.z, CONFIG.arena.size);
  let vx = Math.sin(player.facing) * speed;
  let vz = Math.cos(player.facing) * speed;
  if (rel.dist > 1e-6) {
    vx = (rel.dx / rel.dist) * speed;
    vz = (rel.dz / rel.dist) * speed;
  }
  bullets.alive[slot] = 1;
  bullets.x[slot] = player.x;
  bullets.z[slot] = player.z;
  bullets.vx[slot] = vx;
  bullets.vz[slot] = vz;
  bullets.age[slot] = 0;
  bullets.pierce[slot] = player.pierce;
  bullets.charge[slot] = 0;
  const maxAlive = CONFIG.spawn.maxAlive;
  bullets.hit.fill(0, slot * maxAlive, slot * maxAlive + maxAlive);
  state.fx.queue.push('shoot');
}

function fireCharged(state) {
  const player = state.player;
  const bullets = state.bullets;
  let slot = -1;
  for (let i = 0; i < bullets.count; i += 1) {
    if (bullets.alive[i] === 0) {
      slot = i;
      break;
    }
  }
  if (slot < 0) return false;

  const speed = CONFIG.weapon.speed;
  const targetId = state.weapon.target;
  const target = targetId >= 0 ? state.enemies[targetId] : null;
  const rel = target && target.alive
    ? torusDelta(player.x, player.z, target.x, target.z, CONFIG.arena.size)
    : null;
  let vx = Math.sin(player.facing) * speed;
  let vz = Math.cos(player.facing) * speed;
  if (rel && rel.dist > 1e-6) {
    vx = (rel.dx / rel.dist) * speed;
    vz = (rel.dz / rel.dist) * speed;
  }
  bullets.alive[slot] = 1;
  bullets.x[slot] = player.x;
  bullets.z[slot] = player.z;
  bullets.vx[slot] = vx;
  bullets.vz[slot] = vz;
  bullets.age[slot] = 0;
  bullets.pierce[slot] = player.pierce;
  bullets.charge[slot] = 1;
  const maxAlive = CONFIG.spawn.maxAlive;
  bullets.hit.fill(0, slot * maxAlive, slot * maxAlive + maxAlive);
  state.fx.queue.push('shoot');
  return true;
}

function updateCharge(state) {
  const player = state.player;
  const hold = CONFIG.weapon.chargeHold;
  if (state.input.slow) {
    player.chargeT = Math.min(hold, player.chargeT + state.time.delta);
    return false;
  }
  if (player.chargeT >= hold) {
    if (!fireCharged(state)) return false;
    player.chargeT = 0;
    return true;
  }
  player.chargeT = 0;
  return false;
}

function hitEnemy(state, bulletIndex, enemy) {
  const bullets = state.bullets;
  const weapon = CONFIG.weapon;
  const player = state.player;
  const maxAlive = CONFIG.spawn.maxAlive;
  bullets.hit[bulletIndex * maxAlive + enemy.id] = 1;

  const def = enemy.id === 0 ? CONFIG.boss.def : 0;
  let amount = CONFIG.weapon.chargeDamage;
  if (!bullets.charge[bulletIndex]) {
    const crit = nextUnit(state) < player.crit ? player.critDmg : 1;
    amount = player.atk * weapon.coefficient * crit;
  }
  enemy.hp -= mitigate(amount, def, CONFIG.formulas.outgoingDefK);

  // 腾空下一帧会盖掉这次推动。落地这一拍 latch 还在，击退会把模型推离锁点。
  const pinned = (enemy.kind === 'ogre' && enemy.state === 'arc') || enemy.impactLatched === 1;
  if (!pinned) {
    const vx = bullets.vx[bulletIndex];
    const vz = bullets.vz[bulletIndex];
    const speed = Math.hypot(vx, vz);
    if (speed > 1e-8) {
      enemy.x += (vx / speed) * weapon.knockback;
      enemy.z += (vz / speed) * weapon.knockback;
    }
    const table = state.assets && state.assets.bodyRadius;
    const visual = table && table[enemy.kind];
    const body = Math.max(enemy.radius || 0, visual ? visual * (enemy.scale || 1) : 0);
    const solved = resolve(enemy.x, enemy.z, body);
    enemy.x = solved.x;
    enemy.z = solved.z;
  }

  enemy.hitFlash = weapon.hitFlash;
  if (enemy.id === 0) {
    enemy.hits += 1;
    if (enemy.hits % CONFIG.boss.armorFlashEveryHits === 0) {
      enemy.hitFlash = CONFIG.boss.armorFlash;
    }
  }
  if (enemy.hp <= 0) killEnemy(state, enemy);

  if (bullets.pierce[bulletIndex] > 0) bullets.pierce[bulletIndex] -= 1;
  else bullets.alive[bulletIndex] = 0;
}

function updateBullets(state, step) {
  const bullets = state.bullets;
  const enemies = state.enemies;
  const weapon = CONFIG.weapon;
  const half = CONFIG.arena.half;
  for (let i = 0; i < bullets.count; i += 1) {
    if (bullets.alive[i] === 0) continue;
    bullets.x[i] += bullets.vx[i] * step;
    bullets.z[i] += bullets.vz[i] * step;
    bullets.age[i] += step;
    const x = bullets.x[i];
    const z = bullets.z[i];
    const outside = x < -half || x > half || z < -half || z > half;
    if (!outside) {
      for (let e = 0; e < enemies.length; e += 1) {
        if (bullets.alive[i] === 0) break;
        const enemy = enemies[e];
        if (!enemy.alive) continue;
        if (bullets.hit[i * CONFIG.spawn.maxAlive + enemy.id] !== 0) continue;
        const reach = weapon.hitRadius + enemy.radius;
        if (Math.hypot(x - enemy.x, z - enemy.z) > reach) continue;
        hitEnemy(state, i, enemy);
      }
    }
    if (outside || bullets.age[i] >= weapon.life) bullets.alive[i] = 0;
  }
}

function nearestContact(state) {
  const player = state.player;
  const enemies = state.enemies;
  let best = -1;
  let bestDist = 0;
  for (let i = 0; i < enemies.length; i += 1) {
    const enemy = enemies[i];
    if (!enemy.alive || enemy.state === 'dash' || enemy.state === 'arc' || enemy.impactLatched === 1) continue;
    const dist = Math.hypot(enemy.x - player.x, enemy.z - player.z);
    if (dist > playerRadius() + enemy.radius) continue;
    if (best === -1 || dist < bestDist) {
      best = i;
      bestDist = dist;
    }
  }
  return best;
}

function playerRadius() {
  return CONFIG.player.radius;
}

function applyContact(state, step) {
  const player = state.player;
  if (player.hurtCd > 0) player.hurtCd = Math.max(0, player.hurtCd - step);
  if (player.hurtCd > 0 || player.invuln > 0) return;
  const index = nearestContact(state);
  if (index < 0) return;
  if (nextUnit(state) < player.dodge) return;
  const enemy = state.enemies[index];
  player.hp -= mitigate(enemy.contact, player.def, CONFIG.player.incomingDefK);
  player.hurtCd = HURT_COOLDOWN;
  player.combo = 0;
  state.fx.queue.push('hurt');
  state.fx.rumble = 'hurt';
  if (player.hp <= 0) failRun(state);
}

function applyBossDash(state) {
  const player = state.player;
  if (!player.alive || player.invuln > 0) return;
  const boss = state.enemies[0];
  if (!boss || !boss.alive || boss.state !== 'dash' || boss.dashHit) return;
  const dist = Math.hypot(boss.x - player.x, boss.z - player.z);
  if (dist > playerRadius() + boss.radius) return;

  player.hp -= mitigate(CONFIG.boss.chargeDamage, player.def, CONFIG.player.incomingDefK);
  const len = Math.hypot(boss.dashDirX, boss.dashDirZ);
  if (len > 1e-8) {
    player.x += (boss.dashDirX / len) * CONFIG.boss.chargeKnockback;
    player.z += (boss.dashDirZ / len) * CONFIG.boss.chargeKnockback;
  }
  const solved = resolve(player.x, player.z, playerRadius());
  const px = solved.x;
  const pz = solved.z;
  player.x = px;
  player.z = pz;
  const shore = pushOutOfLake(px, pz);
  if (shore) {
    player.x = shore.x;
    player.z = shore.z;
  }
  boss.dashHit = true;
  player.hurtCd = HURT_COOLDOWN;
  state.fx.queue.push('bossHit');
  state.fx.rumble = 'boss';
  if (player.hp <= 0) failRun(state);
}

function applyOgreSlam(state) {
  const player = state.player;
  const leap = CONFIG.enemies.ogre.leap;
  const blocked = !player.alive || player.invuln > 0;
  const enemies = state.enemies;
  for (let i = 0; i < enemies.length; i += 1) {
    const enemy = enemies[i];
    if (enemy.impactLatched !== 1) continue;
    enemy.impactLatched = 0;
    if (blocked) continue;
    if (Math.hypot(player.x - enemy.lockX, player.z - enemy.lockZ) > leap.radius) continue;
    player.hp -= mitigate(leap.damage, player.def, CONFIG.player.incomingDefK);
    player.hurtCd = HURT_COOLDOWN;
    state.fx.queue.push('hurt');
    state.fx.rumble = 'hurt';
  }
  if (player.hp <= 0) failRun(state);
}

function updateGems(state, step) {
  const gems = state.gems;
  const player = state.player;
  const size = CONFIG.arena.size;
  const half = CONFIG.arena.half;
  const reach = playerRadius() + GEM_PICK_PAD;
  for (let i = 0; i < gems.count; i += 1) {
    if (gems.alive[i] === 0) continue;
    let rel = torusDelta(gems.x[i], gems.z[i], player.x, player.z, size);
    if (rel.dist >= reach && rel.dist < GEM_MAGNET && rel.dist > 0) {
      const travel = Math.min(GEM_SPEED * step, rel.dist);
      const scale = travel / rel.dist;
      gems.x[i] = wrapCoord(gems.x[i] + rel.dx * scale, half, size);
      gems.z[i] = wrapCoord(gems.z[i] + rel.dz * scale, half, size);
      rel = torusDelta(gems.x[i], gems.z[i], player.x, player.z, size);
    }
    if (rel.dist >= reach) continue;
    gems.alive[i] = 0;
    player.xp += gems.value[i];
    openUpgradeIfReady(state);
  }
}

function choiceById(id) {
  const choices = CONFIG.upgrades.choices;
  for (let i = 0; i < choices.length; i += 1) {
    if (choices[i].id === id) return choices[i];
  }
  return null;
}

function applyChoice(player, choice) {
  const caps = CONFIG.player.caps;
  if (choice.healToFull) {
    player.hpMax += choice.add;
    if (player.hpMax > caps.hp) player.hpMax = caps.hp;
    player.hp = player.hpMax;
    return;
  }
  if (choice.mul) player[choice.stat] *= choice.mul;
  else if (choice.add) player[choice.stat] += choice.add;
  if (choice.stat === 'pierce') return;
  const cap = caps[choice.stat];
  if (cap !== undefined && player[choice.stat] > cap) player[choice.stat] = cap;
}

function rollOptions(state) {
  const choices = CONFIG.upgrades.choices;
  const repeat = CONFIG.upgrades.repeatWeight;
  const lastId = state.upgrade.lastId;
  const pool = [];
  for (let i = 0; i < choices.length; i += 1) pool.push(i);
  const picked = [];
  const count = Math.min(CONFIG.upgrades.pick, pool.length);
  for (let n = 0; n < count; n += 1) {
    let total = 0;
    for (let i = 0; i < pool.length; i += 1) {
      total += choices[pool[i]].id === lastId ? repeat : 1;
    }
    let roll = nextUnit(state) * total;
    let found = pool.length - 1;
    for (let i = 0; i < pool.length; i += 1) {
      roll -= choices[pool[i]].id === lastId ? repeat : 1;
      if (roll < 0) {
        found = i;
        break;
      }
    }
    const choice = choices[pool.splice(found, 1)[0]];
    picked.push({
      id: choice.id,
      stat: choice.stat,
      text: UPGRADE_TEXT[choice.id],
    });
  }
  return picked;
}

function openUpgradeIfReady(state) {
  if (state.result.win || state.result.ready || !state.player.alive) return;
  const upgrade = state.upgrade;
  if (upgrade.pending) return;
  const player = state.player;
  const cost = levelCost(player.level);
  if (player.xp < cost) return;
  player.xp -= cost;
  player.level += 1;
  upgrade.options = rollOptions(state);
  upgrade.pending = true;
  state.time.scale = CONFIG.upgrades.timeScale;
}

function grantRandomUpgrade(state) {
  const choices = CONFIG.upgrades.choices;
  const index = Math.min(choices.length - 1, Math.floor(nextUnit(state) * choices.length));
  applyChoice(state.player, choices[index]);
}

function openChest(state, chest) {
  const player = state.player;
  chest.opening = true;
  player.chestsOpened += 1;
  state.fx.queue.push('chest');
  state.fx.rumble = 'chest';

  if (chest.type === 'xp' || chest.type === 'rare') {
    chest.rewardXP = Math.floor(levelCost(player.level) * CONFIG.formulas.chestXpRatio);
    player.xp += chest.rewardXP;
  } else if (chest.type === 'health') {
    const spec = CONFIG.chests.types.health;
    if (player.hp >= player.hpMax) {
      player.speedBuff = spec.fullSpeedTime;
      player.speedBuffMul = spec.fullSpeedMul;
    } else {
      player.hp = Math.min(player.hpMax, player.hp + player.hpMax * spec.healRatio);
    }
  } else if (chest.type === 'trap') {
    chest.rewardLevel = state.time.elapsed;
    return;
  }

  if (chest.type === 'rare') grantRandomUpgrade(state);
  if (chest.type === 'xp' || chest.type === 'rare') openUpgradeIfReady(state);
  chest.settled = true;
  chest.alive = false;
}

function updateChests(state) {
  const player = state.player;
  const chests = state.chests;
  const openR = CONFIG.chests.openRadius;
  const warn = CONFIG.chests.types.trap.warnTime;
  for (let i = 0; i < chests.length; i += 1) {
    const chest = chests[i];
    if (!chest.alive) continue;
    if (chest.opening) {
      if (chest.type === 'trap' && state.time.elapsed - chest.rewardLevel >= warn) {
        state.spawn.trapHounds = CONFIG.chests.types.trap.hounds;
        state.spawn.trapX = chest.x;
        state.spawn.trapZ = chest.z;
        chest.alive = false;
      }
      continue;
    }
    if (Math.hypot(chest.x - player.x, chest.z - player.z) >= openR) continue;
    openChest(state, chest);
  }
}

function tickHitFlash(state, step) {
  const enemies = state.enemies;
  for (let i = 0; i < enemies.length; i += 1) {
    const enemy = enemies[i];
    if (enemy.hitFlash > 0) enemy.hitFlash = Math.max(0, enemy.hitFlash - step);
  }
}

function tickSpeedBuff(player, step) {
  if (player.speedBuff <= 0) return;
  player.speedBuff -= step;
  if (player.speedBuff > 0) return;
  player.speedBuff = 0;
  player.speedBuffMul = 1;
}

export function applyUpgrade(state, id) {
  const choice = choiceById(id);
  if (!choice) return;
  applyChoice(state.player, choice);
  const upgrade = state.upgrade;
  upgrade.lastId = id;
  upgrade.pending = false;
  upgrade.options = [];
  state.time.scale = 1;
  openUpgradeIfReady(state);
}

export function updateCombat(state, dt) {
  if (state.time.paused) return;
  if (state.result.ready || state.player.alive === false) return;
  if (state.result.hold > 0) {
    state.result.hold -= state.time.delta;
    if (state.result.hold <= 0) {
      state.result.hold = 0;
      state.phase = 'result';
    }
    return;
  }

  const step = state.time.delta * state.time.scale;
  const player = state.player;
  tickSpeedBuff(player, step);
  tickHitFlash(state, step);
  if (player.fireCd > 0) player.fireCd -= step;

  const weapon = state.weapon;
  weapon.seekT -= step;
  if (weapon.seekT <= 0) {
    weapon.seekT += 1 / CONFIG.weapon.seekHz;
    acquireTarget(state);
  }
  const firedCharge = updateCharge(state);
  if (!firedCharge) tryFire(state);
  updateBullets(state, step);
  if (!player.alive) return;
  applyContact(state, step);
  if (player.alive) applyBossDash(state);
  applyOgreSlam(state);
  if (!player.alive) return;
  updateGems(state, step);
  updateChests(state);
  if (state.result.win && state.result.hold > 0) state.time.scale = 0;
}
