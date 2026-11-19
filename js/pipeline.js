// 区块 5 [ASSET & TOON PIPELINE]
// 加载、底部归零、Toon 替换、缺文件时的几何体。音效只提供穿门 whoosh。

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const loader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath('vendor/draco/');
// Draco 每个网格独立解码（Google Draco / three.js #15249）。多网格场景用 worker 池
// 才能并行；单网格模型也不会因此多下一次解码器。
const dracoWorkers = Math.min(8, Math.max(4, navigator.hardwareConcurrency || 4));
draco.setWorkerLimit(dracoWorkers);
loader.setDRACOLoader(draco);
let gradientMap = null;
let synth = null;

// _initDecoder 会再去拉 wrapper 和 wasm。这里把已经下好的字节直接交回去，
// 避免解码器在关键路径上走两遍网络。
const decoderBytes = new Map();
const loadLibrary = draco._loadLibrary.bind(draco);
draco._loadLibrary = function loadCachedLibrary(filename, responseType) {
  if (decoderBytes.has(filename)) return Promise.resolve(decoderBytes.get(filename));
  return loadLibrary(filename, responseType);
};

// 进主界面之前先把字节数摊进一条进度。GLTFLoader.loadAsync 只有文件个数，
// 主角一个文件就占掉大部分时间，按个数走进度条会长时间停在半截。
// 这里改成自己 fetch（能读到 Content-Length），解析完再把这一项记满。
const loadTasks = new Map();
const loadListeners = new Set();
const decodedImages = new Map();
let loadSeq = 0;
let loadScheduled = false;
let bootPresented = false;
let grassTexture = null;
let grassTexturePromise = null;
let dracoPromise = null;
const inflight = new Map();
const PARSE_LIMIT = 4;
let parseActive = 0;
const parseWaiters = [];

function loadLabel(url) {
  if (url.includes('fyagent_cover')) return '封面';
  if (url.includes('emblem_knight')) return '纹章';
  if (url.includes('env_base_grass')) return '地面';
  if (url.includes('draco_')) return '解码器';
  if (url.includes('/hero/')) return '主角';
  if (url.includes('/enemies/')) return '敌人';
  if (url.includes('/anim/')) return '动作';
  if (url.includes('/env/')) return '场景';
  return '资源';
}

function loadSnapshot() {
  let loaded = 0;
  let total = 0;
  let label = '';
  let labelWeight = -1;
  for (const task of loadTasks.values()) {
    const known = task.total > 0;
    const weight = known ? task.total : Math.max(task.loaded / 0.85, 256 * 1024);
    let doneBytes;
    if (task.done) doneBytes = weight;
    else if (task.parsing) doneBytes = weight * 0.92;
    else doneBytes = Math.min(task.loaded, weight * 0.9);
    loaded += doneBytes;
    total += weight;
    if (!task.done && weight > labelWeight) {
      labelWeight = weight;
      label = task.label;
    }
  }
  const raw = total > 0 ? loaded / total : 0;
  return {
    ratio: bootPresented ? 1 : raw * 0.92,
    label,
    presenting: !bootPresented && total > 0 && !label,
  };
}

function flushLoadProgress() {
  loadScheduled = false;
  const snap = loadSnapshot();
  for (const fn of loadListeners) fn(snap);
}

function emitLoadProgress() {
  if (loadScheduled) return;
  loadScheduled = true;
  requestAnimationFrame(flushLoadProgress);
}

export function onAssetProgress(fn) {
  loadListeners.add(fn);
  fn(loadSnapshot());
  return () => loadListeners.delete(fn);
}

export function finishBootPresentation() {
  bootPresented = true;
  flushLoadProgress();
}

function trackStart(url, label) {
  const id = ++loadSeq;
  loadTasks.set(id, { url, label: label || loadLabel(url), loaded: 0, total: 0, done: false, parsing: false });
  emitLoadProgress();
  return id;
}

function trackBytes(id, loaded, total) {
  const task = loadTasks.get(id);
  if (!task || task.done) return;
  task.loaded = loaded;
  if (total > 0) task.total = total;
  emitLoadProgress();
}

function trackParsing(id) {
  const task = loadTasks.get(id);
  if (!task || task.done) return;
  task.parsing = true;
  if (task.total <= 0) task.total = Math.max(task.loaded, 1);
  emitLoadProgress();
}

function trackDone(id) {
  const task = loadTasks.get(id);
  if (!task) return;
  task.done = true;
  task.parsing = false;
  if (task.total <= 0) task.total = Math.max(task.loaded, 1);
  task.loaded = task.total;
  emitLoadProgress();
}

