'use strict';

// CodePeek mascot renderer — pixel art characters drawn with fillRect blocks.
// Ported from CodeIsland's SwiftUI Canvas approach: each body part is a
// positioned rectangle, not a pixel grid.

// ===== Viewport mapper (same as CodeIsland's V struct) =====

function V(size, svgW, svgH, svgY0) {
  const s = size / Math.max(svgW, svgH);
  const ox = (size - svgW * s) / 2;
  const oy = (size - svgH * s) / 2;
  return {
    s, ox, oy, y0: svgY0 || 0,
    r(x, y, w, h, dy) {
      return [ox + x * s, oy + (y - this.y0 + (dy || 0)) * s, w * s, h * s];
    }
  };
}

function lerp(kf, pct) {
  if (pct <= kf[0][0]) return kf[0][1];
  for (let i = 1; i < kf.length; i++) {
    if (pct <= kf[i][0]) {
      const t = (pct - kf[i-1][0]) / (kf[i][0] - kf[i-1][0]);
      return kf[i-1][1] + (kf[i][1] - kf[i-1][1]) * t;
    }
  }
  return kf[kf.length - 1][1];
}

function drawZzz(ctx, v, t) {
  for (let i = 0; i < 3; i++) {
    const cycle = 2.8 + i * 0.3;
    const phase = ((t - i * 0.9) % cycle) / cycle;
    if (phase < 0) continue;
    const baseOp = 0.7 - i * 0.1;
    const op = phase < 0.8 ? baseOp : baseOp * (1 - (phase - 0.8) / 0.2);
    if (op <= 0) continue;
    const fontSize = (0.18 + phase * 0.1) * 27;
    ctx.font = `bold ${fontSize * v.s / 1.8}px monospace`;
    ctx.fillStyle = `rgba(255,255,255,${op})`;
    const zx = v.ox + (12 + i * 1.5) * v.s;
    const zy = v.oy + (4 - phase * 5 - i * 1) * v.s;
    ctx.fillText('z', zx, zy);
  }
}

// ===== Claude (Clawd) — block creature, standing pose =====
// Ported from CodeIsland's PixelCharacterView.swift

const CLAUDE = {
  body: '#DE886D', eye: '#000', alert: '#FF3D00',
  kbBase: 'rgb(97,112,128)', kbKey: 'rgb(153,168,184)', kbHi: '#fff'
};

