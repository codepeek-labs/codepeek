'use strict';

// ========== DOM references ==========
const island = document.getElementById('island');
const header = document.getElementById('header');
const content = document.getElementById('content');
const mascot = document.getElementById('mascot');
const statusDot = document.getElementById('statusDot');
const titleText = document.getElementById('titleText');
const headerStats = document.getElementById('headerStats');
const btnSettings = document.getElementById('btnSettings');
const btnCollapse = document.getElementById('btnCollapse');
const sessionsList = document.getElementById('sessionsList');
const sessionsSection = document.getElementById('sessionsSection');
const sessionsTitle = document.getElementById('sessionsTitle');
const permissionsList = document.getElementById('permissionsList');
const permissionsSection = document.getElementById('permissionsSection');
const permissionsTitle = document.getElementById('permissionsTitle');
const questionsList = document.getElementById('questionsList');
const questionsSection = document.getElementById('questionsSection');
const questionsTitle = document.getElementById('questionsTitle');
const completionSection = document.getElementById('completionSection');
const completionBody = document.getElementById('completionBody');
const completionTitle = document.getElementById('completionTitle');
const settingsModal = document.getElementById('settingsModal');
const btnSettingsClose = document.getElementById('btnSettingsClose');
const audio = document.getElementById('audio');

// Sizes
const COLLAPSED_WIDTH = 360;
const COLLAPSED_HEIGHT = 48;

// State
let isExpanded = false;
let currentState = { sessions: [], pendingPermissions: [], pendingQuestions: [] };
let currentConfig = {};
let currentDict = {};
let currentAgents = [];
let currentSounds = {};
let currentDisplays = [];
let selectedSessionId = null;
let _lastToolBySession = new Map(); // sessionId -> { tool, input, fadeTimer, timestamp }
let _startupAnimActive = false;
let _dragState = null; // { startX, startOffsetX }

// Hover timing - delays are read from config with sensible defaults.
function getHoverExpandDelay() {
  const v = currentConfig.hoverExpandDelay;
  return (typeof v === 'number' && v >= 0) ? v : 80;
}
function getHoverCollapseDelay() {
  const v = currentConfig.hoverCollapseDelay;
  return (typeof v === 'number' && v >= 0) ? v : 1500;
}
let hoverExpandTimer = null;
let hoverCollapseTimer = null;
let manuallyPinned = false;

// ========== Initialization ==========

async function init() {
  [currentConfig, currentDict, currentAgents, currentSounds, currentDisplays, currentState] = await Promise.all([
    window.codePeek.getConfig(),
    window.codePeek.getDict(),
    window.codePeek.getAgents(),
    window.codePeek.getSounds(),
    window.codePeek.getDisplays(),
    window.codePeek.getState()
  ]);

  applyConfigToUI();
  applyI18n();
  reconcileSurface();
  render();

  window.codePeek.onStateChanged(state => {
    currentState = state;
    // A state-changed event may introduce/remove approval or question items; recompute surface.
    reconcileSurface();
    render();
  });

  window.codePeek.onConfigChanged(async cfg => {
    currentConfig = cfg;
    currentDict = await window.codePeek.getDict();
    applyConfigToUI();
    applyI18n();
    render();
  });

  window.codePeek.onPlaySound(type => playSound(type));
  window.codePeek.onSoundsChanged(sounds => { currentSounds = sounds; });
  window.codePeek.onCollapse(() => collapse());
  window.codePeek.onNotification(data => showToast(data.message, data.type));
  window.codePeek.onCompletionNotify(data => handleCompletion(data));

  // Track recent keyboard activity for completion-notification suppression.
  window.addEventListener('keydown', () => { _lastKeyAt = Date.now(); }, true);
  // Once the mouse enters the island, the user's intent is clear: do not auto-collapse.
  island.addEventListener('mouseenter', () => {
    _mouseOverIsland = true;
    _autoExpandedByEvent = false;
  });
  island.addEventListener('mouseleave', () => { _mouseOverIsland = false; });

  // Startup confirmation animation: briefly expand then collapse to signal "I'm running".
  setTimeout(() => {
    if (!isExpanded && !mouseInIsland && currentState.sessions.length === 0) {
      _startupAnimActive = true;
      island.classList.add('expanded-state');
      setTimeout(() => {
        if (_startupAnimActive && !isExpanded && !mouseInIsland) {
          island.classList.remove('expanded-state');
        }
        _startupAnimActive = false;
      }, 1200);
    }
  }, 500);
}

// ========== Surface state machine ==========
// At any moment the island renders exactly one surface.
// Priority: approval > question > completion > list > peek.
let _surface = 'peek';
// Whether the current expansion was triggered by an event (vs. user hover/pin);
// used to decide whether to auto-collapse once the event surface dismisses.
let _autoExpandedByEvent = false;
// Completion single-card state
let _completionCurrent = null;     // currently displayed completion payload
let _completionBadgeCount = 0;      // count of completions suppressed/merged into the badge
let _completionTimer = null;
let _completionHover = false;
let _lastCompletionShownAt = 0;
// Completion suppression signals
let _lastKeyAt = 0;
let _mouseOverIsland = false;
const COMPLETION_AUTO_HIDE_MS = 5000;
const COMPLETION_THROTTLE_MS = 5000;  // at most one card every 5s; extras go to the badge
const INPUT_ACTIVE_MS = 2000;         // keyboard activity window considered "user busy"

function setSurface(next) {
  if (_surface === next) return;
  _surface = next;
  if (next === 'peek') {
    if (!manuallyPinned && !isModalOpen()) collapse();
  } else {
    if (!isExpanded) {
      _autoExpandedByEvent = true; // flag that the expansion was event-driven, not user-driven
      expand();
    }
  }
  render();
}

// Recompute the target surface from the current state and completion-display flags.
const EVENT_SURFACES = new Set(['approval', 'question', 'completion']);
function reconcileSurface() {
  const hasApproval = currentState.pendingPermissions.length > 0;
  const hasQuestion = currentState.pendingQuestions.length > 0;
  if (hasApproval) { setSurface('approval'); return; }
  if (hasQuestion) { setSurface('question'); return; }
  if (_completionCurrent) { setSurface('completion'); return; }
  // No event cards remaining.
  if (!isExpanded) { setSurface('peek'); return; }
  // If the previous surface was an event card, the island was auto-expanded for it.
  // Collapse back unless the user has pinned or is hovering.
  if (EVENT_SURFACES.has(_surface) && !manuallyPinned) {
    setSurface('peek');
    return;
  }
  if (_autoExpandedByEvent && !manuallyPinned && !_mouseOverIsland) {
    _autoExpandedByEvent = false;
    setSurface('peek');
    return;
  }
  setSurface('list');
}