function trackFail(id) {
  loadTasks.delete(id);
  emitLoadProgress();
}

function priorityFor(url) {
  if (url.includes('/hero/hero.glb') || url.includes('draco_decoder.wasm') || url.includes('fyagent_cover')) {
    return 'high';
  }
  return 'auto';
}

function takeWarmResponse(url) {
  const warm = window.__fyawaWarm;
  if (!warm || typeof warm.take !== 'function') return null;
  return warm.take(url);
}

async function readResponse(response, id) {
  if (!response.ok) throw new Error(`${response.status} ${response.url || ''}`);
  const declared = Number(response.headers.get('content-length')) || 0;
  if (declared) trackBytes(id, 0, declared);
  const reader = response.body && response.body.getReader ? response.body.getReader() : null;
  if (!reader) {
    const buffer = await response.arrayBuffer();
    trackBytes(id, buffer.byteLength, buffer.byteLength);
    return buffer;
  }
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    trackBytes(id, received, declared);
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  trackBytes(id, received, declared || received);
  return merged.buffer;
}

function acquireParse(high) {
  return new Promise((resolve) => {
    const grant = () => {
      parseActive += 1;
      resolve(() => {
        parseActive -= 1;
        const next = parseWaiters.shift();
        if (next) next();
      });
    };
    if (parseActive < PARSE_LIMIT) grant();
    else if (high) parseWaiters.unshift(grant);
    else parseWaiters.push(grant);
  });
}

async function fetchArrayBuffer(url, label) {
  const existing = inflight.get(url);
  if (existing) {
    existing.readers += 1;
    const buffer = await existing.promise;
    return { id: existing.id, buffer: existing.readers > 1 ? buffer.slice(0) : buffer };
  }
  const id = trackStart(url, label);
  const slot = { id, readers: 1, promise: null };
  slot.promise = (async () => {
    const warm = takeWarmResponse(url);
    let response = null;
    if (warm) {
      try {
        response = await warm;
        if (!response.ok) response = null;
      } catch (err) {
        response = null;
      }
    }
    if (!response) response = await fetch(url, { priority: priorityFor(url) });
    return readResponse(response, id);
  })().catch((err) => {
    trackFail(id);
    inflight.delete(url);
    throw err;
  });
  inflight.set(url, slot);
  const buffer = await slot.promise;
  return { id, buffer: slot.readers > 1 ? buffer.slice(0) : buffer };
}

async function decodeImage(buffer, mime) {
  const blobUrl = URL.createObjectURL(new Blob([buffer], mime ? { type: mime } : undefined));
  const image = new Image();
  image.src = blobUrl;
  try {
    if (image.decode) await image.decode();
    else {
      await new Promise((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('图片没有解码'));
      });
    }
  } catch (err) {
    URL.revokeObjectURL(blobUrl);
    throw err;
  }
  return image;
}

// wrapper 和 wasm 并行下。下载和后面的 GLB 抢的是同一条连接，所以不要串行等解码器
// 再开始下模型（three.js #18097：几何下载不该排在别的资源后面）。
export function preloadDracoDecoder() {
  if (dracoPromise) return dracoPromise;
  dracoPromise = (async () => {
    const [wrapper, wasm] = await Promise.all([
      fetchArrayBuffer('vendor/draco/draco_wasm_wrapper.js', '解码器'),
      fetchArrayBuffer('vendor/draco/draco_decoder.wasm', '解码器'),
    ]);
    decoderBytes.set('draco_wasm_wrapper.js', new TextDecoder().decode(wrapper.buffer));
    decoderBytes.set('draco_decoder.wasm', wasm.buffer);
    trackDone(wrapper.id);
    trackParsing(wasm.id);
    try {
      await draco._initDecoder();
      trackDone(wasm.id);
    } catch (err) {
      trackFail(wasm.id);
      throw err;
    }
  })();
  return dracoPromise;
}

export function preloadDecodedImage(url, label) {
  if (decodedImages.has(url)) return decodedImages.get(url);
  const promise = (async () => {
    const { id, buffer } = await fetchArrayBuffer(url, label);
    try {
      trackParsing(id);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const image = await decodeImage(buffer);
      trackDone(id);
      return image;
    } catch (err) {
      trackFail(id);
      throw err;
    }
  })().catch((err) => {
    decodedImages.delete(url);
    throw err;
  });
  decodedImages.set(url, promise);
  return promise;
}

export function preloadedImage(url) {
  return decodedImages.get(url) || null;
}

