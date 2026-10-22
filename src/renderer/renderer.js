'use strict';

// ========== DOM references ==========
const $ = (id) => document.getElementById(id);
const island = $('island');
const panel = $('panel');
const content = $('content');
const indicator = $('indicator');
const stripHit = $('stripHit');
const strip = $('strip');
const pill = $('pill');
const pillMascot = $('pillMascot');
const pillText = $('pillText');
const pillBadge = $('pillBadge');
const pillTime = $('pillTime');
const header = $('header');
const hdrMain = $('hdrMain');
const statusDot = $('statusDot');
const headerStats = $('headerStats');
const groupTabs = $('groupTabs');
const btnBack = $('btnBack');
const btnMute = $('btnMute');
const btnPin = $('btnPin');
const btnSettings = $('btnSettings');
const btnCollapse = $('btnCollapse');
const pendingBanner = $('pendingBanner');
const sessionsList = $('sessionsList');
const permissionsList = $('permissionsList');
const questionsList = $('questionsList');
const completionBody = $('completionBody');
const toastEl = $('toast');
const audio = $('audio');
const SECTIONS = {
  list: $('sessionsSection'),
  approval: $('permissionsSection'),
  question: $('questionsSection'),
  completion: $('completionSection'),
  settings: $('settingsSection')
};

const DEFAULT_ACCENT = '#4CC2FF';
// Fluent decelerate/accelerate tokens for "snappy"; a gentler ease-out/ease-in pair for "smooth".
const EASINGS = {
  snappy: ['cubic-bezier(0.1, 0.9, 0.2, 1)', 'cubic-bezier(0.9, 0.1, 1, 0.2)'],
  smooth: ['cubic-bezier(0.33, 0, 0.1, 1)', 'cubic-bezier(0.4, 0, 0.8, 0.4)']
};
const EXIT_LOCAL_MS = 450;
const EXIT_EXTERNAL_MS = 900;
const TOOL_LINGER_MS = 2000;
const COMPLETION_THROTTLE_MS = 5000;
const INPUT_ACTIVE_MS = 2000;

// ========== State ==========
let currentState = { sessions: [], pendingPermissions: [], pendingQuestions: [], recentlyResolved: [] };
let currentConfig = {};
let currentDict = {};
let currentAgents = [];
let currentSounds = {};
let currentDisplays = [];
let accentColor = null;
let hooksInstalled = true;
let reducedMotion = false;

const ui = {
  expanded: false,
  expandedBy: null, // hover | click | event | settings
  pinned: false,
  surface: 'list',
  settingsOpen: false,
  animSeq: 0,
  animating: false,
  renderQueued: false
};

// Request ids the user collapsed away: they stop auto-expanding but stay reachable from the pill.
const snoozed = new Set();
const seenRequests = new Set();
// id -> local outcome while our own IPC submit is in flight.
const submitting = new Map();
// id -> { el, surface, timer } while a resolved card plays its exit.
const exiting = new Map();
// Request cards are cached by id so AskUserQuestion drafts survive re-renders.
const requestCards = new Map();
const sessionCards = new Map();
const groupHeaders = new Map();
const lastToolBySession = new Map();
const foldedGroups = new Set(['ended']);

let completion = null; // { data, timer }
let completionBadge = 0;
let lastCompletionShownAt = 0;
let lastKeyAt = 0;
let mouseInIsland = false;
let composing = false;
let hoverExpandTimer = null;
let hoverCollapseTimer = null;
// Last rendered list layout (order, group of each id, group order); reused while the cursor is over the list.
let lastLayout = null;
let emptyNode = null;
let selectedSessionId = null;

const t = (key, fallback) => (currentDict && currentDict[key]) || fallback || key;
const fmt = (key, vars, fallback) => t(key, fallback).replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : ''));
const uiLog = (msg) => console.log('[ui] ' + msg);

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}
function icon(code, cls) {
  const n = el('span', 'ico' + (cls ? ' ' + cls : ''));
  n.textContent = String.fromCharCode(parseInt(code, 16));
  return n;
}

// ========== Init ==========
async function init() {
  [currentConfig, currentDict, currentAgents, currentSounds, currentDisplays, currentState, accentColor, hooksInstalled] = await Promise.all([
    window.codePeek.getConfig(),
    window.codePeek.getDict(),
    window.codePeek.getAgents(),
    window.codePeek.getSounds(),
    window.codePeek.getDisplays(),
    window.codePeek.getState(),
    window.codePeek.getAccentColor().catch(() => null),
    window.codePeek.isHooksInstalled().catch(() => true)
  ]);
  currentState = normalizeState(currentState);
  for (const p of currentState.pendingPermissions) seenRequests.add(p.id);
  for (const q of currentState.pendingQuestions) seenRequests.add(q.id);

  applyConfigToUI();
  applyI18n();
  reconcile();
  renderNow();

  window.codePeek.onStateChanged(handleState);
  window.codePeek.onConfigChanged(async (cfg) => {
    const langChanged = cfg.language !== currentConfig.language;
    currentConfig = cfg;
    if (langChanged) currentDict = await window.codePeek.getDict();
    applyConfigToUI();
    applyI18n();
    sessionCards.forEach(c => { c.fp = ''; });
    render();
  });
  window.codePeek.onPlaySound(type => playSound(type));
  window.codePeek.onSoundsChanged(sounds => { currentSounds = sounds; });
  window.codePeek.onCollapse(() => userCollapse('main'));
  window.codePeek.onCompletionNotify(data => handleCompletion(data));
  window.codePeek.onAccentChanged(color => { accentColor = color; applyAccent(); });

  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  mq.addEventListener('change', applyMotionPreference);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) MascotClock.pause(); else MascotClock.resume();
  });
  window.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('compositionstart', () => { composing = true; }, true);
  document.addEventListener('compositionend', () => { composing = false; }, true);

  setInterval(tickClocks, 1000);
  setInterval(safetyPoll, 200);

  // Brief hover-style cue so the user can see where the island lives after launch.
  setTimeout(() => {
    const target = stripHit.offsetParent ? stripHit : pill;
    target.classList.add('prehover');
    setTimeout(() => target.classList.remove('prehover'), 900);
  }, 600);
}

function normalizeState(s) {
  return {
    sessions: (s && s.sessions) || [],
    pendingPermissions: (s && s.pendingPermissions) || [],
    pendingQuestions: (s && s.pendingQuestions) || [],
    recentlyResolved: (s && s.recentlyResolved) || []
  };
}

// ========== State intake ==========
function handleState(state) {
  const prevIds = new Set([...currentState.pendingPermissions, ...currentState.pendingQuestions].map(x => x.id));
  currentState = normalizeState(state);
  const liveIds = new Set([...currentState.pendingPermissions, ...currentState.pendingQuestions].map(x => x.id));

  for (const id of prevIds) {
    if (!liveIds.has(id)) startExit(id);
  }
  for (const id of liveIds) {
    if (!seenRequests.has(id)) {
      seenRequests.add(id);
      playSound(id.startsWith('q_') ? 'question' : 'permission');
    }
  }
  for (const id of Array.from(snoozed)) if (!liveIds.has(id)) snoozed.delete(id);
  for (const id of Array.from(requestCards.keys())) {
    if (!liveIds.has(id) && !exiting.has(id)) requestCards.delete(id);
  }
  reconcile();
}

function livePerms() { return currentState.pendingPermissions; }
function liveQuestions() { return currentState.pendingQuestions; }
function liveRequests() { return [...livePerms(), ...liveQuestions()]; }
function hasUnsnoozedPending() { return liveRequests().some(r => !snoozed.has(r.id)); }
function isEditing() {
  if (composing) return true;
  const a = document.activeElement;
  return !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT') && island.contains(a));
}

// ========== Surface state machine ==========
function computeSurface() {
  if (ui.settingsOpen) return 'settings';
  for (const x of exiting.values()) return x.surface;
  if (livePerms().some(p => !snoozed.has(p.id))) return 'approval';
  if (liveQuestions().some(q => !snoozed.has(q.id))) return 'question';
  if (completion) return 'completion';
  return 'list';
}

function reconcile() {
  if (!ui.expanded) {
    if (hasUnsnoozedPending() || completion) expand('event');
  } else if (shouldAutoCollapse()) {
    collapse('event-done');
    renderIndicator();
    renderHeader();
    return;
  } else if (!mouseInIsland && !hoverCollapseTimer && ui.expandedBy !== 'event') {
    // A hover/click expansion whose blocking request just resolved: leave via the normal delayed collapse.
    scheduleCollapse();
  }
  setSurface(computeSurface());
  render();
}

function shouldAutoCollapse() {
  return ui.expandedBy === 'event' && !hasUnsnoozedPending() && !completion && exiting.size === 0
    && !mouseInIsland && !ui.pinned && !ui.settingsOpen && !isEditing();
}

// The panel's geometry is frozen while it slides; a surface switch requested then is applied afterwards.
function setSurface(next) {
  if (ui.animating) { ui.renderQueued = true; return; }
  const prev = ui.surface;
  ui.surface = next;
  island.classList.toggle('surface-settings', next === 'settings');
  if (prev === next && SECTIONS[next].classList.contains('on')) return;
  for (const [name, sec] of Object.entries(SECTIONS)) sec.classList.toggle('on', name === next);
  renderSurface(next);
  // One layout, then the new content fades in; no per-frame height animation.
  if (ui.expanded && prev !== next) {
    const sec = SECTIONS[next];
    sec.classList.remove('swap-in');
    void sec.offsetWidth;
    sec.classList.add('swap-in');
  }
}

