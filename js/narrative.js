// 区块 6e · 叙事陈设层
//
// 前面的 6b 草、6c 土路、6d 路旁道具解决的是「这里长什么样」。
// 这一层解决另一个问题：**玩家走过之后，能不能说出这里发生过什么。**
//
// 关键判断：单个道具只能暗示，剧情是靠「顺序」讲出来的。
// 所以这些物件不是随机撒在路边的装饰，而是一条沿路铺开的五幕戏 ——
// 沿 +x 方向一直走，正好走完一圈（世界是 120 m 环面），回到出生点时，
// 最初那个「什么都很正常」的路口已经被重新理解了。这就是这一层的全部设计。
//
//   幕一  0…16     路还在用：车辙、路标、里程碑、木桶 —— 都还是立着的
//   幕二 16…27     人走了：一口井、一个凉掉的火塘、一辆翻倒的车 —— 走得急
//   幕三 32…40     处决：断墙、掉在地上的盾和断剑、绞刑架 —— 谁在管这条路
//   幕四 44…−46    兽：巨兽骨骸压到路肩上，旁边一座立着十字架的坟 —— 这才是路荒掉的原因
//   幕五 −37…−27   更早的一层：一座门、一座塌掉的同款门、一圈立石 —— 兽来之前这里已经死过一次
//
// 摆位不写死坐标，而是写「沿路的里程 + 离中线的距离」，由 pathCenterZ / pathSlope
// 换算成世界坐标，和 6d 的路旁道具共用同一套公式，所以道具永远贴着路走。
//
// 资产是 G1 文生 3D 出的体量物，尺寸按 targetHeight 归一化到真实米数
// （生成时给的米数只能当参考，实测偏差可达 ±18%，见 docs/环境_体量层资产清单.md）。

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { loadAndNormalizeGLB, createToonGradientMap } from './pipeline.js';
import { pathCenterZ, pathSlope, terrainY } from './path.js';
import { COLLIDERS } from './collision-data.js';
import { registerAsset } from './collision.js';

const ASSET_ROOT = 'models/env/body/';

// targetHeight 是「这个物件进游戏后应该多高」，不是模型的原始高度。
// shadow 是贴地阴影片的 [半径, 纵向压扁]，没有 shadowMap，靠它把物件钉在地上。
// 文生 3D 出来的贴图基色偏冷偏亮（废墟石材实测是 A9AEB3 一带），
// 直接进场景会比 6d 的手绘道具白一档，看着像新砌的水泥，和土路草地完全不是一路。
//
// 但乘子不能给狠：three 的 Color.setHex 按 sRGB 解析后转 linear，
// 0xB2A892 落到线性空间只剩 0.44/0.39/0.29，等于把贴图压到四成亮度 ——
// 石井和绞刑架第一版就是这么变成黑木桶的。所以分两档：
// 大片浅色砌石（拱门、断塔）用 stone 压一档；本来就偏深的物件（井、木架）用 stoneLight 只压一点。
const TINTS = {
  stone: { color: 0xb2a892, gain: 1.0 },
  stoneLight: { color: 0xd6cebd, gain: 1.30 },
  bone: { color: 0xf0f2f5, gain: 1.05 },
  // 断塔是远景地标，比拱门亮一档是有意的，但 stoneLight 的 1.3 会白到像新砌的石灰岩。
  stoneMid: { color: 0xc8bfa8, gain: 1.12 },
  // 立石的贴图是冷灰蓝花岗岩（8B9196），压一档就成了深蓝块。场景的 ambient 本身是冷蓝
  // （0xd2dae4），灰石头进去只会更蓝，所以乘子要一路压到蓝通道只剩四成。
  // 立石的贴图是冷钢蓝（实测 R<G<B），压一档只会更蓝。要压回石场那种暖灰，
  // 只能把蓝通道乘到 0.45 左右、红通道顶到 1.2 —— 乘子写成暖黄色才够。
  granite: { color: 0xffd9a0, gain: 1.25 },
  // 碎木头、麻绳、车板。乘子只能压不能提 —— 贴图极暗时压到底就是一块黑铁架，
  // 这里反过来用 gain 把暗木提亮，才对得上 6d 那批红棕栅栏。
  wood: { color: 0xe0c8a8, gain: 1.55 },
  // 深色织物（裹尸布）。布料本身是 3A3226 一带，不提亮在俯视下就是一团黑。
  cloth: { color: 0xffe2c4, gain: 2.60 },
};