function drawClaude(ctx, size, state, t) {
  const fill = (c, ...r) => { ctx.fillStyle = c; ctx.fillRect(...r); };

  if (state === 'idle') {
    // Sleeping sploot pose
    const v = V(size, 17, 8, 9);
    const phase = (t % 4.5) / 4.5;
    const breathe = phase < 0.4 ? Math.sin(phase / 0.4 * Math.PI) : 0;
    const bw = 13 * (1 + breathe * 0.015);

    // Shadow
    fill(`rgba(0,0,0,${0.25 + breathe * 0.05})`, ...v.r(-1, 15, 17, 1));
    // Legs up
    for (const x of [3, 5, 9, 11]) fill(CLAUDE.body, ...v.r(x, 8.5, 1, 1.5));
    // Torso
    fill(CLAUDE.body, ...v.r(1 - (bw - 13) / 2, 10, bw, 5 * (1 + breathe * 0.25)));
    // Arms
    fill(CLAUDE.body, ...v.r(-1, 13, 2, 2));
    fill(CLAUDE.body, ...v.r(14, 13, 2, 2));
    // Eyes shut
    const ey = 12.2 - breathe * 2.5;
    fill(CLAUDE.eye, ...v.r(3, ey, 2.5, 1));
    fill(CLAUDE.eye, ...v.r(9.5, ey, 2.5, 1));
    drawZzz(ctx, v, t);

  } else if (state === 'working') {
    // Standing, typing at keyboard
    const v = V(size, 16, 11, 5.5);
    const bounce = Math.sin(t * 2 * Math.PI / 0.35) * 1.2;
    const dy = bounce;

    // Shadow
    const sw = 9 - Math.abs(dy) * 0.3;
    fill(`rgba(0,0,0,${Math.max(0.1, 0.35 - Math.abs(dy) * 0.03)})`,
      ...v.r(3 + (9 - sw) / 2, 15, sw, 1));
    // Legs
    for (const x of [3, 5, 9, 11]) fill(CLAUDE.body, ...v.r(x, 13, 1, 2));
    // Torso
    fill(CLAUDE.body, ...v.r(2, 6, 11, 7, dy));
    // Eyes (squinted)
    const blink = (t % 3.5);
    const eyeH = (blink > 1.4 && blink < 1.55) ? 0.2 : 1;
    fill(CLAUDE.eye, ...v.r(4, 8 + (2 - eyeH * 2) / 2, 1, eyeH * 2, dy));
    fill(CLAUDE.eye, ...v.r(10, 8 + (2 - eyeH * 2) / 2, 1, eyeH * 2, dy));
    // Keyboard
    fill(CLAUDE.kbBase, ...v.r(-0.5, 11.8, 16, 3.5));
    const keyPhase = Math.floor(t / 0.12) % 6;
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 6; col++) {
        const kx = 0.3 + col * 2.5, ky = 12.2 + row * 1;
        const isHit = (row * 2 + col) % 6 === keyPhase;
        fill(isHit ? CLAUDE.kbHi : CLAUDE.kbKey, ...v.r(kx, ky, 2, 0.7));
      }
    }
    // Arms (simple blocks beside body)
    fill(CLAUDE.body, ...v.r(0, 9, 2, 2, dy));
    fill(CLAUDE.body, ...v.r(13, 9, 2, 2, dy));

  } else {
    // Alert: jumping
    const v = V(size, 15, 12, 4);
    const pct = (t % 3.5) / 3.5;
    const jumpY = lerp([
      [0,0],[0.03,0],[0.1,-1],[0.15,1.5],[0.175,-10],[0.2,-10],[0.25,1.5],
      [0.275,-8],[0.3,-8],[0.35,1.2],[0.375,-5],[0.4,-5],[0.45,1],
      [0.475,-3],[0.5,-3],[0.55,0.5],[0.62,0],[1,0]
    ], pct);
    const shakeX = (pct > 0.15 && pct < 0.55) ? Math.sin(pct * 80) * 0.6 : 0;

    // Shadow
    const sw = 9 * (1 - Math.abs(Math.min(0, jumpY)) * 0.04);
    fill(`rgba(0,0,0,${Math.max(0.08, 0.4 - Math.abs(Math.min(0, jumpY)) * 0.04)})`,
      ...v.r(3 + (9 - sw) / 2, 15, sw, 1));
    // Legs
    for (const x of [3, 5, 9, 11]) fill(CLAUDE.body, ...v.r(x + shakeX, 11, 1, 4, jumpY));
    // Torso
    fill(CLAUDE.body, ...v.r(2 + shakeX, 6, 11, 7, jumpY));
    // Eyes (widened)
    const eyeColor = Math.sin(pct * 25) > 0 ? CLAUDE.alert : CLAUDE.eye;
    fill(eyeColor, ...v.r(4 + shakeX, 7.5, 1, 2.6, jumpY));
    fill(eyeColor, ...v.r(10 + shakeX, 7.5, 1, 2.6, jumpY));
    // ! mark
    if (pct < 0.6) {
      const bangOp = pct < 0.5 ? 1 : 1 - (pct - 0.5) / 0.1;
      fill(`rgba(255,61,0,${bangOp})`, ...v.r(13, 4 + jumpY * 0.15, 1.5, 3.5));
      fill(`rgba(255,61,0,${bangOp})`, ...v.r(13, 8.5 + jumpY * 0.15, 1.5, 1.5));
    }
  }
}

// ===== Codex (Dex) — pixel cloud with >_ face =====

const CODEX = { body: '#EBEBEE', bodyDk: '#D0D0D5', face: '#1a1a1a', accent: '#10A37F' };

function drawCodex(ctx, size, state, t) {
  const v = V(size, 15, 12, 5);
  const fill = (c, ...r) => { ctx.fillStyle = c; ctx.fillRect(...r); };

  let dy = 0;
  if (state === 'idle') dy = Math.sin(t * 1.5) * 0.8;
  else if (state === 'working') dy = Math.sin(t * 2 * Math.PI / 0.5) * 0.8;
  else {
    const pct = (t % 3.5) / 3.5;
    dy = lerp([[0,0],[0.1,-1],[0.175,-7],[0.25,1],[0.275,-5],[0.35,0.8],
      [0.375,-3],[0.45,0.5],[0.55,0],[1,0]], pct);
  }

  // Shadow
  fill('rgba(0,0,0,0.15)', ...v.r(3, 16, 9, 0.8));
  // Cloud body (rows of blocks)
  const rows = [
    [5, 5, 5], [4, 7, 0], [2, 3, 0], [3, 9, 0],
    [2, 11, 0], [1, 13, 0], [1, 13, 0], [1, 13, 0],
    [2, 11, 0], [3, 9, 0], [4, 7, 0]
  ];
  for (let i = 0; i < rows.length; i++) {
    fill(CODEX.body, ...v.r(rows[i][0], 5 + i, rows[i][1], 1, dy));
  }
  // Face: > symbol
  fill(CODEX.face, ...v.r(4, 9, 1.2, 0.8, dy));
  fill(CODEX.face, ...v.r(5.2, 9.8, 1.2, 0.8, dy));
  fill(CODEX.face, ...v.r(4, 10.6, 1.2, 0.8, dy));
  // _ underscore
  fill(CODEX.face, ...v.r(7, 10.6, 3, 0.8, dy));
  // Cursor blink
  if (state === 'idle' ? (t % 1.2) < 0.6 : state === 'working') {
    fill(CODEX.face, ...v.r(10.5, 9, 0.8, 2.4, dy));
  }
  if (state === 'idle') drawZzz(ctx, v, t);
  if (state === 'alert') {
    const pct = (t % 3.5) / 3.5;
    if (pct < 0.6) {
      const op = pct < 0.5 ? 1 : 1 - (pct - 0.5) / 0.1;
      fill(`rgba(255,61,0,${op})`, ...v.r(13, 4 + dy * 0.15, 1.3, 3));
      fill(`rgba(255,61,0,${op})`, ...v.r(13, 7.5 + dy * 0.15, 1.3, 1.3));
    }
  }
}