// ========== Expand / collapse ==========
function expand(by) {
  clearTimeout(hoverCollapseTimer);
  hoverCollapseTimer = null;
  if (ui.expanded) return;
  ui.expanded = true;
  ui.expandedBy = by;
  uiLog(`expand by=${by}`);
  const seq = ++ui.animSeq;
  ui.animating = false;
  setSurface(computeSurface());
  renderNow();
  ui.animating = true;
  island.classList.add('animating');
  content.classList.add('entering');
  island.classList.add('expanded');
  syncIgnoreMouse();
  afterTransform(seq, durOpen(), () => {
    island.classList.remove('animating');
    content.classList.remove('entering');
    ui.animating = false;
    if (ui.renderQueued) { setSurface(computeSurface()); renderNow(); }
    window.codePeek.refreshSessions();
  });
}

function collapse(reason) {
  clearTimeout(hoverExpandTimer);
  clearTimeout(hoverCollapseTimer);
  hoverExpandTimer = null;
  hoverCollapseTimer = null;
  if (!ui.expanded) return;
  ui.expanded = false;
  ui.expandedBy = null;
  ui.pinned = false;
  uiLog(`collapse reason=${reason || '-'}`);
  if (ui.settingsOpen) closeSettings(true);
  if (completion) clearCompletion();
  const seq = ++ui.animSeq;
  ui.animating = true;
  island.classList.add('animating');
  island.classList.remove('expanded');
  if (document.activeElement && island.contains(document.activeElement)) document.activeElement.blur();
  syncIgnoreMouse();
  afterTransform(seq, durClose(), () => {
    island.classList.remove('animating');
    ui.animating = false;
    completionBadge = 0;
    lastLayout = null;
    setSurface(computeSurface());
    renderNow();
  });
}

// Runs fn once the panel transform finishes; a newer animation (seq) invalidates older callbacks.
function afterTransform(seq, duration, fn) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    panel.removeEventListener('transitionend', onEnd);
    if (seq === ui.animSeq) fn();
  };
  const onEnd = (e) => { if (e.target === panel && e.propertyName === 'transform') finish(); };
  if (reducedMotion) { finish(); return; }
  panel.addEventListener('transitionend', onEnd);
  setTimeout(finish, duration + 80);
}

// Collapsing from a button or Esc snoozes whatever is pending so the next state tick cannot re-open it.
function userCollapse(source) {
  for (const r of liveRequests()) snoozed.add(r.id);
  collapse('user:' + source);
  renderIndicator();
  renderHeader();
}

function openRequests(sessionId) {
  for (const r of liveRequests()) {
    if (!sessionId || r.sessionId === sessionId) snoozed.delete(r.id);
  }
  if (!ui.expanded) expand('click');
  reconcile();
}

function scheduleExpand(by) {
  if (ui.expanded) { clearTimeout(hoverCollapseTimer); hoverCollapseTimer = null; return; }
  if (by === 'hover' && !currentConfig.hoverExpand) return;
  if (hoverExpandTimer) return;
  const target = indicator.classList.contains('mode-pill') ? pill : stripHit;
  target.classList.add('prehover');
  hoverExpandTimer = setTimeout(() => {
    hoverExpandTimer = null;
    target.classList.remove('prehover');
    if (mouseInIsland) expand(by);
  }, getHoverExpandDelay());
}

function scheduleCollapse() {
  clearTimeout(hoverExpandTimer);
  hoverExpandTimer = null;
  pill.classList.remove('prehover');
  stripHit.classList.remove('prehover');
  if (!ui.expanded) return;
  if (ui.pinned || ui.settingsOpen || isEditing() || completion) return;
  if (hasUnsnoozedPending() || exiting.size > 0) return;
  if (!currentConfig.autoHidePanel) return;
  clearTimeout(hoverCollapseTimer);
  hoverCollapseTimer = setTimeout(() => {
    hoverCollapseTimer = null;
    if (mouseInIsland || ui.pinned || ui.settingsOpen || isEditing() || hasUnsnoozedPending() || completion) return;
    collapse('mouse-leave');
  }, getHoverCollapseDelay());
}

function durOpen() {
  const v = Number(currentConfig.animationDuration);
  return Number.isFinite(v) ? Math.min(800, Math.max(150, v)) : 300;
}
function durClose() { return Math.round(durOpen() * 2 / 3); }

function getHoverExpandDelay() {
  const v = currentConfig.hoverExpandDelay;
  return (typeof v === 'number' && v >= 0) ? v : 80;
}
function getHoverCollapseDelay() {
  const v = currentConfig.hoverCollapseDelay;
  return (typeof v === 'number' && v >= 0) ? v : 1500;
}

// ========== Exit of resolved requests ==========
const OUTCOME_VIEW = {
  allowed: ['resAllowed', 'E73E', 'ok'],
  answered: ['resAnswered', 'E73E', 'ok'],
  clarify: ['resClarify', 'E8BD', 'neutral'],
  denied: ['resDenied', 'E711', 'no'],
  rejected: ['resRejected', 'E711', 'no'],
  executed: ['resExecuted', 'E73E', 'ok'],
  failed: ['resExternal', 'E7BA', 'neutral'],
  external: ['resExternal', 'E73E', 'neutral'],
  ended: ['resEnded', 'E711', 'neutral'],
  expired: ['resExpired', 'E916', 'neutral']
};

function startExit(id) {
  const local = submitting.get(id);
  submitting.delete(id);
  const record = currentState.recentlyResolved.find(r => r.id === id);
  const outcome = (record && record.outcome) || local || 'ended';
  const card = requestCards.get(id);
  const surface = id.startsWith('q_') ? 'question' : 'approval';
  if (!card || !card.isConnected || !ui.expanded || ui.surface !== surface) {
    requestCards.delete(id);
    return;
  }
  const view = OUTCOME_VIEW[outcome] || OUTCOME_VIEW.ended;
  const result = card.querySelector('.result');
  if (result) {
    result.innerHTML = '';
    const res = el('span', 'res ' + view[2]);
    res.appendChild(icon(view[1]));
    res.appendChild(document.createTextNode(t(view[0])));
    result.appendChild(res);
  }
  card.classList.add('is-resolved');
  card.querySelectorAll('button, textarea, input').forEach(b => { b.disabled = true; });
  const isLocal = record ? record.reason === 'island' : !!local;
  const timer = setTimeout(() => {
    exiting.delete(id);
    requestCards.delete(id);
    reconcile();
  }, isLocal ? EXIT_LOCAL_MS : EXIT_EXTERNAL_MS);
  exiting.set(id, { el: card, surface, timer });
}

// ========== Render ==========
let renderScheduled = false;
function render() {
  if (ui.animating) { ui.renderQueued = true; return; }
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderNow();
  });
}

// Event surfaces paint synchronously: rAF is throttled while the transparent window is idle.
function renderNow() {
  ui.renderQueued = false;
  renderHeader();
  renderIndicator();
  renderBanner();
  renderSurface(ui.surface);
}

function renderSurface(name) {
  if (name === 'list') renderSessions();
  else if (name === 'approval') renderApproval();
  else if (name === 'question') renderQuestionSurface();
  else if (name === 'completion') renderCompletion();
}

function sessionCounts() {
  const sessions = currentState.sessions;
  const running = sessions.filter(s => s.isRunning !== false && ['thinking', 'tool_use', 'subagent', 'compacting'].includes(s.status)).length;
  return { total: sessions.length, running, pending: liveRequests().length };
}

function renderHeader() {
  const { total, running, pending } = sessionCounts();
  statusDot.className = 'dot' + (pending ? ' a' : running ? ' g' : '');
  headerStats.textContent = pending
    ? `${running} ${t('statsRunning')} · ${pending} ${t('statsPending')}`
    : total ? `${running} ${t('statsRunning')} · ${total} ${t('statsSessions')}` : '';
  if (completionBadge > 0) {
    const b = el('span', 'badge', completionBadge);
    headerStats.appendChild(b);
  }
  const group = currentConfig.sessionGrouping || 'status';
  groupTabs.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.group === group));
  const muted = !currentConfig.soundEnabled;
  $('icoMute').textContent = String.fromCharCode(muted ? 0xE74F : 0xE767);
  btnMute.title = muted ? t('tipUnmute') : t('tipMute');
  btnPin.classList.toggle('on', ui.pinned);
  btnPin.title = ui.pinned ? t('tipUnpin') : t('tipPin');
  btnSettings.title = t('tipSettings');
  btnCollapse.title = t('tipCollapse');
}

function renderBanner() {
  const n = liveRequests().length;
  const on = ui.settingsOpen && n > 0;
  pendingBanner.classList.toggle('on', on);
  if (on) {
    pendingBanner.textContent = '';
    pendingBanner.appendChild(icon('E7BA'));
    pendingBanner.appendChild(document.createTextNode(fmt('pendingBanner', { n }) + ' ›'));
  }
}