const ASSETS = {
  well: { file: 'stone_well.glb', height: 1.69, tint: 'stoneLight', shadow: [0.95, 0.92], ...COLLIDERS.well },
  pillar: { file: 'ruins_pillar.glb', height: 2.50, tint: 'stone', shadow: [1.10, 0.78], ...COLLIDERS.pillar },
  // 立石的贴图是冷灰蓝花岗岩，压一档就是一块蓝石头，和暖场景打架 ——
  // 换成井用的 stoneLight 之后才和拱门、断塔是同一个石场出来的。
  stones: { file: 'standing_stones.glb', height: 2.78, tint: 'granite', shadow: [1.75, 0.62], ...COLLIDERS.stones },
  archLow: { file: 'ruins_arch_low.glb', height: 3.00, tint: 'stone', shadow: [1.70, 0.58], ...COLLIDERS.archLow },
  // v2（第六批 6698848）：原始 2.805 宽 × 3.20 高 × 0.931 深，两根立柱严格垂直平行，
  // 柱心间距 2.44 m，横梁在 3.33 m 处外挑。归一化到 3.85 高（×1.20）后柱距 2.93 m、
  // 梁面 4.00 m —— 比原来的 A 字架高 10 cm，但底部不再收窄，俯视读成门形而不是木架。
  gallows: { file: 'gallows.glb', height: 3.85, tint: 'wood', shadow: [1.72, 0.50], ...COLLIDERS.gallows },
  // 拱门要横跨路面，但相机是固定俯角、永远顺着 -z 看（视线与路面法线成 27°），
  // 1.25 m 厚的券圈会把自己 2.8 m 的洞口挡掉 2.4 m，读出来就是一根柱子。
  // 所以形体要改，不是改朝向：跨度放宽到 6.25 m（洞口约 3.5 m），厚度压到 0.75 m，
  // 遮挡降到 1.45 m，洞口还剩下 2 m 能看见。y 不动，贴地关系不变。
  arch: { file: 'ruins_arch.glb', height: 4.95, tint: 'stone', shadow: [2.95, 0.52],
    reshape: [1.25, 1.0, 0.60], ...COLLIDERS.arch },
  tower: { file: 'watchtower_ruin.glb', height: 6.00, tint: 'stoneMid', shadow: [2.05, 0.82], ...COLLIDERS.tower },
  // 骨骸按「最长边 3.9 m」反算的等效高度：模型实测 3.6 宽 × 3.27 高 × 4.9 长，
  // 直接按 1.45 m 高归一化的话，整具骨架只剩 1.6 m 长，读不出「巨兽」。
  // 3.9 / 4.9 × 3.27 ≈ 2.60。
  skeleton: { file: 'beast_skeleton.glb', height: 2.60, tint: 'bone', shadow: [2.05, 0.92], ...COLLIDERS.skeleton },

  // 第四批：人的痕迹。上面八个是「这里是什么地方」，这四个是「这里的人怎么了」。
  // 尺寸全部按实测包围盒反算：推车 2.20 长本来就对，直接给高度 1.30；
  // 破盾那一组被生成成 0.75 m 的小件（又是 1.2 m 先验回落），按高度 1.05 放到
  // 盾面 1.2 m 左右；裹布十字架 2.0 m 是真人尺度，不用动。
  cart: { file: 'overturned_handcart.glb', height: 1.30, tint: 'wood', shadow: [1.35, 0.62], ...COLLIDERS.cart },
  shield: { file: 'broken_shield_sword.glb', height: 1.05, tint: 'stoneMid', shadow: [0.72, 0.72], ...COLLIDERS.shield },
  cloak: { file: 'cloak_cross.glb', height: 2.45, tint: 'cloth', shadow: [0.62, 0.34], ...COLLIDERS.cloak },
  // 火塘实测是 0.90 × 0.89 × 0.81 —— 又一个近立方体。原样进场景是一个直径 1.2 m 的圆包，
  // 又和 6d 的 cairn 撞车。高度按「直径 1.35 m」反算到 1.338，再用 y×0.25 压扁，
  // 得到 1.35 × 0.33。石头被压成扁卵石，正是半埋在地上的样子。
  // 压扁后最高 0.33 m，整件都在迈步高度 0.40 m 以下。加箱子会变成一道看不见的坎。
  campfire: { file: 'campfire_remains.glb', height: 1.338, tint: 'stoneMid',
    reshape: [1.0, 0.25, 1.0], shadow: [0.74, 0.74] },
};

