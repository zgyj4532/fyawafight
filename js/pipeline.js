// 区块 5 [ASSET & TOON PIPELINE]
// 加载、底部归零、Toon 替换、缺文件时的几何体。音效只提供穿门 whoosh。

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const loader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath('vendor/draco/');
loader.setDRACOLoader(draco);
let gradientMap = null;
let synth = null;

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
  const gltf = await loader.loadAsync(url);
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
  return { pivot, clips, fallback: false };
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
  synth = {
    play(name) {
      const audio = context();
      if (!audio || name !== 'whoosh') return;
      const t = audio.currentTime;
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(180, t);
      osc.frequency.exponentialRampToValueAtTime(60, t + 0.18);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      osc.connect(gain);
      gain.connect(audio.destination);
      osc.start(t);
      osc.stop(t + 0.21);
    },
  };
  return synth;
}