// ---------- Collapsed indicator ----------
let pillKey = '';
function renderIndicator() {
  const reqs = liveRequests();
  const mode = currentConfig.collapsedMode || 'smart';
  const showPill = mode === 'pill' || (mode === 'smart' && reqs.length > 0);
  indicator.classList.toggle('mode-pill', showPill);
  indicator.classList.toggle('mode-strip', !showPill);
  const { running } = sessionCounts();
  strip.classList.toggle('pending', reqs.length > 0);
  strip.classList.toggle('running', reqs.length === 0 && running > 0);
  if (!showPill) return;

  const sessions = currentState.sessions;
  let agent = 'claude', status = 'idle', key, build;
  if (reqs.length) {
    const oldest = reqs.slice().sort((a, b) => a.timestamp - b.timestamp)[0];
    const s = sessions.find(x => x.id === oldest.sessionId) || {};
    agent = s.agent || 'claude';
    status = 'waiting_permission';
    const tool = oldest.toolName || '';
    const label = oldest.id.startsWith('q_') || tool === 'AskUserQuestion' ? t('chipQuestion') : t('chipWaiting');
    key = `req:${oldest.id}:${reqs.length}:${agent}`;
    build = () => {
      pillText.textContent = '';
      pillText.appendChild(el('b', '', sessionName(s, oldest.sessionId)));
      pillText.appendChild(document.createTextNode(` › ${label}${tool && tool !== 'AskUserQuestion' ? ' · ' + tool : ''}`));
      pillBadge.textContent = `${reqs.length} ${t('statsPending')}`;
      pillTime.dataset.since = String(oldest.timestamp || Date.now());
    };
  } else {
    const runningSessions = sessions.filter(s => s.isRunning !== false && ['thinking', 'tool_use', 'subagent', 'compacting'].includes(s.status));
    if (runningSessions.length) {
      const s = runningSessions[0];
      agent = s.agent || 'claude';
      status = 'tool_use';
      key = `run:${runningSessions.length}:${s.id}:${s.currentTool || ''}:${agent}`;
      build = () => {
        pillText.textContent = '';
        if (runningSessions.length === 1) {
          pillText.appendChild(el('b', '', sessionName(s)));
          pillText.appendChild(document.createTextNode(' › '));
          pillText.appendChild(el('span', 'shimmer', t('chipRunning')));
          if (s.currentTool) pillText.appendChild(document.createTextNode(` · ${s.currentTool}`));
        } else {
          pillText.appendChild(el('span', 'shimmer', fmt('pillRunning', { n: runningSessions.length })));
        }
        pillBadge.textContent = '';
        delete pillTime.dataset.since;
        pillTime.textContent = '';
      };
    } else {
      key = 'idle';
      build = () => {
        pillText.textContent = t('pillIdle');
        pillBadge.textContent = '';
        delete pillTime.dataset.since;
        pillTime.textContent = '';
      };
    }
  }
  if (key === pillKey) return;
  pillKey = key;
  build();
  setMascot(pillMascot, agent, status, 20);
  tickClocks();
}

function setMascot(host, agent, status, size) {
  const state = (typeof agentStatusToMascotState === 'function') ? agentStatusToMascotState(status) : status;
  const sig = `${agent}:${state}:${size}:${currentConfig.mascotEnabled !== false}`;
  if (host.dataset.sig === sig) return;
  host.dataset.sig = sig;
  const old = host.querySelector('canvas');
  if (old) destroyMascotCanvas(old);
  host.textContent = '';
  if (currentConfig.mascotEnabled === false) {
    const a = currentAgents.find(x => x.id === agent) || {};
    const b = el('span', 'agent-badge', (a.icon || agent[0] || '?').toString().toUpperCase());
    b.style.background = sanitizeColor(a.color);
    b.style.width = b.style.height = Math.round(size * 0.75) + 'px';
    host.appendChild(b);
    return;
  }
  host.appendChild(createMascotCanvas(agent, status, size));
}

// ---------- Session list ----------
function sessionName(s, fallbackId) {
  return (s && (s.name || s.projectName)) || shortId((s && s.id) || fallbackId || '');
}

function statusView(s) {
  if (s.isRunning === false) return { key: 'ended', chip: 'gray', label: t('chipEnded'), cls: 's-ended', mascot: 'idle' };
  const hasPerm = livePerms().some(p => p.sessionId === s.id);
  const hasQ = liveQuestions().some(q => q.sessionId === s.id);
  if (hasPerm || s.status === 'waiting_permission') return { key: 'needs', chip: 'amber', label: t('chipWaiting'), cls: 's-wait', mascot: 'waiting_permission' };
  if (hasQ || s.status === 'waiting_answer') return { key: 'needs', chip: 'blue', label: t('chipQuestion'), cls: 's-ask', mascot: 'waiting_answer' };
  switch (s.status) {
    case 'thinking':
    case 'tool_use': return { key: 'running', chip: 'green', label: t('chipRunning'), cls: 's-run', mascot: s.status };
    case 'subagent': return { key: 'running', chip: 'violet', label: t('chipSubagent'), cls: 's-run', mascot: 'subagent' };
    case 'compacting': return { key: 'running', chip: 'cyan', label: t('chipCompacting'), cls: 's-run', mascot: 'compacting' };
    case 'idle': return { key: 'idle', chip: 'gray', label: t('chipIdle'), cls: 's-idle', mascot: 'idle' };
    default: return { key: 'idle', chip: 'gray', label: t('chipOnline'), cls: 's-idle', mascot: 'idle' };
  }
}

const GROUP_ORDER = ['needs', 'running', 'idle', 'ended'];
const GROUP_LABEL = { needs: 'grpNeedsAction', running: 'grpRunning', idle: 'grpIdle', ended: 'grpEnded' };
const GROUP_DOT = { needs: 'a', running: 'g', idle: '', ended: '' };