export function preloadCover(url) {
  return (async () => {
    const { id, buffer } = await fetchArrayBuffer(url, '封面');
    try {
      trackParsing(id);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const image = await decodeImage(buffer, 'image/png');
      const cover = document.getElementById('cover');
      if (cover) cover.src = image.src;
      trackDone(id);
    } catch (err) {
      trackFail(id);
      throw err;
    }
  })();
}

export function preloadGrassTexture() {
  if (grassTexturePromise) return grassTexturePromise;
  grassTexturePromise = (async () => {
    const url = 'models/active/env/textures/env_base_grass.jpg';
    const { id, buffer } = await fetchArrayBuffer(url, '地面');
    let image;
    try {
      trackParsing(id);
      await new Promise((resolve) => setTimeout(resolve, 0));
      image = await decodeImage(buffer, 'image/jpeg');
    } catch (err) {
      trackFail(id);
      throw err;
    }
    const texture = new THREE.Texture(image);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 8;
    grassTexture = texture;
    trackDone(id);
    return texture;
  })().catch((err) => {
    grassTexturePromise = null;
    throw err;
  });
  return grassTexturePromise;
}

export function cloneGrassTexture() {
  if (!grassTexture) throw new Error('草地贴图还没预加载');
  const texture = grassTexture.clone();
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

// 光照查找表。原来 3 阶 + NearestFilter，明暗只有两次跳变，是所有材质
// 「卡通味」的共同来源。改 8 阶 + LinearFilter 后过渡接近 Lambert，
// 但仍保留一档压缩，属于 B 路线「平滑卡通」。暗部保留原来的偏冷倾向。
const GRADIENT_STEPS = [
  48, 48, 52,
  74, 74, 78,
  104, 104, 108,
  138, 138, 142,
  174, 174, 178,
  206, 206, 210,
  232, 232, 235,
  252, 252, 255,
];

export function createToonGradientMap() {
  if (gradientMap) return gradientMap;
  const data = new Uint8Array(GRADIENT_STEPS.length / 3 * 4);
  for (let i = 0; i < GRADIENT_STEPS.length / 3; i += 1) {
    data[i * 4] = GRADIENT_STEPS[i * 3];
    data[i * 4 + 1] = GRADIENT_STEPS[i * 3 + 1];
    data[i * 4 + 2] = GRADIENT_STEPS[i * 3 + 2];
    data[i * 4 + 3] = 255;
  }
  gradientMap = new THREE.DataTexture(data, GRADIENT_STEPS.length / 3, 1);
  gradientMap.magFilter = THREE.LinearFilter;
  gradientMap.minFilter = THREE.LinearFilter;
  gradientMap.colorSpace = THREE.NoColorSpace;
  gradientMap.needsUpdate = true;
  return gradientMap;
}

function convertToToon(root) {
  const gradient = createToonGradientMap();
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    const source = Array.isArray(obj.material) ? obj.material : [obj.material];
    const next = source.map((mat) => {
      const map = mat && mat.map ? mat.map : null;
      if (map) map.colorSpace = THREE.SRGBColorSpace;
      const color = mat && mat.color ? mat.color.clone() : new THREE.Color(0xffffff);
      return new THREE.MeshToonMaterial({ color, map, gradientMap: gradient });
    });
    obj.material = next.length === 1 ? next[0] : next;
    obj.castShadow = false;
    obj.receiveShadow = false;
  });
}

