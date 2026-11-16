// 区块 6g · 湖
//
// 路外唯一一块**走不进去**的地方。这里只放两件事：湖在世界里的位置，
// 和一条把角色推出去的判定。模型由 js/scenery.js 统一加载摆放，
// 判定由 js/movement.js 在位移之后调用一次。
//
// 为什么单独一个文件：movement.js 不应该为了几个湖去 import 整条体量层
// （那会把 three 和 GLB 加载器拖进移动逻辑）。这里只有数据和两个函数。
//
// **这不是碰撞系统。** 全套碰撞（石头、墙、车）仍然是
// docs/待办_未解决问题.md 里的第 2 条，没有动。这里只处理水 ——
// 因为水是唯一一处"走进去会破相"的地方：角色站在水面上没有任何解释。
//
// 从一潭改成两潭（2026-11-12）：一潭水在 100 多米长的路上只出现一次，
// 剩下全是草地。两潭的作用不是"更多水"，是**给画面一条前后节奏**：
// 出生点东边一潭、西边一潭，玩家从任一端出发都会先经过水。
// 判定与草场遮罩因此都改成了数组 —— 见 pushOutOfLake() 和 grass.js 的 uLakes。

import { pathCenterZ, pathSlope } from './path.js';

// radius 是泥岸外沿（可以走上去），水面是 radius × water（走不进去）。
//
// sink 必须**跟着缩放走**。水盆压到地面以下才不会像一只摆在草地上的澡盆，
// 但沉多少是按模型自身高度算的：小潭整体缩到 0.73 倍，如果还沉原来那 0.50 m，
// 水盆相对地面只剩 0.17 m，水面就沉到地面以下了 —— 画面上只剩一个干坑。
// 所以数据里只留一个基准比例，真正的沉入深度 = LAKE_SINK_RATIO × scale。
export const LAKES = Object.freeze([
  {
    name: '主湖',
    x: 4.5,
    lateral: 12.4,
    side: -1, // 只放 −z 侧：相机永远在玩家 +z 侧
    radius: 4.2,
    water: 0.86,
    yaw: 0.7,
  },
  {
    // 第二个潭。位置不是随便挑的：路在 x=±45 处向南弯到 z=−7，
    // 湖放在那里会直接跑到画面上沿之外。能同时满足"落在地图内、又进画面"
    // 的横向带只有 x≈0 附近，而那一带本来只有一处背景林块 ——
    // 把那处林块撤掉换成一潭水，视觉上不亏（灌木层已经把那片填满了）。
    name: '西潭',
    x: -6.0,
    lateral: 11.0,
    side: -1,
    radius: 3.2,
    water: 0.84,
    yaw: 2.1,
  },
]);

// 资产归一化后是 8 m 宽（对应 radius 4.2），所以实例缩放 = radius / 4.2。
// 缩放的代价是深度也跟着缩 —— 沉入深度必须同步缩，否则小潭会露出一圈盆沿。
export const LAKE_BASE_RADIUS = 4.2;

export function lakeScale(lake) {
  return lake.radius / LAKE_BASE_RADIUS;
}

// 主湖（scale 1）调到"水面高出草地一点、盆沿不露"的深度是 0.62 m。
// 其余潭按同一比例缩 —— 几何整体等比缩小时，水面在模型里的相对位置不变，
// 所以沉入深度等比缩就能保持"露出同样多的水"。
export const LAKE_SINK_RATIO = 0.62;

export function lakeSink(lake) {
  return LAKE_SINK_RATIO * lakeScale(lake);
}

// 路面相对坐标 → 世界坐标。公式与 narrative.js / props.js / scenery.js 逐字一致，
// 注意 lateral 会带动 x（cx = x − s/len · lateral）。
export function lakeCenter(lake) {
  const s = pathSlope(lake.x);
  const len = Math.sqrt(1 + s * s);
  const lateral = lake.lateral * lake.side;
  return {
    cx: lake.x + (-s / len) * lateral,
    cz: pathCenterZ(lake.x) + (1 / len) * lateral,
  };
}

// 预计算一次世界坐标：grass.js 每帧要传 uniform，movement.js 每次位移要判定，
// 没必要每次都重算三角函数。
export const LAKE_SPOTS = LAKES.map((lake) => ({ ...lake, ...lakeCenter(lake) }));

/**
 * 如果 (x, z) 落在任何一潭水里，返回推到岸上的坐标；否则返回 null。
 *
 * 用径向投影而不是"挡住不让进"：玩家斜着撞上湖岸时会沿着岸滑开，
 * 不会被钉在原地。水面积不小（直径 4–7 m），硬挡的手感会很糟。
 */
export function pushOutOfLake(x, z) {
  for (const lake of LAKE_SPOTS) {
    const dx = x - lake.cx;
    const dz = z - lake.cz;
    const d = Math.hypot(dx, dz);
    const r = lake.radius * lake.water;
    if (d >= r) continue;
    if (d < 1e-4) {
      // 正好落在圆心（只可能是瞬移），随便挑一个方向推出去。
      return { x: lake.cx + r, z: lake.cz };
    }
    return { x: lake.cx + (dx / d) * r, z: lake.cz + (dz / d) * r };
  }
  return null;
}
