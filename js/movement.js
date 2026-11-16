// 区块 6 · updateMovement
// 加减速、转向、翻滚、环面环绕、0.38 秒 easeOutCubic 镜头横扫。只写 player、camera、fx。

import { CONFIG } from './config.js';
import { pathFactor, terrainY } from './path.js';
import { pushOutOfLake } from './lake.js';
import { clipVelocity, resolve, substepCount } from './collision.js';

export function easeOutCubic(u) {
  const t = Math.min(1, Math.max(0, u));
  return 1 - (1 - t) ** 3;
}

function approach(vx, vz, targetX, targetZ, rate, dt) {
  const dx = targetX - vx;
  const dz = targetZ - vz;
  const dist = Math.hypot(dx, dz);
  const step = rate * dt;
  if (dist <= step || dist === 0) return { x: targetX, z: targetZ };
  return { x: vx + (dx / dist) * step, z: vz + (dz / dist) * step };
}

function wrapAngle(delta) {
  return Math.atan2(Math.sin(delta), Math.cos(delta));
}

function desiredCamera(player) {
  const limit = CONFIG.arena.half - CONFIG.camera.inset;
  return {
    x: Math.min(limit, Math.max(-limit, player.x)),
    z: Math.min(limit, Math.max(-limit, player.z + CONFIG.camera.back)),
  };
}

function beginSweep(state) {
  const camera = state.camera;
  const next = desiredCamera(state.player);
  camera.fromX = camera.x;
  camera.fromZ = camera.z;
  camera.toX = next.x;
  camera.toZ = next.z;
  camera.sweepT = 0;
  camera.sweeping = true;
  camera.speedLineT = CONFIG.camera.speedLine;
  state.fx.whoosh = true;
}

function tryWrap(state) {
  const player = state.player;
  const half = CONFIG.arena.half;
  const inset = CONFIG.movement.portal.inset;
  let wrapped = false;
  if (player.x < -half) {
    player.x = half - inset;
    wrapped = true;
  } else if (player.x > half) {
    player.x = -half + inset;
    wrapped = true;
  }
  if (player.z < -half) {
    player.z = half - inset;
    wrapped = true;
  } else if (player.z > half) {
    player.z = -half + inset;
    wrapped = true;
  }
  if (!wrapped) return;
  const portal = CONFIG.movement.portal;
  if (player.portalWindow > 0) player.portalInvuln = 0;
  else {
    player.portalInvuln = portal.invuln;
    player.portalWindow = portal.invulnWindow;
    player.invuln = Math.max(player.invuln, portal.invuln);
  }
  player.portalCd = portal.cooldown;
  player.portalRipple = 0.4;
  player.fadeT = 0.15;
  beginSweep(state);
}