// Completion entry point: merges duplicates, throttles frequency, suppresses during input.
function handleCompletion(data) {
  if (!data) return;
  const hasBlocking = currentState.pendingPermissions.length > 0 || currentState.pendingQuestions.length > 0;
  if (hasBlocking) {
    _completionBadgeCount++;
    updateCompletionBadge();
    return;
  }
  // Active typing and mouse not on the island: skip the card, bump the badge instead.
  if (!_mouseOverIsland && (Date.now() - _lastKeyAt) < INPUT_ACTIVE_MS) {
    _completionBadgeCount++;
    updateCompletionBadge();
    return;
  }
  // Global throttle: at most one card within the throttle window.
  if (Date.now() - _lastCompletionShownAt < COMPLETION_THROTTLE_MS) {
    _completionBadgeCount++;
    updateCompletionBadge();
    return;
  }
  showCompletionSurface(data);
}

function showCompletionSurface(data) {
  _completionCurrent = data;
  _completionHover = false; // reset stale hover flag from previous card
  _lastCompletionShownAt = Date.now();
  renderCompletionBody(data);
  reconcileSurface();
  startCompletionTimer();
}

function renderCompletionBody(data) {
  const project = (data.projectName || '').trim();
  const title = (data.sessionTitle || '').trim();
  const tag = currentDict.completionDone || 'Completed';

  const card = document.createElement('div');
  card.className = 'completion-card';
  const icon = document.createElement('div');
  icon.className = 'cc-icon';
  icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
  const body = document.createElement('div');
  body.className = 'cc-body';
  const t = document.createElement('div'); t.className = 'cc-title';
  const tagEl = document.createElement('span'); tagEl.className = 'cc-tag'; tagEl.textContent = '✓ ' + tag;
  const nameEl = document.createElement('span'); nameEl.textContent = project || title || (currentDict.completionUntitled || 'Untitled');
  t.appendChild(tagEl); t.appendChild(nameEl);
  const s = document.createElement('div'); s.className = 'cc-sub';
  s.textContent = title && project ? title : (data.cwd || '');
  body.appendChild(t); body.appendChild(s);
  card.appendChild(icon); card.appendChild(body);

  card.addEventListener('click', () => {
    if (_completionCurrent && _completionCurrent.sessionId) {
      const sess = (currentState.sessions || []).find(x => x.id === _completionCurrent.sessionId);
      const pid = sess && sess.pid;
      const name = (_completionCurrent.sessionTitle || _completionCurrent.projectName || '').toString();
      const cwd = (_completionCurrent.cwd || (sess && sess.cwd) || '').toString();
      if (pid) window.codePeek.jumpToTerminal(pid, name, cwd);
    }
    if (_completionTimer) { clearTimeout(_completionTimer); _completionTimer = null; }
    _completionCurrent = null;
    completionBody.innerHTML = '';
    collapse();
  });
  card.addEventListener('mouseenter', () => {
    _completionHover = true;
    if (_completionTimer) { clearTimeout(_completionTimer); _completionTimer = null; }
  });
  card.addEventListener('mouseleave', () => {
    _completionHover = false;
    startCompletionTimer();
  });

  completionBody.innerHTML = '';
  completionBody.appendChild(card);
}

function startCompletionTimer() {
  if (_completionTimer) clearTimeout(_completionTimer);
  const ms = ((currentConfig.completionDisplayTime || 5) * 1000);
  _completionTimer = setTimeout(() => {
    // If hovering when timer fires, wait for mouseleave instead of dismissing.
    if (_completionHover) { _completionTimer = null; return; }
    dismissCompletion();
  }, ms);
}

function dismissCompletion() {
  if (_completionTimer) { clearTimeout(_completionTimer); _completionTimer = null; }
  _completionCurrent = null;
  completionBody.innerHTML = '';
  // Always collapse after completion dismisses (unless user pinned).
  if (isExpanded && !manuallyPinned) {
    collapse();
  } else {
    reconcileSurface();
  }
}

function updateCompletionBadge() {
  // Badge is rendered next to headerStats; store count on dataset so render() can pick it up.
  if (headerStats) {
    headerStats.dataset.completionBadge = String(_completionBadgeCount || 0);
  }
  render();
}


function applyConfigToUI() {
  document.documentElement.style.setProperty('--font-size', currentConfig.fontSize + 'px');
  document.documentElement.style.setProperty('--response-lines', currentConfig.responseLines || 2);
  const peek = (typeof currentConfig.peekHeight === 'number') ? currentConfig.peekHeight : 6;
  document.documentElement.style.setProperty('--peek-height', peek + 'px');
  // Content scroll-area max height = panel height - header (~48) - vertical padding.
  const ph = (typeof currentConfig.panelHeight === 'number' && currentConfig.panelHeight > 0)
    ? currentConfig.panelHeight : 560;
  document.documentElement.style.setProperty('--content-max-height', Math.max(120, ph - 60) + 'px');
  if (currentConfig.mascotEnabled) mascot.classList.add('visible');
  else mascot.classList.remove('visible');
  const offsetX = currentConfig.panelOffsetX || 0;
  if (offsetX && isExpanded) {
    island.style.transform = `translateY(0) translateX(${offsetX}px)`;
  }
}

function applyI18n() {
  titleText.textContent = currentDict.appName || 'CodePeek';
  sessionsTitle.textContent = 'Sessions';
  permissionsTitle.textContent = currentDict.permissionRequired;
  questionsTitle.textContent = currentDict.questions;
  if (completionTitle) completionTitle.textContent = currentDict.completionDone || 'Completed';

  // Settings modal labels
  const mapping = {
    settingsTitle: 'menuSettings',
    tabGeneral: 'tabGeneral', tabBehavior: 'tabBehavior', tabAppearance: 'tabAppearance',
    tabMascots: 'tabMascots', tabSound: 'tabSound', tabHooks: 'tabHooks', tabAbout: 'tabAbout',
    lblLang: 'lang', lblStartOnLogin: 'startOnLogin', lblDisplay: 'display',
    lblAutoHide: 'autoHide', lblHoverExpand: 'hoverExpand',
    lblHoverExpandDelay: 'hoverExpandDelay', lblHoverCollapseDelay: 'hoverCollapseDelay',
    lblCompletionTime: 'completionDisplayTime',
    lblSuppressNotif: 'suppressNotif', lblCleanup: 'cleanupStale', lblSeconds: 'seconds',
    lblPanelWidth: 'panelWidth', lblPanelHeight: 'panelHeight',
    lblFontSize: 'fontSize', lblRespLines: 'responseLines', lblMascots: 'mascots',
    lblPeekHeight: 'peekHeight',
    lblSoundEnabled: 'soundEnabled', lblSoundPack: 'soundPack',
    lblVolume: 'soundVolume', lblEventSounds: 'soundEvents',
    lblSndSessionStart: 'soundSessionStart', lblSndToolUse: 'soundToolUse',
    lblSndPermission: 'soundPermission', lblSndQuestion: 'soundQuestion', lblSndComplete: 'soundComplete',
    lblHookStatus: 'hooksStatus', lblEnabledAgents: 'enabledAgents',
    aboutLicense: 'aboutLicense', aboutGitHub: 'aboutGitHub'
  };
  for (const [id, key] of Object.entries(mapping)) {
    const el = document.getElementById(id);
    if (el && currentDict[key]) el.textContent = currentDict[key];
  }
  // Refresh hook status text if the settings panel is open.
  if (settingsModal.style.display !== 'none') updateHookStatus();
}

