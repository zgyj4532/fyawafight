// 区块 6 · updateAIAndBoss
// 史莱姆 / 猎狗 / 食人魔移动，赫塞五态，1.8s 地面填充预警。Boss 不穿门。
//
// 接土路提速：移动循环里算目标速度时乘 pathSpeedMul(e.x, e.z)（见 js/path.js）。
// 权重本身就是 0…1 的连续值，敌人不必另存缓动状态。
//
// 赫塞：idle → chase → warn → dash → recover → chase。
// stateT 每帧先加上 step，进入新状态时归零。半血（hp < hpMax * p2.hpBelow）读 p2。

import { CONFIG } from './config.js';
import { pathSpeedMul } from './path.js';
import { clipVelocity, resolve, substepCount } from './collision.js';
import { pushOutOfLake } from './lake.js';

const HOUND_SIDE = 2.4;
const HOUND_BACK = 1.2;
const MOVE_ANIM_SPEED = 0.2;
const DASH_BLOCK_PUSH = 0.2;

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

function wrapAngle(delta) {
  return Math.atan2(Math.sin(delta), Math.cos(delta));
}

function turnTowardVelocity(e, step) {
  const speed = Math.hypot(e.vx, e.vz);
  if (speed > MOVE_ANIM_SPEED) {
    const aim = Math.atan2(e.vx, e.vz);
    const k = 1 - Math.exp(-CONFIG.movement.turnDamp * step);
    e.facing += wrapAngle(aim - e.facing) * k;
  }
  return speed;
}

// resolve / clipVelocity 的返回是共用草稿，读完立刻抄进数字。
function takeResolve(x, z, radius) {
  const hit = resolve(x, z, radius);
  return {
    x: hit.x,
    z: hit.z,
    pushX: hit.pushX,
    pushZ: hit.pushZ,
  };
}

function takeClip(vx, vz, pushX, pushZ) {
  const clipped = clipVelocity(vx, vz, pushX, pushZ);
  return { x: clipped.x, z: clipped.z };
}

function placeOnShore(e) {
  const shore = pushOutOfLake(e.x, e.z);
  if (!shore) return;
  e.x = shore.x;
  e.z = shore.z;
}

// mode: wrap 小怪穿门；block 追击夹在场内；dash 越界或被实物推出超过 0.2m 就停。
// 湖的推开不记入这 0.2m：先记下 resolve 的 push，再推湖。
function moveBody(e, vx, vz, step, mode) {
  const half = CONFIG.arena.half;
  const slices = substepCount(Math.hypot(vx, vz) * step);
  const inv = 1 / slices;
  const sx = vx * step * inv;
  const sz = vz * step * inv;
  let pushX = 0;
  let pushZ = 0;
  let hitWall = false;

  for (let i = 0; i < slices; i += 1) {
    let nx = e.x + sx;
    let nz = e.z + sz;
    if (mode !== 'wrap' && (nx < -half || nx > half || nz < -half || nz > half)) {
      nx = Math.min(half, Math.max(-half, nx));
      nz = Math.min(half, Math.max(-half, nz));
      if (mode === 'dash') hitWall = true;
    }
    e.x = nx;
    e.z = nz;

    const hit = takeResolve(e.x, e.z, e.radius);
    pushX = hit.pushX;
    pushZ = hit.pushZ;
    e.x = hit.x;
    e.z = hit.z;
    const pushLen = Math.hypot(pushX, pushZ);
    placeOnShore(e);
    if (mode === 'dash' && pushLen > DASH_BLOCK_PUSH) hitWall = true;
    if (mode !== 'wrap' && (e.x < -half || e.x > half || e.z < -half || e.z > half)) {
      e.x = Math.min(half, Math.max(-half, e.x));
      e.z = Math.min(half, Math.max(-half, e.z));
    }
    if (hitWall) break;
  }

  if (mode === 'wrap') {
    if (e.portalCd > 0) {
      const keep = half - 0.05;
      e.x = Math.min(keep, Math.max(-keep, e.x));
      e.z = Math.min(keep, Math.max(-keep, e.z));
    } else {
      const portal = CONFIG.movement.portal;
      let wrapped = false;
      if (e.x < -half) {
        e.x = half - portal.inset;
        wrapped = true;
      } else if (e.x > half) {
        e.x = -half + portal.inset;
        wrapped = true;
      }
      if (e.z < -half) {
        e.z = half - portal.inset;
        wrapped = true;
      } else if (e.z > half) {
        e.z = -half + portal.inset;
        wrapped = true;
      }
      if (wrapped) {
        e.portalCd = portal.cooldown;
        e.portalSlow = portal.enemySlowTime;
        const hit = takeResolve(e.x, e.z, e.radius);
        pushX = hit.pushX;
        pushZ = hit.pushZ;
        e.x = hit.x;
        e.z = hit.z;
        placeOnShore(e);
      }
    }
  }

  const clipped = takeClip(vx, vz, pushX, pushZ);
  e.vx = clipped.x;
  e.vz = clipped.z;
  return hitWall;
}