function renderSessions() {
  const sessions = currentState.sessions;
  if (sessions.length === 0) {
    clearSessionCards();
    if (!emptyNode || emptyNode._hooks !== hooksInstalled) {
      if (emptyNode) emptyNode.querySelectorAll('canvas').forEach(c => destroyMascotCanvas(c));
      emptyNode = buildEmptyState();
      emptyNode._hooks = hooksInstalled;
    }
    syncChildren(sessionsList, [emptyNode]);
    lastLayout = null;
    return;
  }
  if (emptyNode && emptyNode.isConnected) emptyNode.remove();

  const mode = currentConfig.sessionGrouping || 'status';
  const views = new Map(sessions.map(s => [s.id, statusView(s)]));
  const keyOf = (s) => (mode === 'status' ? views.get(s.id).key : mode === 'cli' ? 'cli:' + (s.agent || 'claude') : 'all');
  // While the cursor is over the list, order and group membership are frozen so click targets never move.
  const frozen = !!(mouseInIsland && ui.expanded && lastLayout && lastLayout.mode === mode);
  let ordered = sessions.slice();
  if (frozen) {
    const idx = new Map(lastLayout.order.map((id, i) => [id, i]));
    ordered.sort((a, b) => (idx.has(a.id) ? idx.get(a.id) : 1e9) - (idx.has(b.id) ? idx.get(b.id) : 1e9));
  }

  const groups = new Map();
  const groupOf = new Map();
  for (const s of ordered) {
    const key = frozen && lastLayout.group.has(s.id) ? lastLayout.group.get(s.id) : keyOf(s);
    groupOf.set(s.id, key);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  let groupKeys = Array.from(groups.keys());
  if (frozen) {
    const gi = new Map(lastLayout.groups.map((k, i) => [k, i]));
    groupKeys.sort((a, b) => (gi.has(a) ? gi.get(a) : 1e9) - (gi.has(b) ? gi.get(b) : 1e9));
  } else if (mode === 'status') {
    groupKeys.sort((a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b));
  }

  const nodes = [];
  const seen = new Set();
  for (const key of groupKeys) {
    const items = groups.get(key);
    if (mode !== 'all') nodes.push(groupHeader(key, items.length, mode));
    const folded = mode === 'status' && foldedGroups.has(key);
    if (folded) continue;
    for (const s of items) {
      nodes.push(sessionCard(s, views.get(s.id)));
      seen.add(s.id);
    }
  }
  for (const [id, c] of sessionCards) {
    if (!seen.has(id)) {
      const canvas = c.el.querySelector('canvas');
      if (canvas) destroyMascotCanvas(canvas);
      c.el.remove();
      sessionCards.delete(id);
    }
  }
  syncChildren(sessionsList, nodes);
  if (!frozen) lastLayout = { mode, order: ordered.map(s => s.id), group: groupOf, groups: groupKeys };
}

function syncChildren(parent, nodes) {
  for (let i = 0; i < nodes.length; i++) {
    if (parent.children[i] !== nodes[i]) parent.insertBefore(nodes[i], parent.children[i] || null);
  }
  while (parent.children.length > nodes.length) parent.lastElementChild.remove();
}

function clearSessionCards() {
  for (const [, c] of sessionCards) {
    const canvas = c.el.querySelector('canvas');
    if (canvas) destroyMascotCanvas(canvas);
  }
  sessionCards.clear();
}

function groupHeader(key, count, mode) {
  let h = groupHeaders.get(key);
  if (!h) {
    h = el('div', 'grp');
    h.dataset.key = key;
    h.addEventListener('click', () => {
      if (!h.classList.contains('fold')) return;
      if (foldedGroups.has(key)) foldedGroups.delete(key); else foldedGroups.add(key);
      renderSessions();
    });
    groupHeaders.set(key, h);
  }
  h.textContent = '';
  const foldable = mode === 'status' && key === 'ended';
  h.classList.toggle('fold', foldable);
  h.classList.toggle('open', foldable && !foldedGroups.has(key));
  if (foldable) h.appendChild(icon('E70D', 'chev'));
  else if (mode === 'status') h.appendChild(el('span', 'dot ' + (GROUP_DOT[key] || '')));
  let label;
  if (mode === 'status') label = t(GROUP_LABEL[key]);
  else {
    const agentId = key.slice(4);
    const a = currentAgents.find(x => x.id === agentId);
    label = (a && a.name) || agentId;
  }
  h.appendChild(el('b', '', label));
  h.appendChild(el('span', 'n', count));
  return h;
}

function sessionCard(s, view) {
  let c = sessionCards.get(s.id);
  if (!c) {
    const root = el('div', 'card');
    root.dataset.sessionId = s.id;
    const av = el('div', 'av');
    const main = el('div', 'cmain');
    const row1 = el('div', 'row1');
    const chip = el('span', 'chip');
    const name = el('span', 'name');
    const branch = el('span', 'branch');
    const meta = el('span', 'meta');
    const time = el('span', 'tchip');
    const term = el('span', 'term');
    meta.append(time, term);
    row1.append(chip, name, branch, meta);
    const prompt = el('div', 'line prompt');
    const reply = el('div', 'line reply');
    const tool = el('div', 'tool');
    const err = el('div', 'line err');
    main.append(row1, prompt, reply, tool, err);
    root.append(av, main);
    root.addEventListener('click', (e) => handleSessionClick(s.id, e));
    c = { el: root, refs: { av, chip, name, branch, time, term, prompt, reply, tool, err }, fp: '' };
    sessionCards.set(s.id, c);
  }
  const toolInfo = toolLineFor(s, view);
  const fp = [view.cls, view.label, sessionName(s), s.gitBranch, s.lastPrompt, s.lastResponse, s.lastError, s.pid,
    toolInfo ? `${toolInfo.cls}|${toolInfo.name}|${toolInfo.arg}|${toolInfo.linger}` : '', s.id === selectedSessionId,
    currentConfig.mascotEnabled].join('\u0001');
  const r = c.refs;
  r.time.textContent = formatTimeAgo(s.lastActivity || s.lastActivityAt || s.startedAt);
  setMascot(r.av, s.agent || 'claude', view.mascot, 36);
  if (fp === c.fp) return c.el;
  c.fp = fp;

  c.el.className = 'card ' + view.cls + (s.id === selectedSessionId ? ' selected' : '');
  c.el.title = [s.model ? formatModel(s.model) : '', s.cwd || ''].filter(Boolean).join(' · ');
  r.chip.className = 'chip ' + view.chip;
  r.chip.textContent = view.label;
  r.name.textContent = sessionName(s);
  r.branch.textContent = s.gitBranch ? `⑂ ${s.gitBranch}` : '';
  r.branch.style.display = s.gitBranch ? '' : 'none';
  r.term.textContent = '';
  if (s.isRunning === false) {
    r.term.appendChild(icon('E72C'));
    r.term.appendChild(document.createTextNode(t('reopen')));
  } else {
    const a = currentAgents.find(x => x.id === (s.agent || 'claude'));
    r.term.appendChild(icon('E756'));
    r.term.appendChild(document.createTextNode((a && a.name) || (s.agent || 'claude')));
  }
  setText(r.prompt, s.lastPrompt);
  setText(r.reply, s.lastResponse);
  setText(r.err, s.lastError ? '⚠ ' + String(s.lastError).substring(0, 160) : '');
  r.tool.textContent = '';
  r.tool.style.display = toolInfo ? '' : 'none';
  r.tool.classList.toggle('linger', !!(toolInfo && toolInfo.linger));
  if (toolInfo) {
    r.tool.appendChild(el('span', 'tn ' + toolInfo.cls, toolInfo.name));
    if (toolInfo.arg) r.tool.appendChild(el('span', 'arg', toolInfo.arg));
  }
  return c.el;
}

function setText(node, text) {
  const v = text ? String(text) : '';
  node.textContent = v;
  node.style.display = v ? '' : 'none';
}

function toolLineFor(s, view) {
  if (view.key === 'needs') {
    const p = livePerms().find(x => x.sessionId === s.id);
    if (p) {
      const d = p.display || {};
      return { cls: 't-wait', name: '⏸ ' + (p.toolName === 'AskUserQuestion' ? t('chipQuestion') : p.toolName), arg: d.command || d.path || p.toolInput || '', linger: false };
    }
  }
  const now = Date.now();
  if (s.currentTool) {
    lastToolBySession.set(s.id, { tool: s.currentTool, input: s.toolInput, endedAt: 0 });
    return { cls: toolClass(s.currentTool), name: '▶ ' + s.currentTool, arg: s.toolInput || '', linger: false };
  }
  const last = lastToolBySession.get(s.id);
  if (!last) return null;
  if (!last.endedAt) {
    last.endedAt = now;
    setTimeout(() => { if (sessionCards.has(s.id)) { sessionCards.get(s.id).fp = ''; render(); } }, TOOL_LINGER_MS + 50);
  }
  if (now - last.endedAt > TOOL_LINGER_MS) { lastToolBySession.delete(s.id); return null; }
  return { cls: toolClass(last.tool), name: '▶ ' + last.tool, arg: last.input || '', linger: true };
}

function toolClass(name) {
  switch (name) {
    case 'Bash': case 'PowerShell': return 't-bash';
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': return 't-edit';
    case 'Read': return 't-read';
    case 'Grep': case 'Glob': case 'WebSearch': case 'WebFetch': return 't-grep';
    case 'Agent': case 'Task': return 't-agent';
    default: return '';
  }
}

function buildEmptyState() {
  const box = el('div', 'empty');
  const av = el('div', 'av');
  setMascot(av, 'claude', 'idle', 40);
  box.appendChild(av);
  if (!hooksInstalled) {
    box.appendChild(el('div', 'em-title', t('setupTitle')));
    box.appendChild(el('div', 'em-hint', t('setupHint')));
    const b = el('button', 'btn allow', t('setupBtn'));
    b.addEventListener('click', async () => {
      const results = await window.codePeek.installAllHooks();
      hooksInstalled = !!(results && results.claude && results.claude.success);
      showToast(hooksInstalled ? t('hooksInstalled') : t('operationFailed'), hooksInstalled ? 'success' : 'error');
      render();
    });
    box.appendChild(b);
  } else {
    box.appendChild(el('div', 'em-title', t('emptyTitle')));
    box.appendChild(el('div', 'em-hint', t('emptyHint')));
  }
  return box;
}

// ---------- Approval surface ----------
function renderApproval() {
  const perms = livePerms();
  let focus = null;
  for (const [id, x] of exiting) if (x.surface === 'approval') { focus = x.el; break; }
  if (!focus) {
    const p = perms.find(x => !snoozed.has(x.id)) || perms[0];
    if (!p) { permissionsList.textContent = ''; return; }
    focus = requestCards.get(p.id) || buildRequestCard(p);
    requestCards.set(p.id, focus);
    // AskUserQuestion cards use the same slot for their own "question n / N" step indicator.
    const q = focus.querySelector('.queue');
    if (q && !focus._isAsk) q.textContent = perms.length > 1 ? `${perms.indexOf(p) + 1} / ${perms.length}` : '';
  }
  if (permissionsList.firstElementChild !== focus || permissionsList.children.length !== 1) {
    permissionsList.textContent = '';
    permissionsList.appendChild(focus);
  }
}

function buildRequestCard(p) {
  if (p.toolName === 'AskUserQuestion' && Array.isArray(p.questions) && p.questions.length > 0) return buildAskCard(p);
  return buildPermissionCard(p);
}

function sourceRow(p, chipDot) {
  const s = currentState.sessions.find(x => x.id === p.sessionId) || {};
  const row = el('div', 'src');
  row.appendChild(el('span', 'dot ' + chipDot));
  row.appendChild(el('span', 'name', sessionName(s, p.sessionId)));
  if (s.gitBranch) row.appendChild(el('span', 'branch', `⑂ ${s.gitBranch}`));
  const a = currentAgents.find(x => x.id === (s.agent || 'claude'));
  const when = el('span', 'when');
  when.appendChild(document.createTextNode(`· ${(a && a.name) || 'Claude'}${p.isSubagent ? ' · ' + t('subagentTag') : ''} · ${t('waitingFor')} `));
  const since = el('b');
  since.dataset.since = String(p.timestamp || Date.now());
  when.appendChild(since);
  row.appendChild(when);
  row.appendChild(el('span', 'queue'));
  if (s.pid || s.cwd) {
    const jump = el('button', 'ibtn');
    jump.title = t('tipJump');
    jump.appendChild(icon('E8A7'));
    jump.addEventListener('click', (e) => { e.stopPropagation(); jumpToSession(s.id || p.sessionId); });
    row.appendChild(jump);
  }
  return row;
}

function permVerb(tool) {
  if (tool === 'Bash' || tool === 'PowerShell') return t('permVerbBash');
  if (tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') return t('permVerbEdit');
  if (tool === 'Write') return t('permVerbWrite');
  if (tool === 'Read') return t('permVerbRead');
  if (tool === 'WebFetch') return t('permVerbWeb');
  if (tool === 'WebSearch') return t('permVerbSearch');
  if (tool === 'Task' || tool === 'Agent') return t('permVerbAgent');
  if (tool && tool.startsWith('mcp__')) return t('permVerbMcp');
  return t('permVerbDefault');
}

function buildPermissionCard(p) {
  const d = p.display || {};
  const card = el('div', 'req');
  card.dataset.id = p.id;
  card.appendChild(sourceRow(p, 'a'));

  const ttl = el('div', 'ttl');
  ttl.appendChild(el('span', 'chip amber', t('permChip')));
  ttl.appendChild(document.createTextNode(`${p.toolName} ${permVerb(p.toolName)}`));
  card.appendChild(ttl);

  const code = el('div', 'code');
  if (d.path) code.appendChild(el('div', 'path', d.path));
  const body = d.command || d.detail || (!d.path ? p.toolInput : '');
  let cmd = null;
  if (body) {
    cmd = el('div', 'cmd clamped');
    if (p.toolName === 'Bash' || p.toolName === 'PowerShell') {
      cmd.appendChild(el('span', 'ps', p.toolName === 'PowerShell' ? '>' : '$'));
      cmd.appendChild(document.createTextNode(body));
    } else if (d.detail && !d.command) {
      for (const line of String(body).split('\n')) {
        const ln = el('div', line.startsWith('- ') ? 'del' : line.startsWith('+ ') ? 'add' : '', line);
        cmd.appendChild(ln);
      }
    } else {
      cmd.textContent = body;
    }
    code.appendChild(cmd);
  }
  if (d.description) code.appendChild(el('div', 'desc', d.description));
  if (code.children.length) card.appendChild(code);

  if (cmd) {
    const tools = el('div', 'code-tools');
    const toggle = el('button', '', t('expandAll'));
    toggle.style.display = 'none';
    toggle.addEventListener('click', () => {
      const clamped = cmd.classList.toggle('clamped');
      toggle.textContent = clamped ? t('expandAll') : t('showLess');
    });
    const copy = el('button', '', t('copy'));
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(body); copy.textContent = t('copied'); } catch {}
      setTimeout(() => { copy.textContent = t('copy'); }, 1200);
    });
    tools.append(toggle, copy);
    card.appendChild(tools);
    requestAnimationFrame(() => { if (cmd.scrollHeight > cmd.clientHeight + 2) toggle.style.display = ''; });
  }

  const acts = el('div', 'acts');
  if (p.alwaysLabel) {
    const always = el('button', 'lnk');
    always.appendChild(document.createTextNode(t('alwaysAllowFor') + ' '));
    always.appendChild(el('code', '', p.alwaysLabel));
    always.addEventListener('click', () => submitDecision(p, card, always, 'always'));
    acts.appendChild(always);
  }
  acts.appendChild(el('span', 'sp'));
  const later = el('button', 'btn text', t('btnLater'));
  later.addEventListener('click', () => userCollapse('card'));
  const deny = el('button', 'btn deny', t('btnDeny'));
  deny.addEventListener('click', () => submitDecision(p, card, deny, 'deny'));
  const allow = el('button', 'btn allow', t('btnAllowOnce'));
  allow.addEventListener('click', () => submitDecision(p, card, allow, 'allow'));
  acts.append(later, deny, allow);
  card.appendChild(acts);
  card.appendChild(el('div', 'result'));
  return card;
}

