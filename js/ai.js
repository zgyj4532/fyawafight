// 区块 6 · updateAIAndBoss
// 史莱姆 / 猎狗 / 食人魔移动，赫塞五态，1.8s 地面填充预警。Boss 不穿门。
//
// 接土路提速：移动循环里算目标速度时乘 pathSpeedMul(e.x, e.z)（见 js/path.js）。
// 权重本身就是 0…1 的连续值，敌人不必另存缓动状态。
//
// 赫塞：idle → chase → warn → dash → recover → chase。
// 食人魔：chase → windup → arc → recover → chase。没绑到骨骼槽就留在 chase。
// stateT 每帧先加上 step，进入新状态时归零。半血（hp < hpMax * p2.hpBelow）读 p2。

import { CONFIG } from './config.js';
import { leapSample } from './leap.js';
import { pathSpeedMul } from './path.js';
import { clearanceAt, clipVelocity, resolve, substepCount } from './collision.js';
import { pushOutOfLake } from './lake.js';

const HOUND_SIDE = 2.4;
const HOUND_BACK = 1.2;
const MOVE_ANIM_SPEED = 0.2;
const DASH_BLOCK_PUSH = 0.2;

// --- 贴着障碍滑（2026-11-17 夜）--------------------------------------------
//
// 玩家截图里史莱姆顶在一捆干草上不动。量出来的原因不是"被挡住"，是**正对撞**：
// 史莱姆的期望方向就是「朝玩家」，当障碍正好在两者连线上时，碰撞法线和期望速度
// 完全反向，`clipVelocity` 把整条速度削成 0 —— 切向分量本来就是 0，没有东西可滑。
// 下一帧方向还是对准玩家，于是永远停在那里。这不是概率极低的情况：
// 一批怪从同一侧压上来、或者玩家站着不动，很容易落进这条对称轴。
//
// 处理：上一次移动吃到推力，就把法线记在自己身上；下一帧把期望方向**投影到切向**，
// 顺着障碍表面滑过去。两条切向里取和"想去"同号的那条；正对撞时两者点积都是 0，
// 按 id 奇偶分左右 —— 不然一群怪会全部往同一边挤。
//
// 只记 0.35 s：滑开之后就恢复直线追击，不会绕着障碍转圈。
const CONTACT_MEMORY = 0.35;
const CONTACT_SLIDE = 0.85;

// **夹角死锁与绕行。** 两个物件挨得比怪的身体还窄时（实测一处石堆 + 桶只隔 1.03 m，
// 史莱姆体宽 1.4 m），它挤进 V 字里，两条法线每帧交替推、合起来正好抵消，
// 速度归零 —— 切向滑动救不了，因为没有哪一侧是"能滑过去"的。
// 只往后退也不行：退出去再直线追回来，还是同一条线、同一个 V（实测 1.6 s 一个循环）。
//
// 所以夹住之后**换一条路**：以「朝玩家」为基准取左右各 72°/110° 四个候选点，
// 3 m 外，用 clearanceAt 挑最空的那个当临时目标，走过去再恢复追击。
// 它没有寻路，这一步就是它能做到的全部"绕"。
const WEDGE_TIME = 0.45;
const WEDGE_PROGRESS = 0.3;
const DETOUR_TIME = 1.8;
const DETOUR_DIST = 3.0;

