// 区块 6j · 证据链陈设（A 组：兽的产业链 / B 组：团长的署名）
//
// 五幕（js/narrative.js）讲的全是「人怎么了」：抓人、处决、收尸。
// 剧情 §5 的四步证据里，**步骤 3（试验、失控）与步骤 4（量产、装箱、转运）
// 在场景上一直没有落点** —— 玩家看完骨骸就直接走进更早的遗址层，
// 「兽是怎么来的」这一环是空的。这一层补的就是这一环。
//
// 两处现场，都接在幕四（骨骸 x=45.4）的两侧，走完就进幕五：
//
//   x ≈ 39–45.5  拴养排（路 −z 侧）  五根木桩，两根的皮绳挣断了
//   x ≈ 47–51    转运场（路 −z 侧）  笼车 + 门口的镣铐 + 两只封了封条的军箱
//
// 拴养排和骨骸**故意分在路的两侧**：玩家走在中间时，一头是兽的骨头、
// 一头是拴兽的桩，两组同框。这一帧不需要任何文本，「这头死了，那头拴过」
// 自己就说明白了。
//
// --- 从「代码手搓」换成 Lux3D 资产（第八批）--------------------------------
//
// 上一版这五件是用 BoxGeometry / TorusGeometry 拼的，约 2.2 k 三角，够读轮廓
// 但经不起停下来的玩家细看：木纹没有、铁件是一根方条、封条是纯色片。
// 这一版换成 Lux3D 生成的 GLB（models/active/env/body/，第八批 3.62 MB + 第九批陶罐 0.49 MB
// + 第一批石槽 0.85 MB），
// **摆位、贴地阴影、可交互锚点全部沿用**，只换几何来源。
//
// 七个资产都实测过包围盒（tools/glb_bbox.py）。第八批那五件尺寸一律偏小，
// 所以每个都要乘一个修正系数。**细长件不能等比**：拴养桩如果等比放大到
// 1.15 m，桩身会胖成一根柱子，必须「高 ×2.55、粗 ×1.4」分开给。
//
//   tether     0.16 × 0.45 × 0.13 → 高 1.15、粗 0.22（不等比）
//   cage       1.80 × 1.00 × 0.92 → 2.16 × 1.20 × 1.10（×1.2）
//   shackle    0.25 × 0.13 × 0.23 → 0.55 × 0.29 × 0.51（×2.2）
//   sealCrate  0.40 × 0.32 × 0.37 → 0.80 × 0.64 × 0.73（×2）
//   scroll     0.22 × 0.07 × 0.27 → 0.29 × 0.07 × 0.35（平面 ×1.3，厚度不动）
//   jar        0.87 × 0.95 × 0.87 → 0.48 × 0.52 × 0.48（×0.55，第九批）
//   trough     1.20 × 0.46 × 0.94 → 2.22 × 0.83 × 1.75（×1.80，第一批）
//
// 三个渲染约束没有变，换资产时按它们挑的尺寸，不是照搬：
//
// **一、只能靠轮廓，不能靠厚度。** 俯角 58° 把竖直方向压到 0.85 的投影系数，
//   57.6 px/m 下 1 m 高的东西只有 49 px。所以笼车不能选实心车斗的款式，
//   必须看得见格子；镣铐必须是**平躺**的一摊（竖立的环在 58° 下退化成一条线，
//   这是项目里踩过两次的坑：绞刑架的绳套、地面的节点环）；封条必须跨**顶面**，
//   顶面是主视面，侧面的封条只是一条几乎看不见的斜线。
//
// **二、「批量」要靠重复本身读出来。** 五根一样的桩排成一条线、间距固定、
//   偏航只给 ±0.05 rad，比任何单件道具都更能说明「这里拴过一排东西」。
//   所以五根桩是同一个 GLB 的五个实例，不做随机变形。
//
// **三、断口一律朝路。** 断绳的散头、外翻的栅条、断链的开口，全部朝 +z
//   （玩家走的那一侧）。玩家路过时正对着断口，读到的是「它朝这个方向挣开」。
//
// 运行时 draw call：每个资产一份材质（贴图各不相同，合并不了），
// 7 个 InstancedMesh + 1 个合并阴影 = 8 次，比上一版的 2 次多 6 次。
// 三角数从 2.2 k 涨到约 240 k（陶罐 3 × 13 k、石槽 18.7 k）—— 换贴图资产的代价。
//
// 可交互的物件（两只军箱、一包文书）另外导出世界坐标与检测半径，
// 供交互系统用（规格见 docs/待办_未解决问题.md 第 4 条）。