export function updateMovement(state, dt) {
  if (state.time.paused) return;
  const step = dt * state.time.scale;
  if (step <= 0) return;

  const player = state.player;
  const move = CONFIG.movement;
  player.portalCd = Math.max(0, player.portalCd - step);
  player.portalWindow = Math.max(0, player.portalWindow - step);
  player.portalInvuln = Math.max(0, player.portalInvuln - step);
  player.invuln = Math.max(0, player.invuln - step);
  player.rollCd = Math.max(0, player.rollCd - step);
  player.rollT = Math.max(0, player.rollT - step);
  player.portalRipple = Math.max(0, player.portalRipple - step);
  player.fadeT = Math.max(0, player.fadeT - step);
  state.camera.speedLineT = Math.max(0, state.camera.speedLineT - step);

  const input = state.input;
  if (input.dodge && player.rollCd <= 0 && player.alive) {
    const mag = Math.hypot(input.moveX, input.moveZ);
    if (mag > 0.01) {
      player.facing = Math.atan2(input.moveX, input.moveZ);
    }
    player.rollT = move.roll.duration;
    player.rollCd = move.roll.cooldown;
    player.invuln = Math.max(player.invuln, move.roll.duration);
  }

  // 土路权重。路面本身已经是 0…1 的连续值，这里再缓一步，
  // 让离开路面时提速是「卸掉」而不是「关掉」。
  const pathW = pathFactor(player.x, player.z);
  player.pathBlend += (pathW - player.pathBlend)
    * (1 - Math.exp(-move.path.blendRate * step));

  let maxSpeed = player.spd * (player.speedBuff > 0 ? player.speedBuffMul : 1);
  maxSpeed *= 1 + (move.path.speedMul - 1) * player.pathBlend;
  if (input.slow) maxSpeed *= move.slowMul;
  const stick = input.stickMag ?? Math.hypot(input.moveX, input.moveZ);
  if (input.device === 'gamepad' && stick > 0 && stick <= CONFIG.input.fineMax) {
    maxSpeed *= stick / CONFIG.input.fineMax;
  }

  let wishX = 0;
  let wishZ = 0;
  if (player.rollT > 0) {
    wishX = Math.sin(player.facing);
    wishZ = Math.cos(player.facing);
    maxSpeed *= 1.2;
  } else {
    const mag = Math.hypot(input.moveX, input.moveZ);
    if (mag > 0) {
      wishX = input.moveX / mag;
      wishZ = input.moveZ / mag;
    }
  }
  const targetX = wishX * maxSpeed;
  const targetZ = wishZ * maxSpeed;
  const rate = wishX === 0 && wishZ === 0 && player.rollT <= 0 ? move.decel : move.accel;
  const stepped = approach(player.vx, player.vz, targetX, targetZ, rate, step);
  player.vx = stepped.x;
  player.vz = stepped.z;
  if (Math.hypot(player.vx, player.vz) < 0.04 && wishX === 0 && wishZ === 0) {
    player.vx = 0;
    player.vz = 0;
  }

  const speed = Math.hypot(player.vx, player.vz);
  if (speed > 0.2 && player.rollT <= 0) {
    const aim = Math.atan2(player.vx, player.vz);
    player.facing += wrapAngle(aim - player.facing) * (1 - Math.exp(-move.turnDamp * step));
  }

  // 碰撞在湖之前。步长大于最小柱半径的一半时拆成子步，避免从柱子中间穿过去。
  // 传送是一次跳变：传送前解一次，落到对面再解一次，中间那 120 m 不扫掠。
  const moveX = player.vx * step;
  const moveZ = player.vz * step;
  const slices = substepCount(Math.hypot(moveX, moveZ));
  const slice = 1 / slices;
  let pushX = 0;
  let pushZ = 0;
  for (let i = 0; i < slices; i += 1) {
    player.x += moveX * slice;
    player.z += moveZ * slice;
    const beforeX = player.x;
    const beforeZ = player.z;
    const hit = resolve(player.x, player.z, CONFIG.player.radius);
    player.x = hit.x;
    player.z = hit.z;
    pushX = player.x - beforeX;
    pushZ = player.z - beforeZ;
    const shore = pushOutOfLake(player.x, player.z);
    if (shore) {
      player.x = shore.x;
      player.z = shore.z;
    }
  }

  if (player.portalCd > 0) {
    const keep = CONFIG.arena.half - 0.05;
    player.x = Math.min(keep, Math.max(-keep, player.x));
    player.z = Math.min(keep, Math.max(-keep, player.z));
  } else {
    const wrapX = player.x;
    const wrapZ = player.z;
    tryWrap(state);
    if (player.x !== wrapX || player.z !== wrapZ) {
      const beforeX = player.x;
      const beforeZ = player.z;
      const hit = resolve(player.x, player.z, CONFIG.player.radius);
      player.x = hit.x;
      player.z = hit.z;
      pushX = player.x - beforeX;
      pushZ = player.z - beforeZ;
      const shore = pushOutOfLake(player.x, player.z);
      if (shore) {
        player.x = shore.x;
        player.z = shore.z;
      }
    }
  }

  // 只消掉朝箱子里的速度。切向留下，贴着走会滑开。湖的推出不参与这一步。
  const clipped = clipVelocity(player.vx, player.vz, pushX, pushZ);
  player.vx = clipped.x;
  player.vz = clipped.z;

  const camera = state.camera;

  // 相机高度跟着脚下的路基走，但带 0.3 s 的滞后。
  // 不跟的话，上坡时镜头会切进坡里；跟太紧的话，起伏会被抵消成一块平地 ——
  // 视差正是"地面有高低"的唯一线索。
  const camYTarget = CONFIG.camera.height + terrainY(player.x, player.z);
  camera.y += (camYTarget - camera.y)
    * (1 - Math.exp(-CONFIG.camera.heightDamp * step));

  if (camera.sweeping) {
    camera.sweepT += step;
    const u = camera.sweepT / CONFIG.camera.sweep;
    const k = easeOutCubic(u);
    camera.x = camera.fromX + (camera.toX - camera.fromX) * k;
    camera.z = camera.fromZ + (camera.toZ - camera.fromZ) * k;
    const breath = Math.sin(Math.min(1, u) * Math.PI);
    camera.fov = CONFIG.camera.fov + (CONFIG.camera.fovPeak - CONFIG.camera.fov) * breath;
    if (u >= 1) {
      camera.sweeping = false;
      camera.x = camera.toX;
      camera.z = camera.toZ;
      camera.fov = CONFIG.camera.fov;
    }
  } else {
    const next = desiredCamera(player);
    const k = 1 - Math.exp(-CONFIG.camera.followDamp * step);
    camera.x += (next.x - camera.x) * k;
    camera.z += (next.z - camera.z) * k;
    camera.fov += (CONFIG.camera.fov - camera.fov) * k;
  }
}
