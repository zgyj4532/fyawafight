// 区块 6 · updateInput
// 键盘、手柄 0 号、左下触屏摇杆。只写 state.input。

import { CONFIG } from './config.js';

const keys = new Set();
const touch = {
  active: false,
  id: -1,
  x: 0,
  y: 0,
  dx: 0,
  dy: 0,
};
const edge = { dodge: false, pause: false, use: false, pick: -1 };
const padWas = { dodge: false, pause: false, idle: 0 };
let rightTapAt = 0;
let bound = false;

function bind() {
  if (bound || typeof window === 'undefined') return;
  bound = true;
  window.addEventListener('keydown', (event) => {
    keys.add(event.code);
    if (event.repeat) return;
    if (event.code === 'Space') {
      edge.dodge = true;
      event.preventDefault();
    }
    if (event.code === 'Escape' || event.code === 'KeyP') edge.pause = true;
    if (event.code === 'KeyE') edge.use = true;
    if (event.code === 'Digit1') edge.pick = 0;
    if (event.code === 'Digit2') edge.pick = 1;
    if (event.code === 'Digit3') edge.pick = 2;
    if (event.code.startsWith('Arrow')) event.preventDefault();
  });
  window.addEventListener('keyup', (event) => keys.delete(event.code));
  window.addEventListener('blur', () => keys.clear());
  window.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
}

function onPointerDown(event) {
  if (event.pointerType === 'mouse') return;
  const right = event.clientX > window.innerWidth * 0.5;
  if (right) {
    const now = performance.now();
    if (now - rightTapAt < 300) edge.dodge = true;
    rightTapAt = now;
    return;
  }
  if (touch.active) return;
  touch.active = true;
  touch.id = event.pointerId;
  touch.x = event.clientX;
  touch.y = event.clientY;
  touch.dx = 0;
  touch.dy = 0;
}

function onPointerMove(event) {
  if (!touch.active || event.pointerId !== touch.id) return;
  touch.dx = event.clientX - touch.x;
  touch.dy = event.clientY - touch.y;
}

function onPointerUp(event) {
  if (event.pointerId !== touch.id) return;
  touch.active = false;
  touch.id = -1;
  touch.dx = 0;
  touch.dy = 0;
}

function keyboardVector() {
  let x = 0;
  let z = 0;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) x -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) x += 1;
  if (keys.has('KeyW') || keys.has('ArrowUp')) z -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) z += 1;
  const mag = Math.hypot(x, z);
  if (mag > 1) {
    x /= mag;
    z /= mag;
  }
  return {
    x,
    z,
    mag: Math.min(1, mag),
    slow: keys.has('ShiftLeft') || keys.has('ShiftRight'),
  };
}

function axisVector(pad) {
  const cfg = CONFIG.input;
  let x = pad.axes[0] || 0;
  let y = pad.axes[1] || 0;
  let raw = Math.hypot(x, y);
  if (raw < cfg.idleEpsilon) padWas.idle += 1;
  else padWas.idle = 0;
  if (padWas.idle >= cfg.idleFrames) raw = 0;
  if (raw < cfg.deadzone) {
    x = 0;
    y = 0;
    raw = 0;
  } else if (raw > 0) {
    const scaled = Math.min(1, (raw - cfg.deadzone) / (1 - cfg.deadzone));
    x = (x / raw) * scaled;
    y = (y / raw) * scaled;
    raw = scaled;
  }
  if (raw === 0) {
    if (pad.buttons[14] && pad.buttons[14].pressed) x -= 1;
    if (pad.buttons[15] && pad.buttons[15].pressed) x += 1;
    if (pad.buttons[12] && pad.buttons[12].pressed) y -= 1;
    if (pad.buttons[13] && pad.buttons[13].pressed) y += 1;
    const mag = Math.hypot(x, y);
    if (mag > 1) {
      x /= mag;
      y /= mag;
    }
    raw = Math.min(1, mag);
  }
  const dodge = buttonDown(pad, 0) || buttonDown(pad, 7);
  const pause = buttonDown(pad, 9);
  return { x, z: y, mag: raw, dodge, pause };
}

function buttonDown(pad, index) {
  const button = pad.buttons[index];
  if (!button) return false;
  return button.pressed || button.value > 0.5;
}