// ========== Expand / collapse ==========

function expand() {
  clearTimeout(hoverCollapseTimer);
  hoverCollapseTimer = null;
  _startupAnimActive = false;
  if (_collapseTimer) { clearTimeout(_collapseTimer); _collapseTimer = null; content.style.opacity = ''; content.style.pointerEvents = ''; }
  if (isExpanded) return;
  isExpanded = true;
  island.classList.add('expanded-state'); // slide fully into view
  const offsetX = currentConfig.panelOffsetX || 0;
  if (offsetX) island.style.transform = `translateY(0) translateX(${offsetX}px)`;
  content.classList.add('expanded');      // reveal content body
  btnCollapse.style.display = 'flex';
  window.codePeek.refreshSessions();
  // Hover / manual expand defaults to 'list' surface, but keeps approval/question/completion if set.
  if (_surface === 'peek') { _surface = 'list'; render(); }
}

let _collapseTimer = null;
function collapse() {
  clearTimeout(hoverExpandTimer);
  clearTimeout(hoverCollapseTimer);
  if (_collapseTimer) clearTimeout(_collapseTimer);
  hoverExpandTimer = null;
  hoverCollapseTimer = null;
  if (!isExpanded) return;
  isExpanded = false;
  manuallyPinned = false;
  _autoExpandedByEvent = false;

  // Phase 1: fade out content quickly while keeping height stable for the slide.
  content.style.opacity = '0';
  content.style.pointerEvents = 'none';
  btnCollapse.style.display = 'none';

  // Phase 2: slide the island up (height is preserved so -100% is the full distance).
  island.classList.remove('expanded-state');
  island.style.transform = '';

  // Phase 3: after slide completes, clean up DOM state.
  _collapseTimer = setTimeout(() => {
    _collapseTimer = null;
    content.classList.remove('expanded');
    content.style.opacity = '';
    content.style.pointerEvents = '';
    _surface = 'peek';
    if (_completionCurrent) {
      if (_completionTimer) { clearTimeout(_completionTimer); _completionTimer = null; }
      _completionCurrent = null;
      completionBody.innerHTML = '';
    }
    _completionBadgeCount = 0;
    _lastSessionStructure = '';
    _lastSessionContent = '';
    render();
  }, 480);
}

function hasBlockingInteraction() {
  return currentState.pendingPermissions.length > 0 || currentState.pendingQuestions.length > 0;
}

function isUserInputting() {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT');
}

function isModalOpen() {
  return settingsModal.style.display !== 'none';
}

function onDragStart(e) {
  if (!isExpanded) return;
  if (e.target.closest('.content') || e.target.closest('.header-actions') || e.target.closest('.modal')) return;
  _dragState = { startX: e.screenX, startOffsetX: currentConfig.panelOffsetX || 0 };
  e.preventDefault();
}

function onDragMove(e) {
  if (!_dragState) return;
  const dx = e.screenX - _dragState.startX;
  const newOffset = _dragState.startOffsetX + dx;
  island.style.transform = `translateY(0) translateX(${newOffset}px)`;
}

function onDragEnd(e) {
  if (!_dragState) return;
  const dx = e.screenX - _dragState.startX;
  const newOffset = _dragState.startOffsetX + dx;
  _dragState = null;
  window.codePeek.setConfig({ panelOffsetX: newOffset });
}

function scheduleExpand() {
  if (!currentConfig.hoverExpand) return;
  if (isExpanded) {
    clearTimeout(hoverCollapseTimer);
    hoverCollapseTimer = null;
    return;
  }
  if (hoverExpandTimer) return;
  hoverExpandTimer = setTimeout(() => {
    hoverExpandTimer = null;
    expand();
  }, getHoverExpandDelay());
}

function scheduleCollapse() {
  clearTimeout(hoverExpandTimer);
  hoverExpandTimer = null;
  if (!isExpanded) return;
  // Intentionally no isUserInputting guard: a stuck focused input after closing Settings would block collapse forever.
  if (manuallyPinned || hasBlockingInteraction() || isModalOpen()) return;
  if (!currentConfig.autoHidePanel) return;
  clearTimeout(hoverCollapseTimer);
  hoverCollapseTimer = setTimeout(() => {
    hoverCollapseTimer = null;
    if (!manuallyPinned && !hasBlockingInteraction() && !isModalOpen()) {
      collapse();
    }
  }, getHoverCollapseDelay());
}

// ========== Render (rAF-batched to avoid flicker from frequent scanner ticks) ==========

let _renderScheduled = false;
function render() {
  if (_renderScheduled) return;
  _renderScheduled = true;
  requestAnimationFrame(() => {
    _renderScheduled = false;
    _doRender();
  });
}

function _doRender() {
  const { sessions, pendingPermissions, pendingQuestions } = currentState;
  const activeSessions = sessions.filter(s => s.isRunning !== false);
  const totalCount = sessions.length;
  const activeCount = activeSessions.length;
  const hasPending = pendingPermissions.length > 0 || pendingQuestions.length > 0;

  statusDot.className = 'status-dot';
  if (hasPending) statusDot.classList.add('warning');
  else if (activeCount > 0) statusDot.classList.add('active');

  // Peek bar color (static; only the color itself switches)
  const islandBody = document.getElementById('islandBody');
  if (islandBody) {
    islandBody.classList.remove('peek-idle', 'peek-active', 'peek-pending');
    if (hasPending) islandBody.classList.add('peek-pending');
    else if (activeCount > 0) islandBody.classList.add('peek-active');
    else islandBody.classList.add('peek-idle');
  }

  // Header stats + completion badge
  if (totalCount > 0) {
    headerStats.innerHTML = `<span class="active-count">${activeCount} ${currentDict.sessionsActive}</span> <span class="total-count">&middot; ${totalCount} ${currentDict.sessionsTotal}</span>`;
  } else {
    headerStats.textContent = '';
  }
  if (_completionBadgeCount > 0) {
    const badge = document.createElement('span');
    badge.className = 'completion-badge';
    badge.textContent = String(_completionBadgeCount);
    headerStats.appendChild(badge);
  }

  // Surface dispatch: the island renders exactly one surface at a time.
  const showList      = _surface === 'list';
  const showApproval  = _surface === 'approval';
  const showQuestion  = _surface === 'question';
  const showCompletion = _surface === 'completion';
  sessionsSection.style.display    = showList ? 'block' : 'none';
  permissionsSection.style.display = showApproval ? 'block' : 'none';
  questionsSection.style.display   = showQuestion ? 'block' : 'none';
  completionSection.style.display  = showCompletion ? 'block' : 'none';

  if (showList) renderSessions(sessions);
  if (showApproval) renderPermissions(pendingPermissions.slice(0, 1)); // show only the head of the queue
  if (showQuestion) renderQuestions(pendingQuestions.slice(0, 1));
}