import * as THREE from 'three';
import { loadAndNormalizeGLB } from './pipeline.js';
import { crossCenterX, crossSlope, pathCenterZ, pathSlope, terrainY } from './path.js';
import { COLLIDERS } from './collision-data.js';
import { registerAsset } from './collision.js';

const ASSET_ROOT = 'models/active/env/body/';

// scale 写成数组就是不等比（x / y / z），写成数字就是等比。
// yaw 是资产自身的朝向修正 —— 生成模型的「正面」不一定是 +z，
// 由截图逐个校准，不靠猜。
const ASSETS = {
  // tether：铁环在模型 +z 那一面。第一版给了 -90° 把环转到路侧，
  // 结果环平面正对相机边缘、退化成一条线（项目里第三次踩这个坑）。
  // 归零之后环面朝路，58° 俯视下读成椭圆 —— 能认出来。
  tether: {
    file: 'tether_stake.glb',
    scale: [1.40, 2.55, 1.40],
    yaw: 0,
    gain: 1.15,
    shadow: [0.40, 0.66],
    ...COLLIDERS.tether,
  },
  cage: {
    file: 'cage_cart.glb',
    scale: 1.20,
    yaw: Math.PI,
    gain: 1.25,
    shadow: [1.62, 0.60],
    ...COLLIDERS.cage,
  },
  // 铁件在草地上天然对比最低，给一档提亮，否则 20 m 外只剩一个小灰点。
  // 放大后最高 0.27 m，躺在地上，迈得过去。不建碰撞箱。
  shackle: {
    file: 'shackle_chain.glb',
    scale: 2.20,
    yaw: 0.35,
    gain: 1.45,
    shadow: [0.36, 0.72],
  },
  sealCrate: {
    file: 'sealed_crate.glb',
    scale: 2.00,
    yaw: 0.0,
    gain: 1.0,
    // 提示图标要悬在箱盖上方，不能停在箱体里面 —— 箱高 0.64，锚点给 0.95。
    anchor: 0.95,
    shadow: [0.80, 0.86],
    ...COLLIDERS.sealCrate,
  },
  scroll: {
    file: 'order_packet.glb',
    scale: [1.30, 1.00, 1.30],
    yaw: 0.55,
    gain: 1.0,
    anchor: 0.45,
    shadow: null,
    ...COLLIDERS.scroll,
  },
  // 陶罐（第九批）。剧情 §5.2 把骑士团的工艺落在「锻铁、皮革、粗布、石槽陶罐
  // 和炼金结晶」上，石槽有资产但还没接，陶罐这一件是那次盘点里唯一"一件都没造"
  // 的东西。它读的不是工艺本身，而是**这里有人在装东西**：三只罐并排立在
  // 军箱和笼车之间，装箱这道工序才有了下手的地方。
  // 生成实测 0.867 × 0.950 × 0.874 —— 这一件文生 3D 几乎给了 1:1 的尺寸，
  // 和前几批"小件只有 0.4×"不一样，所以缩放是 ×0.55 而不是往上放大。
  jar: {
    file: 'clay_jar.glb',
    scale: 0.55,
    yaw: 0.40,
    gain: 1.05,
    shadow: [0.30, 0.92],
    ...COLLIDERS.jar,
  },
  // 培养石槽。剧情 §5.2 那句话的**源头**：锻铁是镣铐、皮革是皮绳、粗布是裹布，
  // 「石槽陶罐和炼金结晶」落到这个物件上 —— 槽里有暗色液体，漂着一块紫色结晶。
  // 它是整套证据里唯一说得出「兽是被喂出来的」的东西，所以不放在转运场，
  // 摆在拴养排后面（喂食的位置），玩家先看见桩、再看见槽。
  //
  // 这件资产的包围盒 1.20 × 0.46 × 0.94，看着像方盆，但里面**不只一件东西**：
  // GLB 自带一只翻倒的陶罐、一段锈链、一只小铁笼 —— 提示词当初是照着
  // 「石槽、陶罐、铁笼与束具」那一句生成的，它们连成一件一体资产。
  // 不拆（拆了只剩一个空盆，反而丢了「现场」的味道），整体按 ×1.80 放大到
  // 2.16 × 0.83 × 1.69 —— 槽体本身约 1.8 m 长，和 2.2 m 的设计值差在陶罐那头。
  trough: {
    file: 'cultivation_trough.glb',
    scale: 1.80,
    yaw: 0.10,
    gain: 1.10,
    shadow: [1.10, 0.80],
    ...COLLIDERS.trough,
  },
};