function readGamepad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const pad = pads[CONFIG.input.gamepadIndex];
  if (!pad || !pad.connected) return null;
  return axisVector(pad);
}

function touchVector() {
  if (!touch.active) return { x: 0, z: 0, mag: 0 };
  const radius = 48;
  let x = touch.dx / radius;
  let z = touch.dy / radius;
  const mag = Math.hypot(x, z);
  if (mag > 1) {
    x /= mag;
    z /= mag;
  }
  return { x, z, mag: Math.min(1, mag) };
}

function noteDevice(input, name, active, dt) {
  input.deviceHold = Math.max(0, input.deviceHold - dt);
  if (!active) return;
  if (input.device !== name && input.deviceHold > 0) return;
  if (input.device !== name) input.deviceHold = CONFIG.input.deviceHoldSec;
  input.device = name;
}

export function updateInput(state, dt) {
  bind();
  const board = keyboardVector();
  const pad = readGamepad();
  const finger = touchVector();
  const candidates = [
    { name: 'keyboard', ...board, active: board.mag > 0 || board.slow },
    { name: 'gamepad', x: pad ? pad.x : 0, z: pad ? pad.z : 0, mag: pad ? pad.mag : 0, slow: false, active: !!pad && (pad.mag > 0 || pad.dodge || pad.pause) },
    { name: 'touch', ...finger, slow: false, active: finger.mag > 0 || touch.active },
  ];
  candidates.sort((a, b) => b.mag - a.mag);
  const move = candidates[0];
  const input = state.input;
  input.moveX = move.x;
  input.moveZ = move.z;
  input.slow = board.slow;
  const picking = state.upgrade.pending;
  const reading = state.doc.open || (state.doc.nearId && !picking);
  const padConfirm = !!(pad && pad.dodge && !padWas.dodge);
  input.padConnected = !!pad;
  if (!input.padConnected && input.device === 'gamepad') input.device = 'keyboard';
  input.dodge = !picking && !reading && (edge.dodge || padConfirm);
  input.confirm = padConfirm && (picking || reading);
  input.useEdge = edge.use;
  input.pauseEdge = edge.pause || !!(pad && pad.pause && !padWas.pause);
  if (edge.pick >= 0 && picking) {
    input.upgradeIndex = edge.pick;
    input.confirm = true;
  }
  if (picking && pad && !input.pickLatch && Math.abs(pad.x) > 0.55) {
    input.pickLatch = true;
    const count = state.upgrade.options.length || 1;
    input.upgradeIndex = (input.upgradeIndex + (pad.x > 0 ? 1 : count - 1)) % count;
  }
  if (!pad || Math.abs(pad.x) < 0.35) input.pickLatch = false;
  if (picking && input.device === 'gamepad') {
    input.moveX = 0;
    input.moveZ = 0;
  }
  edge.dodge = false;
  edge.pause = false;
  edge.use = false;
  edge.pick = -1;
  padWas.dodge = !!(pad && pad.dodge);
  padWas.pause = !!(pad && pad.pause);
  input.pointer.active = touch.active;
  input.pointer.id = touch.id;
  input.pointer.x = touch.x;
  input.pointer.y = touch.y;
  input.pointer.dx = touch.dx;
  input.pointer.dy = touch.dy;
  const driving = candidates.find((item) => item.active);
  noteDevice(input, driving ? driving.name : input.device, !!driving, dt);
  input.stickMag = move.mag;
  if (state.fx.rumble) {
    const kind = state.fx.rumble;
    state.fx.rumble = '';
    const live = navigator.getGamepads ? navigator.getGamepads()[CONFIG.input.gamepadIndex] : null;
    const act = live && (live.vibrationActuator || (live.hapticActuators && live.hapticActuators[0]));
    if (act && act.playEffect) {
      const strong = kind === 'boss';
      act.playEffect('dual-rumble', {
        duration: strong ? CONFIG.input.bossHitRumbleMs : kind === 'chest' ? CONFIG.input.chestRumbleMs : CONFIG.input.hurtRumbleMs,
        strongMagnitude: strong ? 0.8 : 0.25,
        weakMagnitude: strong ? 0.6 : 0.4,
      }).catch(() => {});
    }
  }
}