function separateOgres(state, e, vx, vz, speed) {
  const sep = CONFIG.enemies.ogre.separation;
  let ax = vx;
  let az = vz;
  const list = state.enemies;
  for (let i = 0; i < list.length; i += 1) {
    const other = list[i];
    if (other === e || !other.alive || other.kind !== 'ogre') continue;
    let dx = e.x - other.x;
    let dz = e.z - other.z;
    const dist = Math.hypot(dx, dz);
    if (!(dist < sep)) continue;
    if (dist < 1e-4) {
      dx = e.id >= other.id ? 1 : -1;
      dz = 0;
    } else {
      dx /= dist;
      dz /= dist;
    }
    const weight = (sep - dist) / sep;
    ax += dx * speed * weight;
    az += dz * speed * weight;
  }
  const mag = Math.hypot(ax, az);
  if (speed > 1e-6 && mag > speed) {
    ax = (ax / mag) * speed;
    az = (az / mag) * speed;
  }
  return { x: ax, z: az };
}

function updateMinion(state, e, step) {
  const family = CONFIG.enemies[e.kind];
  if (!family) return;

  const player = state.player;
  const size = CONFIG.arena.size;
  const toPlayer = torusDelta(e.x, e.z, player.x, player.z, size);
  let speed = e.speed * pathSpeedMul(e.x, e.z);
  if (e.kind === 'hound' && toPlayer.dist < family.sprintRange) speed *= family.sprintMul;
  if (e.portalSlow > 0) speed *= CONFIG.movement.portal.enemySlow;
  e.portalSlow = Math.max(0, e.portalSlow - step);
  e.portalCd = Math.max(0, e.portalCd - step);

  let vx = 0;
  let vz = 0;
  if (e.kind === 'slime') {
    const every = family.hopEvery;
    e.hopT += step;
    if (every > 0 && e.hopT >= every) e.hopT %= every;
    if (toPlayer.dist > 1e-6) {
      vx = (toPlayer.dx / toPlayer.dist) * speed;
      vz = (toPlayer.dz / toPlayer.dist) * speed;
    }
  } else if (e.kind === 'hound' && toPlayer.dist > 1e-6) {
    const ux = toPlayer.dx / toPlayer.dist;
    const uz = toPlayer.dz / toPlayer.dist;
    const side = (e.id & 1) === 0 ? 1 : -1;
    const px = uz * side;
    const pz = -ux * side;
    const tx = player.x + px * HOUND_SIDE - ux * HOUND_BACK;
    const tz = player.z + pz * HOUND_SIDE - uz * HOUND_BACK;
    const aim = torusDelta(e.x, e.z, tx, tz, size);
    if (aim.dist > 1e-6) {
      vx = (aim.dx / aim.dist) * speed;
      vz = (aim.dz / aim.dist) * speed;
    }
  } else if (e.kind === 'ogre' && toPlayer.dist > 1e-6) {
    const sway = Math.sin(state.time.elapsed * 2.1) * family.swayDeg * (Math.PI / 180);
    const angle = Math.atan2(toPlayer.dx, toPlayer.dz) + sway;
    vx = Math.sin(angle) * speed;
    vz = Math.cos(angle) * speed;
    const pushed = separateOgres(state, e, vx, vz, speed);
    vx = pushed.x;
    vz = pushed.z;
  }

  moveBody(e, vx, vz, step, family.wraps ? 'wrap' : 'block');
  const rate = turnTowardVelocity(e, step);
  e.anim = rate > MOVE_ANIM_SPEED ? 'walk' : 'idle';
  if (e.hitFlash > 0) e.anim = 'hit';
}

function halfHp(boss) {
  const line = CONFIG.boss.p2.hpBelow;
  return boss.hpMax > 0 && boss.hp < boss.hpMax * line;
}

function bossPhase(boss) {
  return halfHp(boss) ? CONFIG.boss.p2 : CONFIG.boss.p1;
}