function stripRootMotion(clip) {
  const tracks = clip.tracks.filter((track) => {
    const root = /GameRoot|Armature|^Root/i.test(track.name);
    return !(root && track.name.endsWith('.position'));
  });
  if (tracks.length === clip.tracks.length) return clip;
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

export function findClip(clips, pattern) {
  if (!pattern) return null;
  const re = new RegExp(pattern, 'i');
  return clips.find((clip) => re.test(clip.name)) || null;
}

export async function loadAndNormalizeGLB(url, config = {}) {
  const download = fetchArrayBuffer(url);
  const decoder = preloadDracoDecoder().catch((err) => {
    console.warn('[boot] Draco 预加载失败，继续尝试直接解析', err);
  });
  const { id, buffer } = await download;
  await decoder;
  trackParsing(id);
  const release = await acquireParse(url.includes('/hero/hero.glb'));
  try {
    const path = url.slice(0, url.lastIndexOf('/') + 1);
    const gltf = await loader.parseAsync(buffer, path);
    const model = gltf.scene;
    model.updateMatrixWorld(true);

    const measured = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    measured.getSize(size);
    if (config.autoScale && config.targetHeight > 0 && size.y > 0) {
      model.scale.multiplyScalar(config.targetHeight / size.y);
    }
    if (config.scale && config.scale !== 1) model.scale.multiplyScalar(config.scale);
    model.updateMatrixWorld(true);

    const fitted = new THREE.Box3().setFromObject(model);
    const center = new THREE.Vector3();
    fitted.getCenter(center);
    model.position.x -= center.x;
    model.position.z -= center.z;
    model.position.y -= fitted.min.y;
    model.position.y += config.offsetY || 0;

    const pivot = new THREE.Group();
    pivot.rotation.y = config.rotationY || 0;
    pivot.add(model);
    convertToToon(pivot);

    const clips = (gltf.animations || []).map(stripRootMotion);
    trackDone(id);
    return { pivot, clips, fallback: false };
  } catch (err) {
    trackFail(id);
    throw err;
  } finally {
    release();
  }
}

export function createFallbackMesh(kind) {
  const gradient = createToonGradientMap();
  const group = new THREE.Group();
  group.name = `fallback-${kind}`;
  const coat = new THREE.MeshToonMaterial({ color: 0x1b1f2a, gradientMap: gradient });
  const cloth = new THREE.MeshToonMaterial({ color: 0xf4f7fb, gradientMap: gradient });
  const accent = new THREE.MeshToonMaterial({ color: 0x1e9be8, gradientMap: gradient });

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.55, 4, 8), coat);
  body.position.y = 0.72;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), cloth);
  head.position.y = 1.28;
  const hair = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.12, 0.3), accent);
  hair.position.set(0, 1.46, 0);
  group.add(body, head, hair);
  return group;
}

export function createSynth() {
  if (synth) return synth;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  let ctx = null;
  function context() {
    if (!AudioContext) return null;
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  const tones = {
    whoosh: [180, 60, 0.2, 'sine'],
    shoot: [880, 440, 0.06, 'square'],
    hit: [240, 120, 0.05, 'triangle'],
    hurt: [140, 70, 0.12, 'sawtooth'],
    chest: [520, 880, 0.16, 'sine'],
    charge: [90, 40, 0.28, 'sawtooth'],
    bossHit: [70, 30, 0.22, 'square'],
  };
  // 轰是落地的一击：攻击要短，主体是往下掉的低频，再加一层很快灭掉的噪声。
  // 跟 charge 一样的锯齿滑音听起来是在蓄力，不是砸中地面。
  function playSlam(audio, volume, t) {
    const body = audio.createOscillator();
    const bodyGain = audio.createGain();
    body.type = 'sine';
    body.frequency.setValueAtTime(95, t);
    body.frequency.exponentialRampToValueAtTime(30, t + 0.34);
    bodyGain.gain.setValueAtTime(0.0001, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.24 * volume, t + 0.008);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
    body.connect(bodyGain);
    bodyGain.connect(audio.destination);
    body.start(t);
    body.stop(t + 0.44);

    const low = audio.createOscillator();
    const lowGain = audio.createGain();
    low.type = 'triangle';
    low.frequency.setValueAtTime(52, t);
    low.frequency.exponentialRampToValueAtTime(24, t + 0.36);
    lowGain.gain.setValueAtTime(0.0001, t);
    lowGain.gain.exponentialRampToValueAtTime(0.14 * volume, t + 0.012);
    lowGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    low.connect(lowGain);
    lowGain.connect(audio.destination);
    low.start(t);
    low.stop(t + 0.42);

    const frames = Math.max(1, Math.floor(audio.sampleRate * 0.08));
    const buffer = audio.createBuffer(1, frames, audio.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i += 1) data[i] = Math.random() * 2 - 1;
    const noise = audio.createBufferSource();
    noise.buffer = buffer;
    const filter = audio.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(220, t);
    filter.frequency.exponentialRampToValueAtTime(70, t + 0.08);
    const noiseGain = audio.createGain();
    noiseGain.gain.setValueAtTime(0.18 * volume, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    noise.connect(filter);
    filter.connect(noiseGain);
    noiseGain.connect(audio.destination);
    noise.start(t);
    noise.stop(t + 0.09);
  }
  synth = {
    play(name, volume = 1) {
      const audio = context();
      if (!audio || volume <= 0) return;
      const t = audio.currentTime;
      if (name === 'slam') {
        playSlam(audio, volume, t);
        return;
      }
      const tone = tones[name];
      if (!tone) return;
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = tone[3];
      osc.frequency.setValueAtTime(tone[0], t);
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, tone[1]), t + tone[2]);
      const peak = 0.08 * volume;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + tone[2]);
      osc.connect(gain);
      gain.connect(audio.destination);
      osc.start(t);
      osc.stop(t + tone[2] + 0.02);
    },
  };
  return synth;
}
