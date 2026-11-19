// 区块 6 · updateRenderAndHUD
// 石板庭院、主界面、主角、镜头和 DOM 脏检查。不改玩法数值，只消费 fx.whoosh。

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { createGrassField } from './grass.js';
import { bindGroundZones } from './zones.js';
import { createZoneAmbience } from './ambience.js';
import {
  bindGroundStain, createDirtPath, crossDistance, pathDistance, terrainY,
} from './path.js';
import { createRoadProps } from './props.js';
import { createNarrativeScenery } from './narrative.js';
import { createLandmarks } from './landmarks.js';
import { createEvidence } from './evidence.js';
import { createScenery } from './scenery.js';
import { createBorderFX } from './borderfx.js';
import { createBossView } from './bossview.js';
import { createActors } from './actors.js';
import { applyUpgrade, levelCost } from './combat.js';
import { documentFor } from './documents.js';
import { resetRun } from './state.js';
import { assertClearances, colliderStats, debugSegmentCount, debugShapes, writeDebugXZ } from './collision.js';
import {
  cloneGrassTexture,
  createFallbackMesh,
  createSynth,
  createToonGradientMap,
  findClip,
  finishBootPresentation,
  loadAndNormalizeGLB,
  onAssetProgress,
  preloadCover,
  preloadDecodedImage,
  preloadDracoDecoder,
  preloadGrassTexture,
} from './pipeline.js';

const hud = {};

function dom() {
  if (hud.timer) return hud;
  hud.hp = document.getElementById('hp-fill');
  hud.xp = document.getElementById('xp-fill');
  hud.level = document.getElementById('level');
  hud.timer = document.getElementById('timer');
  hud.kills = document.getElementById('kills');
  hud.pad = document.getElementById('pad-hint');
  hud.stick = document.getElementById('joystick');
  hud.nub = document.getElementById('stick');
  hud.pause = document.getElementById('pause');
  hud.pauseStats = document.getElementById('pause-stats');
  hud.charge = document.getElementById('charge');
  hud.chargeFill = document.getElementById('charge-fill');
  hud.chargeLabel = document.getElementById('charge-label');
  hud.note = document.getElementById('boot-note');
  hud.root = document.getElementById('hud');
  hud.menu = document.getElementById('menu');
  hud.menuCopy = document.getElementById('menu-copy');
  hud.howto = document.getElementById('howto');
  hud.start = document.getElementById('btn-start');
  hud.howtoOpen = document.getElementById('btn-howto');
  hud.howtoBack = document.getElementById('btn-howto-back');
  hud.levelup = document.getElementById('levelup');
  hud.cards = Array.from(document.querySelectorAll('#cards .card'));
  hud.pickHint = document.getElementById('pick-hint');
  hud.result = document.getElementById('result');
  hud.resultTitle = document.getElementById('result-title');
  hud.resultStats = document.getElementById('result-stats');
  hud.resultPanel = document.getElementById('result-panel');
  hud.retry = document.getElementById('retry');
  hud.bossBar = document.getElementById('boss-bar');
  hud.bossSegs = Array.from(document.querySelectorAll('#boss-segments i'));
  hud.bossName = document.getElementById('boss-name');
  hud.pauseSettings = document.getElementById('btn-pause-settings');
  hud.doc = document.getElementById('doc');
  hud.docHint = document.getElementById('doc-hint');
  hud.docKey = document.getElementById('doc-key');
  hud.docOffice = document.getElementById('doc-office');
  hud.docTitle = document.getElementById('doc-title');
  hud.docMeta = document.getElementById('doc-meta');
  hud.docBody = document.getElementById('doc-body');
  hud.docSign = document.getElementById('doc-sign');
  hud.docSeal = document.getElementById('doc-seal');
  hud.settings = document.getElementById('settings');
  hud.settingsOpen = document.getElementById('btn-settings');
  hud.settingsBack = document.getElementById('btn-settings-back');
  hud.padHead = document.getElementById('pad-head');
  hud.vol = document.getElementById('vol');
  hud.sfx = document.getElementById('sfx');
  hud.volPct = document.getElementById('vol-pct');
  hud.sfxPct = document.getElementById('sfx-pct');
  hud.arrows = document.getElementById('chest-arrows');
  return hud;
}

function openSheet(state, name) {
  const nodes = dom();
  const inRun = state.phase === 'play' || state.phase === 'result';
  if (name === 'settings') {
    state.ui.settings = true;
    if (!inRun) state.phase = 'menu';
  } else if (name === 'howto') {
    if (inRun) return;
    state.ui.settings = false;
    state.phase = 'howto';
  } else {
    state.ui.settings = false;
    if (state.phase === 'howto') state.phase = 'menu';
  }
  if (!inRun && nodes.menuCopy) nodes.menuCopy.hidden = state.phase === 'howto' || state.ui.settings;
  if (nodes.howto) nodes.howto.hidden = state.phase !== 'howto';
  if (nodes.settings) {
    nodes.settings.hidden = !state.ui.settings;
    nodes.settings.classList.toggle('over-cover', !inRun && state.ui.settings);
  }
}

