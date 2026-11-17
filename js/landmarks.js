// 区块 · 四角专属地标层（第三层，2026-11-17 夜）
//
// 第一层（js/zones.js）改了「地的颜色」，第二层（js/ambience.js）补了「氛围」，
// 但四个角还缺一件**只有这里才有的大东西** —— 一件能让人远远看见、说得出
// "我到了古战场 / 伐木营地 / 沼泽枯林 / 废弃农舍"的标志物。这就是第三层。
//
// 四角各一件地标：
//   西北 · 古战场   → 残破石塔（Lux3D）
//   东北 · 伐木营地 → 帆布帐篷（Lux3D）
//   西南 · 沼泽枯林 → 巨兽骨骸（复用叙事层的 beast_skeleton.glb，见下）
//   东南 · 废弃农舍 → 破败农舍（Lux3D）
//
// 骨骸复用说明：幕四原本在主路东段（x=47.6）摆了一具巨兽骨骸当叙事陈设。
// 同一具骨头如果在路肩和西南角各出现一次，会被读成"两只一模一样的兽"，
// 破坏"那只兽只有一只"的叙事。所以把它从叙事层搬到西南角，作为沼泽枯林的
// 地标；叙事层只留那座"立了十字架、披了布的坟"，反而多出一层"坟是空的、
// 兽骨被拖去了沼泽"的读法。这是 2026-11-17 定下的取舍。
//
// 加载策略：西南角骨骸复用现有 GLB，立即可用；其余三件是 Lux3D 生成的体量物，
// 文件到位后自动加载，缺失时静默跳过（不拖垮整个场景，也不报致命错）。

import * as THREE from 'three';
import { loadAndNormalizeGLB } from './pipeline.js';
import { terrainY } from './path.js';
import { COLLIDERS } from './collision-data.js';
import { registerAsset } from './collision.js';

const ASSET_ROOT = 'models/active/env/body/';

// 骨骸的染色和 narrative.js 的 TINTS.bone 保持同一档（骨白 + 1.05 gain），
// 不然同一具骨头换个地方就换了色，还是会被看出是"复制粘贴"。
const BONE_TINT = { color: 0xf0f2f5, gain: 1.05 };
// 石塔/农舍的灰石，和 narrative 的 TINTS.stone 同档（压掉文生 3D 偏冷偏亮的贴图）。
const STONE_TINT = { color: 0xb2a892, gain: 1.0 };
// 帐篷：帆布是米白、木杆是深木，给一个温和的暖白，比 cloth(2.60) 收敛得多 ——
// 那档是提亮裹尸布的，帐篷照搬会白成一块发光布。
const TENT_TINT = { color: 0xe8dcc8, gain: 1.15 };