const LOCAL_OUTCOME = { allow: 'allowed', always: 'allowed', deny: 'denied' };

// Locks the card until the main process confirms; a failed send restores it instead of silently vanishing.
async function submitDecision(p, card, btn, behavior, answers, message) {
  if (submitting.has(p.id) || card.classList.contains('is-resolved')) return;
  submitting.set(p.id, answers ? 'answered' : message ? 'clarify' : LOCAL_OUTCOME[behavior]);
  const buttons = card.querySelectorAll('button');
  buttons.forEach(b => { b.disabled = true; });
  btn.classList.add('busy');
  console.log(`[perm] submit id=${p.id} behavior=${behavior}`);
  let res;
  try {
    res = await window.codePeek.approvePermission(p.id, behavior, answers || null, message || null);
  } catch {
    res = { ok: false, status: 'delivery-failed' };
  }
  btn.classList.remove('busy');
  if (res && (res.ok || res.status === 'already-settled')) {
    if (!livePerms().some(x => x.id === p.id) && !exiting.has(p.id) && !card.classList.contains('is-resolved')) startExit(p.id);
    return;
  }
  submitting.delete(p.id);
  if (!card.classList.contains('is-resolved')) buttons.forEach(b => { b.disabled = false; });
  if (card._refresh) card._refresh();
  showToast(t('submitFailed'), 'error');
}

// ---------- AskUserQuestion ----------
function buildAskCard(p) {
  const qs = p.questions;
  const st = {
    step: 0,
    picks: qs.map(() => []),
    other: qs.map(() => ''),
    otherOn: qs.map(() => false)
  };
  const card = el('div', 'req');
  card.dataset.id = p.id;
  card.appendChild(sourceRow(p, 'b'));
  const ttl = el('div', 'ttl');
  const meta = el('div', 'ask-meta');
  const opts = el('div', 'opts');
  const foot = el('div', 'ask-foot');
  card.append(ttl, meta, opts, foot, el('div', 'result'));

  const answered = (i) => (st.otherOn[i] ? st.other[i].trim().length > 0 : st.picks[i].length > 0);
  const answerOf = (i) => {
    const labels = st.picks[i].slice();
    if (st.otherOn[i] && st.other[i].trim()) labels.push(st.other[i].trim());
    return qs[i].multiSelect ? labels : (labels[labels.length - 1] || '');
  };
  const submit = (btn) => {
    if (!qs.every((_, i) => answered(i))) return;
    const answers = {};
    qs.forEach((q, i) => { answers[q.question] = answerOf(i); });
    submitDecision(p, card, btn, 'allow', answers);
  };

  function draw() {
    const i = st.step;
    const q = qs[i];
    ttl.textContent = '';
    ttl.appendChild(el('span', 'qm', '?'));
    if (q.header) ttl.appendChild(el('span', 'chip blue', q.header));
    ttl.appendChild(document.createTextNode(String(q.question || '')));
    const queue = card.querySelector('.queue');
    if (queue) queue.textContent = qs.length > 1 ? fmt('askStep', { n: i + 1, total: qs.length }) : '';
    meta.textContent = q.multiSelect ? t('askMulti') : '';
    meta.style.display = q.multiSelect ? '' : 'none';

    opts.textContent = '';
    (q.options || []).forEach((opt, oi) => {
      const label = String(opt.label || '');
      const row = el('button', 'opt' + (q.multiSelect ? ' multi' : ''));
      row.classList.toggle('sel', st.picks[i].includes(label));
      row.appendChild(el('span', 'ix', `${oi + 1}.`));
      const txt = el('div');
      const ol = el('div', 'ol', label.replace(/\s*\((recommended|推荐)\)\s*$/i, ''));
      if (/\((recommended|推荐)\)\s*$/i.test(label)) ol.appendChild(el('em', '', t('recommended')));
      txt.appendChild(ol);
      if (opt.description) txt.appendChild(el('div', 'od', opt.description));
      row.appendChild(txt);
      row.addEventListener('click', () => {
        if (q.multiSelect) {
          const at = st.picks[i].indexOf(label);
          if (at >= 0) st.picks[i].splice(at, 1); else st.picks[i].push(label);
        } else {
          st.picks[i] = [label];
          st.otherOn[i] = false;
        }
        draw();
      });
      opts.appendChild(row);
    });
    const other = el('div', 'opt other' + (q.multiSelect ? ' multi' : ''));
    other.classList.toggle('sel', st.otherOn[i]);
    other.appendChild(el('span', 'ix', '…'));
    other.appendChild(el('div', 'ol', t('askOther')));
    const ta = el('textarea');
    ta.maxLength = 4000;
    ta.placeholder = t('askOtherPlaceholder');
    ta.value = st.other[i];
    ta.addEventListener('click', e => e.stopPropagation());
    ta.addEventListener('input', () => { st.other[i] = ta.value; refreshFoot(); });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !composing) {
        e.preventDefault();
        if (i < qs.length - 1 && answered(i)) { st.step++; draw(); } else submit(foot.querySelector('.btn.allow'));
      }
    });
    other.appendChild(ta);
    other.addEventListener('click', () => {
      st.otherOn[i] = q.multiSelect ? !st.otherOn[i] : true;
      if (!q.multiSelect) st.picks[i] = [];
      draw();
      if (st.otherOn[i]) {
        window.codePeek.focusWindow();
        setTimeout(() => { const fresh = opts.querySelector('.opt.other textarea'); if (fresh) fresh.focus(); }, 0);
      }
    });
    opts.appendChild(other);
    drawFoot();
  }

  function drawFoot() {
    const i = st.step;
    foot.textContent = '';
    if (qs[i].multiSelect) foot.appendChild(el('span', 'count', fmt('askSelected', { n: answerOfCount(i) })));
    foot.appendChild(el('span', 'sp'));
    const later = el('button', 'btn text', t('btnLater'));
    later.addEventListener('click', () => userCollapse('card'));
    const clarify = el('button', 'btn line', t('askClarify'));
    clarify.addEventListener('click', () => {
      const lines = qs.map((q, n) => `${n + 1}. ${q.question}`).join('\n');
      submitDecision(p, card, clarify, 'deny', null,
        `The user wants to discuss these questions in the conversation instead of picking an option.\n\nQuestions asked:\n${lines}`);
    });
    const skip = el('button', 'btn line', t('askSkip'));
    skip.addEventListener('click', () => submitDecision(p, card, skip, 'deny'));
    foot.append(later, clarify, skip);
    if (i > 0) {
      const prev = el('button', 'btn line', t('askPrev'));
      prev.addEventListener('click', () => { st.step--; draw(); });
      foot.appendChild(prev);
    }
    const last = i === qs.length - 1;
    const next = el('button', 'btn allow', last ? (qs.length > 1 ? t('askSubmitAll') : t('askSubmit')) : t('askNext'));
    next.disabled = !answered(i) || (last && !qs.every((_, n) => answered(n)));
    next.addEventListener('click', () => {
      if (!last) { st.step++; draw(); return; }
      submit(next);
    });
    foot.appendChild(next);
  }

  function answerOfCount(i) {
    return st.picks[i].length + (st.otherOn[i] && st.other[i].trim() ? 1 : 0);
  }

  function refreshFoot() {
    const i = st.step;
    const last = i === qs.length - 1;
    const next = foot.querySelector('.btn.allow');
    if (next && !submitting.has(p.id)) next.disabled = !answered(i) || (last && !qs.every((_, n) => answered(n)));
    const count = foot.querySelector('.count');
    if (count) count.textContent = fmt('askSelected', { n: answerOfCount(i) });
  }

  card._refresh = refreshFoot;
  card._isAsk = true;
  draw();
  return card;
}

// ---------- Codex free-text question surface ----------
function renderQuestionSurface() {
  let focus = null;
  for (const [, x] of exiting) if (x.surface === 'question') { focus = x.el; break; }
  if (!focus) {
    const qs = liveQuestions();
    const q = qs.find(x => !snoozed.has(x.id)) || qs[0];
    if (!q) { questionsList.textContent = ''; return; }
    focus = requestCards.get(q.id) || buildQuestionCard(q);
    requestCards.set(q.id, focus);
  }
  if (questionsList.firstElementChild !== focus) {
    questionsList.textContent = '';
    questionsList.appendChild(focus);
  }
}