// ===== Gemini — 4-pointed sparkle =====

const GEMINI = { c1: '#4796E4', c2: '#847ACE', c3: '#C3677F' };

function drawGemini(ctx, size, state, t) {
  const v = V(size, 15, 15, 3);
  const fill = (c, ...r) => { ctx.fillStyle = c; ctx.fillRect(...r); };

  let dy = 0;
  if (state === 'idle') dy = Math.sin(t * 1.5) * 0.8;
  else if (state === 'working') dy = Math.sin(t * 2 * Math.PI / 0.5) * 0.8;

  fill('rgba(0,0,0,0.12)', ...v.r(4, 17, 7, 0.8));
  // 4-pointed star shape (diamond blocks)
  const bc = GEMINI.c1;
  // Vertical arm
  fill(bc, ...v.r(6.5, 4, 2, 3, dy));
  fill(bc, ...v.r(6.5, 12, 2, 3, dy));
  // Horizontal arm
  fill(GEMINI.c2, ...v.r(2, 8.5, 3, 2, dy));
  fill(GEMINI.c3, ...v.r(10, 8.5, 3, 2, dy));
  // Center body
  fill(bc, ...v.r(5, 7, 5, 5, dy));
  fill(GEMINI.c2, ...v.r(4, 8, 7, 3, dy));
  // Eyes
  fill('#fff', ...v.r(5.5, 9, 1.2, 1.2, dy));
  fill('#fff', ...v.r(8.3, 9, 1.2, 1.2, dy));

  if (state === 'idle') drawZzz(ctx, v, t);
}

// ===== Fallback: simple block character =====

function drawFallback(ctx, size, state, t, color) {
  const v = V(size, 15, 12, 5);
  const fill = (c, ...r) => { ctx.fillStyle = c; ctx.fillRect(...r); };
  let dy = state === 'idle' ? Math.sin(t * 1.5) * 0.8 : 0;

  fill('rgba(0,0,0,0.12)', ...v.r(3, 15, 9, 0.8));
  fill(color || '#8E8E93', ...v.r(3, 6, 9, 8, dy));
  fill(color || '#8E8E93', ...v.r(4, 5, 7, 1, dy));
  fill(color || '#8E8E93', ...v.r(4, 14, 7, 1, dy));
  // Eyes
  fill('#fff', ...v.r(5, 8, 1.5, 1.5, dy));
  fill('#fff', ...v.r(8.5, 8, 1.5, 1.5, dy));
  if (state === 'idle') drawZzz(ctx, v, t);
}

// ===== Registry =====

const DRAW_FNS = { claude: drawClaude, codex: drawCodex, gemini: drawGemini };

const AGENT_COLORS = {
  claude: '#DE886D', codex: '#EBEBEE', gemini: '#4796E4',
  cursor: '#22C55E', copilot: '#CC3366', qoder: '#2ADB5C',
  factory: '#D56A26', codebuddy: '#6C4DFF', opencode: '#555'
};

function agentStatusToMascotState(status) {
  switch (status) {
    case 'tool_use': case 'thinking': case 'active': case 'subagent': case 'compacting':
      return 'working';
    case 'waiting_permission': case 'waiting_answer':
      return 'alert';
    default:
      return 'idle';
  }
}

function createMascotCanvas(source, status, size) {
  size = size || 32;
  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  canvas.style.imageRendering = 'pixelated';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.imageSmoothingEnabled = false;

  const drawFn = DRAW_FNS[source];
  const mascotState = agentStatusToMascotState(status);
  const color = AGENT_COLORS[source];
  let _timerId = null, _rafId = null, _destroyed = false;
  const startTime = performance.now() / 1000;

  function frame() {
    if (_destroyed) return;
    const t = performance.now() / 1000 - startTime;
    ctx.clearRect(0, 0, size, size);
    if (drawFn) drawFn(ctx, size, mascotState, t);
    else drawFallback(ctx, size, mascotState, t, color);
    const interval = mascotState === 'idle' ? 60 : 30;
    _timerId = setTimeout(() => { _rafId = requestAnimationFrame(frame); }, interval);
  }

  _rafId = requestAnimationFrame(frame);
  canvas._mascotDestroy = () => {
    _destroyed = true;
    if (_timerId) clearTimeout(_timerId);
    if (_rafId) cancelAnimationFrame(_rafId);
    _timerId = null; _rafId = null;
  };
  return canvas;
}

function destroyMascotCanvas(canvas) {
  if (canvas && canvas._mascotDestroy) canvas._mascotDestroy();
}