let _lastSessionStructure = ''; // triggers full rebuild (IDs + agents)
let _lastSessionContent = '';   // triggers in-place update only
function renderSessions(sessions) {
  // Structure fingerprint: session IDs and agent types (adding/removing cards)
  const groupMode = currentConfig.sessionGrouping || 'all';
  const structFp = groupMode + ':' + sessions.map(s => `${s.id}:${s.agent || ''}:${s.isRunning}:${agentStatusToMascotState(s.status || 'idle')}`).join('|');
  // Content fingerprint: status, tool, error, prompt, response
  const contentFp = sessions.map(s => `${s.status}:${s.currentTool || ''}:${s.lastError || ''}:${s.lastPrompt || ''}:${s.lastResponse || ''}`).join('|');

  // If only content changed (not structure), patch existing cards in place.
  if (structFp === _lastSessionStructure && contentFp !== _lastSessionContent) {
    _lastSessionContent = contentFp;
    _patchSessionCards(sessions);
    return;
  }
  if (structFp === _lastSessionStructure && contentFp === _lastSessionContent) return;

  _lastSessionStructure = structFp;
  _lastSessionContent = contentFp;

  // Full rebuild: destroy old canvases
  sessionsList.querySelectorAll('.session-agent-badge').forEach(b => {
    if (b._mascotCanvas) destroyMascotCanvas(b._mascotCanvas);
  });
  sessionsList.innerHTML = '';

  if (sessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = currentDict.noSessions;
    sessionsList.appendChild(empty);
    return;
  }

  const mode = currentConfig.sessionGrouping || 'all';
  // Update active button
  document.querySelectorAll('.group-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.group === mode);
  });

  if (mode === 'all') {
    for (const s of sessions) sessionsList.appendChild(buildSessionCard(s));
    return;
  }

  const groups = new Map();
  for (const s of sessions) {
    let key;
    if (mode === 'status') {
      if (s.isRunning === false) key = 'Stale';
      else if (s.status === 'waiting_permission' || s.status === 'waiting_answer') key = 'Waiting';
      else if (s.status === 'tool_use' || s.status === 'thinking' || s.status === 'active') key = 'Running';
      else key = 'Idle';
    } else {
      key = (s.agent || 'claude').charAt(0).toUpperCase() + (s.agent || 'claude').slice(1);
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  for (const [label, items] of groups) {
    const hdr = document.createElement('div');
    hdr.className = 'group-header';
    hdr.textContent = `${label} (${items.length})`;
    sessionsList.appendChild(hdr);
    for (const s of items) sessionsList.appendChild(buildSessionCard(s));
  }
}

function _patchSessionCards(sessions) {
  const cards = sessionsList.querySelectorAll('.session-card');
  const sessionMap = new Map(sessions.map(s => [s.id, s]));
  cards.forEach(card => {
    const sid = card.dataset.sessionId;
    const s = sessionMap.get(sid);
    if (!s) return;
    // Patch status dot + label
    const dot = card.querySelector('.session-status-dot');
    const lbl = card.querySelector('.session-status-label');
    const statusClass = s.isRunning === false ? 'stale' : (s.status || 'active');
    if (dot) { dot.className = 'session-status-dot ' + statusClass; }
    if (lbl) { lbl.className = 'session-status-label ' + statusClass; lbl.textContent = s.isRunning === false ? currentDict.statusStale : getStatusLabel(s.status || 'active'); }
    // Patch tool bar
    let toolBar = card.querySelector('.session-tool-bar');
    const toolInfo = getLingeringTool(s);
    if (toolInfo) {
      if (!toolBar) { toolBar = document.createElement('div'); const meta = card.querySelector('.session-meta'); if (meta) meta.after(toolBar); else card.appendChild(toolBar); }
      toolBar.className = 'session-tool-bar tool-color-' + getToolColorClass(toolInfo.tool);
      if (toolInfo.lingering) toolBar.classList.add('tool-lingering');
      toolBar.textContent = toolInfo.input ? `${toolInfo.tool}: ${String(toolInfo.input).substring(0, 80)}` : String(toolInfo.tool);
    } else if (toolBar) {
      toolBar.remove();
    }
    // Patch error
    let errEl = card.querySelector('.session-error');
    if (s.lastError) {
      if (!errEl) { errEl = document.createElement('div'); errEl.className = 'session-error'; card.appendChild(errEl); }
      errEl.textContent = '⚠ ' + String(s.lastError).substring(0, 100);
    } else if (errEl) { errEl.remove(); }
  });
}

function buildSessionCard(s) {
  const name = s.name || s.projectName || shortId(s.id);
  const statusClass = s.isRunning === false ? 'stale' : (s.status || 'active');
  const statusLabel = s.isRunning === false ? currentDict.statusStale : getStatusLabel(s.status || 'active');
  const timeAgo = s.timeAgo || '';
  const model = formatModel(s.model);
  const agentId = s.agent || 'claude';
  const agent = currentAgents.find(a => a.id === agentId) || { color: '#D97757', icon: 'C' };

  const card = document.createElement('div');
  card.className = 'session-card';
  if (s.isRunning === false) card.classList.add('stale');
  else if (s.status) card.classList.add(s.status); // active / thinking / tool_use / ...
  if (s.id === selectedSessionId) card.classList.add('selected');
  // Using dataset means values are auto-escaped and cannot be interpreted as attribute injection.
  if (s.pid) card.dataset.pid = String(parseInt(s.pid) || '');
  card.dataset.sessionId = String(s.id || '');
  card.dataset.sessionName = String(name || '');
  card.dataset.cwd = String(s.cwd || '');
  card.dataset.isRunning = (s.isRunning === false) ? 'false' : 'true';
  card.dataset.agent = String(agentId);
  card.addEventListener('click', (e) => handleSessionClick(card, e));

  // Top row
  const top = document.createElement('div');
  top.className = 'session-top';

  const badge = document.createElement('span');
  badge.className = 'session-agent-badge';
  badge.style.background = 'transparent';
  const mascotCanvas = createMascotCanvas(agentId, s.status || 'idle', 32);
  badge.appendChild(mascotCanvas);
  badge._mascotCanvas = mascotCanvas;

  const nameEl = document.createElement('span');
  nameEl.className = 'session-name';
  nameEl.textContent = name;

  const timeEl = document.createElement('span');
  timeEl.className = 'session-time';
  timeEl.textContent = timeAgo;

  top.appendChild(badge);
  top.appendChild(nameEl);
  top.appendChild(timeEl);
  card.appendChild(top);

  // meta
  const meta = document.createElement('div');
  meta.className = 'session-meta';
  const dot = document.createElement('span');
  dot.className = 'session-status-dot ' + statusClass;
  const lbl = document.createElement('span');
  lbl.className = 'session-status-label ' + statusClass;
  lbl.textContent = statusLabel;
  meta.appendChild(dot);
  meta.appendChild(lbl);
  if (model) {
    const sep = document.createElement('span');
    sep.className = 'session-separator';
    meta.appendChild(sep);
    const modelEl = document.createElement('span');
    modelEl.className = 'session-model';
    modelEl.textContent = model;
    meta.appendChild(modelEl);
  }
  card.appendChild(meta);

  // Current tool (with linger effect)
  {
    const toolInfo = getLingeringTool(s);
    if (toolInfo) {
      const tool = document.createElement('div');
      tool.className = 'session-tool-bar tool-color-' + getToolColorClass(toolInfo.tool);
      if (toolInfo.lingering) tool.classList.add('tool-lingering');
      tool.textContent = (toolInfo.input
        ? `${toolInfo.tool}: ${String(toolInfo.input).substring(0, 80)}`
        : String(toolInfo.tool));
      card.appendChild(tool);
    }
  }

  // Error
  if (s.lastError) {
    const err = document.createElement('div');
    err.className = 'session-error';
    err.textContent = '⚠ ' + String(s.lastError).substring(0, 100);
    card.appendChild(err);
  }

  // Conversation preview
  if (s.lastPrompt || s.lastResponse) {
    const convo = document.createElement('div');
    convo.className = 'session-conversation';
    if (s.lastPrompt) {
      const lbl1 = document.createElement('div');
      lbl1.className = 'convo-label';
      lbl1.textContent = currentDict.lastPrompt;
      convo.appendChild(lbl1);
      const txt1 = document.createElement('div');
      txt1.className = 'convo-text';
      txt1.textContent = String(s.lastPrompt);
      convo.appendChild(txt1);
    }
    if (s.lastResponse) {
      const lbl2 = document.createElement('div');
      lbl2.className = 'convo-label response';
      lbl2.textContent = currentDict.lastResponse;
      convo.appendChild(lbl2);
      const txt2 = document.createElement('div');
      txt2.className = 'convo-text';
      txt2.textContent = String(s.lastResponse);
      convo.appendChild(txt2);
    }
    card.appendChild(convo);
  }

  // Jump / Reopen hint
  const hint = document.createElement('span');
  hint.className = 'jump-hint';
  if (s.isRunning === false) {
    hint.textContent = `${currentDict.reopen || 'Reopen'} →`;
    hint.classList.add('reopen');
  } else if (s.pid) {
    hint.textContent = `${currentDict.jump} →`;
  } else {
    // Active session without a PID (should not normally happen)
    hint.style.display = 'none';
  }
  card.appendChild(hint);

  return card;
}

// Allow only #RRGGBB / #RRGGBBAA / rgb() / rgba() forms to prevent CSS injection.
function sanitizeColor(color) {
  if (!color || typeof color !== 'string') return '#8E8E93';
  if (/^#[0-9a-fA-F]{3,8}$/.test(color)) return color;
  if (/^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(,\s*[\d.]+\s*)?\)$/.test(color)) return color;
  return '#8E8E93';
}

function renderPermissions(permissions) {
  permissionsList.innerHTML = '';
  if (permissions.length === 0) { permissionsSection.style.display = 'none'; return; }
  permissionsSection.style.display = 'block';
  for (const p of permissions) {
    permissionsList.appendChild(buildPermissionCard(p));
  }
}

function buildPermissionCard(p) {
  const card = document.createElement('div');
  card.className = 'permission-card';
  const tool = document.createElement('div');
  tool.className = 'permission-tool';
  tool.textContent = String(p.toolName || '');
  card.appendChild(tool);

  if (p.toolInput) {
    const inp = document.createElement('div');
    inp.className = 'permission-input perm-tool-' + getToolColorClass(p.toolName);
    const prefix = document.createElement('span');
    prefix.className = 'perm-prefix';
    if (p.toolName === 'Bash') {
      prefix.textContent = '$ ';
      prefix.style.color = 'var(--accent-green)';
    } else if (p.toolName === 'Read') {
      prefix.textContent = '📄 ';
    } else if (p.toolName === 'Edit' || p.toolName === 'Write') {
      prefix.textContent = '✏ ';
    } else if (p.toolName === 'Grep' || p.toolName === 'Glob') {
      prefix.textContent = '/ ';
      prefix.style.color = 'var(--accent-purple)';
    }
    inp.appendChild(prefix);
    const text = document.createElement('span');
    text.textContent = String(p.toolInput).substring(0, 200);
    inp.appendChild(text);
    card.appendChild(inp);
  }

  const actions = document.createElement('div');
  actions.className = 'permission-actions';
  const mkBtn = (cls, label, behavior) => {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', () => window.codePeek.approvePermission(p.id, behavior));
    return b;
  };
  actions.appendChild(mkBtn('btn-allow', currentDict.btnAllow, 'allow'));
  actions.appendChild(mkBtn('btn-deny', currentDict.btnDeny, 'deny'));
  actions.appendChild(mkBtn('btn-always', currentDict.btnAlways, 'always'));
  card.appendChild(actions);

  return card;
}

function renderQuestions(questions) {
  questionsList.innerHTML = '';
  if (questions.length === 0) { questionsSection.style.display = 'none'; return; }
  questionsSection.style.display = 'block';
  for (const q of questions) {
    questionsList.appendChild(buildQuestionCard(q));
  }
}

function buildQuestionCard(q) {
  const card = document.createElement('div');
  card.className = 'question-card';

  const txt = document.createElement('div');
  txt.className = 'question-text';
  txt.textContent = String(q.question || '');
  card.appendChild(txt);

  // If the question contains numbered options (lines starting with 1. 2. 3. etc),
  // render them as clickable option buttons.
  const optionLines = String(q.question || '').split('\n').filter(l => /^\s*\d+[\.\)]\s/.test(l));
  if (optionLines.length >= 2) {
    const optionsDiv = document.createElement('div');
    optionsDiv.className = 'question-options';
    for (const line of optionLines) {
      const optBtn = document.createElement('div');
      optBtn.className = 'question-option';
      optBtn.textContent = line.trim();
      optBtn.addEventListener('click', () => {
        const num = line.match(/^\s*(\d+)/);
        window.codePeek.answerQuestion(q.id, num ? num[1] : line.trim());
      });
      optBtn.addEventListener('mouseenter', () => optBtn.classList.add('hovered'));
      optBtn.addEventListener('mouseleave', () => optBtn.classList.remove('hovered'));
      optionsDiv.appendChild(optBtn);
    }
    card.appendChild(optionsDiv);
  }

  // Always show free-text input as fallback / "Other" option
  const row = document.createElement('div');
  row.className = 'question-input-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'question-input';
  input.placeholder = currentDict.questionPlaceholder;
  const send = () => {
    const v = input.value.trim();
    if (v) window.codePeek.answerQuestion(q.id, v);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

  const btn = document.createElement('button');
  btn.className = 'btn-send';
  btn.textContent = currentDict.btnSend;
  btn.addEventListener('click', send);

  row.appendChild(input);
  row.appendChild(btn);
  card.appendChild(row);
  return card;
}

// ========== Actions ==========

async function handleSessionClick(card, event) {
  const sid = card.dataset.sessionId;
  if (event.shiftKey || event.ctrlKey) {
    selectedSessionId = selectedSessionId === sid ? null : sid;
    render();
    return;
  }
  selectedSessionId = sid;
  render();

  const isRunning = card.dataset.isRunning !== 'false';
  const cwd = card.dataset.cwd || '';

  if (!isRunning) {
    // Stale session: launch a new terminal tab running `<cli> resume`.
    showToast(currentDict.reopening || 'Reopening...', 'success');
    const agent = card.dataset.agent || 'claude';
    const result = await window.codePeek.launchSession(sid, cwd, agent);
    if (result.success) {
      showToast(currentDict.reopenOk || 'Reopened', 'success');
    } else {
      showToast(`${currentDict.reopenFailed || 'Reopen failed'}: ${result.error || 'Unknown'}`, 'error');
    }
    return;
  }

  // Active session: focus the existing terminal tab.
  const pid = parseInt(card.dataset.pid || '0');
  const sessionName = card.dataset.sessionName || '';
  if (!pid) { showToast(currentDict.menuNoPid, 'error'); return; }
  showToast(currentDict.menuJumping, 'success');
  const result = await window.codePeek.jumpToTerminal(pid, sessionName, cwd);
  if (result.success) showToast(currentDict.menuSwitched, 'success');
  else showToast(`${currentDict.menuJumpFailed}: ${result.error || 'Unknown'}`, 'error');
}

// Permission / question button handlers are bound inside buildPermissionCard / buildQuestionCard.

// ========== Sound playback ==========

function playSound(type) {
  const url = currentSounds[type];
  if (!url) return;
  const vol = currentConfig.soundVolume || 0.5;
  audio.src = url;
  audio.volume = vol;
  audio.play().catch(() => {});
}

// ========== Context menu ==========

island.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const existing = document.querySelector('.context-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.innerHTML = `
    <div class="context-item" id="ctxSettings">${currentDict.menuSettings}</div>
    <div class="context-divider"></div>
    <div class="context-item danger" id="ctxQuit">${currentDict.menuQuit}</div>
  `;
  menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - 100) + 'px';
  document.body.appendChild(menu);

  menu.querySelector('#ctxSettings').onclick = () => { menu.remove(); openSettings(); };
  menu.querySelector('#ctxQuit').onclick = () => { menu.remove(); window.codePeek.quitApp(); };

  setTimeout(() => {
    const close = () => { menu.remove(); document.removeEventListener('click', close); };
    document.addEventListener('click', close);
  }, 0);
});

// ========== Mouse events ==========

// Mouse-passthrough state machine:
//  - modal open                       -> must NOT passthrough (so modal buttons are clickable)
//  - modal closed + mouse over island -> do not passthrough (normal interaction)
//  - modal closed + mouse outside     -> passthrough (clicks fall through to desktop / windows below)
function syncIgnoreMouse(mouseInIsland) {
  const shouldIgnore = !isModalOpen() && !mouseInIsland;
  window.codePeek.setIgnoreMouse(shouldIgnore);
}

// mouseenter/mouseleave can be lost when the window toggles ignoreMouseEvents,
// so continuously track "is mouse inside island" via mousemove as the primary signal.
let mouseInIsland = false;

function updateMouseInIsland(inside) {
  if (inside === mouseInIsland) return;
  mouseInIsland = inside;
  syncIgnoreMouse(inside);
  if (inside) scheduleExpand();
  else scheduleCollapse();
}

island.addEventListener('mouseenter', () => updateMouseInIsland(true));
island.addEventListener('mouseleave', () => updateMouseInIsland(false));
island.addEventListener('mousemove', () => {
  if (!mouseInIsland) updateMouseInIsland(true);
});

// Safety poll every 250ms: verify the mouse is still inside the island rect.
// Works around lost mouseleave events caused by Electron setIgnoreMouseEvents toggles.
setInterval(() => {
  if (!mouseInIsland) return; // already outside; nothing to verify
  const rect = island.getBoundingClientRect();
  // lastMouseEvent holds the most recent mousemove coordinates
  const x = lastMouseX, y = lastMouseY;
  if (x < 0 || y < 0) return;
  const inside = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  if (!inside && mouseInIsland) {
    updateMouseInIsland(false);
  }
}, 250);

let lastMouseX = -1, lastMouseY = -1;
window.addEventListener('mousemove', (e) => {
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
});

// ========== Click handlers ==========

header.addEventListener('mousedown', (e) => {
  if (e.button === 0 && isExpanded && !e.target.closest('.header-actions')) {
    onDragStart(e);
  }
});
window.addEventListener('mousemove', (e) => { if (_dragState) onDragMove(e); });
window.addEventListener('mouseup', (e) => { if (_dragState) onDragEnd(e); });

header.addEventListener('click', (e) => {
  if (e.target.closest('.header-actions')) return;
  if (isExpanded && manuallyPinned) {
    manuallyPinned = false;
    collapse();
  } else if (isExpanded && !manuallyPinned) {
    manuallyPinned = true;
    showToast(currentDict.menuPin, 'success');
  } else {
    manuallyPinned = true;
    expand();
  }
});

btnCollapse.addEventListener('click', (e) => {
  e.stopPropagation();
  manuallyPinned = false;
  collapse();
});

btnSettings.addEventListener('click', (e) => { e.stopPropagation(); openSettings(); });
btnSettingsClose.addEventListener('click', closeSettings);
settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) closeSettings(); });

// ========== Settings panel ==========

function openSettings() {
  if (!isExpanded) { manuallyPinned = true; expand(); }
  settingsModal.style.display = 'flex';
  // Modal opened: force passthrough OFF, otherwise button clicks fall through to the window below.
  window.codePeek.setIgnoreMouse(false);
  populateSettings();
}

function closeSettings() {
  settingsModal.style.display = 'none';
  // Modal closed: reset to passthrough; next time the mouse hits the island, mouseenter flips it back off.
  syncIgnoreMouse(false);
}

function populateSettings() {
  // General
  document.getElementById('selLang').value = currentConfig.language || 'auto';
  document.getElementById('chkStartOnLogin').checked = currentConfig.startOnLogin;

  const selDisplay = document.getElementById('selDisplay');
  selDisplay.innerHTML = currentDisplays.map(d =>
    `<option value="${d.id}">${d.label}${d.primary ? ' (Primary)' : ''}</option>`
  ).join('');
  selDisplay.value = currentConfig.displayId || (currentDisplays.find(d => d.primary)?.id || '');

  // Behavior
  document.getElementById('chkAutoHide').checked = currentConfig.autoHidePanel;
  document.getElementById('chkHoverExpand').checked = currentConfig.hoverExpand;
  const hed = document.getElementById('rangeHoverExpandDelay');
  hed.value = currentConfig.hoverExpandDelay;
  document.getElementById('valHoverExpandDelay').textContent = hed.value + 'ms';
  const hcd = document.getElementById('rangeHoverCollapseDelay');
  hcd.value = currentConfig.hoverCollapseDelay;
  document.getElementById('valHoverCollapseDelay').textContent = hcd.value + 'ms';
  const rct = document.getElementById('rangeCompletionTime');
  rct.value = currentConfig.completionDisplayTime || 5;
  document.getElementById('valCompletionTime').textContent = rct.value + 's';
  document.getElementById('chkSuppressNotif').checked = currentConfig.suppressNotifications;
  document.getElementById('numCleanup').value = currentConfig.cleanupStaleAfter;

  // Appearance
  const sw = document.getElementById('rangePanelWidth');
  sw.value = currentConfig.panelWidth;
  document.getElementById('valPanelWidth').textContent = sw.value + 'px';

  const sh = document.getElementById('rangePanelHeight');
  sh.value = currentConfig.panelHeight;
  document.getElementById('valPanelHeight').textContent = sh.value + 'px';

  const sf = document.getElementById('rangeFontSize');
  sf.value = currentConfig.fontSize;
  document.getElementById('valFontSize').textContent = sf.value + 'px';

  document.getElementById('numRespLines').value = currentConfig.responseLines;
  document.getElementById('chkMascots').checked = currentConfig.mascotEnabled;

  const rp = document.getElementById('rangePeekHeight');
  rp.value = currentConfig.peekHeight;
  document.getElementById('valPeekHeight').textContent = rp.value + 'px';

  // Sound
  document.getElementById('chkSoundEnabled').checked = currentConfig.soundEnabled;
  // Populate the sound-pack dropdown
  window.codePeek.getSoundPacks().then(packs => {
    const sel = document.getElementById('selSoundPack');
    const labels = { soft: 'Soft (Sine)', chime: 'Chime (Bells)', '8bit': '8-bit Retro', minimal: 'Minimal', silent: 'Silent' };
    sel.innerHTML = packs.map(p => `<option value="${p}">${labels[p] || p}</option>`).join('');
    sel.value = currentConfig.soundPack || 'soft';
  });
  const rv = document.getElementById('rangeVolume');
  rv.value = Math.round(currentConfig.soundVolume * 100);
  document.getElementById('valVolume').textContent = rv.value + '%';
  document.getElementById('chkSndSessionStart').checked = currentConfig.soundOnSessionStart;
  document.getElementById('chkSndToolUse').checked = currentConfig.soundOnToolUse;
  document.getElementById('chkSndPermission').checked = currentConfig.soundOnPermission;
  document.getElementById('chkSndQuestion').checked = currentConfig.soundOnQuestion;
  document.getElementById('chkSndComplete').checked = currentConfig.soundOnComplete;

  // Hooks
  updateHookStatus();
  renderAgentList();

  // Mascots
  renderMascotGallery();
}

async function updateHookStatus() {
  const [claudeOk, codexOk] = await Promise.all([
    window.codePeek.isHooksInstalled(),
    window.codePeek.isCodexHooksInstalled()
  ]);
  // Claude
  document.getElementById('hookStatusText').textContent = claudeOk ? currentDict.installed : currentDict.notInstalled;
  const cb = document.getElementById('btnToggleHooks');
  cb.textContent = claudeOk ? currentDict.btnUninstall : currentDict.btnInstall;
  cb.classList.toggle('installed', claudeOk);
  // Codex
  document.getElementById('codexHookStatusText').textContent = codexOk ? currentDict.installed : currentDict.notInstalled;
  const xb = document.getElementById('btnToggleCodexHooks');
  xb.textContent = codexOk ? currentDict.btnUninstall : currentDict.btnInstall;
  xb.classList.toggle('installed', codexOk);
}

function renderAgentList() {
  const list = document.getElementById('agentList');
  list.innerHTML = '';
  for (const a of currentAgents) {
    const row = document.createElement('div');
    row.className = 'agent-row';

    const badge = document.createElement('span');
    badge.className = 'agent-badge';
    badge.style.background = sanitizeColor(a.color);
    if (a.iconSvg) {
      badge.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" style="color:#fff">${a.iconSvg}</svg>`;
    } else {
      badge.textContent = a.icon || '?';
    }
    row.appendChild(badge);

    const nameEl = document.createElement('span');
    nameEl.className = 'agent-name';
    nameEl.textContent = a.name;
    if (!a.supported) {
      const tag = document.createElement('span');
      tag.className = 'coming-soon';
      tag.textContent = 'Coming soon';
      nameEl.appendChild(tag);
    }
    row.appendChild(nameEl);

    const sw = document.createElement('label');
    sw.className = 'switch';
    const inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.checked = !!(currentConfig.agents && currentConfig.agents[a.id]);
    if (!a.supported) {
      inp.disabled = true;
      inp.checked = false;
    }
    inp.addEventListener('change', () => {
      if (!a.supported) return;
      const agents = { ...(currentConfig.agents || {}) };
      agents[a.id] = inp.checked;
      window.codePeek.setConfig({ agents });
    });
    const slider = document.createElement('span');
    slider.className = 'slider';
    sw.appendChild(inp);
    sw.appendChild(slider);
    row.appendChild(sw);

    list.appendChild(row);
  }
}

