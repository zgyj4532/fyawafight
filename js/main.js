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
let last = performance.now();

function frame(now) {
  const dt = Math.min((now - last) / 1000, CONFIG.loop.maxDelta);
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
  const note = document.getElementById('boot-note');
  if (note) {
    note.hidden = false;
    note.textContent = err && err.message ? err.message : '场景没有启动';
  }
});
