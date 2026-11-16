// 区块 3 [CONFIG & TABLE]
// 只读数值。策划正文是 docs 里的 v3.4 整理稿。
// 随机流从 1:40 起按史莱姆:猎狗 = 3:2。食人魔走 scripted.ogre。

function freeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) freeze(value[key]);
  return Object.freeze(value);
}

export const CONFIG = freeze({
  meta: {
    game: 'FYAgent Survivors',
    design: 'v3.4',
    numbersFrom: 'v3.3',
  },

  loop: {
    // 策划只要求截断 delta，没给上限。50ms：切后台不会用一整段真实时间追帧。
    maxDelta: 0.05,
  },

  renderer: {
    maxPixelRatio: 2,
    shadows: false,
    // 脚底圆影与人的碰撞半径是同一个数，绘制时读 player.radius。
    shadowDiscRadius: 0.45,
  },

  arena: {
    size: 120,
    half: 60,
    portalDepth: 3,
    portalHeight: 3,
    spawn: { x: 0, z: 0 },
  },

  camera: {
    fov: 45,
    pitch: 58,
    height: 16,
    back: 10,
    inset: 8,
    followDamp: 8,
    // 相机高度跟随路基的阻尼。给一点滞后（约 0.3 s），上下坡时镜头
    // 才不会和地面焊死 —— 起伏要靠这点视差才读得出来。
    heightDamp: 3.2,
    viewWidth: 24,
    viewHeight: 14,
    sweep: 0.38,
    sweepEase: 'easeOutCubic',
    fovPeak: 52,
    speedLine: 0.15,
  },

  player: {
    radius: 0.45,
    height: 1.5,
    hp: 100,
    spd: 5,
    atk: 10,
    aspd: 1.5,
    def: 0,
    dodge: 0.05,
    crit: 0.05,
    critDmg: 1.5,
    pierce: 0,
    caps: {
      hp: 300,
      spd: 8,
      atk: 40,
      aspd: 4,
      def: 30,
      dodge: 0.6,
      crit: 0.5,
      critDmg: 2.5,
    },
    incomingDefK: 40,
    levelHp: 20,
  },

  formulas: {
    xpBase: 8,
    xpPerLevel: 5,
    outgoingDefK: 50,
    chestXpRatio: 0.5,
  },

  movement: {
    accel: 40,
    decel: 55,
    turnDamp: 12,
    slowMul: 0.45,
    roll: { duration: 0.35, cooldown: 2 },
    // 土路提速。乘在 spd 之上、roll 的 1.2 之前，和现有的 speedBuff 同类叠乘。
    // 1.18 相当于把 5.0 抬到 5.9，能跑赢猎狗的 4.2，但赢不了冲刺的 5.04。
    path: { speedMul: 1.18, blendRate: 11 },
    portal: {
      cooldown: 1,
      inset: 0.5,
      invuln: 0.25,
      invulnWindow: 1.5,
      enemySlow: 0.5,
      enemySlowTime: 0.4,
      bossWallStun: 1,
    },
  },

  input: {
    deadzone: 0.18,
    fineMax: 0.3,
    gamepadIndex: 0,
    deviceHoldSec: 2,
    idleFrames: 10,
    idleEpsilon: 0.12,
    hurtRumbleMs: 120,
    chestRumbleMs: 80,
    bossHitRumbleMs: 250,
  },

  weapon: {
    id: 'pulse',
    coefficient: 1,
    speed: 18,
    life: 1.2,
    hitRadius: 0.08,
    length: 0.35,
    visualRadius: 0.05,
    pool: 30,
    seekHz: 10,
    seekRadius: 9,
    bossLockRadius: 12,
    knockback: 0.15,
    hitFlash: 0.08,
    outOfBounds: 'destroy',
  },

  gems: {
    pool: 200,
  },

  spawn: {
    basePerSec: 0.7,
    perMinute: 0.5,
    capPerSec: 3.2,
    ringMin: 14,
    ringMax: 18,
    rejectWithin: 12,
    maxAlive: 120,
    stableTarget: 80,
    despawnFade: 1.5,
  },

  // 3:2:1 里食人魔的 1 不进随机流，见 scripted.ogre。随机流只滚史莱姆和猎狗。
  familyRatio: { slime: 3, hound: 2, ogre: 1 },
  scripted: {
    hounds: [
      { t: 30, count: 1, elite: false },
      { t: 60, count: 1, elite: false },
    ],
    ogre: { firstAt: 180, every: 30, count: 1, elite: false },
  },
  waves: [
    {
      id: 'early-tutorial',
      start: 0,
      end: 40,
      weights: { slime: 3, hound: 0, ogre: 0 },
      elite: false,
      rateScale: 1,
    },
    {
      id: 'early',
      start: 40,
      end: 100,
      weights: { slime: 3, hound: 0, ogre: 0 },
      elite: false,
      rateScale: 1,
    },
    {
      id: 'mid',
      start: 100,
      end: 180,
      weights: { slime: 3, hound: 2, ogre: 0 },
      elite: true,
      rateScale: 1,
    },
    {
      id: 'late',
      start: 180,
      end: 260,
      weights: { slime: 3, hound: 2, ogre: 0 },
      elite: true,
      rateScale: 1,
    },
    {
      id: 'late-prep',
      start: 260,
      end: 300,
      weights: { slime: 3, hound: 2, ogre: 0 },
      elite: true,
      rateScale: 0.3,
      forceChest: 'health',
    },
    {
      id: 'boss',
      start: 300,
      end: null,
      weights: { slime: 3, hound: 2, ogre: 0 },
      elite: false,
      rateScale: 0.4,
      boss: 'hese',
    },
  ],

  elite: {
    hp: 2.4,
    scale: 1.35,
    contact: 1.3,
    xp: 4,
    speed: 0.95,
    firstAt: 100,
    every: 25,
    pauseInBoss: true,
    ring: 0.15,
  },

  enemies: {
    slime: {
      id: 'slime',
      name: '史莱姆',
      color: '#6E4AA8',
      hp: 40,
      speed: 1.6,
      contact: 10,
      radius: 0.7,
      xp: 2,
      hopEvery: 1.2,
      render: 'instanced',
      wraps: true,
      glb: 'models/rigged_v1/slime_rigged_v1.glb',
      legacyGlb: 'models/enemies/slime.glb',
      targetHeight: null,
    },
    hound: {
      id: 'hound',
      name: '猎狗',
      color: '#C69A4B',
      hp: 70,
      speed: 4.2,
      contact: 12,
      radius: 0.6,
      xp: 3,
      sprintRange: 6,
      sprintMul: 1.2,
      render: 'skinned',
      wraps: true,
      glb: 'models/rigged_v1/hound_rigged_v1.glb',
      legacyGlb: 'models/enemies/hound.glb',
      targetHeight: null,
    },
    ogre: {
      id: 'ogre',
      name: '食人魔',
      color: '#B96745',
      hp: 220,
      speed: 1.2,
      contact: 22,
      radius: 1.15,
      xp: 6,
      swayDeg: 6,
      separation: 1.2,
      render: 'skinned',
      wraps: true,
      glb: 'models/rigged_v1/ogre_rigged_v1.glb',
      legacyGlb: 'models/enemies/orge.glb',
      targetHeight: null,
    },
  },

  // 史莱姆名额内替换。强度从高到低的权重是 1:2:3。紫色只作造型参考。
  slimeVariants: {
    enabled: true,
    replaceWithin: 'slime',
    referenceColor: '#6E4AA8',
    red: { id: 'red', intensity: 'high', weight: 1, color: '#B95645', hp: 30, speed: 2.2, contact: 16, radius: 0.6, xp: 3 },
    blue: { id: 'blue', intensity: 'mid', weight: 2, color: '#4C83BD', hp: 70, speed: 1.2, contact: 12, radius: 0.8, xp: 3 },
    green: { id: 'green', intensity: 'low', weight: 3, color: '#659B4A', hp: 40, speed: 1.6, contact: 10, radius: 0.7, xp: 2 },
  },

  boss: {
    id: 'hese',
    name: '赫塞重甲骑士',
    hp: 3000,
    def: 25,
    speed: 2,
    contact: 25,
    radius: 0.9,
    height: 1.8,
    chargeDamage: 35,
    chargeKnockback: 2,
    armorFlashEveryHits: 10,
    armorFlash: 0.2,
    hpSegments: 4,
    render: 'skinned',
    wraps: false,
    glb: 'models/rigged_v1/boss_knight_rigged_v1.glb',
    legacyGlb: 'models/enemies/boss_knight.glb',
    targetHeight: 1.8,
    idle: 1.5,
    recover: 1.5,
    p1: {
      warn: 1.8,
      lockAt: 1.2,
      cooldown: 4.5,
      dashSpeed: 14,
      dashTime: 0.9,
    },
    p2: {
      hpBelow: 0.5,
      warn: 1.4,
      cooldown: 3.5,
      dashSpeed: 16,
      summon: { kind: 'slime', count: 4 },
    },
    telegraph: {
      width: 3,
      length: 14,
      y: 0.02,
      color: '#E8455C',
      alphaStart: 0.3,
      alphaFill: 0.45,
      alphaLock: 0.55,
    },
  },

  chests: {
    max: 3,
    firstAt: 25,
    firstType: 'xp',
    every: 35,
    life: 45,
    openRadius: 1.2,
    openAnim: 0.35,
    flyAnim: 0.4,
    placeMin: 18,
    placeMax: 30,
    oppositeChance: 0.15,
    trapChance: 0.15,
    trapNoStreak: true,
    arrowBeyond: 22,
    types: {
      xp: { weight: 0.4, color: '#1E9BE8', pulse: 1.4, xpRatio: 0.5 },
      health: { weight: 0.45, color: '#3FD68A', pulse: 1.4, healRatio: 0.3, fullSpeedMul: 1.15, fullSpeedTime: 5 },
      rare: { weight: 0.15, color: '#F5B63C', pulse: 1.4, xpRatio: 0.5, disguise: false, grantUpgrade: 1 },
      trap: { color: '#E8455C', pulse: 0.6, xpRatio: 0, hounds: 3, warnRadius: 3, warnTime: 0.5, countsKill: false },
    },
    glb: 'models/rigged_v1/chest_rigged_v1.glb',
    legacyGlb: 'models/enemies/chest.glb',
  },

  upgrades: {
    pick: 3,
    timeScale: 0.15,
    repeatWeight: 0.5,
    choices: [
      { id: 'atk', stat: 'atk', mul: 1.15 },
      { id: 'aspd', stat: 'aspd', mul: 1.12 },
      { id: 'spd', stat: 'spd', mul: 1.08 },
      { id: 'hp', stat: 'hpMax', add: 20, healToFull: true },
      { id: 'def', stat: 'def', add: 5 },
      { id: 'dodge', stat: 'dodge', add: 0.05 },
      { id: 'crit', stat: 'crit', add: 0.05 },
      { id: 'pierce', stat: 'pierce', add: 1 },
    ],
  },

  hero: {
    glb: 'models/rigged_v1/protagonist_rigged_v1.glb',
    legacyGlb: 'models/fyagent_hero_g1_1024.glb',
    targetHeight: 1.5,
    clips: {
      idle: 'idle|stand',
      run: 'moveforward|run|jog|walk',
    },
    separateAnims: {
      idle: 'models/anim_Idle_Loop.glb',
      jog: 'models/anim_Jog_Fwd_Loop.glb',
    },
  },

  hud: {
    hpWidth: 220,
    hpHeight: 14,
    xpHeight: 6,
    timerSize: 28,
    bossFlashAt: 295,
    cardWidth: 180,
    joystick: 120,
  },
});