// side: +1 在路的 +z 侧，−1 在 −z 侧。lateral: 离中心线的米数。
// yaw 是额外偏航，用来让同一个模型出现两次时不至于一眼认出来。
//
// 摆位按「组」而不是按「件」排。单件道具在 57 px/m 下只是路边一个形状，
// 两件离得近、朝向又相关的东西才会读成一件事 —— 营地、刑场、坟、废墟，
// 全是靠 3–6 m 内的两三件互相解释出来的。孤件只留两处：断塔（远景）和收尾的井。
const SPOTS = [
  // 幕二 · 人走了：一个营地。火塘凉了、井绳没了、车翻在门口。
  // 这一组全在 −z 侧、离路 5–7 m，正好是「院子」的尺度。
  // 三件之间留 3.5–4 m：俯视下一件 1.5 m 的东西只有 86 px，
  // 挤在一起就是一团，看不出是"火塘 + 井 + 车"三件事。
  { asset: 'campfire', x: 15.4, side: -1, lateral: 4.8, yaw: 0.4, note: '火塘在井边，凉了很久' },
  { asset: 'well', x: 19.4, side: -1, lateral: 5.8, yaw: 0.35, note: '井圈还在，绳没了' },
  { asset: 'cart', x: 23.0, side: -1, lateral: 6.4, yaw: 0.75, note: '车翻在营地门口，货撒了一地 —— 走得急' },
  { asset: 'pillar', x: 27.6, side: 1, lateral: 6.2, yaw: 1.05, note: '倒塌院墙的一角，在路的另一边' },

  // 幕三 · 处决：断墙、掉在地上的盾和断剑、绞刑架。
  // 顺序是顺着路的：先看到墙，再看到墙脚的装备，最后抬头是绞刑架。
  // 三件 3 m 上下一件，仍然是一处现场，但不再互相压住。
  { asset: 'pillar', x: 32.6, side: 1, lateral: 5.2, yaw: 0.2, note: '断墙，墙脚有东西' },
  { asset: 'shield', x: 35.4, side: 1, lateral: 4.8, yaw: -0.5, note: '盾还靠在石头上，剑断了 —— 抵抗过' },
  { asset: 'gallows', x: 38.6, side: 1, lateral: 4.4, yaw: -0.12, note: '贴在路肩上，是给过路人看的' },

  // 幕四 · 兽：巨兽骨骸，旁边一座坟。有人给它立了十字架、披了布。
  // 这两件必须同框，否则「谁埋了它」这层意思就没了。
  { asset: 'cloak', x: 41.6, side: 1, lateral: 6.2, yaw: -0.25, note: '裹布十字架，坟就在兽旁边' },
  { asset: 'skeleton', x: 45.4, side: 1, lateral: 3.6, yaw: 1.42, note: '横在路肩上，肋骨朝着路' },
  { asset: 'tower', x: -42, side: -1, lateral: 9.0, yaw: 0.25, note: '远景方向感，也是唯一的制高点' },

  // 幕五 · 更早的一层：一座门、一座塌了的门、一圈立石。
  // 三件收在 9 m 内，读成同一处遗址，而不是三个孤立的古董。
  { asset: 'arch', x: -35, side: 1, lateral: 0.4, yaw: Math.PI / 2, note: '门洞正对路面，玩家从下面穿过，是进入遗址区的界线' },
  { asset: 'archLow', x: -31.0, side: -1, lateral: 6.4, yaw: 0.9, note: '同一座门的另一半，塌了' },
  { asset: 'stones', x: -27.4, side: 1, lateral: 8.6, yaw: 0.6, note: '立石还站着，说明它比门更晚倒' },

  // 收尾 · 回到起点：一口井、一根柱子，正对着出生点。
  { asset: 'well', x: -12, side: 1, lateral: 5.8, yaw: 2.9, note: '和幕二那口井是同一类东西，读者自己会连起来' },
  { asset: 'pillar', x: -6.4, side: -1, lateral: 6.0, yaw: 2.1, note: '最后一根柱子，正对着出生点' },
];


const SHADOW_Y = 0.010;