function buildQuestionCard(q) {
  const card = el('div', 'req');
  card.dataset.id = q.id;
  card.appendChild(sourceRow(q, 'b'));
  const ttl = el('div', 'ttl');
  ttl.appendChild(el('span', 'chip blue', t('chipQuestion')));
  card.appendChild(ttl);
  card.appendChild(el('div', 'qtext', q.question || ''));
  const row = el('div', 'acts');
  const input = el('input', 'qinput');
  input.type = 'text';
  input.placeholder = t('questionPlaceholder');
  const send = el('button', 'btn allow', t('btnSend'));
  const doSend = async () => {
    const v = input.value.trim();
    if (!v || submitting.has(q.id)) return;
    submitting.set(q.id, 'answered');
    send.disabled = true;
    const res = await window.codePeek.answerQuestion(q.id, v).catch(() => ({ ok: false }));
    if (!res || (!res.ok && res.status !== 'already-settled')) {
      submitting.delete(q.id);
      send.disabled = false;
      showToast(t('submitFailed'), 'error');
    }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && !composing) doSend(); });
  input.addEventListener('focus', () => window.codePeek.focusWindow());
  send.addEventListener('click', doSend);
  const later = el('button', 'btn text', t('btnLater'));
  later.addEventListener('click', () => userCollapse('card'));
  row.append(input, later, send);
  card.appendChild(row);
  card.appendChild(el('div', 'result'));
  return card;
}

// ---------- Completion ----------
function handleCompletion(data) {
  if (!data) return;
  const suppress = (why) => {
    console.log(`[completion] suppressed: ${why}`);
    completionBadge++;
    renderHeader();
  };
  if (hasUnsnoozedPending()) return suppress('blocking request');
  if (ui.settingsOpen) return suppress('settings open');
  if (ui.expanded && ui.expandedBy !== 'event' && ui.surface === 'list') return suppress('user browsing');
  if (!mouseInIsland && Date.now() - lastKeyAt < INPUT_ACTIVE_MS) return suppress('typing');
  if (Date.now() - lastCompletionShownAt < COMPLETION_THROTTLE_MS) return suppress('throttled');
  showCompletion(data);
}

function showCompletion(data) {
  if (completion && completion.timer) clearTimeout(completion.timer);
  completion = { data, timer: null, hover: false };
  lastCompletionShownAt = Date.now();
  playSound('complete');
  console.log(`[completion] show: expanded=${ui.expanded}`);
  completionBody.textContent = '';
  reconcile();
}

function completionMs() {
  return (currentConfig.completionDisplayTime || 5) * 1000;
}

function startCompletionTimer() {
  if (!completion) return;
  clearTimeout(completion.timer);
  completion.timer = setTimeout(() => {
    if (completion && completion.hover) return;
    dismissCompletion();
  }, completionMs());
}

function clearCompletion() {
  if (completion && completion.timer) clearTimeout(completion.timer);
  completion = null;
  completionBody.textContent = '';
}

function dismissCompletion() {
  console.log('[completion] dismiss');
  clearCompletion();
  reconcile();
}

function renderCompletion() {
  if (!completion) { completionBody.textContent = ''; return; }
  if (completionBody.firstElementChild && completionBody.firstElementChild._data === completion.data) return;
  const d = completion.data;
  const card = el('div', 'done');
  card._data = d;
  card.style.setProperty('--countdown', completionMs() + 'ms');
  const ok = el('div', 'ok');
  ok.appendChild(icon('E73E'));
  const body = el('div');
  body.style.minWidth = '0';
  const t1 = el('div', 't1');
  t1.appendChild(el('span', 'chip green', t('completionDone')));
  t1.appendChild(el('span', 'name', (d.projectName || d.sessionTitle || t('completionUntitled')).trim()));
  if (d.gitBranch) t1.appendChild(el('span', 'branch', `⑂ ${d.gitBranch}`));
  body.appendChild(t1);
  const summary = (d.lastResponse || d.sessionTitle || d.cwd || '').toString().trim();
  if (summary) body.appendChild(el('div', 't2', summary));
  const view = el('span', 'term');
  view.appendChild(icon('E8A7'));
  view.appendChild(document.createTextNode(t('completionView')));
  card.append(ok, body, view, el('div', 'bar'));
  card.addEventListener('mouseenter', () => { if (completion) { completion.hover = true; clearTimeout(completion.timer); } });
  card.addEventListener('mouseleave', () => { if (completion) { completion.hover = false; startCompletionTimer(); } });
  card.addEventListener('click', () => {
    const snap = completion && completion.data;
    clearCompletion();
    collapse('completion-click');
    if (snap) jumpToSession(snap.sessionId, snap);
  });
  completionBody.textContent = '';
  completionBody.appendChild(card);
  startCompletionTimer();
}

// ========== Clocks ==========
function tickClocks() {
  const now = Date.now();
  const nodes = [];
  if (indicator.classList.contains('mode-pill') && pillTime.dataset.since) nodes.push(pillTime);
  if (ui.expanded) island.querySelectorAll('.panel [data-since]').forEach(n => nodes.push(n));
  for (const n of nodes) {
    const sec = Math.max(0, Math.floor((now - Number(n.dataset.since)) / 1000));
    n.textContent = sec >= 3600 ? `${Math.floor(sec / 3600)}h${String(Math.floor(sec % 3600 / 60)).padStart(2, '0')}`
      : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  }
  if (ui.expanded && ui.surface === 'list') {
    for (const [id, c] of sessionCards) {
      const s = currentState.sessions.find(x => x.id === id);
      if (s) c.refs.time.textContent = formatTimeAgo(s.lastActivity || s.lastActivityAt || s.startedAt);
    }
  }
}

// ========== Actions ==========
async function handleSessionClick(sessionId, event) {
  const s = currentState.sessions.find(x => x.id === sessionId);
  if (!s) return;
  if (event.shiftKey || event.ctrlKey) {
    selectedSessionId = selectedSessionId === sessionId ? null : sessionId;
    render();
    return;
  }
  if (liveRequests().some(r => r.sessionId === sessionId)) { openRequests(sessionId); return; }
  if (s.isRunning === false) {
    showToast(t('reopening'), 'success');
    const result = await window.codePeek.launchSession(s.id, s.cwd || '', s.agent || 'claude');
    showToast(result && result.success ? t('reopenOk') : `${t('reopenFailed')}: ${(result && result.error) || 'Unknown'}`,
      result && result.success ? 'success' : 'error');
    return;
  }
  jumpToSession(sessionId);
}

// Codex sessions spawned by Claude have no PID of their own; fall back to a live session in the same cwd.
async function jumpToSession(sessionId, snapshot) {
  let sessions = currentState.sessions;
  try { sessions = (await window.codePeek.getState()).sessions || sessions; } catch {}
  const s = sessions.find(x => x.id === sessionId) || {};
  const cwd = (s.cwd || (snapshot && snapshot.cwd) || '').toString();
  const agent = s.agent || (snapshot && snapshot.agent) || '';
  let pid = s.pid;
  if (!pid && cwd) {
    const parent = sessions.find(x => x.pid && x.isRunning !== false && x.cwd === cwd && x.agent !== agent)
      || sessions.find(x => x.pid && x.isRunning !== false && x.cwd === cwd);
    if (parent) pid = parent.pid;
  }
  if (!pid) { showToast(t('menuNoPid'), 'error'); return; }
  const name = (s.name || (snapshot && (snapshot.sessionTitle || snapshot.projectName)) || '').toString();
  const result = await window.codePeek.jumpToTerminal(pid, name, cwd);
  if (!result || !result.success) {
    const err = (result && result.error) || '';
    showToast(/NO_WINDOW|No ancestors/i.test(err) ? t('sessionClosed') : `${t('menuJumpFailed')}: ${err || 'Unknown'}`, 'error');
  }
}

function playSound(type) {
  if (!currentConfig.soundEnabled) return;
  const keyMap = { sessionStart: 'soundOnSessionStart', toolUse: 'soundOnToolUse', permission: 'soundOnPermission', question: 'soundOnQuestion', complete: 'soundOnComplete' };
  if (keyMap[type] && !currentConfig[keyMap[type]]) return;
  const url = currentSounds[type];
  if (!url) return;
  audio.src = url;
  audio.volume = currentConfig.soundVolume || 0.5;
  audio.play().catch(() => {});
}

// ========== Config / i18n / theme ==========
function applyConfigToUI() {
  const root = document.documentElement.style;
  const fs = Number(currentConfig.fontSize) || 13;
  root.setProperty('--fs', fs + 'px');
  root.setProperty('--response-lines', currentConfig.responseLines || 2);
  const peek = typeof currentConfig.peekHeight === 'number' ? currentConfig.peekHeight : 5;
  root.setProperty('--peek-height', peek + 'px');
  const ph = Number(currentConfig.panelHeight) > 0 ? Number(currentConfig.panelHeight) : 560;
  root.setProperty('--content-max-height', Math.max(200, ph - 62) + 'px');
  const ease = EASINGS[currentConfig.animationEasing] || EASINGS.snappy;
  root.setProperty('--dur-open', durOpen() + 'ms');
  root.setProperty('--dur-close', durClose() + 'ms');
  root.setProperty('--ease-open', ease[0]);
  root.setProperty('--ease-close', ease[1]);
  applyAccent();
  applyMotionPreference();
  pillKey = '';
}

function applyMotionPreference() {
  const sys = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  reducedMotion = sys || currentConfig.reduceMotion === true;
  document.documentElement.classList.toggle('reduced', reducedMotion);
  MascotClock.setReduced(reducedMotion);
}

// Dark accents (e.g. default Windows blue) are lifted so links and indicators stay legible on near-black.
function applyAccent() {
  let color = (currentConfig.followAccent !== false && accentColor) ? accentColor : DEFAULT_ACCENT;
  const m = /^#([0-9a-f]{6})$/i.exec(color || '');
  if (!m) color = DEFAULT_ACCENT;
  else {
    let [r, g, b] = [0, 2, 4].map(i => parseInt(m[1].substr(i, 2), 16));
    const lum = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    let k = 0;
    while (0.2126 * lum(r) + 0.7152 * lum(g) + 0.0722 * lum(b) < 0.28 && k < 10) {
      r = Math.round(r + (255 - r) * 0.18); g = Math.round(g + (255 - g) * 0.18); b = Math.round(b + (255 - b) * 0.18);
      k++;
    }
    color = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
  }
  document.documentElement.style.setProperty('--accent', color);
}

