// 区块 4 [GLOBAL STATE]
// 全局只有这一棵可变状态。系统函数只读写它，不另建类实例。

import { CONFIG } from './config.js';

function enemySlot(id) {
  return {
    id,
    alive: false,
    kind: '',
    variantId: '',
    elite: false,
    trap: false,
    x: 0,
    z: 0,
    vx: 0,
    vz: 0,
    facing: 0,
    hp: 0,
    hpMax: 0,
    radius: 0,
    contact: 0,
    speed: 0,
    xp: 0,
    scale: 1,
    anim: 'idle',
    state: 'idle',
    stateT: 0,
    hitFlash: 0,
    portalSlow: 0,
    hopT: 0,
    telegraph: 0,
    dashDirX: 0,
    dashDirZ: 1,
    hits: 0,
    contactCd: 0,
    dashHit: false,
    portalCd: 0,
    recoverNeed: 0,
  };
}

function chestSlot(id) {
  return {
    id,
    alive: false,
    type: '',
    x: 0,
    z: 0,
    age: 0,
    opening: false,
    settled: false,
    rewardXP: 0,
    rewardLevel: 0,
  };
}

function bulletPool(count) {
  const pool = typedPool(count);
  pool.pierce = new Uint8Array(count);
  pool.hit = new Uint8Array(count * CONFIG.spawn.maxAlive);
  return pool;
}

function typedPool(count) {
  return {
    count,
    alive: new Uint8Array(count),
    x: new Float32Array(count),
    z: new Float32Array(count),
    vx: new Float32Array(count),
    vz: new Float32Array(count),
    age: new Float32Array(count),
    value: new Float32Array(count),
  };
}

export function nextUnit(state) {
  state.rng = (Math.imul(state.rng | 0, 1664525) + 1013904223) >>> 0;
  return state.rng / 4294967296;
}

export function createState() {
  const p = CONFIG.player;
  const enemies = Array.from({ length: CONFIG.spawn.maxAlive }, (_, i) => enemySlot(i));
  const chests = Array.from({ length: CONFIG.chests.max }, (_, i) => chestSlot(i));

  return {
    time: {
      elapsed: 0,
      delta: 0,
      paused: false,
      scale: 1,
    },
    phase: 'menu',
    player: {
      x: CONFIG.arena.spawn.x,
      z: CONFIG.arena.spawn.z,
      vx: 0,
      vz: 0,
      facing: 0,
      hp: p.hp,
      hpMax: p.hp,
      spd: p.spd,
      atk: p.atk,
      aspd: p.aspd,
      def: p.def,
      dodge: p.dodge,
      crit: p.crit,
      critDmg: p.critDmg,
      pierce: p.pierce,
      level: 1,
      xp: 0,
      invuln: 0,
      rollCd: 0,
      rollT: 0,
      fireCd: 0,
      kills: 0,
      combo: 0,
      bestCombo: 0,
      chestsOpened: 0,
      alive: true,
      portalCd: 0,
      portalInvuln: 0,
      portalWindow: 0,
      portalRipple: 0,
      fadeT: 0,
      speedBuff: 0,
      speedBuffMul: 1,
      // 0…1，土路权重。移动和渲染共用，避免两处各算一遍导致视觉和数值对不上。
      pathBlend: 0,
      hurtCd: 0,
    },
    input: {
      moveX: 0,
      moveZ: 0,
      slow: false,
      dodge: false,
      pauseEdge: false,
      device: 'keyboard',
      deviceHold: 0,
      upgradeIndex: 0,
      confirm: false,
      stickIdleFrames: 0,
      pointer: { active: false, id: -1, x: 0, y: 0, dx: 0, dy: 0 },
    },
    enemies,
    bullets: bulletPool(CONFIG.weapon.pool),
    gems: typedPool(CONFIG.gems.pool),
    chests,
    camera: {
      x: 0,
      y: CONFIG.camera.height,
      z: CONFIG.camera.back,
      fov: CONFIG.camera.fov,
      sweeping: false,
      sweepT: 0,
      speedLineT: 0,
      fromX: 0,
      fromZ: CONFIG.camera.back,
      toX: 0,
      toZ: CONFIG.camera.back,
    },
    weapon: { seekT: 0, target: -1 },
    upgrade: { pending: false, options: [], lastId: '' },
    result: { ready: false, win: false, hold: 0 },
    spawn: {
      credit: 0,
      hound30: false,
      hound60: false,
      ogreNext: CONFIG.scripted.ogre.firstAt,
      bossSpawned: false,
      eliteNext: CONFIG.elite.firstAt,
      chestNext: CONFIG.chests.firstAt,
      prepChest: false,
      trapLast: false,
      trapHounds: 0,
      trapX: 0,
      trapZ: 0,
    },
    boss: { summon: 0 },
    settings: { volume: 0.8, sfx: 1, sweep: true },
    doc: { open: false, nearId: '' },
    fx: { whoosh: false, queue: [], rumble: '' },
    assets: {
      ready: false,
      hero: null,
      meshes: {},
    },
    hud: {
      hp: -1,
      xp: -1,
      level: -1,
      time: -1,
      kills: -1,
      bossHp: -1,
      overlay: '',
    },
    rng: 1,
  };
}