// 模板加载完先染色，材质是 clone 共享的，只需染一次。
// gain > 1 用来提亮贴图本身极暗的模型（乘子只能压不能提，靠 color 超过 1 才提得起来）。
function tintTemplate(root, tint) {
  const t = typeof tint === 'string' ? { color: tint, gain: 1 } : tint;
  const c = new THREE.Color(t.color);
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    const list = Array.isArray(obj.material) ? obj.material : [obj.material];
    list.forEach((mat) => {
      if (!mat || !mat.color) return;
      mat.color.multiply(c);
      if (t.gain && t.gain !== 1) mat.color.multiplyScalar(t.gain);
    });
  });
}

// 非等比缩放一个模板：只动几何，不动朝向，也不重新生成模型。
// 用在拱门上 —— 它的洞口被自己的厚度挡住，靠转动是转不出来的（见 ASSETS.arch 注释）。
//
// 两个细节：
// 1. 法线按逆转置变换。对角缩放下就是逐分量除以缩放系数再归一化。
//    不能直接 computeVertexNormals()，那会把券石原有的圆滑过渡拆成硬边。
// 2. 缩放之后必须重新对中贴地。loadAndNormalizeGLB 的居中是把偏移写在
//    model.position 上的（不是顶点上），几何一缩，那个偏移就不再对应包围盒中心了。
function reshapeTemplate(pivot, [sx, sy, sz]) {
  pivot.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry) return;
    const geo = obj.geometry;
    geo.scale(sx, sy, sz);
    const n = geo.attributes.normal;
    if (n) {
      for (let i = 0; i < n.count; i += 1) {
        const x = n.getX(i) / sx;
        const y = n.getY(i) / sy;
        const z = n.getZ(i) / sz;
        const len = Math.hypot(x, y, z) || 1;
        n.setXYZ(i, x / len, y / len, z / len);
      }
      n.needsUpdate = true;
    }
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
  });

  pivot.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(pivot);
  const center = box.getCenter(new THREE.Vector3());
  // pivot 自身没有变换，所以包围盒的 x/z 中心就是 model.position 要补偿的量。
  pivot.children.forEach((child) => {
    child.position.x -= center.x;
    child.position.z -= center.z;
    child.position.y -= box.min.y;
  });
}

// 没有垂下来的绳套，绞刑架就只读成「一个木门框」，绞刑这层意思完全丢了，所以绳在这里补。
//
// v1 是从包围盒里按 x 73.6% / z 63.7% 去找模型自带那截绳的位置 —— 因为那版模型只在
// **一根柱子顶上**挂了团绳，柱又是斜的，除了这个硬编码比例没有别的锚点。
// v2（第六批 6698848）明确要求模型**不带绳**，结构改成两根垂直柱 + 居中横梁、左右对称，
// 于是枢轴局部原点本身就是横梁中点，绳直接放 (0, 0)。不再依赖任何比例常数。
function addGallowsRope(pivot) {
  const box = new THREE.Box3().setFromObject(pivot);

  // 横梁下沿。梁 0.26 m 方，归一化到 3.85 高后约 0.31 m 厚，这里多让 2 cm 免得绳头穿出梁顶。
  const beamUnder = box.max.y - 0.33;
  // 绳圈圆心离地 1.25 m：成年人的高度，58° 俯视压到 0.66 m 也还看得见是个圈。
  const nooseY = 1.25;
  // 绳圈半径 0.35（含绳粗），绳头要落在圈的**上沿**而不是圆心 ——
  // 落在圆心的话，绳子看起来是从圈当中穿过去的，读成"杆子上套了个环"，不像绳套。
  const ropeEnd = nooseY + 0.35;
  const ropeLen = beamUnder - ropeEnd;

  const gradient = createToonGradientMap();
  // 麻绳本色，压深一档。0x8f7f62 在这个暖光 + 卡通梯度的组合下会发白，
  // 读成"一根白色管子"，和石灰色的石础抢注意力。
  const material = new THREE.MeshToonMaterial({ color: 0x83714f, gradientMap: gradient });

  const rope = new THREE.Group();
  rope.name = 'gallows-rope';

  // 直径 0.13 m：1600×900 下约 4 px，正好是能看清的下限。
  const line = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.07, ropeLen, 6), material);
  line.position.y = ropeEnd + ropeLen / 2;
  rope.add(line);

  // 梁上一小段横向缠绕，把绳头和梁绑在一起 —— 少了它，细杆直接插进梁底会读成"悬空"。
  // 横梁沿局部 x 走，所以圆柱绕 z 转 90° 才是横向。
  const wrap = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.30, 8), material);
  wrap.rotation.z = Math.PI / 2;
  wrap.position.y = beamUnder + 0.13;
  rope.add(wrap);

  // 环压成水平：58° 俯视下竖直的环只剩一条线，水平的环才看得出是个圈套。
  const noose = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.07, 5, 14), material);
  noose.rotation.x = -Math.PI / 2;
  noose.position.y = nooseY;
  rope.add(noose);

  pivot.add(rope);
}

