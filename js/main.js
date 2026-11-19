// 区块 7 [MAIN LOOP]
// 主界面不推进对局。开始游戏后才按固定顺序轮询。delta 截断见 CONFIG.loop.maxDelta。

import { CONFIG } from './config.js';
import { createState } from './state.js';
import { updateInput } from './input.js';
import { updateMovement } from './movement.js';
import { updateSpawning } from './spawning.js';
import { updateAIAndBoss } from './ai.js';
import { updateCombat } from './combat.js';
import { bootView, updateRenderAndHUD } from './render.js';

const state = createState();
// 调试钩子，和 render.js 的 window.__view 配套：控制台可以直接读 player、量速度。
window.__state = state;

// 构筑标记。**由 JS 写，不由 HTML 写** —— 这样才能区分「HTML 更新了但 js 被缓存」
// 和「两边都是新的」。玩家反馈过三次「启动后什么都没改」，每次都要靠猜是不是缓存；
// 有这一行，看一眼菜单底部就知道跑的是哪一版。
const BUILD = '2026-11-18 · pipe';
document.getElementById('build-stamp').textContent = `构筑 ${BUILD}`;
window.__build = BUILD;

let last = performance.now();

function frame(now) {
  const dt = Math.max(0, Math.min((now - last) / 1000, CONFIG.loop.maxDelta));
  last = now;
  state.time.delta = dt;
  const playing = state.phase === 'play';
  if (playing && !state.time.paused) state.time.elapsed += dt * state.time.scale;

  updateInput(state, dt);
  if (playing) {
    updateMovement(state, dt);
    updateSpawning(state, dt);
    updateAIAndBoss(state, dt);
    updateCombat(state, dt);
  }
  updateRenderAndHUD(state, dt);

  requestAnimationFrame(frame);
}

bootView(state).then(() => {
  last = performance.now();
  requestAnimationFrame(frame);
}).catch((err) => {
  // 别只把错误写进页面提示条：控制台没有堆栈就无从查起（教训：卡了 10 分钟才发现是这里吞了异常）
  console.error('[boot] 场景启动失败', err && err.stack ? err.stack : err);
  const message = err && err.message ? err.message : '场景没有启动';
  const note = document.getElementById('boot-note');
  if (note) {
    note.hidden = false;
    note.textContent = message;
  }
  const loading = document.getElementById('loading');
  const status = document.getElementById('loading-status');
  if (loading && !loading.hidden && status) status.textContent = message;
});