function applyI18n() {
  document.documentElement.lang = (currentDict.statusIdle === '空闲') ? 'zh-CN' : 'en';
  $('titleText').textContent = t('appName', 'CodePeek');
  document.querySelectorAll('[data-i18n]').forEach(n => {
    const v = currentDict[n.dataset.i18n];
    if (v) n.textContent = v;
  });
  if (ui.settingsOpen) updateHookStatus();
  renderHeader();
}

// ========== Mouse handling ==========
// Passthrough: outside the island the transparent window ignores the mouse but still forwards moves.
let lastIgnore = null;
function syncIgnoreMouse() {
  const ignore = !mouseInIsland;
  if (ignore === lastIgnore) return;
  lastIgnore = ignore;
  window.codePeek.setIgnoreMouse(ignore);
}

function updateMouseInIsland(inside) {
  if (inside === mouseInIsland) return;
  mouseInIsland = inside;
  syncIgnoreMouse();
  if (inside) {
    if (ui.expandedBy === 'event') ui.expandedBy = 'hover';
    scheduleExpand('hover');
  } else {
    scheduleCollapse();
    if (lastLayout && ui.surface === 'list') render();
  }
}

island.addEventListener('mouseenter', () => updateMouseInIsland(true));
island.addEventListener('mouseleave', () => updateMouseInIsland(false));
island.addEventListener('mousemove', () => { if (!mouseInIsland) updateMouseInIsland(true); });

function interactiveRect() {
  if (ui.expanded) {
    const r = panel.getBoundingClientRect();
    return { left: r.left - 14, right: r.right + 14, top: 0, bottom: r.bottom + 2 };
  }
  const target = indicator.classList.contains('mode-pill') ? pill : stripHit;
  const r = target.getBoundingClientRect();
  return { left: r.left - 10, right: r.right + 10, top: 0, bottom: r.bottom + 2 };
}

// mouseleave can be lost while passthrough toggles, so the real cursor position is polled while inside.
let safetyPollInFlight = false;
async function safetyPoll() {
  if (!mouseInIsland || safetyPollInFlight || document.querySelector('select:focus')) return;
  safetyPollInFlight = true;
  try {
    const { screenX, screenY, winBounds } = await window.codePeek.getCursorScreenPoint();
    if (!mouseInIsland || !winBounds) return;
    const x = screenX - winBounds.x;
    const y = screenY - winBounds.y;
    const r = interactiveRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) updateMouseInIsland(false);
  } catch {} finally {
    safetyPollInFlight = false;
  }
}

pill.addEventListener('click', () => {
  clearTimeout(hoverExpandTimer);
  hoverExpandTimer = null;
  if (liveRequests().length) openRequests(null);
  else expand('click');
});
stripHit.addEventListener('click', () => {
  clearTimeout(hoverExpandTimer);
  hoverExpandTimer = null;
  if (liveRequests().length) openRequests(null);
  else expand('click');
});

// Header drag moves the native window horizontally; the final offset is persisted on mouseup.
let drag = null;
hdrMain.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || e.target.closest('button')) return;
  drag = { startX: e.screenX, dx: 0, moved: false, raf: 0, applied: null };
  e.preventDefault();
});
window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  drag.dx = e.screenX - drag.startX;
  if (!drag.moved && Math.abs(drag.dx) < 6) return;
  drag.moved = true;
  if (drag.raf) return;
  drag.raf = requestAnimationFrame(() => {
    if (!drag) return;
    drag.raf = 0;
    const d = drag;
    window.codePeek.dragWindow(d.dx).then(applied => { if (typeof applied === 'number') d.applied = applied; }).catch(() => {});
  });
});
window.addEventListener('mouseup', () => {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (!d.moved) return;
  window.codePeek.dragWindow(d.dx).then(applied => {
    const offset = typeof applied === 'number' ? applied : (d.applied !== null ? d.applied : (Number(currentConfig.panelOffsetX) || 0) + Math.round(d.dx));
    window.codePeek.setConfig({ panelOffsetX: offset });
  }).catch(() => {});
});

groupTabs.addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (!b) return;
  lastLayout = null;
  window.codePeek.setConfig({ sessionGrouping: b.dataset.group });
});
btnCollapse.addEventListener('click', (e) => { e.stopPropagation(); userCollapse('button'); });
btnPin.addEventListener('click', (e) => {
  e.stopPropagation();
  ui.pinned = !ui.pinned;
  if (ui.pinned && !ui.expanded) expand('click');
  showToast(ui.pinned ? t('toastPinned') : t('toastUnpinned'), 'success');
  renderHeader();
});
btnMute.addEventListener('click', (e) => {
  e.stopPropagation();
  window.codePeek.setConfig({ soundEnabled: !currentConfig.soundEnabled });
});
btnSettings.addEventListener('click', (e) => {
  e.stopPropagation();
  if (ui.settingsOpen) closeSettings(); else openSettings();
});
btnBack.addEventListener('click', () => closeSettings());
pendingBanner.addEventListener('click', () => {
  closeSettings();
  openRequests(null);
});

function onKeyDown(e) {
  lastKeyAt = Date.now();
  if (e.key !== 'Escape' || e.isComposing || composing) return;
  if (ui.settingsOpen) closeSettings();
  else if (ui.expanded) userCollapse('esc');
}

island.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  document.querySelectorAll('.context-menu').forEach(m => m.remove());
  const menu = el('div', 'context-menu');
  const settings = el('div', 'context-item', t('menuSettings'));
  const quit = el('div', 'context-item danger', t('menuQuit'));
  menu.append(settings, el('div', 'context-divider'), quit);
  menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - 100) + 'px';
  document.body.appendChild(menu);
  settings.onclick = () => { menu.remove(); openSettings(); };
  quit.onclick = () => { menu.remove(); window.codePeek.quitApp(); };
  setTimeout(() => {
    const close = () => { menu.remove(); document.removeEventListener('click', close); };
    document.addEventListener('click', close);
  }, 0);
});

// ========== Settings ==========
function openSettings() {
  ui.settingsOpen = true;
  if (!ui.expanded) expand('settings');
  window.codePeek.focusWindow();
  syncIgnoreMouse();
  populateSettings();
  setSurface('settings');
  render();
}

function closeSettings(fromCollapse) {
  if (!ui.settingsOpen) return;
  ui.settingsOpen = false;
  destroyGallery();
  if (document.activeElement && island.contains(document.activeElement)) document.activeElement.blur();
  syncIgnoreMouse();
  if (fromCollapse) return;
  if (ui.expandedBy === 'settings') ui.expandedBy = mouseInIsland ? 'hover' : 'event';
  reconcile();
}

document.querySelectorAll('#setNav button').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#setNav button').forEach(x => x.classList.toggle('on', x === b));
    document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.dataset.pane === b.dataset.pane));
    if (b.dataset.pane === 'appearance') renderMascotGallery(); else destroyGallery();
  });
});

function populateSettings() {
  $('selLang').value = currentConfig.language || 'auto';
  $('chkStartOnLogin').checked = !!currentConfig.startOnLogin;
  const selDisplay = $('selDisplay');
  selDisplay.textContent = '';
  for (const d of currentDisplays) {
    const opt = el('option', '', `${d.label || 'Display ' + d.id}${d.primary ? ' (' + t('displayPrimary') + ')' : ''}`);
    opt.value = String(d.id);
    selDisplay.appendChild(opt);
  }
  selDisplay.value = String(currentConfig.displayId || (currentDisplays.find(d => d.primary) || {}).id || '');

  $('chkAutoHide').checked = !!currentConfig.autoHidePanel;
  $('chkHoverExpand').checked = !!currentConfig.hoverExpand;
  setRange('rangeHoverExpandDelay', 'valHoverExpandDelay', currentConfig.hoverExpandDelay, 'ms');
  setRange('rangeHoverCollapseDelay', 'valHoverCollapseDelay', currentConfig.hoverCollapseDelay, 'ms');
  setRange('rangeCompletionTime', 'valCompletionTime', currentConfig.completionDisplayTime || 5, 's');
  $('chkSuppressNotif').checked = !!currentConfig.suppressNotifications;
  $('numCleanup').value = currentConfig.cleanupStaleAfter;

  setRange('rangePanelWidth', 'valPanelWidth', currentConfig.panelWidth, 'px');
  setRange('rangePanelHeight', 'valPanelHeight', currentConfig.panelHeight, 'px');
  setRange('rangeFontSize', 'valFontSize', currentConfig.fontSize, 'px');
  $('numRespLines').value = currentConfig.responseLines;
  $('chkMascots').checked = currentConfig.mascotEnabled !== false;
  setRange('rangePeekHeight', 'valPeekHeight', currentConfig.peekHeight, 'px');
  $('chkFollowAccent').checked = currentConfig.followAccent !== false;
  $('chkReduceMotion').checked = currentConfig.reduceMotion === true;
  setRange('rangeAnimDuration', 'valAnimDuration', durOpen(), 'ms');
  const easing = EASINGS[currentConfig.animationEasing] ? currentConfig.animationEasing : 'snappy';
  document.querySelectorAll('#segAnimEasing span').forEach(s => s.classList.toggle('on', s.dataset.v === easing));
  const mode = currentConfig.collapsedMode || 'smart';
  document.querySelectorAll('#segCollapsedMode span').forEach(s => s.classList.toggle('on', s.dataset.v === mode));

  $('chkSoundEnabled').checked = !!currentConfig.soundEnabled;
  window.codePeek.getSoundPacks().then(packs => {
    const sel = $('selSoundPack');
    const labels = { soft: 'Soft (Sine)', chime: 'Chime (Bells)', '8bit': '8-bit Retro', minimal: 'Minimal', silent: 'Silent' };
    sel.textContent = '';
    for (const p of packs) {
      const o = el('option', '', labels[p] || p);
      o.value = p;
      sel.appendChild(o);
    }
    sel.value = currentConfig.soundPack || 'soft';
  });
  setRange('rangeVolume', 'valVolume', Math.round((currentConfig.soundVolume || 0) * 100), '%');
  for (const n of ['SessionStart', 'ToolUse', 'Permission', 'Question', 'Complete']) {
    $('chkSnd' + n).checked = !!currentConfig['soundOn' + n];
  }

  updateHookStatus();
  renderAgentList();
  if (document.querySelector('#setNav button.on').dataset.pane === 'appearance') renderMascotGallery();
}