function bindMenu(state) {
  const nodes = dom();
  if (nodes.menuBound) return;
  nodes.menuBound = true;
  nodes.start.addEventListener('click', () => startGame(state));
  nodes.howtoOpen.addEventListener('click', () => openSheet(state, 'howto'));
  nodes.howtoBack.addEventListener('click', () => openSheet(state, ''));
  if (nodes.retry) nodes.retry.addEventListener('click', () => startGame(state));
  nodes.cards.forEach((card, i) => {
    card.addEventListener('click', () => {
      if (!state.upgrade.pending) return;
      const pick = state.upgrade.options[i];
      if (pick) applyUpgrade(state, pick.id);
    });
  });
  if (nodes.settingsOpen) {
    nodes.settingsOpen.addEventListener('click', () => openSheet(state, 'settings'));
  }
  if (nodes.pauseSettings) {
    nodes.pauseSettings.addEventListener('click', () => openSheet(state, 'settings'));
  }
  if (nodes.settingsBack) {
    nodes.settingsBack.addEventListener('click', () => openSheet(state, ''));
  }
  document.querySelectorAll('#settings [data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      state.ui.tab = button.dataset.tab;
    });
  });
  function previewSound() {
    if (nodes.volPct) nodes.volPct.textContent = `${nodes.vol.value}%`;
    if (nodes.sfxPct) nodes.sfxPct.textContent = `${nodes.sfx.value}%`;
    if (state.view) state.view.synth.play('shoot', state.settings.volume * state.settings.sfx);
  }
  if (nodes.vol) {
    nodes.vol.addEventListener('input', () => {
      state.settings.volume = Number(nodes.vol.value) / 100;
      previewSound();
    });
  }
  if (nodes.sfx) {
    nodes.sfx.addEventListener('input', () => {
      state.settings.sfx = Number(nodes.sfx.value) / 100;
      previewSound();
    });
  }
  const sweepOn = document.getElementById('sweep-on');
  const sweepOff = document.getElementById('sweep-off');
  if (sweepOn) sweepOn.addEventListener('click', () => { state.settings.sweep = true; });
  if (sweepOff) sweepOff.addEventListener('click', () => { state.settings.sweep = false; });
}

function startGame(state) {
  resetRun(state);
  const spawn = CONFIG.arena.spawn;
  const player = state.player;
  player.x = spawn.x;
  player.z = spawn.z;
  player.vx = 0;
  player.vz = 0;
  player.facing = 0;
  player.rollT = 0;
  state.camera.x = spawn.x;
  state.camera.z = spawn.z + CONFIG.camera.back;
  state.camera.fov = CONFIG.camera.fov;
  state.camera.sweeping = false;
  state.camera.sweepT = 0;
  state.camera.speedLineT = 0;
  state.camera.fromX = state.camera.x;
  state.camera.fromZ = state.camera.z;
  state.camera.toX = state.camera.x;
  state.camera.toZ = state.camera.z;
  state.camera.shake = 0;
  state.time.elapsed = 0;
  state.time.paused = false;
  state.time.scale = 1;
  state.hud.time = -1;
  state.phase = 'play';
}

// 石板贴图保留给传送门和菜单，地面改用草地基底。
// 草地基底只提供从草叶缝隙里透出来的色温，不承担细节——
// 在 69 px/m 的机位下，贴图里小于 2 cm 的东西都会被 mipmap 抹平。
function groundTexture() {
  const texture = cloneGrassTexture();
  texture.repeat.set(4, 4);
  return texture;
}

// 世界之外：一块比竞技场大得多的地面。
//
// 为什么不是天空盒 —— 量过了（tools/probe_horizon.mjs）：
// 相机 pitch 58° / fov 45，上沿是水平以下 33.9°、上沿左右角 27.5°、下沿 78.9°，
// **整幅画面都在水平线以下，画框里没有地平线**。天空盒能被看到的只有下半球，
// 也就是"天空球的地面"，读起来仍是一片地，不会出现山和天际线。
// 所以这里把"虚空"换成"继续延伸的地面"——这才是天空盒在这个机位该起的作用，
// 而成本只有一个平面。
//
// 尺寸 680 m：竞技场半宽 60，画面上沿最远只看到相机前方 35 m，
// 所以 680 保证任何机位、任何一帧都看不到它的边。
// 贴图密度对齐主地面（120 m / repeat 4 = 30 m 一格），接缝处不会突然变细。
// 压到 y=−0.10 是躲 z-fighting；6–10 cm 的高差在 58° 俯视下不到一个像素。
const FAR_GROUND_SIZE = 680;
const FAR_GROUND_TILE = 30;

function farGroundTexture() {
  const texture = cloneGrassTexture();
  texture.repeat.set(FAR_GROUND_SIZE / FAR_GROUND_TILE, FAR_GROUND_SIZE / FAR_GROUND_TILE);
  return texture;
}

function createFarGround() {
  const geo = new THREE.PlaneGeometry(FAR_GROUND_SIZE, FAR_GROUND_SIZE);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshToonMaterial({
      // 和主地面同一个贴图、同一个 color（0xffffff）：远地面要"看起来就是同一块地"，
      // 任何 tint 都会在接缝处留一道色差。实测两边均色差约 −1%R / −9%B，
      // 剩下的差值来自草叶本身，靠 grass.js 的边缘衰减收掉。
      map: farGroundTexture(),
      color: 0xffffff,
      gradientMap: createToonGradientMap(),
    }),
  );
  mesh.position.y = -0.10;
  mesh.name = 'far-ground';
  return mesh;
}

// 石板贴图对应的原始地面已停用：草地改由 groundTexture() + js/grass.js 的
// 实例化草丛承担。函数保留，供「石板庭院」这类室内场地复用。
function stoneTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#555b63';
  ctx.fillRect(0, 0, 256, 256);
  const tiles = 4;
  const tile = 256 / tiles;
  for (let y = 0; y < tiles; y += 1) {
    for (let x = 0; x < tiles; x += 1) {
      const shade = ((x + y) % 2 === 0) ? '#5b616a' : '#4e555d';
      ctx.fillStyle = shade;
      ctx.fillRect(x * tile + 2, y * tile + 2, tile - 4, tile - 4);
    }
  }
  ctx.strokeStyle = '#353b44';
  ctx.lineWidth = 4;
  for (let i = 0; i <= tiles; i += 1) {
    ctx.beginPath();
    ctx.moveTo(i * tile, 0);
    ctx.lineTo(i * tile, 256);
    ctx.moveTo(0, i * tile);
    ctx.lineTo(256, i * tile);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.repeat.set(30, 30);
  texture.anisotropy = 4;
  return texture;
}