function renderMascotGallery() {
  const gallery = document.getElementById('mascotGallery');
  gallery.innerHTML = '';
  for (const a of currentAgents) {
    const item = document.createElement('div');
    item.className = 'mascot-item';
    if (!a.supported) item.style.opacity = '0.4';
    const vis = document.createElement('div');
    vis.className = 'mascot-visual';
    const color = sanitizeColor(a.color);
    vis.style.background = `linear-gradient(135deg, ${color}, #FF9F0A)`;
    if (a.iconSvg) {
      vis.innerHTML = `<svg viewBox="0 0 24 24" width="40" height="40" style="color:#fff">${a.iconSvg}</svg>`;
    }
    const nm = document.createElement('div');
    nm.className = 'mascot-name';
    nm.textContent = a.name;
    item.appendChild(vis);
    item.appendChild(nm);
    gallery.appendChild(item);
  }
}

// Settings form bindings
document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.querySelector(`[data-panel="${t.dataset.tab}"]`).classList.add('active');
  });
});

document.getElementById('selLang').addEventListener('change', (e) => {
  window.codePeek.setConfig({ language: e.target.value });
});
document.getElementById('chkStartOnLogin').addEventListener('change', async (e) => {
  await window.codePeek.toggleAutoStart(e.target.checked);
});
document.getElementById('selDisplay').addEventListener('change', (e) => {
  window.codePeek.setConfig({ displayId: parseInt(e.target.value) });
});
document.getElementById('chkAutoHide').addEventListener('change', (e) => {
  window.codePeek.setConfig({ autoHidePanel: e.target.checked });
});
document.getElementById('chkHoverExpand').addEventListener('change', (e) => {
  window.codePeek.setConfig({ hoverExpand: e.target.checked });
});
document.getElementById('rangeHoverExpandDelay').addEventListener('input', (e) => {
  document.getElementById('valHoverExpandDelay').textContent = e.target.value + 'ms';
});
document.getElementById('rangeHoverExpandDelay').addEventListener('change', (e) => {
  window.codePeek.setConfig({ hoverExpandDelay: parseInt(e.target.value) || 0 });
});
document.getElementById('rangeHoverCollapseDelay').addEventListener('input', (e) => {
  document.getElementById('valHoverCollapseDelay').textContent = e.target.value + 'ms';
});
document.getElementById('rangeHoverCollapseDelay').addEventListener('change', (e) => {
  window.codePeek.setConfig({ hoverCollapseDelay: parseInt(e.target.value) || 0 });
});
document.getElementById('rangeCompletionTime').addEventListener('input', (e) => {
  document.getElementById('valCompletionTime').textContent = e.target.value + 's';
});
document.getElementById('rangeCompletionTime').addEventListener('change', (e) => {
  window.codePeek.setConfig({ completionDisplayTime: parseInt(e.target.value) || 5 });
});
document.getElementById('chkSuppressNotif').addEventListener('change', (e) => {
  window.codePeek.setConfig({ suppressNotifications: e.target.checked });
});
document.getElementById('numCleanup').addEventListener('change', (e) => {
  window.codePeek.setConfig({ cleanupStaleAfter: parseInt(e.target.value) || 0 });
});
document.getElementById('rangePanelWidth').addEventListener('input', (e) => {
  document.getElementById('valPanelWidth').textContent = e.target.value + 'px';
});
document.getElementById('rangePanelWidth').addEventListener('change', (e) => {
  window.codePeek.setConfig({ panelWidth: parseInt(e.target.value) });
});
document.getElementById('rangePanelHeight').addEventListener('input', (e) => {
  document.getElementById('valPanelHeight').textContent = e.target.value + 'px';
});
document.getElementById('rangePanelHeight').addEventListener('change', (e) => {
  window.codePeek.setConfig({ panelHeight: parseInt(e.target.value) });
});
document.getElementById('rangeFontSize').addEventListener('input', (e) => {
  document.getElementById('valFontSize').textContent = e.target.value + 'px';
});
document.getElementById('rangeFontSize').addEventListener('change', (e) => {
  window.codePeek.setConfig({ fontSize: parseInt(e.target.value) });
});
document.getElementById('numRespLines').addEventListener('change', (e) => {
  window.codePeek.setConfig({ responseLines: parseInt(e.target.value) || 2 });
});
document.getElementById('chkMascots').addEventListener('change', (e) => {
  window.codePeek.setConfig({ mascotEnabled: e.target.checked });
});
document.getElementById('rangePeekHeight').addEventListener('input', (e) => {
  document.getElementById('valPeekHeight').textContent = e.target.value + 'px';
  document.documentElement.style.setProperty('--peek-height', e.target.value + 'px');
});
document.getElementById('rangePeekHeight').addEventListener('change', (e) => {
  window.codePeek.setConfig({ peekHeight: parseInt(e.target.value) || 0 });
});
document.getElementById('chkSoundEnabled').addEventListener('change', (e) => {
  window.codePeek.setConfig({ soundEnabled: e.target.checked });
});
document.getElementById('selSoundPack').addEventListener('change', async (e) => {
  await window.codePeek.setConfig({ soundPack: e.target.value });
  // Refresh the local sound cache and play the "complete" sample as preview.
  currentSounds = await window.codePeek.getSounds();
  playSound('complete');
});
document.getElementById('rangeVolume').addEventListener('input', (e) => {
  document.getElementById('valVolume').textContent = e.target.value + '%';
});
document.getElementById('rangeVolume').addEventListener('change', (e) => {
  window.codePeek.setConfig({ soundVolume: parseInt(e.target.value) / 100 });
});
['SessionStart', 'ToolUse', 'Permission', 'Question', 'Complete'].forEach(name => {
  const el = document.getElementById('chkSnd' + name);
  if (el) el.addEventListener('change', (e) => {
    window.codePeek.setConfig({ ['soundOn' + name]: e.target.checked });
  });
});
document.querySelectorAll('.btn-play').forEach(b => {
  b.addEventListener('click', () => playSound(b.dataset.sound));
});
document.getElementById('btnToggleHooks').addEventListener('click', async () => {
  const installed = await window.codePeek.isHooksInstalled();
  const result = installed
    ? await window.codePeek.uninstallHooks()
    : await window.codePeek.installHooks();
  if (result.success) {
    updateHookStatus();
    showToast(installed ? currentDict.hooksUninstalled : currentDict.hooksInstalled, 'success');
  } else {
    showToast(result.error || currentDict.operationFailed, 'error');
  }
});