// 摆位。里程 x + 路的一侧 + 离中线的米数，换算公式和 6d / 6e 逐字一致。
//
// 拴养排的间距固定 1.6 m、偏航只给 ±0.05 rad：这是「一排」的读法，
// 不是五根各自的随机。第 3 根和第 5 根是断的 —— 一根太少（像意外），
// 三根太多（像布景），两根正好读作「试过两次」。
//
// tilt / v 两个字段是上一版代码几何用的姿态参数，GLB 不再接受顶点级变形，
// 保留在数据里只作为「这根在第几根位置」的标记（v 同时给微小的偏航抖动）。
const SPOTS = [
  { build: 'tether', x: 38.9, side: -1, lateral: 4.55, yaw: 0.04, tilt: 0.03, v: 0.18 },
  { build: 'tether', x: 40.5, side: -1, lateral: 4.62, yaw: -0.05, tilt: -0.04, v: 0.62 },
  { build: 'tether', x: 42.1, side: -1, lateral: 4.50, yaw: 0.08, tilt: 0.02, v: 0.41, broken: true },
  { build: 'tether', x: 43.7, side: -1, lateral: 4.66, yaw: -0.02, tilt: 0.05, v: 0.77 },
  { build: 'tether', x: 45.3, side: -1, lateral: 4.58, yaw: 0.06, tilt: -0.02, v: 0.30, broken: true },

  // 石槽在桩列的**外侧**（x 42.4 / lateral 7.2，世界坐标 40.39/−17.34）。
  // 第一版摆在 44.2 / 6.9，贴着树冠边缘，读成"树下放了个灰箱子"；第二版挪到 39.8 / 6.4，
  // 落进桩列里 —— 与第一、第二根桩的净空只有 0.805 m，人形怪过不去。
  // 现在往外挪一档：离最近一根桩 1.7 m、离 x=42 那棵树 3.0 m。
  // 从路上看仍是「槽 → 一排桩 → 骨骸」，槽在最外侧，先读到"喂过"。
  { build: 'trough', x: 42.4, side: -1, lateral: 7.20, yaw: 0.10, clear: 2.40 },

  // 转运场。笼车尾门朝 −x（也就是朝来路），镣铐掉在门外 ——
  // 玩家从 x=47 走过来，先看到两只军箱，再看到门和地上的链子，最后才看到车。
  //
  // 2026-11-17 第二次改：**两只军箱上的文书都挪走了**，这里只剩空箱。
  // 三份文书分散到地图三个尽头（见下面的「散落的箱子」），转运场变成
  // 「车还在、箱子还在、纸没了」—— 反倒更像被翻过一遍的现场。
  { build: 'cage', x: 50.6, side: -1, lateral: 5.30, yaw: 0.03 },
  { build: 'shackle', x: 49.15, side: -1, lateral: 4.35, yaw: 0.55 },
  { build: 'sealCrate', x: 47.9, side: -1, lateral: 6.30, yaw: 0.22 },
  { build: 'sealCrate', x: 47.15, side: -1, lateral: 7.20, yaw: 0.94 },

  // --- 散落的箱子：三份文书，三个尽头 -----------------------------------
  //
  // 转运路线从西部（哥维纳）往东、往北走，路上掉队的箱子就散在三个方向的尽头。
  // 玩家为了拿全三份，必须把整条主路走完、再横穿一次十字路口 ——
  // 三份文件本身就是「这条路有多长」的度量。
  //
  // 每处都是「军箱 + 盖上的文书包」，可读的是包（纸是纸），箱体不再单独可读。
  // 包的位置沿用第二只箱子上量过的 0.64 m 盖高与 dx/dz 偏移。
  // 三处与既有陈设的净空用 tools/probe_clearance.mjs 复核过。

  // 西端（主路 −x 尽头）。哥维纳在西部，命令从团部往外发，所以令放在这一头。
  { build: 'sealCrate', x: -52.0, side: 1, lateral: 4.90, yaw: 0.34 },
  { build: 'scroll', x: -52.0, side: 1, lateral: 4.90, yaw: 0.34, dy: 0.64, dx: 0.03, dz: -0.05, doc: 'seal-warrant' },

  // 东端（主路 +x 尽头）。账本放在货物的去向上 —— 莫斯塔拉那边的收货记录。
  { build: 'sealCrate', x: 53.0, side: 1, lateral: 4.80, yaw: 1.02 },
  { build: 'scroll', x: 53.0, side: 1, lateral: 4.80, yaw: 1.02, dy: 0.64, dx: 0.03, dz: -0.05, doc: 'order-scroll' },

  // 北端（横路 −z 尽头）。回执是从收方寄回来的，所以放在与主路无关的一条岔道上。
  { build: 'sealCrate', cross: true, x: -54.0, side: 1, lateral: 4.60, yaw: 0.30 },
  { build: 'scroll', cross: true, x: -54.0, side: 1, lateral: 4.60, yaw: 0.30, dy: 0.64, dx: 0.03, dz: -0.05, doc: 'receipt-konica' },

  // 三只陶罐，摆在军箱西侧的空草地上（世界坐标 45.17/−19.57、44.14/−19.90、
  // 43.38/−19.21）。互相 1.0–1.2 m：罐径 0.48，再近就碰在一起，再远就散成三件孤物。
  //
  // 2026-11-17 从「军箱与笼车之间」挪出来。原位置（48.8–49.4 / −17.3 一带）被
  // 军箱、笼车、岩群夹住，最紧一处净空只有 0.620 m，怪物从那儿过会卡；
  // 而这批东西本来就是"掉在转运场边上的货"，往空草地散一步仍然读得懂。
  // 偏航给三个不同值，避免三只罐口朝同一方向那种复制感。
  { build: 'jar', x: 45.60, side: -1, lateral: 8.60, yaw: 0.40 },
  { build: 'jar', x: 45.00, side: -1, lateral: 9.00, yaw: 1.90 },
  { build: 'jar', x: 44.50, side: -1, lateral: 8.40, yaw: 3.10 },
];