function speedLines() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 256, 64);
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 8; i += 1) {
    const y = 6 + i * 8;
    ctx.beginPath();
    ctx.moveTo(20, y);
    ctx.lineTo(180 - (i % 3) * 30, y);
    ctx.stroke();
  }
  const material = new THREE.MeshBasicMaterial({
    map: new THREE.CanvasTexture(canvas),
    transparent: true,
    depthTest: false,
    depthWrite: false,
    opacity: 0,
  });
  material.map.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 0.9), material);
  mesh.position.set(0, 0, -1.4);
  mesh.renderOrder = 20;
  mesh.visible = false;
  return mesh;
}

function showNote(text) {
  const note = dom().note;
  if (!text) {
    note.hidden = true;
    note.textContent = '';
    return;
  }
  note.hidden = false;
  note.textContent = text;
}

async function loadHero() {
  const hero = CONFIG.hero;
  const options = {
    autoScale: true,
    targetHeight: hero.targetHeight,
    scale: 1,
    offsetY: 0,
    rotationY: 0,
  };
  try {
    return await loadAndNormalizeGLB(hero.glb, options);
  } catch (primary) {
    try {
      return await loadAndNormalizeGLB(hero.legacyGlb, options);
    } catch (legacy) {
      return {
        pivot: createFallbackMesh('hero'),
        clips: [],
        fallback: true,
        error: primary,
        legacy,
      };
    }
  }
}

function playClips(root, clips) {
  const idleClip = findClip(clips, CONFIG.hero.clips.idle);
  const runClip = findClip(clips, CONFIG.hero.clips.run);
  if (!idleClip && !runClip) return null;
  const mixer = new THREE.AnimationMixer(root);
  const idle = idleClip ? mixer.clipAction(idleClip) : null;
  const run = runClip ? mixer.clipAction(runClip) : null;
  if (idle) idle.play();
  if (run) {
    run.play();
    run.enabled = true;
    run.setEffectiveWeight(0);
  }
  return { mixer, idle, run };
}

function buildColliderDebug() {
  const count = debugSegmentCount();
  const xz = new Float32Array(Math.max(1, count) * 4);
  const written = writeDebugXZ(xz);
  const position = new Float32Array(count * 6);
  for (let i = 0; i < count; i += 1) {
    const x1 = xz[i * 4];
    const z1 = xz[i * 4 + 1];
    const x2 = xz[i * 4 + 2];
    const z2 = xz[i * 4 + 3];
    const o = i * 6;
    position[o] = x1;
    position[o + 1] = terrainY(x1, z1) + 0.15;
    position[o + 2] = z1;
    position[o + 3] = x2;
    position[o + 4] = terrainY(x2, z2) + 0.15;
    position[o + 5] = z2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  const line = new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({ color: 0x39ff6a }),
  );
  line.name = 'collider-debug';
  if (written !== count * 4) console.error('[collision] 调试线顶点数不一致', written, count);
  return line;
}

function bindLoadingProgress() {
  const fill = document.getElementById('loading-fill');
  const status = document.getElementById('loading-status');
  const bar = document.getElementById('loading-bar');
  if (!fill || fill.dataset.bound === '1') return;
  fill.dataset.bound = '1';
  onAssetProgress((snap) => {
    const pct = Math.round(snap.ratio * 100);
    fill.style.transform = `scaleX(${snap.ratio})`;
    if (bar) bar.setAttribute('aria-valuenow', String(pct));
    if (!status) return;
    if (snap.ratio >= 1) status.textContent = '准备完成';
    else if (snap.presenting) status.textContent = `正在准备主界面 ${pct}%`;
    else if (snap.label) status.textContent = `正在载入${snap.label} ${pct}%`;
    else status.textContent = `正在载入资源 ${pct}%`;
  });
}

function dismissLoading() {
  const loading = document.getElementById('loading');
  const menu = document.getElementById('menu');
  if (menu) menu.hidden = false;
  if (!loading || loading.hidden) return;
  loading.classList.add('is-done');
  const hide = () => {
    loading.hidden = true;
  };
  loading.addEventListener('transitionend', hide, { once: true });
  setTimeout(hide, 400);
}