function setRange(id, valId, value, unit) {
  const r = $(id);
  if (value !== undefined && value !== null) r.value = value;
  $(valId).textContent = r.value + unit;
}

async function updateHookStatus() {
  const [claudeOk, codexOk] = await Promise.all([
    window.codePeek.isHooksInstalled(),
    window.codePeek.isCodexHooksInstalled()
  ]);
  hooksInstalled = claudeOk;
  $('hookStatusText').textContent = claudeOk ? t('installed') : t('notInstalled');
  $('btnToggleHooks').textContent = claudeOk ? t('btnUninstall') : t('btnInstall');
  $('codexHookStatusText').textContent = codexOk ? t('installed') : t('notInstalled');
  $('btnToggleCodexHooks').textContent = codexOk ? t('btnUninstall') : t('btnInstall');
}

function renderAgentList() {
  const list = $('agentList');
  list.textContent = '';
  for (const a of currentAgents) {
    const row = el('div', 'agent-row');
    const badge = el('span', 'agent-badge');
    badge.style.background = sanitizeColor(a.color);
    if (a.iconSvg) badge.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" style="color:#fff">${a.iconSvg}</svg>`;
    else badge.textContent = a.icon || '?';
    const name = el('span', 'agent-name', a.name);
    if (!a.supported) name.appendChild(el('span', 'coming-soon', 'Coming soon'));
    const sw = el('label', 'switch');
    const inp = el('input');
    inp.type = 'checkbox';
    inp.checked = !!(a.supported && currentConfig.agents && currentConfig.agents[a.id]);
    inp.disabled = !a.supported;
    inp.addEventListener('change', () => {
      const agents = { ...(currentConfig.agents || {}) };
      agents[a.id] = inp.checked;
      window.codePeek.setConfig({ agents });
    });
    sw.append(inp, el('span', 'slider'));
    row.append(badge, name, sw);
    list.appendChild(row);
  }
}

function renderMascotGallery() {
  destroyGallery();
  const gallery = $('mascotGallery');
  for (const a of currentAgents) {
    const item = el('div', 'mascot-item');
    if (!a.supported) item.style.opacity = '0.4';
    const vis = el('div', 'mascot-visual');
    for (const st of ['idle', 'thinking', 'waiting_permission']) vis.appendChild(createMascotCanvas(a.id, st, 36));
    item.append(vis, el('div', 'mascot-name', a.name));
    gallery.appendChild(item);
  }
}

function destroyGallery() {
  const gallery = $('mascotGallery');
  gallery.querySelectorAll('canvas').forEach(c => destroyMascotCanvas(c));
  gallery.textContent = '';
}

const bindConfig = (id, ev, map) => $(id).addEventListener(ev, (e) => window.codePeek.setConfig(map(e.target)));
const bindRangeLabel = (id, valId, unit) => $(id).addEventListener('input', (e) => { $(valId).textContent = e.target.value + unit; });

bindConfig('selLang', 'change', x => ({ language: x.value }));
$('chkStartOnLogin').addEventListener('change', (e) => window.codePeek.toggleAutoStart(e.target.checked));
bindConfig('selDisplay', 'change', x => ({ displayId: parseInt(x.value) || null }));
bindConfig('chkAutoHide', 'change', x => ({ autoHidePanel: x.checked }));
bindConfig('chkHoverExpand', 'change', x => ({ hoverExpand: x.checked }));
bindRangeLabel('rangeHoverExpandDelay', 'valHoverExpandDelay', 'ms');
bindConfig('rangeHoverExpandDelay', 'change', x => ({ hoverExpandDelay: parseInt(x.value) || 0 }));
bindRangeLabel('rangeHoverCollapseDelay', 'valHoverCollapseDelay', 'ms');
bindConfig('rangeHoverCollapseDelay', 'change', x => ({ hoverCollapseDelay: parseInt(x.value) || 0 }));
bindRangeLabel('rangeCompletionTime', 'valCompletionTime', 's');
bindConfig('rangeCompletionTime', 'change', x => ({ completionDisplayTime: parseInt(x.value) || 5 }));
bindConfig('chkSuppressNotif', 'change', x => ({ suppressNotifications: x.checked }));
bindConfig('numCleanup', 'change', x => ({ cleanupStaleAfter: parseInt(x.value) || 0 }));
bindRangeLabel('rangePanelWidth', 'valPanelWidth', 'px');
bindConfig('rangePanelWidth', 'change', x => ({ panelWidth: parseInt(x.value) }));
bindRangeLabel('rangePanelHeight', 'valPanelHeight', 'px');
bindConfig('rangePanelHeight', 'change', x => ({ panelHeight: parseInt(x.value) }));
bindRangeLabel('rangeFontSize', 'valFontSize', 'px');
bindConfig('rangeFontSize', 'change', x => ({ fontSize: parseInt(x.value) }));
bindConfig('numRespLines', 'change', x => ({ responseLines: parseInt(x.value) || 2 }));
bindConfig('chkMascots', 'change', x => ({ mascotEnabled: x.checked }));
$('rangePeekHeight').addEventListener('input', (e) => {
  $('valPeekHeight').textContent = e.target.value + 'px';
  document.documentElement.style.setProperty('--peek-height', e.target.value + 'px');
});
bindConfig('rangePeekHeight', 'change', x => ({ peekHeight: parseInt(x.value) || 5 }));
bindConfig('chkFollowAccent', 'change', x => ({ followAccent: x.checked }));
bindConfig('chkReduceMotion', 'change', x => ({ reduceMotion: x.checked }));
bindRangeLabel('rangeAnimDuration', 'valAnimDuration', 'ms');
bindConfig('rangeAnimDuration', 'change', x => ({ animationDuration: parseInt(x.value) || 300 }));
$('segAnimEasing').addEventListener('click', (e) => {
  const s = e.target.closest('span[data-v]');
  if (!s) return;
  document.querySelectorAll('#segAnimEasing span').forEach(x => x.classList.toggle('on', x === s));
  window.codePeek.setConfig({ animationEasing: s.dataset.v });
});
$('segCollapsedMode').addEventListener('click', (e) => {
  const s = e.target.closest('span[data-v]');
  if (!s) return;
  document.querySelectorAll('#segCollapsedMode span').forEach(x => x.classList.toggle('on', x === s));
  window.codePeek.setConfig({ collapsedMode: s.dataset.v });
});
bindConfig('chkSoundEnabled', 'change', x => ({ soundEnabled: x.checked }));
$('selSoundPack').addEventListener('change', async (e) => {
  await window.codePeek.setConfig({ soundPack: e.target.value });
  currentSounds = await window.codePeek.getSounds();
  playSound('complete');
});
bindRangeLabel('rangeVolume', 'valVolume', '%');
bindConfig('rangeVolume', 'change', x => ({ soundVolume: parseInt(x.value) / 100 }));
for (const n of ['SessionStart', 'ToolUse', 'Permission', 'Question', 'Complete']) {
  bindConfig('chkSnd' + n, 'change', x => ({ ['soundOn' + n]: x.checked }));
}
document.querySelectorAll('.btn-play').forEach(b => b.addEventListener('click', () => playSound(b.dataset.sound)));

async function toggleHook(isInstalled, install, uninstall) {
  const installed = await isInstalled();
  const result = installed ? await uninstall() : await install();
  if (result && result.success) {
    updateHookStatus();
    showToast(installed ? t('hooksUninstalled') : t('hooksInstalled'), 'success');
  } else {
    showToast((result && result.error) || t('operationFailed'), 'error');
  }
}
$('btnToggleHooks').addEventListener('click', () => toggleHook(window.codePeek.isHooksInstalled, window.codePeek.installHooks, window.codePeek.uninstallHooks));
$('btnToggleCodexHooks').addEventListener('click', () => toggleHook(window.codePeek.isCodexHooksInstalled, window.codePeek.installCodexHooks, window.codePeek.uninstallCodexHooks));
$('btnInstallAll').addEventListener('click', async () => {
  const results = await window.codePeek.installAllHooks();
  const failed = Object.entries(results || {}).filter(([, r]) => !r.success);
  updateHookStatus();
  showToast(failed.length === 0 ? t('hooksInstalled') : failed.map(([k, r]) => `${k}: ${r.error || 'failed'}`).join(' / '),
    failed.length === 0 ? 'success' : 'error');
});

// ========== Helpers ==========
function sanitizeColor(color) {
  if (!color || typeof color !== 'string') return '#8E8E93';
  if (/^#[0-9a-fA-F]{3,8}$/.test(color)) return color;
  if (/^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(,\s*[\d.]+\s*)?\)$/.test(color)) return color;
  return '#8E8E93';
}

function formatTimeAgo(ts) {
  if (!ts) return '';
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return '<1m';
  if (min < 60) return min + 'm';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + 'h';
  return Math.floor(hr / 24) + 'd';
}

function formatModel(model) {
  return (model || '').replace(/^claude-/, '').replace(/^anthropic\//, '');
}

function shortId(id) { return (id || '').substring(0, 8); }

let toastTimer = null;
function showToast(message, type = 'success') {
  const r = interactiveRect();
  toastEl.style.setProperty('--toast-top', Math.round(r.bottom + 8) + 'px');
  toastEl.textContent = message;
  toastEl.className = `toast ${type}`;
  requestAnimationFrame(() => toastEl.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2000);
}

init();