const SHADOW_Y = 0.010;

/**
 * 需要在草地上"清空"的占位（同步）。
 *
 * 灌木是 scenery.js 在模块初始化时一次性撒完的（seeded），那时 GLB 还没加载，
 * 所以这里不能依赖 createEvidence 的结果，只能是纯计算 —— 换算公式与
 * createEvidence 里逐字一致。只返回 SPOTS 里写了 `clear` 的那几个：
 * 其余陈设周围的灌木本来就没压进来，多清一遍会把已经验收过的画面改掉。
 */
export function evidenceFootprints() {
  return SPOTS.filter((s) => s.clear).map((s) => {
    const sl = pathSlope(s.x);
    const len = Math.sqrt(1 + sl * sl);
    const lateral = s.lateral * s.side;
    return {
      x: s.x + (-sl / len) * lateral,
      z: pathCenterZ(s.x) + (1 / len) * lateral,
      r: s.clear,
    };
  });
}

// 把归一化后的 pivot 烘成一份可实例化的几何：
// pivot 里已经包含了「底部归零 + x/z 居中 + 朝向修正 + 缩放」，
// 这些都在 matrixWorld 里，应用一次之后几何就与实例矩阵无关了。
function bakePivot(pivot) {
  pivot.updateMatrixWorld(true);
  let mesh = null;
  pivot.traverse((obj) => {
    if (obj.isMesh && !mesh) mesh = obj;
  });
  if (!mesh) return null;
  const geo = mesh.geometry.clone();
  geo.applyMatrix4(mesh.matrixWorld);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return { geo, material: mesh.material };
}