export async function bootView(state) {
  bindMenu(state);
  bindLoadingProgress();
  // 封面、纹章、解码器和地面贴图跟后面的模型并行下。主界面要等这些都解码完，
  // 并且第一帧（着色器编译）画完，再揭开，避免菜单自己在抖。
  const coverTask = preloadCover('assets/cover/fyagent_cover.png').catch((err) => {
    console.warn('[boot] 封面没有预先载入', err);
    const img = document.getElementById('cover');
    if (img && !img.getAttribute('src')) img.src = 'assets/cover/fyagent_cover.png';
  });
  const emblemTask = preloadDecodedImage('assets/emblem_knight.png', '纹章').catch((err) => {
    console.warn('[boot] 纹章没有预先载入', err);
  });
  preloadDracoDecoder().catch((err) => {
    console.warn('[boot] Draco 预加载失败', err);
  });
  const grassTask = preloadGrassTexture();
  // 主角和场景模型在搭场景的同步工作之前就发出请求。否则要等草地、
  // 道路网格建完，23 MB 的主角才开始下。
  const heroTask = loadHero();
  const evidenceTask = createEvidence();
  const narrativeTask = createNarrativeScenery();
  const landmarksTask = createLandmarks();
  const sceneryTask = createScenery({ readyBeforeBushes: Promise.all([evidenceTask, narrativeTask, landmarksTask]) });
  const canvas = document.getElementById('view');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = false;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CONFIG.renderer.maxPixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new THREE.Scene();
  const actorsTask = createActors(scene);
  // 背景色 = 雾色。画面里没有地平线，看不到天，所以背景只在"地面没铺到"的地方
  // 露出来；让它和雾同色，万一露一条边也是雾，不是一块深色。
  scene.background = new THREE.Color(0x3a3644);
  scene.fog = new THREE.Fog(0x3a3644, 40, 120);

  const camera = new THREE.PerspectiveCamera(
    CONFIG.camera.fov,
    window.innerWidth / window.innerHeight,
    0.1,
    220,
  );
  scene.add(camera);
  const streaks = speedLines();
  camera.add(streaks);

  scene.add(new THREE.AmbientLight(0xd2dae4, 0.78));
  const sun = new THREE.DirectionalLight(0xfff4e6, 1.55);
  sun.position.set(-8, 18, 6);
  scene.add(sun);
  const menuLight = new THREE.DirectionalLight(0xe7f4ff, 0.85);
  menuLight.position.set(2.4, 3.2, 5);
  scene.add(menuLight);
  createToonGradientMap();

  await grassTask;
  const groundMat = new THREE.MeshToonMaterial({ map: groundTexture(), color: 0xffffff, gradientMap: createToonGradientMap() });
  bindGroundStain(groundMat);
  // 四角的地面分区（见 js/zones.js）。必须排在 bindGroundStain 之后 ——
  // 它要用那边已经接好的 vStainWorld varying，否则会自己补一个用 modelMatrix
  // 算出来的兜底值（那个对实例网格是错的）。
  bindGroundZones(groundMat);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(CONFIG.arena.size, CONFIG.arena.size),
    groundMat,
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  // 竞技场之外的同款地面。没有这一块，靠近地图边界时画面上沿会露出一条背景色
  // （那条"黑边"就是它，不是墙）。见上面的注释。
  const farGround = createFarGround();
  scene.add(farGround);

  const grass = createGrassField();
  // 草也要跟着分区变色。草叶的材质在 js/grass.js 里自建、自带 vStainWorld，
  // 所以这里直接补一刀：**草不跟着变，地上的色块会像一张铺上去的桌布** ——
  // 草叶仍是一茬茬绿点戳在异色地面上，反而更假。
  bindGroundZones(grass.mesh.material);
  scene.add(grass.mesh);

  // 四角的氛围层（见 js/ambience.js）：沼泽积水反光、两处暖点光、战场飘灰。
  // 全都按「玩家离角心多远」做平滑权重，不做硬切。
  const ambience = createZoneAmbience();
  scene.add(ambience._waterGroup);
  scene.add(ambience._ashPoints);
  scene.add(ambience._fireNe);
  scene.add(ambience._fireSe);

  // 土路压在地面之上、草丛之下。草场的顶点着色器会按同一套中心线把草压平，
  // 于是路面是干净的，路肩是渐变的，中间不需要遮罩贴图。
  const path = createDirtPath();
  scene.add(path.group);

  // 路旁陈设：栅栏、里程碑、路标、翻倒的车轮、木桶、石堆、干草。
  // 构建期全部烘成一个合并网格，运行时只占两次 draw call。
  const roadProps = createRoadProps();
  scene.add(roadProps.group);

  // 证据链、叙事、地标、体量层的下载在 bootView 开头就和主角一起发出了。
  // 灌木仍要等三边的碰撞形状注册完（见 scenery.js 的 bushClear）。

  // 边界全息力场（见 js/borderfx.js）。取代原来那四块平躺的紫色符纹贴片 ——
  // 贴片在 58° 俯视下只是一条略深的横带，玩家被传送走之前根本没注意到边界。
  const borderFX = createBorderFX();
  scene.add(borderFX.group);

  // 传送瞬间的扩散环：跟着力场改成青色，否则一个紫环撞在青墙上很突兀。
  const ripple = new THREE.Mesh(
    new THREE.RingGeometry(0.4, 0.7, 28),
    new THREE.MeshBasicMaterial({ color: 0x7cf0ff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
  );
  ripple.rotation.x = -Math.PI / 2;
  ripple.visible = false;
  scene.add(ripple);

  camera.position.set(-0.6, 1.15, 5.4);
  camera.fov = 28;
  camera.lookAt(1.6, 1.05, 0);
  camera.updateProjectionMatrix();

  const __t0 = performance.now();
  console.info('[boot] 开始加载主角');
  const loaded = await heroTask;
  console.info('[boot] 主角载入完成', Math.round(performance.now() - __t0), 'ms',
               'fallback=', loaded.fallback, 'clips=', loaded.clips.length);
  const narrative = await narrativeTask;
  console.info('[boot] 叙事载入完成', Math.round(performance.now() - __t0), 'ms');
  scene.add(narrative.group);
  if (narrative.failed.length) {
    console.warn('[narrative] 未加载的资产', narrative.failed);
  }

  const landmarks = await landmarksTask;
  scene.add(landmarks.group);
  if (landmarks.skipped.length) {
    console.info('[landmarks] 未就位的地标（待 Lux3D 生成）', landmarks.skipped);
  }

  const scenery = await sceneryTask;
  scene.add(scenery.group);
  if (scenery.failed.length) {
    console.warn('[scenery] 未加载的资产', scenery.failed);
  }

  const evidence = await evidenceTask;
  scene.add(evidence.group);
  if (evidence.failed.length) {
    console.warn('[evidence] 未加载的资产', evidence.failed);
  }
  const colliders = colliderStats();
  const gates = assertClearances();
  console.info(
    '[collision]',
    colliders.circles, '圆',
    colliders.boxes, '盒',
    '子步上限', Number.isFinite(colliders.limit) ? colliders.limit.toFixed(3) : 'n/a',
    gates.ok ? '门洞通过' : '门洞未过',
  );
  if (new URLSearchParams(location.search).get('collide') === '1') {
    scene.add(buildColliderDebug());
  }
  const hero = new THREE.Group();
  hero.add(loaded.pivot);
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(CONFIG.player.radius, 24),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.03;
  scene.add(shadow);
  scene.add(hero);
  const actors = await actorsTask;
  state.assets.bodyRadius = actors.bodyRadius;

  // 调试观测点：地址栏加 ?boss=1 会在出生点右前方立一个 Boss，只走渲染，
  // 不参与 AI、碰撞、伤害与血条。用来验收模型、动作切换与胸甲纹章。
  // ?boss=cycle 按 idle→walk→attack→hit→death 轮播，?boss=attack 只待机加间歇攻击。
  // 不传参时这一段完全不执行，正常游戏的加载路径与耗时不受影响。
  let debugBoss = null;
  const bossFlag = new URLSearchParams(location.search).get('boss');
  if (bossFlag) {
    const spot = { x: CONFIG.arena.spawn.x + 3.4, z: CONFIG.arena.spawn.z + 2.6 };
    debugBoss = await createBossView();
    debugBoss.group.position.set(spot.x, terrainY(spot.x, spot.z), spot.z);
    // 0 = 朝向 +Z（模型正面），相机在 +Z 侧，所以这里正对镜头，偏 0.3 给一点侧身
    debugBoss.setFacing(0.3);
    scene.add(debugBoss.group);
    if (bossFlag !== 'idle') debugBoss.startDebugCycle(bossFlag === 'cycle' ? 'cycle' : 'attack');
    window.__boss = debugBoss;
    console.info('[boss] 调试模型已就位', debugBoss.info);
  }

  const materials = [];
  loaded.pivot.traverse((obj) => {
    if (!obj.isMesh) return;
    const list = Array.isArray(obj.material) ? obj.material : [obj.material];
    list.forEach((material) => materials.push(material));
  });

  state.view = {
    renderer,
    scene,
    camera,
    hero,
    shadow,
    clips: playClips(loaded.pivot, loaded.clips),
    materials,
    fallback: loaded.fallback,
    borderFX,
    ripple,
    streaks,
    synth: createSynth(),
    menuLight,
    grass,
    path,
    roadProps,
    ambience,
    narrative,
    landmarks,
    scenery,
    evidence,
    actors,
    debugBoss,
  };
  state.assets.ready = true;
  state.assets.hero = hero;
  state.assets.fallback = !!loaded.fallback;
  // 调试钩子：可在控制台读 renderer.info 核对三角数与绘制调用。
  window.__view = state.view;
  // 碰撞形状的完整快照。tools/probe_clearance.mjs 靠它量道具之间的净空 ——
  // 净空只能从"实际注册进去的形状"里量，照 LAYOUT 手算迟早和代码对不上。
  window.__shapes = debugShapes();
  // 两条路的距离场。tools/probe_counts.mjs 用它把实例按"主路带 / 横路带"分开数。
  window.__road = { pathDistance, crossDistance };

  if (location.protocol === 'file:') {
    showNote('直接双击 HTML 会被浏览器拦住模型。请在仓库根目录运行 python -m http.server，然后打开 http://127.0.0.1:8000/ 。现在用几何体代替主角。');
  } else if (loaded.fallback) {
    showNote('主角模型没有载入，已改用几何体。确认用本地 HTTP 服务打开，并且 models/_deprecated/enemies/rigged_v1/protagonist_rigged_v1.glb 还在。');
  } else {
    showNote('');
  }

  await coverTask;
  await emblemTask;
  syncMenuCamera(state);
  syncHero(state, 0.05);
  state.view.hero.rotation.y = 0;
  syncShell(state);
  console.info('[boot] 首次整帧渲染前', Math.round(performance.now() - __t0), 'ms');
  renderer.render(scene, camera);
  console.info('[boot] 首次整帧渲染完成', Math.round(performance.now() - __t0), 'ms');
  finishBootPresentation();
  dismissLoading();
  window.__booted = true;

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CONFIG.renderer.maxPixelRatio));
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

function syncHero(state, dt) {
  const view = state.view;
  const player = state.player;
  // 主角踩在路基上，不是踩在 y=0：路面被小山丘垫起来 0.35–1.40 m。
  const groundY = terrainY(player.x, player.z);
  view.hero.position.set(player.x, groundY, player.z);
  view.hero.rotation.y = player.facing;
  view.hero.rotation.x = player.rollT > 0 ? 0.35 : 0;
  view.shadow.position.set(player.x, groundY + 0.03, player.z);

  const fade = player.fadeT > 0 ? 1 - Math.sin((1 - player.fadeT / 0.15) * Math.PI) * 0.75 : 1;
  view.materials.forEach((material) => {
    material.transparent = fade < 0.99;
    material.opacity = fade;
    material.depthWrite = fade > 0.99;
  });

  if (view.fallback) {
    const bob = Math.hypot(player.vx, player.vz) > 0.2 ? 1 + Math.sin(state.time.elapsed * 14) * 0.06 : 1;
    view.hero.scale.set(1, bob, 1);
  }

  if (view.clips && !state.time.paused) {
    const moving = Math.hypot(player.vx, player.vz) > 0.25;
    if (view.clips.idle) view.clips.idle.setEffectiveWeight(moving ? 0 : 1);
    if (view.clips.run) view.clips.run.setEffectiveWeight(moving ? 1 : 0);
    view.clips.mixer.update(dt * state.time.scale);
  }
}

function syncBorderFX(state) {
  const view = state.view;
  if (!view.borderFX) return;
  const player = state.player;
  // 传送后的 0.4 s 给一次增强：力场亮一档，和扩散环、角色淡出对上节拍。
  const boost = 1 + (player.portalRipple > 0 ? (player.portalRipple / 0.4) * 0.6 : 0);
  // 粒子的 gl_PointSize 是物理像素，换算系数要用 canvas 的真实高度（含 DPR）。
  const cam = view.camera;
  const pxScale = view.renderer.domElement.height / (2 * Math.tan((cam.fov * Math.PI) / 360));
  view.borderFX.update(state.time.elapsed, player, boost, pxScale);

  const ripple = view.ripple;
  if (player.portalRipple > 0) {
    const u = 1 - player.portalRipple / 0.4;
    ripple.visible = true;
    ripple.position.set(player.x, 0.05, player.z);
    const scale = 1 + u * 6;
    ripple.scale.set(scale, scale, scale);
    ripple.material.opacity = (1 - u) * 0.55;
  } else {
    ripple.visible = false;
  }
}

function syncMenuCamera(state) {
  const cam = state.view.camera;
  cam.position.set(-0.6, 1.15, 5.4);
  cam.fov = 28;
  cam.lookAt(1.6, 1.05, 0);
  cam.updateProjectionMatrix();
  state.view.streaks.visible = false;
  state.view.menuLight.visible = true;
}

function hash01(n) {
  const s = Math.sin(n) * 43758.5453;
  return s - Math.floor(s);
}

// 注视点不动，相机绕着它偏。画面中心还是主角，边缘在抖。
function slamOffset(state, camera, groundY) {
  const kick = camera.shake;
  if (!(kick > 0)) return null;
  const amp = kick * kick * CONFIG.camera.slamKick;
  const lookX = state.player.x;
  const lookY = groundY + 0.9;
  const lookZ = state.player.z;
  let fx = lookX - camera.x;
  let fy = lookY - camera.y;
  let fz = lookZ - camera.z;
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl;
  fy /= fl;
  fz /= fl;
  let sx = -fz;
  let sz = fx;
  const sl = Math.hypot(sx, sz) || 1;
  sx /= sl;
  sz /= sl;
  const ux = -sz * fy;
  const uy = sz * fx - sx * fz;
  const uz = sx * fy;
  const seed = state.time.elapsed * 90;
  const side = (hash01(seed) * 2 - 1) * 0.55;
  const down = -1;
  const len = Math.hypot(side, down);
  return {
    x: camera.x + (sx * side + ux * down) / len * amp,
    y: camera.y + (uy * down) / len * amp,
    z: camera.z + (sz * side + uz * down) / len * amp,
    roll: (hash01(seed + 9) * 2 - 1) * kick * kick * CONFIG.camera.slamRoll,
  };
}

function decaySlam(state, dt) {
  const camera = state.camera;
  if (!(camera.shake > 0)) return;
  if (state.time.paused && state.phase === 'play') return;
  const scale = state.phase === 'play' ? state.time.scale : 1;
  const step = dt * scale;
  camera.shake = Math.max(0, camera.shake - step / CONFIG.camera.slamShake);
}

function syncCamera(state, dt) {
  const view = state.view;
  const camera = state.camera;
  // 相机高度是 movement.js 缓出来的（带滞后），注视点用主角脚下的实时高度：
  // 两者差出来的那点视差，就是上坡/下坡能看出来的原因。
  const groundY = terrainY(state.player.x, state.player.z);
  const slam = slamOffset(state, camera, groundY);
  view.camera.position.set(
    slam ? slam.x : camera.x,
    slam ? slam.y : camera.y,
    slam ? slam.z : camera.z,
  );
  view.camera.fov = camera.fov;
  view.camera.updateProjectionMatrix();
  view.camera.lookAt(state.player.x, groundY + 0.9, state.player.z);
  if (slam) view.camera.rotateZ(slam.roll);
  decaySlam(state, dt);
  view.menuLight.visible = false;
  const streaks = view.streaks;
  streaks.visible = camera.speedLineT > 0;
  streaks.material.opacity = camera.speedLineT > 0 ? camera.speedLineT / CONFIG.camera.speedLine : 0;
}

function statNum(value) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function statPct(value) {
  return `${Math.round(value * 100)}%`;
}

function fillPauseStats(nodes, state) {
  if (!nodes.pauseStats) return;
  const player = state.player;
  const need = levelCost(player.level);
  const moving = player.speedBuff > 0 ? player.spd * player.speedBuffMul : player.spd;
  const speedText = player.speedBuff > 0 ? `${statNum(moving)}（加速中）` : statNum(player.spd);
  const rows = [
    ['生命', `${Math.max(0, Math.round(player.hp))} / ${player.hpMax}`],
    ['等级', String(player.level)],
    ['经验', `${player.xp} / ${need}`],
    ['攻击力', statNum(player.atk)],
    ['攻击速度', `${statNum(player.aspd)} 次/秒`],
    ['移动速度', speedText],
    ['防御', statNum(player.def)],
    ['闪避', statPct(player.dodge)],
    ['暴击率', statPct(player.crit)],
    ['暴击伤害', statPct(player.critDmg)],
    ['穿透', String(player.pierce)],
    ['击杀', String(player.kills)],
    ['当前连击', String(player.combo)],
    ['最高连击', String(player.bestCombo)],
    ['已开宝箱', String(player.chestsOpened)],
  ];
  nodes.pauseStats.textContent = '';
  rows.forEach(([name, value]) => {
    const term = document.createElement('dt');
    const desc = document.createElement('dd');
    term.textContent = name;
    desc.textContent = value;
    nodes.pauseStats.append(term, desc);
  });
}

function syncHud(state) {
  const nodes = dom();
  const player = state.player;
  const hp = player.hp / player.hpMax;
  if (state.hud.hp !== hp) {
    state.hud.hp = hp;
    nodes.hp.style.transform = `scaleX(${Math.max(0, hp)})`;
  }
  const need = levelCost(player.level);
  const xp = need > 0 ? player.xp / need : 0;
  if (state.hud.xp !== xp) {
    state.hud.xp = xp;
    nodes.xp.style.transform = `scaleX(${Math.max(0, Math.min(1, xp))})`;
  }
  if (state.hud.level !== player.level) {
    state.hud.level = player.level;
    nodes.level.textContent = `Lv.${player.level}`;
  }
  const shown = Math.floor(state.time.elapsed);
  if (state.hud.time !== shown) {
    state.hud.time = shown;
    const min = Math.floor(shown / 60);
    const sec = shown % 60;
    nodes.timer.textContent = `${min}:${sec.toString().padStart(2, '0')}`;
  }
  nodes.timer.classList.toggle('boss-soon', state.time.elapsed >= CONFIG.hud.bossFlashAt);
  if (state.hud.kills !== player.kills) {
    state.hud.kills = player.kills;
    nodes.kills.textContent = String(player.kills);
  }
  nodes.pause.hidden = !state.time.paused || state.doc.open;
  const charging = state.phase === 'play' && player.alive && player.chargeT > 0;
  if (nodes.charge) {
    nodes.charge.hidden = !charging;
    if (charging) {
      const ready = player.chargeT >= CONFIG.weapon.chargeHold;
      nodes.charge.classList.toggle('ready', ready);
      nodes.chargeFill.style.transform = `scaleX(${Math.min(1, player.chargeT / CONFIG.weapon.chargeHold)})`;
      nodes.chargeLabel.textContent = ready ? '松开射击' : '蓄力';
    }
  }
  if (!nodes.pause.hidden) fillPauseStats(nodes, state);
  nodes.pad.hidden = state.input.device !== 'gamepad';
  const pointer = state.input.pointer;
  nodes.stick.hidden = !pointer.active;
  if (pointer.active) {
    nodes.stick.style.left = `${pointer.x - 60}px`;
    nodes.stick.style.top = `${pointer.y - 60}px`;
    const reach = 36;
    const mag = Math.hypot(pointer.dx, pointer.dy) || 1;
    const clamp = Math.min(reach, mag);
    nodes.nub.style.transform = `translate(${(pointer.dx / mag) * clamp}px, ${(pointer.dy / mag) * clamp}px)`;
  }
}

function nearestDocument(state) {
  const list = state.view && state.view.evidence && state.view.evidence.interactables;
  if (!list) return '';
  const player = state.player;
  let best = '';
  let bestD = 2.2;
  // 谁近读谁，没有例外。原来这里有一条「走近军箱优先给随箱名册」的硬偏袒，
  // 是替 0.14 m 间距打补丁；2026-11-17 把册子挪到第二只箱子上（见 evidence.js），
  // 两件东西各有各的脚下位置，偏袒一撤就干净了。
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    const d = Math.hypot(item.x - player.x, item.z - player.z);
    if (d < bestD) {
      bestD = d;
      best = item.id;
    }
  }
  return best;
}