function planDetour(state, e, radius) {
  const size = CONFIG.arena.size;
  const aim = torusDelta(e.x, e.z, state.player.x, state.player.z, size);
  const base = Math.atan2(aim.dx, aim.dz);
  let bestScore = -Infinity;
  let bx = e.x;
  let bz = e.z;
  for (let i = 0; i < 4; i += 1) {
    // 两侧各两个角度。正后方（180°）不取：那是"逃跑"，绕不出去。
    const spread = i < 2 ? 1.26 : 1.92;
    const sign = i % 2 === 0 ? 1 : -1;
    const a = base + sign * spread;
    const tx = e.x + Math.sin(a) * DETOUR_DIST;
    const tz = e.z + Math.cos(a) * DETOUR_DIST;
    // 目标点和中点都要空：只算目标点会挑到"隔着另一堆货"的位置
    const score = clearanceAt(tx, tz) - radius
      + (clearanceAt((e.x + tx) * 0.5, (e.z + tz) * 0.5) - radius) * 0.6;
    if (score > bestScore) {
      bestScore = score;
      bx = tx;
      bz = tz;
    }
  }
  return { x: bx, z: bz };
}

function slideAlongContact(e, vx, vz, speed) {
  if (!(e.blockT > 0) || !(speed > 1e-6)) return { x: vx, z: vz };
  const nx = e.nX;
  const nz = e.nZ;
  if (!(Math.abs(nx) + Math.abs(nz) > 1e-6)) return { x: vx, z: vz };
  // 已经在往外走了（推力和期望同向）就不干预，避免在贴面处来回抖
  if (vx * nx + vz * nz > 0.2 * speed) return { x: vx, z: vz };

  const dot = vx * -nz + vz * nx;
  let tx = -nz;
  let tz = nx;
  const nearlyHeadOn = Math.abs(dot) < 0.05 * speed;
  if (dot < 0 || nearlyHeadOn) {
    // 反向，或者正对着撞（切向分量为 0）：改用另一条切向 / 按 id 分左右
    if (!nearlyHeadOn || (e.id & 1) === 0) {
      tx = nz;
      tz = -nx;
    }
  }

  const mx = vx * (1 - CONTACT_SLIDE) + tx * speed * CONTACT_SLIDE;
  const mz = vz * (1 - CONTACT_SLIDE) + tz * speed * CONTACT_SLIDE;
  const m = Math.hypot(mx, mz);
  if (m < 1e-6) return { x: vx, z: vz };
  return { x: (mx / m) * speed, z: (mz / m) * speed };
}

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
function solidRadius(state, e) {
  const table = state.assets && state.assets.bodyRadius;
  const visual = table && table[e.kind];
  const body = visual ? visual * (e.scale || 1) : 0;
  return Math.max(e.radius || 0, body);
}

function separateBodies(state) {
  const list = state.enemies;
  const half = CONFIG.arena.half;
  // 弧线上的点和落地这一拍都是刚写好的终点。latch 要等本帧战斗清掉，这一拍推开会让模型和红圆分开。
  for (let pass = 0; pass < 4; pass += 1) {
    let hit = false;
    for (let i = 0; i < list.length; i += 1) {
      const a = list[i];
      if (!a.alive || a.state === 'arc' || a.impactLatched === 1) continue;
      const ra = solidRadius(state, a);
      for (let j = i + 1; j < list.length; j += 1) {
        const b = list[j];
        if (!b.alive || b.state === 'arc' || b.impactLatched === 1) continue;
        let dx = b.x - a.x;
        let dz = b.z - a.z;
        const dist = Math.hypot(dx, dz);
        const need = ra + solidRadius(state, b);
        if (dist >= need) continue;
        let nx = 1;
        let nz = 0;
        if (dist >= 1e-4) {
          nx = dx / dist;
          nz = dz / dist;
        } else if ((a.id & 1) === 0) nx = -1;
        const push = (need - dist) * 0.5;
        a.x -= nx * push;
        a.z -= nz * push;
        b.x += nx * push;
        b.z += nz * push;
        hit = true;
      }
    }
    if (!hit) break;
  }
  for (let i = 0; i < list.length; i += 1) {
    const e = list[i];
    if (!e.alive || e.state === 'arc' || e.impactLatched === 1) continue;
    const solved = takeResolve(e.x, e.z, solidRadius(state, e));
    e.x = solved.x;
    e.z = solved.z;
    placeOnShore(e);
    if (e.x < -half || e.x > half || e.z < -half || e.z > half) {
      e.x = Math.min(half, Math.max(-half, e.x));
      e.z = Math.min(half, Math.max(-half, e.z));
    }
  }
}

