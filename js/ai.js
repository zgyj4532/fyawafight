// 区块 6 · updateAIAndBoss
// 史莱姆 / 猎狗 / 食人魔移动，赫塞五态，1.8s 地面填充预警。Boss 不穿门。
//
// 接土路提速：移动循环里算目标速度时乘 pathSpeedMul(e.x, e.z)（见 js/path.js）。
// 权重本身就是 0…1 的连续值，敌人不必另存缓动状态。

export function updateAIAndBoss(_state, _dt) {}