// 文书正文只在「换成另一件东西」时重排一次。syncBattle 每帧都跑，
// 逐帧重建 innerHTML 会把面板的滚动位置和动画一直顶回去。
let docShownId = '';

function paintDocument(id) {
  const nodes = dom();
  const doc = documentFor(id);
  if (!doc) return;
  if (nodes.docOffice) nodes.docOffice.textContent = doc.office;
  if (nodes.docTitle) nodes.docTitle.textContent = doc.title;
  if (nodes.docMeta) nodes.docMeta.textContent = doc.meta;
  if (nodes.docSign) nodes.docSign.textContent = `署名：${doc.sign}`;
  if (nodes.docSeal) nodes.docSeal.textContent = doc.seal;
  if (nodes.docBody) {
    // 一条是一件事，用 textContent 而不是拼 HTML —— 正文里有顿号和引号，
    // 走字符串拼接迟早有一天被某个标点咬到。
    nodes.docBody.replaceChildren(...doc.body.map((line) => {
      const p = document.createElement('p');
      p.textContent = line;
      return p;
    }));
  }
  const panel = nodes.doc && nodes.doc.querySelector('.doc-panel');
  if (panel) {
    panel.scrollTop = 0;
    panel.classList.remove('drop');
    void panel.offsetWidth;
    panel.classList.add('drop');
  }
}