function moveBody(state, e, vx, vz, step, mode) {
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

    const hit = takeResolve(e.x, e.z, solidRadius(state, e));
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
        const hit = takeResolve(e.x, e.z, solidRadius(state, e));
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

  // 记下正在顶着的那个面，下一帧顺着它滑（见 slideAlongContact）。
  const pushLen = Math.hypot(pushX, pushZ);
  if (pushLen > 1e-4) {
    e.nX = pushX / pushLen;
    e.nZ = pushZ / pushLen;
    e.blockT = CONTACT_MEMORY;
  } else if (e.blockT > 0) {
    e.blockT = Math.max(0, e.blockT - step);
  }
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

function beginWindup(state, e, player) {
  e.lockX = player.x;
  e.lockZ = player.z;
  e.state = 'windup';
  e.stateT = 0;
  e.detourT = 0;
  e.vx = 0;
  e.vz = 0;
  e.leapH = 0;
  e.leapShow = 1;
  e.anim = 'attack';
  const dx = e.lockX - e.x;
  const dz = e.lockZ - e.z;
  if (Math.hypot(dx, dz) > 1e-6) e.facing = Math.atan2(dx, dz);
  state.fx.queue.push('charge');
}

function beginArc(state, e, leap) {
  e.arcX = e.x;
  e.arcZ = e.z;
  const delta = torusDelta(e.x, e.z, e.lockX, e.lockZ, CONFIG.arena.size);
  e.arcDx = delta.dx;
  e.arcDz = delta.dz;
  e.state = 'arc';
  e.stateT = 0;
  e.vx = 0;
  e.vz = 0;
  e.leapH = 0;
  e.anim = 'attack';
  if (!(leap.flight > 0)) landArc(state, e);
}

function sampleArc(e, leap) {
  const sample = leapSample(e.stateT, leap.flight, leap.apex);
  const placed = torusDelta(0, 0, e.arcX + e.arcDx * sample.u, e.arcZ + e.arcDz * sample.u, CONFIG.arena.size);
  e.x = placed.dx;
  e.z = placed.dz;
  e.leapH = sample.height;
}

function landArc(state, e) {
  const placed = torusDelta(0, 0, e.arcX + e.arcDx, e.arcZ + e.arcDz, CONFIG.arena.size);
  e.x = placed.dx;
  e.z = placed.dz;
  e.leapH = 0;
  e.impactLatched = 1;
  e.state = 'recover';
  e.stateT = 0;
  e.vx = 0;
  e.vz = 0;
  e.anim = e.hitFlash > 0 ? 'hit' : 'idle';
  // 同一帧多只落地只轰一声。镜头重新打满，不把几次冲击叠成抽搐。
  const queue = state.fx.queue;
  if (queue[queue.length - 1] !== 'slam') queue.push('slam');
  state.camera.shake = 1;
}

function updateOgre(state, e, step) {
  const leap = CONFIG.enemies.ogre.leap;
  if (!leap.enabled) {
    e.state = 'chase';
    e.leapH = 0;
    e.leapShow = 0;
    e.impactLatched = 0;
    return false;
  }

  if (e.state === 'windup') {
    e.stateT += step;
    e.portalSlow = Math.max(0, e.portalSlow - step);
    e.portalCd = Math.max(0, e.portalCd - step);
    e.vx = 0;
    e.vz = 0;
    e.anim = 'attack';
    e.leapH = 0;
    e.leapShow = 1;
    if (e.stateT >= leap.windup) beginArc(state, e, leap);
    return true;
  }

  if (e.state === 'arc') {
    e.stateT += step;
    e.portalSlow = Math.max(0, e.portalSlow - step);
    e.portalCd = Math.max(0, e.portalCd - step);
    e.vx = 0;
    e.vz = 0;
    e.anim = 'attack';
    e.leapShow = 1;
    if (!(leap.flight > 0) || e.stateT >= leap.flight) landArc(state, e);
    else sampleArc(e, leap);
    return true;
  }

  if (e.state === 'recover') {
    e.stateT += step;
    e.leapH = 0;
    e.leapShow = 0;
    if (e.stateT < leap.recover) {
      e.portalSlow = Math.max(0, e.portalSlow - step);
      e.portalCd = Math.max(0, e.portalCd - step);
      e.vx = 0;
      e.vz = 0;
      e.anim = 'idle';
      if (e.hitFlash > 0) e.anim = 'hit';
      return true;
    }
    e.state = 'chase';
    e.stateT = 0;
    e.leapCd = leap.cooldown;
    return false;
  }

  e.state = 'chase';
  e.leapCd = Math.max(0, e.leapCd - step);
  const player = state.player;
  if (e.leapCd <= 0 && e.rigged && Math.hypot(e.x - player.x, e.z - player.z) <= leap.sight) {
    beginWindup(state, e, player);
    return true;
  }
  return false;
}

function updateMinion(state, e, step) {
  if (e.kind === 'ogre' && updateOgre(state, e, step)) return;
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

  // 夹住了就换一条路走（见 planDetour）。绕行期间不理目标方向。
  if (e.detourT > 0) {
    e.detourT = Math.max(0, e.detourT - step);
    const aim = torusDelta(e.x, e.z, e.detourX, e.detourZ, size);
    if (aim.dist < 0.7) e.detourT = 0;
    else if (aim.dist > 1e-6) {
      vx = (aim.dx / aim.dist) * speed;
      vz = (aim.dz / aim.dist) * speed;
    }
    e.blockT = 0;
  } else {
    // 正对着小障碍时直线追击会把自己钉死（见 slideAlongContact 的注释）：
    // 贴着面走一瞬，绕过去之后 blockT 归零，立刻恢复直线。
    const steered = slideAlongContact(e, vx, vz, speed);
    vx = steered.x;
    vz = steered.z;
  }

  const beforeX = e.x;
  const beforeZ = e.z;
  moveBody(state, e, vx, vz, step, family.wraps ? 'wrap' : 'block');

  // 贴上了东西、却几乎没走成路 —— 计一次「挤住」。位移比按本帧该走的距离算，
  // 所以慢的怪（史莱姆 1.6）和快的（猎狗）用同一套阈值。
  const want = speed * step;
  const moved = Math.hypot(e.x - beforeX, e.z - beforeZ);
  const wedged = e.blockT > 0 && want > 1e-6 && moved < want * WEDGE_PROGRESS && e.detourT <= 0;
  if (wedged) e.wedgeT += step;
  else e.wedgeT = Math.max(0, e.wedgeT - step * 2);

  if (e.wedgeT > WEDGE_TIME && speed > 1e-6) {
    const plan = planDetour(state, e, solidRadius(state, e));
    e.detourX = plan.x;
    e.detourZ = plan.z;
    e.detourT = DETOUR_TIME;
    e.wedgeT = 0;
  }

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

function beginDash(state, boss) {
  boss.state = 'dash';
  boss.stateT = 0;
  boss.telegraph = 0.2;
  boss.dashHit = false;
  boss.anim = 'attack';
  // 上一冲撞过的标记清掉，这一冲才能再打到同一只怪。
  const enemies = state.enemies;
  for (let i = 1; i < enemies.length; i += 1) enemies[i].dashHit = false;
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
    if (boss.stateT >= phase.warn) beginDash(state, boss);
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
    moveBody(state, boss, vx, vz, step, 'block');
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
    hitWall = moveBody(state, boss, vx, vz, step, 'dash');
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
  separateBodies(state);
}