function shadowDisc([radius, stretch]) {
  const g = new THREE.CircleGeometry(radius, 12);
  g.rotateX(-Math.PI / 2);
  g.scale(1, 1, stretch);
  g.translate(0, SHADOW_Y, 0);
  return g;
}

// 把「里程 x + 侧向距离」换算成世界坐标，公式与 js/props.js 的 LAYOUT 逐字一致。
function spotTransform(spot) {
  const s = pathSlope(spot.x);
  const len = Math.sqrt(1 + s * s);
  const lateral = spot.lateral * spot.side;
  return {
    cx: spot.x + (-s / len) * lateral,
    cz: pathCenterZ(spot.x) + (1 / len) * lateral,
    yaw: -Math.atan(s),
  };
}

// 陈设的占地半径，供体量层避让（灌木不能长在石碑、绞刑架、兽骨上）。
// shadow 的第一项就是阴影半径，本身就是"这件东西占多大地方"的估计；
// 再乘 1.05 留一道缝。导出的是世界坐标，不是里程 —— 两层的坐标口径不同。
export const NARRATIVE_FOOTPRINTS = SPOTS.map((spot) => {
  const t = spotTransform(spot);
  const half = (ASSETS[spot.asset].shadow[0] || 1) * 1.05;
  return { x: t.cx, z: t.cz, r: half };
});

/**
 * 异步加载叙事陈设。任何一个模型失败都只跳过它，不能把整个场景拖垮。
 * 返回 { group, loaded, failed }，loaded/failed 是资产名数组，供日志和自查用。
 */
export async function createNarrativeScenery() {
  const group = new THREE.Group();
  group.name = 'narrative-scenery';

  const templates = {};
  const failed = [];
  await Promise.all(
    Object.entries(ASSETS).map(async ([key, def]) => {
      try {
        const { pivot } = await loadAndNormalizeGLB(ASSET_ROOT + def.file, {
          autoScale: true,
          targetHeight: def.height,
        });
        tintTemplate(pivot, TINTS[def.tint] || TINTS.stone);
        if (def.reshape) reshapeTemplate(pivot, def.reshape);
        if (key === 'gallows') addGallowsRope(pivot);
        templates[key] = pivot;
      } catch (err) {
        failed.push(key);
        console.warn('[narrative] 资产加载失败，跳过', def.file, err);
      }
    }),
  );

  const shadowGeometries = [];
  const loaded = [];

  SPOTS.forEach((spot) => {
    const template = templates[spot.asset];
    if (!template) return;
    const def = ASSETS[spot.asset];
    const { cx, cz, yaw } = spotTransform(spot);

    const inst = template.clone(true);
    // 路基被小山丘垫起来 0.35–1.40 m，陈设必须跟着地面走，否则会陷进坡里。
    inst.position.set(cx, terrainY(cx, cz), cz);
    const face = yaw + spot.yaw;
    inst.rotation.y = face;
    if (def.collider) registerAsset(spot.asset, cx, cz, face, def);
    inst.name = `narrative-${spot.asset}-${spot.x}`;
    inst.userData.note = spot.note;
    group.add(inst);

    const disc = shadowDisc(def.shadow);
    disc.rotateY(yaw + spot.yaw);
    disc.translate(cx, terrainY(cx, cz), cz);
    shadowGeometries.push(disc);

    if (!loaded.includes(spot.asset)) loaded.push(spot.asset);
  });

  if (shadowGeometries.length) {
    const shadows = new THREE.Mesh(
      mergeGeometries(shadowGeometries, false),
      new THREE.MeshBasicMaterial({
        color: 0x1a1408,
        transparent: true,
        opacity: 0.26,
        depthWrite: false,
      }),
    );
    shadows.renderOrder = 1;
    group.add(shadows);
    shadowGeometries.forEach((g) => g.dispose());
  }

  return { group, loaded, failed, count: group.children.length };
}