function syncBattle(state) {
  const nodes = dom();
  const input = state.input;
  if (state.phase === 'play') {
    state.doc.nearId = nearestDocument(state);
    if (input.useEdge && state.doc.nearId) {
      state.doc.open = !state.doc.open;
      state.time.paused = state.doc.open;
    } else if (input.confirm && state.doc.nearId && !state.upgrade.pending) {
      state.doc.open = !state.doc.open;
      state.time.paused = state.doc.open;
    } else if (input.pauseEdge && state.doc.open) {
      state.doc.open = false;
      state.time.paused = false;
      input.pauseEdge = false;
    }
    if (input.confirm && state.upgrade.pending) {
      const pick = state.upgrade.options[input.upgradeIndex] || state.upgrade.options[0];
      if (pick) applyUpgrade(state, pick.id);
    }
  }
  input.confirm = false;
  input.useEdge = false;

  const padHint = input.device === 'gamepad' && input.padConnected;
  if (nodes.levelup) nodes.levelup.hidden = !state.upgrade.pending || state.phase !== 'play';
  if (state.upgrade.pending && nodes.cards) {
    state.upgrade.options.forEach((opt, i) => {
      const card = nodes.cards[i];
      if (!card) return;
      const key = padHint ? '' : `按 ${i + 1}`;
      card.textContent = `${opt.text}\n${key}`;
      card.classList.toggle('selected', i === input.upgradeIndex);
    });
    if (nodes.pickHint) {
      nodes.pickHint.textContent = padHint ? '左摇杆左右选择，A 确定' : '';
    }
  }

  const showResult = state.phase === 'result';
  if (nodes.result) {
    if (showResult && nodes.result.hidden) {
      nodes.result.hidden = false;
      if (nodes.resultPanel) {
        nodes.resultPanel.classList.remove('drop');
        void nodes.resultPanel.offsetWidth;
        nodes.resultPanel.classList.add('drop');
      }
    }
    if (!showResult) nodes.result.hidden = true;
  }
  if (showResult && nodes.resultTitle) {
    nodes.resultTitle.textContent = state.result.win ? '通关' : '失败';
    const sec = Math.floor(state.time.elapsed);
    nodes.resultStats.textContent = `存活 ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}　击杀 ${state.player.kills}　等级 ${state.player.level}　最高连击 ${state.player.bestCombo}`;
  }

  const boss = state.enemies[0];
  const showBoss = boss && boss.kind === 'hese' && (boss.alive || state.result.hold > 0);
  if (nodes.bossBar) nodes.bossBar.hidden = !showBoss;
  if (showBoss && nodes.bossSegs) {
    const ratio = boss.hpMax > 0 ? Math.max(0, boss.hp / boss.hpMax) : 0;
    const parts = CONFIG.boss.hpSegments || nodes.bossSegs.length;
    nodes.bossSegs.forEach((seg, i) => {
      const local = Math.max(0, Math.min(1, ratio * parts - i));
      seg.style.transform = `scaleX(${local})`;
    });
    if (nodes.bossName) nodes.bossName.textContent = CONFIG.boss.name;
  }

  if (nodes.docHint) {
    const showHint = state.phase === 'play' && state.doc.nearId && !state.doc.open;
    nodes.docHint.hidden = !showHint;
    if (showHint) nodes.docHint.textContent = padHint ? '查看文书，A' : '查看文书，E';
  }
  if (nodes.doc) nodes.doc.hidden = !state.doc.open;
  if (state.doc.open && state.doc.nearId) {
    if (docShownId !== state.doc.nearId) {
      paintDocument(state.doc.nearId);
      docShownId = state.doc.nearId;
    }
  } else if (!state.doc.open) {
    docShownId = '';
  }
  if (nodes.docKey) nodes.docKey.textContent = padHint ? '再按 A 或 Esc 关闭' : '再按 E 或 Esc 关闭';

  if (nodes.arrows && state.phase === 'play') {
    const old = nodes.arrows.children;
    while (old.length) old[0].remove();
    state.chests.forEach((chest) => {
      if (!chest.alive) return;
      const dx = chest.x - state.player.x;
      const dz = chest.z - state.player.z;
      let dist = Math.hypot(dx, dz);
      const half = CONFIG.arena.half;
      if (dx > half) dist = Math.hypot(dx - CONFIG.arena.size, dz);
      if (dx < -half) dist = Math.hypot(dx + CONFIG.arena.size, dz);
      if (dist < CONFIG.chests.arrowBeyond) return;
      const type = CONFIG.chests.types[chest.type] || CONFIG.chests.types.xp;
      const arrow = document.createElement('div');
      arrow.className = 'chest-arrow';
      arrow.style.color = type.color;
      const ang = Math.atan2(dx, -dz);
      arrow.style.left = `${50 + Math.sin(ang) * 42}%`;
      arrow.style.top = `${50 - Math.cos(ang) * 36}%`;
      arrow.textContent = '▲';
      nodes.arrows.appendChild(arrow);
    });
  }

  if (nodes.settings) nodes.settings.hidden = !state.ui.settings;
  document.querySelectorAll('#settings [data-pane]').forEach((pane) => {
    pane.hidden = pane.dataset.pane !== state.ui.tab;
  });
  document.querySelectorAll('#settings [data-tab]').forEach((button) => {
    button.classList.toggle('selected', button.dataset.tab === state.ui.tab);
  });
  if (nodes.padHead) nodes.padHead.textContent = input.padConnected ? '手柄' : '手柄未连接';
  document.querySelectorAll('#settings .pad-col').forEach((cell) => {
    cell.classList.toggle('off', !input.padConnected);
  });
  document.getElementById('sweep-on')?.classList.toggle('selected', state.settings.sweep);
  document.getElementById('sweep-off')?.classList.toggle('selected', !state.settings.sweep);
}