function shadowDisc(radius, stretch) {
  const g = new THREE.CircleGeometry(radius, 10);
  g.rotateX(-Math.PI / 2);
  g.scale(1, 1, stretch);
  return g;
}

// 阴影全是同一种 CircleGeometry（只有半径和压扁不同），属性表一致，
// 直接拼位置与法线即可，不必再引一次 BufferGeometryUtils。
function mergeShadows(parts) {
  let count = 0;
  parts.forEach((g) => { count += g.attributes.position.count; });
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  let o = 0;
  parts.forEach((g) => {
    position.set(g.attributes.position.array, o * 3);
    normal.set(g.attributes.normal.array, o * 3);
    o += g.attributes.position.count;
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  return geo;
}

/**
 * 构建证据链陈设。异步：五个 GLB 并行加载，任何一件失败只跳过它。
 * 返回 { group, triangles, instances, interactables, failed, loaded }。
 * interactables 里的坐标是世界坐标，供交互系统按距离检测 —— 不用 raycaster，
 * 因为每类资产是 InstancedMesh，射线命中分不出是哪一件。
 */
export async function createEvidence() {
  const group = new THREE.Group();
  group.name = 'evidence-scenery';

  const failed = [];
  const baked = new Map();

  const kinds = [...new Set(SPOTS.map((s) => s.build))];
  await Promise.all(kinds.map(async (key) => {
    const def = ASSETS[key];
    try {
      const { pivot } = await loadAndNormalizeGLB(ASSET_ROOT + def.file, {
        rotationY: def.yaw || 0,
      });
      if (Array.isArray(def.scale)) {
        pivot.scale.set(def.scale[0], def.scale[1], def.scale[2]);
      } else {
        pivot.scale.setScalar(def.scale);
      }
      const b = bakePivot(pivot);
      if (!b) throw new Error('no mesh');
      // 乘子只抬亮度，不动色相 —— 和 scenery.js 的 tint 是同一套做法。
      if (def.gain && b.material && b.material.color) {
        b.material.color.multiplyScalar(def.gain);
      }
      baked.set(key, b);
    } catch (err) {
      failed.push(key);
      console.warn('[evidence] 资产加载失败，跳过', def.file, err);
    }
  }));

  const shadowParts = [];
  const interactables = [];
  let triangles = 0;
  let instances = 0;

  const matrix = new THREE.Matrix4();
  const offset = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const leanQuat = new THREE.Quaternion();
  const leanAxis = new THREE.Vector3(1, 0, 0);
  const euler = new THREE.Euler();
  const pos = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const anchor = new THREE.Vector3();

  // 先按资产分组，一类一份 InstancedMesh —— 贴图各不相同，跨资产合并会串色。
  kinds.forEach((key) => {
    const b = baked.get(key);
    if (!b) return;
    const spots = SPOTS.filter((s) => s.build === key);
    const mesh = new THREE.InstancedMesh(b.geo, b.material, spots.length);
    mesh.name = `evidence-${key}`;

    spots.forEach((spot, i) => {
      // spot.cross 为真时 x 是横路的里程（也就是 z），换用横路那套换式。
      // 横路不垫高，所以 c z 直接用 z + 侧向分量，高程仍交 terrainY。
      const s = spot.cross ? crossSlope(spot.x) : pathSlope(spot.x);
      const len = Math.sqrt(1 + s * s);
      const lateral = spot.lateral * spot.side;
      const cx = spot.cross
        ? crossCenterX(spot.x) + (1 / len) * lateral
        : spot.x + (-s / len) * lateral;
      const cz = spot.cross
        ? spot.x + (-s / len) * lateral
        : pathCenterZ(spot.x) + (1 / len) * lateral;
      const gy = terrainY(cx, cz);
      const yaw = (spot.cross ? -Math.PI / 2 + Math.atan(s) : -Math.atan(s)) + spot.yaw;
      // 资产自身的 def.yaw 已经烘进顶点，碰撞只跟这一次摆放偏航。
      // dx/dz 是放上箱盖时的局部偏移，要先转到世界再登记，否则文书包会留在箱子中心。
      if (ASSETS[key].collider) {
        const ox = spot.dx || 0;
        const oz = spot.dz || 0;
        const cos = Math.cos(yaw);
        const sin = Math.sin(yaw);
        registerAsset(
          key,
          cx + ox * cos + oz * sin,
          cz - ox * sin + oz * cos,
          yaw,
          ASSETS[key],
        );
      }

      euler.set(0, yaw, 0);
      quat.setFromEuler(euler);
      // 断过的那两根往路这边倒一点 —— GLB 是同一件资产，绳子的断口做不出来，
      // 「被挣过」只能靠姿态说：桩朝路倾 0.17 rad，顶偏出 0.2 m，
      // 一眼能看出这两根和另外三根不一样。
      if (spot.broken) {
        quat.multiply(leanQuat.setFromAxisAngle(leanAxis, 0.17));
      }
      pos.set(cx, gy, cz);
      matrix.compose(pos, quat, one);

      // 局部偏移（dy/dx/dz）在旋转后的坐标系里叠加，所以「放在箱盖上」
      // 会跟着箱子的偏航一起转，不会因为 yaw 不同而错位。
      if (spot.dx || spot.dy || spot.dz) {
        offset.makeTranslation(spot.dx || 0, spot.dy || 0, spot.dz || 0);
        matrix.multiply(offset);
      }
      mesh.setMatrixAt(i, matrix);

      if (ASSETS[key].shadow) {
        const [r, st] = ASSETS[key].shadow;
        const disc = shadowDisc(r, st);
        disc.translate(0, SHADOW_Y, 0);
        disc.applyMatrix4(matrix);
        shadowParts.push(disc);
      }

      if (spot.doc) {
        anchor.set(0, 0, 0).applyMatrix4(matrix);
        interactables.push({
          id: spot.doc,
          kind: spot.build,
          // 锚点抬到物件上方：提示图标要浮在箱盖/纸面上，不能埋在箱子里。
          x: anchor.x,
          y: anchor.y + (ASSETS[key].anchor || 0.5),
          z: anchor.z,
          // 检测半径 2.4 m。玩家身高和移动速度下这是「停下就能按」的距离，
          // 再大会在两件东西之间同时触发。
          radius: 2.4,
        });
      }
    });

    mesh.instanceMatrix.needsUpdate = true;
    // InstancedMesh 的包围球默认只按几何算，不算实例矩阵，不重算会被视锥错误剔除。
    mesh.computeBoundingSphere();
    group.add(mesh);
    // 几何是索引的，三角数要读 index；用 position.count/3 会把 13.5k 顶点
    // 数成 4.5k 三角（第一版就是这么算错的）。
    const perInstance = b.geo.index ? b.geo.index.count / 3 : b.geo.attributes.position.count / 3;
    triangles += perInstance * spots.length;
    instances += spots.length;
  });

  if (shadowParts.length) {
    const shadowMesh = new THREE.Mesh(
      mergeShadows(shadowParts),
      new THREE.MeshBasicMaterial({
        color: 0x1a1408,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
      }),
    );
    shadowMesh.name = 'evidence-shadows';
    shadowMesh.renderOrder = 1;
    group.add(shadowMesh);
    shadowParts.forEach((g) => g.dispose());
  }

  group.userData.interactables = interactables;

  return {
    group,
    triangles,
    instances,
    interactables,
    failed,
    loaded: [...baked.keys()],
  };
}
