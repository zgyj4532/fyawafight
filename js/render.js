// 区块 6 · updateRenderAndHUD
// 石板庭院、主界面、主角、镜头和 DOM 脏检查。不改玩法数值，只消费 fx.whoosh。

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { createGrassField } from './grass.js';
import { createDirtPath, terrainY } from './path.js';
import { createRoadProps } from './props.js';
import { createNarrativeScenery } from './narrative.js';
import { createEvidence } from './evidence.js';
import { createScenery } from './scenery.js';
import { createBorderFX } from './borderfx.js';
import { createBossView } from './bossview.js';
import { assertClearances, colliderStats, debugSegmentCount, writeDebugXZ } from './collision.js';
import {
  createFallbackMesh,
  createSynth,
  createToonGradientMap,
  findClip,
  loadAndNormalizeGLB,
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
  hud.note = document.getElementById('boot-note');
  hud.root = document.getElementById('hud');
  hud.menu = document.getElementById('menu');
  hud.howto = document.getElementById('howto');
  hud.start = document.getElementById('btn-start');
  hud.howtoOpen = document.getElementById('btn-howto');
  hud.howtoBack = document.getElementById('btn-howto-back');
  return hud;
}

function bindMenu(state) {
  const nodes = dom();
  if (nodes.menuBound) return;
  nodes.menuBound = true;
  nodes.start.addEventListener('click', () => startGame(state));
  nodes.howtoOpen.addEventListener('click', () => {
    state.phase = 'howto';
  });
  nodes.howtoBack.addEventListener('click', () => {
    state.phase = 'menu';
  });
}

function startGame(state) {
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
  const texture = new THREE.TextureLoader().load('models/env/textures/env_base_grass.jpg');
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(4, 4);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
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
  const texture = new THREE.TextureLoader().load('models/env/textures/env_base_grass.jpg');
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(FAR_GROUND_SIZE / FAR_GROUND_TILE, FAR_GROUND_SIZE / FAR_GROUND_TILE);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
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

export async function bootView(state) {
  bindMenu(state);
  const canvas = document.getElementById('view');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = false;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CONFIG.renderer.maxPixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new THREE.Scene();
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

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(CONFIG.arena.size, CONFIG.arena.size),
    new THREE.MeshToonMaterial({ map: groundTexture(), color: 0xffffff, gradientMap: createToonGradientMap() }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  // 竞技场之外的同款地面。没有这一块，靠近地图边界时画面上沿会露出一条背景色
  // （那条"黑边"就是它，不是墙）。见上面的注释。
  const farGround = createFarGround();
  scene.add(farGround);

  const grass = createGrassField();
  scene.add(grass.mesh);

  // 土路压在地面之上、草丛之下。草场的顶点着色器会按同一套中心线把草压平，
  // 于是路面是干净的，路肩是渐变的，中间不需要遮罩贴图。
  const path = createDirtPath();
  scene.add(path.group);

  // 路旁陈设：栅栏、里程碑、路标、翻倒的车轮、木桶、石堆、干草。
  // 构建期全部烘成一个合并网格，运行时只占两次 draw call。
  const roadProps = createRoadProps();
  scene.add(roadProps.group);

  // 证据链陈设（A 组拴养排与转运场、B 组封条军箱与命令文书，见 js/evidence.js）。
  // 第八批起换成 Lux3D 的五个 GLB，所以是异步的：和主角、叙事、体量层并行加载。
  // 它补的是五幕里缺的那一段 —— 「兽是怎么来的」。位置接在幕四骨骸的两侧。
  const evidenceTask = createEvidence();

  // 叙事陈设（五幕，见 js/narrative.js）。八个体量物合计约 7 MB，和主角并行加载；
  // 串行等的话，进场会多停两秒。
  const narrativeTask = createNarrativeScenery();

  // 体量层（远景的山、林、岩，见 js/scenery.js）。同样并行加载 ——
  // 它回答的是「路外面还有没有世界」，没有它，远景是一望到底的空草地。
  const sceneryTask = createScenery();

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
  renderer.render(scene, camera);

  const loaded = await loadHero();
  const narrative = await narrativeTask;
  scene.add(narrative.group);
  if (narrative.failed.length) {
    console.warn('[narrative] 未加载的资产', narrative.failed);
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
    narrative,
    scenery,
    evidence,
    debugBoss,
  };
  state.assets.ready = true;
  state.assets.hero = hero;
  state.assets.fallback = !!loaded.fallback;
  // 调试钩子：可在控制台读 renderer.info 核对三角数与绘制调用。
  window.__view = state.view;

  if (location.protocol === 'file:') {
    showNote('直接双击 HTML 会被浏览器拦住模型。请在仓库根目录运行 python -m http.server，然后打开 http://127.0.0.1:8000/ 。现在用几何体代替主角。');
  } else if (loaded.fallback) {
    showNote('主角模型没有载入，已改用几何体。确认用本地 HTTP 服务打开，并且 models/rigged_v1/protagonist_rigged_v1.glb 还在。');
  } else {
    showNote('');
  }

  syncMenuCamera(state);
  syncHero(state, 0.05);
  state.view.hero.rotation.y = 0;
  syncShell(state);
  renderer.render(scene, camera);
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

function syncCamera(state) {
  const view = state.view;
  const camera = state.camera;
  // 相机高度是 movement.js 缓出来的（带滞后），注视点用主角脚下的实时高度：
  // 两者差出来的那点视差，就是上坡/下坡能看出来的原因。
  const groundY = terrainY(state.player.x, state.player.z);
  view.camera.position.set(camera.x, camera.y, camera.z);
  view.camera.fov = camera.fov;
  view.camera.updateProjectionMatrix();
  view.camera.lookAt(state.player.x, groundY + 0.9, state.player.z);
  view.menuLight.visible = false;
  const streaks = view.streaks;
  streaks.visible = camera.speedLineT > 0;
  streaks.material.opacity = camera.speedLineT > 0 ? camera.speedLineT / CONFIG.camera.speedLine : 0;
}

function syncHud(state) {
  const nodes = dom();
  const player = state.player;
  const hp = player.hp / player.hpMax;
  if (state.hud.hp !== hp) {
    state.hud.hp = hp;
    nodes.hp.style.transform = `scaleX(${Math.max(0, hp)})`;
  }
  const need = CONFIG.formulas.xpBase + CONFIG.formulas.xpPerLevel * (player.level - 1);
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
  nodes.pause.hidden = !state.time.paused;
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

function syncShell(state) {
  const nodes = dom();
  nodes.root.classList.toggle('in-play', state.phase === 'play');
  nodes.menu.hidden = state.phase !== 'menu';
  nodes.howto.hidden = state.phase !== 'howto';
}

export function updateRenderAndHUD(state, dt) {
  if (!state.view) return;
  if (state.phase === 'play') {
    if (state.fx.whoosh) {
      state.fx.whoosh = false;
      state.view.synth.play('whoosh');
    }
    if (state.input.pauseEdge) state.time.paused = !state.time.paused;
    syncHero(state, dt);
    syncBorderFX(state);
    syncCamera(state);
    syncHud(state);
  } else {
    syncHero(state, dt);
    state.view.hero.rotation.y = 0;
    syncMenuCamera(state);
  }
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
  // 调试 Boss 自走自己的动作与轮播，不读任何玩法状态。
  if (state.view.debugBoss) state.view.debugBoss.update(dt);
  state.view.renderer.render(state.view.scene, state.view.camera);
}