// 四角地标的定义。skeleton 复用现有 GLB，其余三个 file 待 Lux3D 生成后填入。
// height 是进游戏后的目标高度（米），和叙事层同一套归一化口径。
// collider/fit 与叙事层 ASSETS 的 ...COLLIDERS.x 同构：collider 是形状数组、fit 是
// 包围盒，registerAsset(key, cx, cz, yaw, def) 直接吃这个扁平结构。
//
// 尺寸与碰撞按实测包围盒（tools/glb_bbox.py）反算，缩放系数 = height / bbox.y：
//   ruin_tower      0.336×0.450×0.396 → ×11.11 到 5.0 高，圆柱底 r≈1.9
//   canvas_tent     3.000×1.840×2.768 → ×1.90 到 3.5 高，箱 5.7×5.3
//   derelict_farmhouse 4.5×3.913×4.312 → ×1.02 到 4.0 高，箱 4.6×4.4
const LANDMARKS = [
  {
    name: '西北 · 古战场',
    key: 'tower', // 残破石塔
    cx: -44, cz: -44,
    file: 'ruin_tower.glb',
    height: 5.0,
    yaw: 0.3, // 塌墙豁口朝东南（路的方向），玩家一过来就看见那道破洞
    tint: STONE_TINT,
    collider: [{ kind: 'circle', x: 0, z: 0, r: 1.9 }],
    fit: [-1.9, 1.9, -1.9, 1.9],
  },
  {
    name: '东北 · 伐木营地',
    key: 'tent', // 帆布帐篷
    cx: 44, cz: -43,
    file: 'canvas_tent.glb',
    height: 3.5,
    yaw: 0.5, // 斜着扎，门帘开口朝营地中心
    tint: TENT_TINT,
    collider: [{ kind: 'box', x: 0, z: 0, hx: 2.85, hz: 2.63 }],
    fit: [-2.85, 2.85, -2.63, 2.63],
  },
  {
    name: '西南 · 沼泽枯林',
    key: 'skeleton', // 巨兽骨骸（复用）
    cx: -43, cz: 44,
    file: 'beast_skeleton.glb',
    height: 2.60,
    yaw: 0.6, // 斜着躺，肋骨朝向东北（地图中心/路的方向），玩家从路那边一过来就看见肋骨
    tint: BONE_TINT,
    collider: COLLIDERS.skeleton.collider,
    fit: COLLIDERS.skeleton.fit,
  },
  {
    name: '东南 · 废弃农舍',
    key: 'farmhouse', // 破败农舍
    cx: 43, cz: 43,
    file: 'derelict_farmhouse.glb',
    height: 4.0,
    yaw: 0.2, // 破洞门面朝西北（营地/地图中心方向）
    tint: STONE_TINT,
    collider: [{ kind: 'box', x: 0, z: 0, hx: 2.30, hz: 2.20 }],
    fit: [-2.30, 2.30, -2.20, 2.20],
  },
];

function tintTemplate(root, tint) {
  if (!tint) return;
  const c = new THREE.Color(tint.color);
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    const list = Array.isArray(obj.material) ? obj.material : [obj.material];
    list.forEach((mat) => {
      if (!mat || !mat.color) return;
      mat.color.multiply(c);
      if (tint.gain && tint.gain !== 1) mat.color.multiplyScalar(tint.gain);
    });
  });
}

function shadowDisc(radius, stretch) {
  const g = new THREE.CircleGeometry(radius, 12);
  g.rotateX(-Math.PI / 2);
  g.scale(1, 1, stretch);
  g.translate(0, 0.01, 0);
  return g;
}

/**
 * 异步加载四角地标。文件缺失的地标静默跳过，只加载已就位的（当前仅西南角骨骸）。
 * 返回 { group, loaded, skipped }，供 render.js 挂进场景和自查。
 */
export async function createLandmarks() {
  const group = new THREE.Group();
  group.name = 'landmarks';

  const loaded = [];
  const skipped = [];

  for (const def of LANDMARKS) {
    if (!def.file) {
      skipped.push(def.key);
      continue;
    }

    try {
      const { pivot } = await loadAndNormalizeGLB(ASSET_ROOT + def.file, {
        autoScale: true,
        targetHeight: def.height,
      });
      tintTemplate(pivot, def.tint);

      const inst = pivot;
      inst.position.set(def.cx, terrainY(def.cx, def.cz), def.cz);
      inst.rotation.y = def.yaw;
      if (def.collider) registerAsset(def.key, def.cx, def.cz, def.yaw, def);
      inst.name = `landmark-${def.key}`;
      inst.userData.note = def.name;
      group.add(inst);

      // 贴地阴影片，和叙事层同一套做法，没有 shadowMap 靠它把大件钉在地上。
      // 半径取 fit 的 x 半宽（fit 是 [xMin, xMax, zMin, zMax]），没有 fit 就给默认。
      const radius = def.fit ? Math.max(def.fit[1], 2) : 2.2;
      const disc = shadowDisc(radius, 0.9);
      disc.rotateY(def.yaw);
      disc.translate(def.cx, terrainY(def.cx, def.cz), def.cz);
      group.add(new THREE.Mesh(disc, new THREE.MeshBasicMaterial({
        color: 0x1a1408,
        transparent: true,
        opacity: 0.26,
        depthWrite: false,
      })));

      loaded.push(def.key);
    } catch (err) {
      skipped.push(def.key);
      console.warn('[landmarks] 地标加载失败，跳过', def.key, err);
    }
  }

  return { group, loaded, skipped, count: group.children.length };
}