function syncShell(state) {
  const nodes = dom();
  if (state.ui.settings && state.phase === 'howto') state.phase = 'menu';
  const onTitle = state.phase === 'menu' || state.phase === 'howto';
  nodes.root.classList.toggle('in-play', state.phase === 'play' || state.phase === 'result');
  nodes.menu.hidden = !onTitle;
  if (nodes.menuCopy) nodes.menuCopy.hidden = state.phase === 'howto' || (state.ui.settings && onTitle);
  nodes.howto.hidden = state.phase !== 'howto';
  if (nodes.settings) nodes.settings.classList.toggle('over-cover', onTitle && state.ui.settings);
}

export function updateRenderAndHUD(state, dt) {
  if (!state.view) return;
  if (state.phase === 'play' || state.phase === 'result') {
    const vol = state.settings.volume * state.settings.sfx;
    if (state.fx.whoosh) {
      state.fx.whoosh = false;
      state.view.synth.play('whoosh', vol);
    }
    while (state.fx.queue.length) state.view.synth.play(state.fx.queue.shift(), vol);
    if (state.phase === 'play' && state.input.pauseEdge && !state.doc.open) {
      if (state.ui.settings) state.ui.settings = false;
      else state.time.paused = !state.time.paused;
    }
    syncHero(state, dt);
    syncBorderFX(state);
    syncCamera(state, dt);
    syncHud(state);
    if (state.view.actors) state.view.actors.update(state, dt);
  } else {
    syncHero(state, dt);
    state.view.hero.rotation.y = 0;
    syncMenuCamera(state);
  }
  syncBattle(state);
  syncShell(state);
  const grass = state.view.grass;
  if (grass) {
    // 包裹中心必须是视野中心（玩家），不能用相机位置：机位在玩家身后
    // 约 10 m，按相机包裹会让画面上方（远处）掉出草场范围，出现无草带。
    const player = state.player;
    grass.update(player.x, player.z, state.time.elapsed);
  }
  const path = state.view.path;
  if (path) {
    // 路面高光跟着玩家走，权重用和移动完全相同的 pathBlend，两边不会脱节。
    path.update(state.player.x, state.player.z, state.player.pathBlend);
  }
  // 四角氛围：按玩家位置驱动雾 / 点光 / 飘灰的浓度。
  const ambience = state.view.ambience;
  if (ambience) ambience.update(state.player.x, state.player.z, state.time.elapsed);
  // 大体量物件的近距离淡出：把玩家坐标喂给灌木 / 枯树 / 树 / 林块四份材质，
  // 离得近的那几件逐像素裁掉。不这么做的话，镜头在玩家身后，前面那棵 5.6 m 的树
  // 会把人整个盖住 —— 那是「灌木有碰撞箱」这个误会真正的来源
  // （碰撞实测不存在，见 scenery.js 的 FADE_SPEC 注释）。
  const scenery = state.view.scenery;
  if (scenery && scenery.fadeUniforms) {
    for (const key of Object.keys(scenery.fadeUniforms)) {
      scenery.fadeUniforms[key].value.set(state.player.x, state.player.z);
    }
  }
  // 调试 Boss 自走自己的动作与轮播，不读任何玩法状态。
  if (state.view.debugBoss) state.view.debugBoss.update(dt);
  state.view.renderer.render(state.view.scene, state.view.camera);
}