function beginWarn(state, boss) {
  boss.state = 'warn';
  boss.stateT = 0;
  boss.vx = 0;
  boss.vz = 0;
  boss.anim = 'attack';
  state.fx.queue.push('charge');
  if (halfHp(boss)) state.boss.summon += CONFIG.boss.p2.summon.count;
}

function beginDash(boss) {
  boss.state = 'dash';
  boss.stateT = 0;
  boss.telegraph = 0.2;
  boss.dashHit = false;
  boss.anim = 'attack';
}

function beginRecover(boss, hitWall) {
  const extra = hitWall ? CONFIG.movement.portal.bossWallStun : 0;
  boss.state = 'recover';
  boss.stateT = 0;
  boss.recoverNeed = CONFIG.boss.recover + extra;
  boss.vx = 0;
  boss.vz = 0;
  boss.anim = 'idle';
  boss.telegraph = 0;
}

function updateHese(state, boss, step) {
  const player = state.player;
  const cfg = CONFIG.boss;
  boss.stateT += step;
  const phase = bossPhase(boss);

  if (boss.state === 'idle') {
    if (boss.stateT >= cfg.idle) {
      boss.state = 'chase';
      boss.stateT = 0;
    }
  } else if (boss.state === 'chase') {
    if (boss.stateT >= phase.cooldown) beginWarn(state, boss);
  } else if (boss.state === 'warn') {
    if (boss.stateT >= phase.warn) beginDash(boss);
  } else if (boss.state === 'dash') {
    if (boss.stateT >= cfg.p1.dashTime) beginRecover(boss, false);
  } else if (boss.state === 'recover') {
    const need = boss.recoverNeed > 0 ? boss.recoverNeed : cfg.recover;
    if (boss.stateT >= need) {
      boss.state = 'chase';
      boss.stateT = 0;
    }
  } else {
    boss.state = 'idle';
    boss.stateT = 0;
  }

  let hitWall = false;
  if (boss.state === 'idle' || boss.state === 'recover') {
    boss.vx = 0;
    boss.vz = 0;
    boss.anim = 'idle';
  } else if (boss.state === 'chase') {
    boss.anim = 'walk';
    const speed = cfg.speed * pathSpeedMul(boss.x, boss.z);
    const dx = player.x - boss.x;
    const dz = player.z - boss.z;
    const dist = Math.hypot(dx, dz);
    let vx = 0;
    let vz = 0;
    if (dist > 1e-6) {
      vx = (dx / dist) * speed;
      vz = (dz / dist) * speed;
    }
    moveBody(boss, vx, vz, step, 'block');
  } else if (boss.state === 'warn') {
    boss.vx = 0;
    boss.vz = 0;
    boss.anim = 'attack';
    boss.telegraph = Math.max(0, phase.warn - boss.stateT);
    if (boss.stateT < cfg.p1.lockAt) {
      const dx = player.x - boss.x;
      const dz = player.z - boss.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 1e-6) {
        boss.dashDirX = dx / dist;
        boss.dashDirZ = dz / dist;
      }
    }
  } else if (boss.state === 'dash') {
    boss.anim = 'attack';
    if (boss.stateT > 0) boss.telegraph = Math.max(0, boss.telegraph - step);
    const len = Math.hypot(boss.dashDirX, boss.dashDirZ);
    let vx = 0;
    let vz = 0;
    if (len > 1e-6) {
      vx = (boss.dashDirX / len) * phase.dashSpeed;
      vz = (boss.dashDirZ / len) * phase.dashSpeed;
    }
    hitWall = moveBody(boss, vx, vz, step, 'dash');
  }

  turnTowardVelocity(boss, step);
  if (hitWall) beginRecover(boss, true);
  if (boss.hitFlash > 0 && boss.state !== 'dash') boss.anim = 'hit';
}

export function updateAIAndBoss(state, dt) {
  void dt;
  if (state.time.paused) return;
  if (state.result.hold > 0) return;
  if (state.result.ready) return;
  if (state.player.alive === false) return;
  const step = state.time.delta * state.time.scale;
  if (!(step > 0)) return;

  const list = state.enemies;
  for (let i = 0; i < list.length; i += 1) {
    const e = list[i];
    if (!e.alive || e.kind === 'hese') continue;
    updateMinion(state, e, step);
  }

  const boss = list[0];
  if (boss && boss.alive && boss.kind === 'hese') updateHese(state, boss, step);
}