document.getElementById('btnToggleCodexHooks').addEventListener('click', async () => {
  const installed = await window.codePeek.isCodexHooksInstalled();
  const result = installed
    ? await window.codePeek.uninstallCodexHooks()
    : await window.codePeek.installCodexHooks();
  if (result.success) {
    updateHookStatus();
    showToast(installed ? currentDict.hooksUninstalled : currentDict.hooksInstalled, 'success');
  } else {
    showToast(result.error || currentDict.operationFailed, 'error');
  }
});

document.getElementById('btnInstallAll').addEventListener('click', async () => {
  const results = await window.codePeek.installAllHooks();
  const failed = Object.entries(results).filter(([, r]) => !r.success);
  updateHookStatus();
  if (failed.length === 0) {
    showToast(currentDict.hooksInstalled || 'Hooks installed', 'success');
  } else {
    const msg = failed.map(([k, r]) => `${k}: ${r.error || 'failed'}`).join(' / ');
    showToast(msg, 'error');
  }
});

// ========== Helpers ==========

function getToolColorClass(toolName) {
  if (!toolName) return 'default';
  switch (toolName) {
    case 'Bash': return 'bash';
    case 'Edit': case 'Write': return 'edit';
    case 'Read': return 'read';
    case 'Grep': case 'Glob': return 'grep';
    case 'Agent': case 'Task': return 'agent';
    default: return 'default';
  }
}

const TOOL_LINGER_MS = 2000;

function getLingeringTool(session) {
  const sid = session.id;
  const current = session.currentTool;
  const stored = _lastToolBySession.get(sid);

  if (current) {
    _lastToolBySession.set(sid, { tool: current, input: session.toolInput, timestamp: Date.now(), lingering: false });
    return { tool: current, input: session.toolInput, lingering: false };
  }
  // No active tool: check linger
  if (stored && !stored.lingering) {
    stored.lingering = true;
    stored.timestamp = Date.now();
    setTimeout(() => {
      _lastToolBySession.delete(sid);
      render();
    }, TOOL_LINGER_MS);
    return { tool: stored.tool, input: stored.input, lingering: true };
  }
  if (stored && stored.lingering) {
    if (Date.now() - stored.timestamp < TOOL_LINGER_MS) {
      return { tool: stored.tool, input: stored.input, lingering: true };
    }
    _lastToolBySession.delete(sid);
  }
  return null;
}

function getStatusLabel(status) {
  return {
    active: currentDict.statusActive,
    thinking: currentDict.statusThinking,
    tool_use: currentDict.statusToolUse,
    waiting_permission: currentDict.statusWaiting,
    waiting_answer: currentDict.statusQuestion,
    idle: currentDict.statusIdle,
    subagent: currentDict.statusSubagent,
    compacting: currentDict.statusCompacting
  }[status] || status;
}

function formatModel(model) {
  if (!model) return '';
  return model.replace(/^claude-/, '').replace(/^anthropic\//, '');
}

function shortId(id) { return (id || '').substring(0, 8); }

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function showToast(message, type = 'success') {
  let toast = document.querySelector('.toast');
  if (!toast) { toast = document.createElement('div'); toast.className = 'toast'; document.body.appendChild(toast); }
  toast.textContent = message;
  toast.className = `toast ${type}`;
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => toast.classList.remove('show'), 2000);
}

init();

document.querySelectorAll('.group-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    window.codePeek.setConfig({ sessionGrouping: btn.dataset.group });
  });
});
