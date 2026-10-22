'use strict';

const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, globalShortcut, shell, systemPreferences, powerMonitor, safeStorage } = require('electron');
const path = require('path');
const SessionManager = require('./sessionManager');
const HookServer = require('./hookServer');
const hookInstaller = require('./hookInstaller');
const SessionScanner = require('./sessionScanner');
const { focusTerminalByPid, setProcMap } = require('./terminalFocus');
const { launchSession } = require('./terminalLauncher');
const config = require('./config');
const { getDict, resolveLang, setElectronLocale } = require('./i18n');
const { getAllAgents, getEnabledAgents } = require('./agents');
const { getAllSounds, listPacks } = require('./soundGenerator');
const updateChecker = require('./updateChecker');
const { debugLog } = require('./debugLog');
const AttentionPolicy = require('./attentionPolicy');
const ForegroundWatcher = require('./foregroundWatcher');
const RemoteBridge = require('./remote/remoteBridge');
const { DingTalkStream } = require('./remote/dingtalk');

let mainWindow = null;
let tray = null;
let sessionManager = null;
let hookServer = null;
let sessionScanner = null;
let policy = null;
let fgWatcher = null;
let remote = null;
let shortcutConflicts = [];
const OWN_PIDS = new Set([process.pid]);

// Window size = expanded dimensions + shadow padding. Visual changes are driven by
// CSS animations on the island element so we never call setBounds at runtime; that
// avoids the system's window animation jitter and prevents the shadow from being
// clipped against the window's boundaries.
const WINDOW_PADDING = 24; // reserved space for the box-shadow and the top shoulders

function getWindowSize() {
  const w = (Number(config.get('panelWidth')) || 420) + WINDOW_PADDING * 2;
  const h = (Number(config.get('panelHeight')) || 560) + WINDOW_PADDING * 2;
  return { width: w, height: h };
}

// Single-instance lock: if we don't get it, exit immediately — do NOT register any
// more listeners or start any background work. app.quit() is asynchronous, so we
// must also call process.exit() to interrupt the current tick synchronously.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
  process.exit(0);
}

app.on('second-instance', () => revealWindow('second-instance'));

// Absolute path of the renderer entry. Used as the single allow-listed URL for IPC.
const RENDERER_INDEX_PATH = path.resolve(path.join(__dirname, '..', 'renderer', 'index.html'));
const RENDERER_INDEX_URL = 'file:///' + RENDERER_INDEX_PATH.replace(/\\/g, '/');

app.whenReady().then(async () => {
  try { setElectronLocale(app.getLocale()); } catch {}

  // If hooks are already installed, refresh bridge.js so the protocol version stays in sync.
  try {
    if (hookInstaller.isInstalled()) hookInstaller.deployBridge();
  } catch {}
  // Installed hooks predating a newly handled event (e.g. StopFailure) get it added; only our entries change.
  try {
    if (hookInstaller.isInstalled()) {
      const h = hookInstaller.getHookHealth();
      if (h.missing.length || h.stale.length) {
        hookInstaller.installHooks();
        debugLog('hooks', `repaired missing=${h.missing.join(',') || '-'} stale=${h.stale.join(',') || '-'}`);
      }
    }
  } catch {}

  sessionManager = new SessionManager();
  hookServer = new HookServer(sessionManager);

  try {
    await hookServer.start();
  } catch (err) {
    // Port in use: another process may be listening, causing the bridge to leak events
    // or receive forged responses. We must exit and let the user resolve the conflict
    // rather than continuing to run with a broken event bus.
    console.error('Failed to start hook server:', err.message);
    const { dialog } = require('electron');
    try {
      dialog.showErrorBox(
        'CodePeek: Hook server failed to start',
        `Port 31311 is unavailable (${err.message}). Another process may be using it. CodePeek will exit.`
      );
    } catch {}
    app.exit(1);
    process.exit(1);
  }

  sessionScanner = new SessionScanner();
  sessionScanner.start((scanned) => {
    sessionManager.updateScannedSessions(scanned);
    setProcMap(sessionScanner.procMap);
    sessionManager.reapOrphans(sessionScanner.procMap, sessionScanner._procGen || 0);
  });

  policy = new AttentionPolicy({ config, getIdleSeconds: () => powerMonitor.getSystemIdleTime() });
  policy.start();
  try {
    // Lock then sleep then wake must stay "away (lock)" until the screen is actually unlocked.
    let screenLocked = false;
    powerMonitor.on('lock-screen', () => { screenLocked = true; policy.setAway(true, 'lock'); });
    powerMonitor.on('unlock-screen', () => { screenLocked = false; policy.setAway(false); });
    powerMonitor.on('suspend', () => policy.setAway(true, 'suspend'));
    powerMonitor.on('resume', () => { if (screenLocked) policy.setAway(true, 'lock'); else policy.setAway(false); });
  } catch {}
  policy.on('seen', (sessionId) => sessionManager.markSeen(sessionId));
  let lastSuppress = null;
  policy.on('change', (st) => {
    sendToRenderer('focus-state', st);
    // Quiet periods silence every sound, so their start and end are logged for "why no sound" questions.
    if (st.suppress !== lastSuppress) {
      lastSuppress = st.suppress;
      debugLog('focus', `quiet=${st.suppress} away=${st.away}${st.awayReason ? '(' + st.awayReason + ')' : ''} dnd=${st.dnd} fullscreen=${st.fullscreen}`);
    }
  });
  policy.on('quiet-ended', ({ since }) => sendQuietSummary(since));

  fgWatcher = new ForegroundWatcher();
  fgWatcher.on('change', (fg) => {
    policy.setForeground(fg, sessionManager.getState().sessions, sessionScanner.procMap, OWN_PIDS);
  });
  fgWatcher.start();
  sessionManager.setPresenceProbe((sid) => policy.presenceAt(sid, !!(fgWatcher && fgWatcher.current)));

  // The DingTalk secret is kept DPAPI-encrypted via safeStorage; without it remote answering cannot be configured.
  remote = new RemoteBridge({
    sessionManager, policy, config,
    secrets: {
      available: () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } },
      encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
      decrypt: (b) => safeStorage.decryptString(Buffer.from(b, 'base64'))
    },
    createChannel: (opts) => new DingTalkStream({ ...opts, ua: `codepeek/${app.getVersion()}` }),
    isMuted: (cwd) => isMutedProject(cwd)
  });
  remote.on('status', (st) => sendToRenderer('remote-status', st));
  remote.start();

  sessionManager.on('state-changed', () => {
    const state = sessionManager.getState();
    // Session names can arrive after the window title did, so the foreground match is re-checked here.
    if (fgWatcher && fgWatcher.current) policy.setForeground(fgWatcher.current, state.sessions, sessionScanner.procMap, OWN_PIDS);
    sendToRenderer('state-changed', state);
    scheduleTrayUpdate(state);
  });

  // Ordinary completions are recorded in the inbox; only the policy decides whether one may interrupt.
  sessionManager.on('completion', (payload) => {
    const looking = policy.isLookingAt(payload.sessionId);
    if (looking) sessionManager.markSeen(payload.sessionId, payload.version);
    const rec = sessionManager.attention.get(payload.sessionId);
    const alertNext = !!(rec && rec.alertNext);
    // An explicit "alert me next time" outranks the project mute.
    if (!alertNext && isMutedProject(payload.cwd)) return;
    // Every finished turn chimes (soundOnComplete); whether a card also pops up is the alert mode's call.
    sessionManager.emit('sound', 'complete', { sessionId: payload.sessionId });
    if (!policy.shouldExpandCompletion({ turnMs: payload.turnMs, looking, alertNext })) return;
    // Consumed only once it is actually shown; a suppressed one stays armed for the next finish.
    if (alertNext) sessionManager.attention.consumeAlertNext(payload.sessionId);
    // A card that is allowed to pop up also chimes (soundOnComplete still applies); quiet mode never gets here.
    sendToRenderer('completion-notify', { ...payload, kind: 'completion', alertNext, sound: false });
  });

  sessionManager.on('attention', ({ sessionId, kind, reason }) => {
    const rec = sessionManager.attention.get(sessionId) || {};
    if (isMutedProject(rec.cwd)) return;
    sessionManager.emit('sound', 'permission', { sessionId });
    if (policy.isQuiet()) return;
    sendToRenderer('completion-notify', {
      kind, reason, sessionId,
      projectName: rec.name || '', gitBranch: rec.gitBranch || '', cwd: rec.cwd || '', agent: rec.agent || 'claude',
      lastResponse: rec.text || '', timestamp: Date.now(), sound: false
    });
  });

  // Forward sound events to the renderer
  sessionManager.on('sound', (type, meta) => {
    const keyMap = {
      sessionStart: 'soundOnSessionStart',
      toolUse: 'soundOnToolUse',
      permission: 'soundOnPermission',
      question: 'soundOnQuestion',
      complete: 'soundOnComplete'
    };
    const s = meta && meta.sessionId ? sessionManager.sessions.get(meta.sessionId) : null;
    const skip = !config.get('soundEnabled') ? 'sound-off' : (policy && policy.isSilent()) ? 'dnd-or-fullscreen'
      : !config.get(keyMap[type]) ? 'type-off' : (s && isMutedProject(s.cwd)) ? 'muted-project' : '';
    // toolUse fires on every tool call; only the sounds a user listens for are logged.
    if (type !== 'toolUse') debugLog('sound', `${type} ${skip ? 'skipped ' + skip : 'played'}`);
    if (skip) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('play-sound', type);
    }
  });

  // On config change: notify the renderer and rebuild Windows-side resources that depend on config.
  // setMultiple() emits (null, patch) and reset() emits (null, fullConfig); react only to keys that changed.
  config.on('changed', (key, value) => {
    const keys = new Set(key ? [key] : Object.keys(value || {}));
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('config-changed', publicConfig());
      if (keys.has('soundPack')) {
        mainWindow.webContents.send('sounds-changed', getAllSounds(config.get('soundPack') || 'soft'));
      }
    }
    if (keys.has('language')) rebuildTrayMenu();
    if (keys.has('shortcutToggle') || keys.has('shortcutNext')) registerShortcuts();
    if (keys.has('panelWidth') || keys.has('panelHeight') || keys.has('displayId') || keys.has('panelOffsetX')) {
      repositionWindow();
    }
  });

  try {
    systemPreferences.on('accent-color-changed', () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('accent-changed', getAccentColor());
    });
  } catch {}

  createWindow();
  createTray();
  registerIPC();
  registerShortcuts();
  registerDisplayWatchers();

  // Hook auto-repair: periodically verify and redeploy bridge if hooks are installed.
  setInterval(() => {
    try {
      if (hookInstaller.isInstalled()) hookInstaller.deployBridge();
    } catch {}
    try {
      if (hookInstaller.isCodexInstalled()) hookInstaller.deployBridge();
    } catch {}
  }, 300000);

  // Check for updates 5 seconds after launch (silent, non-blocking).
  setTimeout(() => {
    const pkg = require(path.join(__dirname, '..', '..', 'package.json'));
    updateChecker.check(pkg.version || '0.1.0');
  }, 5000);
});

function registerDisplayWatchers() {
  const handler = () => {
    const displayId = config.get('displayId');
    if (displayId) {
      const all = screen.getAllDisplays();
      const match = all.find(d => d.id === displayId);
      if (!match) {
        // Target display disappeared — fall back to the primary display.
        config.set('displayId', null);
        return; // config.set will trigger repositionWindow
      }
    }
    repositionWindow();
  };
  screen.on('display-added', handler);
  screen.on('display-removed', handler);
  screen.on('display-metrics-changed', handler);
}

function createWindow() {
  const targetDisplay = getTargetDisplay();
  const { width: screenWidth } = targetDisplay.workAreaSize;
  const bounds = targetDisplay.workArea;
  const { width: winW, height: winH } = getWindowSize();

  mainWindow = new BrowserWindow({
    width: winW,
    height: winH,
    x: bounds.x + Math.round((screenWidth - winW) / 2),
    y: bounds.y,
    // WS_EX_TOOLWINDOW stays out of the taskbar after Explorer restarts; skipTaskbar's DeleteTab does not.
    type: 'toolbar',
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    focusable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Forward renderer console.log to a debug log file (for completion lifecycle tracing).
  // Forward selected renderer console.log lines to a debug log file. Electron 28+ changed the
  // console-message signature to a single Event object — keep a fallback for older versions.
  mainWindow.webContents.on('console-message', (...args) => {
    const evt = args[0];
    const message = (evt && typeof evt === 'object' && typeof evt.message === 'string')
      ? evt.message
      : args[2];
    if (typeof message !== 'string') return;
    const m = /^\[(completion|perm|ui|sound)\] ([\s\S]*)$/.exec(message);
    if (m) debugLog('renderer:' + m[1], m[2]);
  });

  if (process.env.CODEPEEK_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Default to mouse-passthrough so clicks aren't captured by the transparent window.
  // forward:true still delivers mousemove events so we can detect hover. The renderer
  // flips passthrough off again once the cursor enters the island DOM.
  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  // Security: allow navigation only to our own index.html. Reject every other file://;
  // route http/https out to the system browser via shell.openExternal.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      if (url.startsWith('file:')) {
        const { fileURLToPath } = require('url');
        if (path.resolve(fileURLToPath(url)).toLowerCase() === RENDERER_INDEX_PATH.toLowerCase()) return;
      }
    } catch {}
    event.preventDefault();
    if (/^https?:/i.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url && /^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => revealWindow('startup'));
  mainWindow.on('show', () => {
    try { mainWindow.setSkipTaskbar(true); } catch {}
  });

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });

  repositionWindow();
}

function getTargetDisplay() {
  const displayId = config.get('displayId');
  if (displayId) {
    const all = screen.getAllDisplays();
    const match = all.find(d => d.id === displayId);
    if (match) return match;
  }
  return screen.getPrimaryDisplay();
}

function createTray() {
  tray = new Tray(trayIcon('idle'));
  tray.setToolTip('CodePeek');
  rebuildTrayMenu();
  tray.on('click', () => revealWindow('tray'));
}

const TRAY_DOTS = { idle: [0x8E, 0x8E, 0x93], running: [0x30, 0xD1, 0x58], reply: [0x6A, 0xB0, 0xFF], waiting: [0xF5, 0xB8, 0x4C] };
const trayIconCache = new Map();
function trayIcon(kind) {
  if (!trayIconCache.has(kind)) {
    trayIconCache.set(kind, nativeImage.createFromBuffer(createTrayIconBuffer(TRAY_DOTS[kind] || TRAY_DOTS.idle), { width: 32, height: 32 }));
  }
  return trayIconCache.get(kind);
}

// The dot shows the most urgent thing: waiting on you > new replies > running > idle.
let trayTimer = null;
let trayKind = '';
function scheduleTrayUpdate(state) {
  if (trayTimer) return;
  trayTimer = setTimeout(() => {
    trayTimer = null;
    if (!tray) return;
    const dict = getDict(config.get('language'));
    const att = state.attention || [];
    const waiting = state.pendingPermissions.length + state.pendingQuestions.length + att.filter(a => a.kind !== 'reply').length;
    const replies = att.filter(a => a.kind === 'reply').length;
    const running = state.sessions.filter(s => s.isRunning !== false && ['thinking', 'tool_use', 'subagent', 'compacting'].includes(s.status)).length;
    const kind = waiting ? 'waiting' : replies ? 'reply' : running ? 'running' : 'idle';
    if (kind !== trayKind) { trayKind = kind; tray.setImage(trayIcon(kind)); }
    const parts = [];
    if (waiting) parts.push(`${waiting} ${dict.inboxAnswer || 'waiting'}`);
    if (replies) parts.push(`${replies} ${dict.inboxReplies || 'new replies'}`);
    if (running) parts.push(`${running} ${dict.statsRunning || 'running'}`);
    tray.setToolTip(['CodePeek', ...parts].join(' · '));
  }, 400);
}

function rebuildTrayMenu() {
  if (!tray) return;
  const dict = getDict(config.get('language'));
  const menu = Menu.buildFromTemplate([
    { label: dict.menuShow || 'Show', click: () => revealWindow('tray-menu') },
    { label: dict.menuHide || 'Hide', click: () => { if (mainWindow) mainWindow.hide(); } },
    { type: 'separator' },
    { label: dict.btnInstall, click: () => { try { hookInstaller.installHooks(); } catch {} } },
    { label: dict.btnUninstall, click: () => { try { hookInstaller.uninstallHooks(); } catch {} } },
    { type: 'separator' },
    { label: dict.menuQuit, click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
}

// 32x32 capsule with a status dot; drawn at 32 because Electron's downsample to 16 is sharper on hi-DPI screens.
function createTrayIconBuffer(dotColor) {
  const W = 32, H = 32;
  // Capsule: 26w x 14h, vertically centered, radius = h/2.
  const capsuleW = 26, capsuleH = 14;
  const capX = (W - capsuleW) / 2, capY = (H - capsuleH) / 2;
  const radius = capsuleH / 2;
  // Capsule background: deep space gray; good contrast against the Win11 taskbar.
  const BG = [0x1C, 0x1C, 0x1E];
  const DOT = dotColor || [0x30, 0xD1, 0x58];

  const pixels = Buffer.alloc(W * H * 4);
  const setPixel = (x, y, r, g, b, a) => {
    const i = (y * W + x) * 4;
    pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = a;
  };

  // Rounded-capsule distance field (with a 1px anti-aliased edge).
  const capsuleAlpha = (x, y) => {
    const cx = Math.max(capX + radius, Math.min(x, capX + capsuleW - radius));
    const cy = capY + radius;
    const dx = x - cx, dy = y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= radius - 0.5) return 255;
    if (dist <= radius + 0.5) return Math.round(255 * (radius + 0.5 - dist));
    return 0;
  };

  // Center pulse dot: radius 2.5, centered.
  const dotCx = W / 2, dotCy = H / 2, dotR = 2.5;
  const dotAlpha = (x, y) => {
    const dx = x - dotCx, dy = y - dotCy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= dotR - 0.5) return 255;
    if (dist <= dotR + 0.5) return Math.round(255 * (dotR + 0.5 - dist));
    return 0;
  };

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const ca = capsuleAlpha(x, y);
      if (ca === 0) { setPixel(x, y, 0, 0, 0, 0); continue; }
      const da = dotAlpha(x, y);
      if (da > 0) {
        // Overlay the green dot on top of the capsule.
        const baseR = BG[0], baseG = BG[1], baseB = BG[2];
        const r = Math.round(baseR + (DOT[0] - baseR) * (da / 255));
        const g = Math.round(baseG + (DOT[1] - baseG) * (da / 255));
        const b = Math.round(baseB + (DOT[2] - baseB) * (da / 255));
        setPixel(x, y, r, g, b, ca);
      } else {
        setPixel(x, y, BG[0], BG[1], BG[2], ca);
      }
    }
  }
  return createPngBuffer(W, H, pixels);
}

function createPngBuffer(width, height, rgbaBuffer) {
  const zlib = require('zlib');
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width * 4)] = 0;
    rgbaBuffer.copy(rawData, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const compressed = zlib.deflateSync(rawData);
  const makeChunk = (type, data) => {
    const buf = Buffer.alloc(4 + type.length + data.length + 4);
    buf.writeUInt32BE(data.length, 0);
    buf.write(type, 4);
    data.copy(buf, 4 + type.length);
    const crc = crc32(Buffer.concat([Buffer.from(type), data]));
    buf.writeInt32BE(crc, buf.length - 4);
    return buf;
  };
  return Buffer.concat([signature, makeChunk('IHDR', ihdr), makeChunk('IDAT', compressed), makeChunk('IEND', Buffer.alloc(0))]);
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
  }
  return (crc ^ 0xFFFFFFFF) | 0;
}

// All IPC calls must come from our own index.html (single allow-listed URL) AND from the
// main window's main frame. A naive startsWith('file:') check would let any local HTML
// invoke our high-privilege IPC handlers, so we match the exact URL and the exact frame.
function assertTrustedSender(event) {
  try {
    if (!mainWindow || event.sender !== mainWindow.webContents) {
      throw new Error('Sender is not main window');
    }
    const frame = event.senderFrame;
    if (!frame) throw new Error('No senderFrame');
    if (frame !== mainWindow.webContents.mainFrame) {
      throw new Error('Sender is not main frame');
    }
    // Compare decoded file paths to handle CJK / special characters in directory names.
    // frame.url may be percent-encoded (e.g. %E5%B7%A5%E4%BD%9C) while our constant is not.
    const { fileURLToPath } = require('url');
    const frameUrl = String(frame.url || '');
    if (!frameUrl.startsWith('file:')) throw new Error('Not a file URL');
    const framePath = path.resolve(fileURLToPath(frameUrl));
    if (framePath.toLowerCase() === RENDERER_INDEX_PATH.toLowerCase()) return true;
  } catch {}
  throw new Error('Untrusted IPC sender');
}

function secureHandle(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedSender(event);
    return handler(event, ...args);
  });
}

function registerIPC() {
  secureHandle('get-state', () => sessionManager.getState());
  secureHandle('get-config', () => publicConfig());
  secureHandle('get-dict', () => getDict(config.get('language')));
  secureHandle('get-agents', () => getAllAgents());
  secureHandle('get-sounds', () => getAllSounds(config.get('soundPack') || 'soft'));
  secureHandle('get-sound-packs', () => listPacks());
  secureHandle('get-accent-color', () => getAccentColor());
  secureHandle('get-displays', () => screen.getAllDisplays().map(d => ({
    id: d.id,
    label: d.label || `Display ${d.id}`,
    bounds: d.bounds,
    primary: d.id === screen.getPrimaryDisplay().id
  })));

  secureHandle('set-config', (_, patch) => {
    if (!patch || typeof patch !== 'object') return publicConfig();
    // Remote credentials and the bound account change only through the remote-* handlers below.
    const clean = {};
    for (const [k, v] of Object.entries(patch)) if (!/^remote/.test(k)) clean[k] = v;
    config.setMultiple(clean);
    return publicConfig();
  });

  secureHandle('quit-app', () => { app.isQuitting = true; app.quit(); });

  secureHandle('jump-to-terminal', async (_, pid, sessionName, cwd) => {
    const n = parseInt(pid);
    if (!n || n <= 0) return { success: false, error: 'Invalid PID' };
    const name = typeof sessionName === 'string' ? sessionName.substring(0, 100) : '';
    const wd = typeof cwd === 'string' ? cwd.substring(0, 500) : '';
    const result = await focusTerminalByPid(n, name, wd);
    // If jump failed, force-refresh the process table so state reflects reality.
    // Only NO_WINDOW (a confirmed windowless ancestor chain) marks the PID as orphaned;
    // "No ancestors" can happen transiently when the procMap is cold/stale and should not
    // be treated as a permanent orphan state.
    if (!result.success && sessionScanner) {
      const err = String(result.error || '');
      if (/NO_WINDOW/i.test(err)) {
        sessionScanner.markOrphaned(n);
      }
      await sessionScanner.refreshNowForced();
      sessionManager.pruneDeadSessions(sessionScanner.procMap, sessionScanner.orphanedPids);
    }
    return result;
  });

  secureHandle('launch-session', (_, sessionId, cwd, agent) => {
    if (typeof sessionId !== 'string') return { success: false, error: 'Invalid sessionId' };
    return launchSession({
      sessionId,
      cwd: typeof cwd === 'string' ? cwd : '',
      agent: agent === 'codex' ? 'codex' : 'claude'
    });
  });

  secureHandle('refresh-sessions', () => { if (sessionScanner) sessionScanner.refreshNow(); });


  // Expose the real screen cursor position for the renderer's safety poll.
  // This does NOT depend on renderer mouse events — works even when setIgnoreMouseEvents is active.
  secureHandle('get-cursor-screen-point', () => {
    const cursor = screen.getCursorScreenPoint();
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null;
    return { screenX: cursor.x, screenY: cursor.y, winBounds: win };
  });

  secureHandle('approve-permission', (_, requestId, behavior, answers, message) => {
    if (typeof requestId !== 'string') return { ok: false, status: 'invalid' };
    if (!['allow', 'deny', 'always'].includes(behavior)) return { ok: false, status: 'invalid' };
    // answers (AskUserQuestion only): { [questionText]: label } or { [questionText]: [labels] }.
    let sanitizedAnswers = null;
    if (answers && typeof answers === 'object' && !Array.isArray(answers)) {
      sanitizedAnswers = {};
      for (const [k, v] of Object.entries(answers)) {
        if (typeof k !== 'string') continue;
        // Over-long answers are rejected rather than cut, so Claude never receives a different answer.
        if (typeof v === 'string') {
          if (v.length > 4000) return { ok: false, status: 'invalid' };
          sanitizedAnswers[k] = v;
        } else if (Array.isArray(v)) {
          const items = v.filter(x => typeof x === 'string');
          if (items.length > 64 || items.some(x => x.length > 4000)) return { ok: false, status: 'invalid' };
          sanitizedAnswers[k] = items;
        }
      }
    }
    if (typeof message === 'string' && message.length > 8000) return { ok: false, status: 'invalid' };
    const sanitizedMessage = typeof message === 'string' ? message : null;
    return sessionManager.approvePermission(requestId, behavior, sanitizedAnswers, sanitizedMessage);
  });

  secureHandle('answer-question', (_, requestId, answer) => {
    if (typeof requestId !== 'string' || typeof answer !== 'string') return { ok: false, status: 'invalid' };
    if (answer.length > 10000) answer = answer.substring(0, 10000);
    return sessionManager.answerQuestion(requestId, answer);
  });

  secureHandle('install-hooks', () => {
    try { hookInstaller.installHooks(); return { success: true }; }
    catch (err) { return { success: false, error: err.message }; }
  });

  secureHandle('uninstall-hooks', () => {
    try { hookInstaller.uninstallHooks(); return { success: true }; }
    catch (err) { return { success: false, error: err.message }; }
  });

  secureHandle('is-hooks-installed', () => hookInstaller.isInstalled());

  // Codex hooks
  secureHandle('install-codex-hooks', () => {
    try { hookInstaller.installCodexHooks(); return { success: true }; }
    catch (err) { return { success: false, error: err.message }; }
  });
  secureHandle('uninstall-codex-hooks', () => {
    try { hookInstaller.uninstallCodexHooks(); return { success: true }; }
    catch (err) { return { success: false, error: err.message }; }
  });
  secureHandle('is-codex-hooks-installed', () => hookInstaller.isCodexInstalled());

  // One-shot install for every supported agent.
  secureHandle('install-all-hooks', () => {
    const results = {};
    try { hookInstaller.installHooks(); results.claude = { success: true }; }
    catch (err) { results.claude = { success: false, error: err.message }; }
    try { hookInstaller.installCodexHooks(); results.codex = { success: true }; }
    catch (err) { results.codex = { success: false, error: err.message }; }
    return results;
  });

  // Live horizontal drag: dx is relative to the persisted offset; the renderer saves the final value itself.
  secureHandle('drag-window', (_, dx) => {
    const n = Number(dx);
    if (!Number.isFinite(n)) return null;
    return repositionWindow((Number(config.get('panelOffsetX')) || 0) + Math.round(n));
  });

  secureHandle('mark-seen', (_, sessionId, version) => {
    if (typeof sessionId !== 'string') return;
    sessionManager.markSeen(sessionId, Number.isFinite(version) ? version : undefined);
  });

  secureHandle('set-alert-next', (_, sessionId, on) => {
    if (typeof sessionId !== 'string') return;
    sessionManager.setAlertNext(sessionId, !!on);
  });

  secureHandle('set-dnd', (_, minutes) => {
    const m = Number(minutes);
    if (![-1, 0, 30, 60, 120].includes(m)) return policy.focusState();
    policy.setDnd(m);
    return policy.focusState();
  });

  secureHandle('get-focus-state', () => policy.focusState());

  secureHandle('get-health', () => ({
    hooks: hookInstaller.getHookHealth(),
    codexInstalled: hookInstaller.isCodexInstalled(),
    serverListening: !!(hookServer && hookServer.server && hookServer.server.listening),
    port: hookServer ? hookServer.port : null,
    lastEventAt: sessionManager.lastEventAt || 0,
    foregroundWatcher: !!(fgWatcher && fgWatcher.current),
    shortcutConflicts
  }));

  secureHandle('remote-get', () => remote.status());

  secureHandle('remote-save', (_, patch) => {
    if (!patch || typeof patch !== 'object') return { ok: false, error: 'invalid' };
    const idOk = (v) => typeof v === 'string' && /^[\w.-]{0,128}$/.test(v);
    const next = {};
    if ('enabled' in patch) next.remoteEnabled = !!patch.enabled;
    if ('clientId' in patch) { if (!idOk(patch.clientId)) return { ok: false, error: 'clientId' }; next.remoteClientId = patch.clientId; }
    if ('robotCode' in patch) { if (!idOk(patch.robotCode)) return { ok: false, error: 'robotCode' }; next.remoteRobotCode = patch.robotCode; }
    if ('pushWhen' in patch) { if (!['away', 'always'].includes(patch.pushWhen)) return { ok: false, error: 'pushWhen' }; next.remotePushWhen = patch.pushWhen; }
    if ('awaySeconds' in patch) next.remoteAwaySeconds = Math.min(3600, Math.max(30, parseInt(patch.awaySeconds) || 120));
    if ('delaySeconds' in patch) next.remoteDelaySeconds = Math.min(3600, Math.max(0, parseInt(patch.delaySeconds) || 0));
    if (typeof patch.clientSecret === 'string' && patch.clientSecret) {
      if (patch.clientSecret.length > 256) return { ok: false, error: 'clientSecret' };
      let enc;
      try { enc = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(patch.clientSecret).toString('base64') : ''; } catch { enc = ''; }
      if (!enc) return { ok: false, error: 'secure-storage' };
      next.remoteSecretEnc = enc;
    }
    // A different robot or app means a different chat, so the old binding no longer applies.
    if ((next.remoteClientId !== undefined && next.remoteClientId !== config.get('remoteClientId'))
        || (next.remoteRobotCode !== undefined && next.remoteRobotCode !== config.get('remoteRobotCode'))) {
      next.remoteStaffId = '';
      next.remoteNick = '';
      next.remoteCorpId = '';
    }
    const reconnect = ['remoteEnabled', 'remoteClientId', 'remoteRobotCode', 'remoteSecretEnc'].some(k => k in next);
    config.setMultiple(next);
    debugLog('remote', `settings saved keys=${Object.keys(next).filter(k => k !== 'remoteSecretEnc').join(',')}${next.remoteSecretEnc ? ',secret' : ''}`);
    if (reconnect) remote.reload(); else remote.evaluate();
    return { ok: true, status: remote.status() };
  });

  secureHandle('remote-pair', () => remote.startPairing());
  secureHandle('remote-unbind', () => { remote.unbind(); return remote.status(); });
  secureHandle('remote-test', async () => {
    try { await remote.sendTest(); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  secureHandle('repair-hooks', () => {
    try { hookInstaller.installHooks(); return { success: true, hooks: hookInstaller.getHookHealth() }; }
    catch (err) { return { success: false, error: err.message }; }
  });

  secureHandle('focus-window', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
  });

  // Renderer toggles window-level mouse passthrough based on whether the cursor is over the island.
  secureHandle('set-ignore-mouse', (_, ignore) => {
    if (!mainWindow) return;
    if (ignore) mainWindow.setIgnoreMouseEvents(true, { forward: true });
    else mainWindow.setIgnoreMouseEvents(false);
  });

  secureHandle('toggle-autostart', (_, enabled) => {
    try {
      hookInstaller.setAutoStart(!!enabled, process.execPath);
      config.set('startOnLogin', !!enabled);
      return { success: true };
    } catch (err) { return { success: false, error: err.message }; }
  });

  secureHandle('is-autostart', () => hookInstaller.isAutoStartEnabled());

  secureHandle('check-update', () => {
    const pkg = require(path.join(__dirname, '..', '..', 'package.json'));
    updateChecker.check(pkg.version || '0.1.0');
    return updateChecker.getState();
  });

  secureHandle('get-update-state', () => updateChecker.getState());

  secureHandle('export-diagnostics', async () => {
    const os = require('os');
    const fs = require('fs');
    const diag = {
      timestamp: new Date().toISOString(),
      version: require(path.join(__dirname, '..', '..', 'package.json')).version || '0.1.0',
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      nodeVersion: process.version,
      electronVersion: process.versions.electron,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
      sessions: sessionManager ? sessionManager.getState() : {},
      config: config.get(),
      hookStatus: {
        claude: hookInstaller.isInstalled(),
        codex: hookInstaller.isCodexInstalled()
      },
      hookServerPort: hookServer ? hookServer.port : null
    };
    // Remove sensitive data
    if (diag.config) { delete diag.config.token; delete diag.config.remoteSecretEnc; delete diag.config.remoteStaffId; }
    return diag;
  });
}

// Returns the offset actually applied after clamping to the work area.
function repositionWindow(offsetOverride) {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const area = getTargetDisplay().workArea;
  const { width: winW, height: winH } = getWindowSize();
  const offset = offsetOverride !== undefined ? offsetOverride : (Number(config.get('panelOffsetX')) || 0);
  const centerX = area.x + Math.round((area.width - winW) / 2);
  const x = Math.min(Math.max(centerX + offset, area.x - WINDOW_PADDING), area.x + area.width - winW + WINDOW_PADDING);
  const next = { x, y: area.y, width: winW, height: winH };
  const cur = mainWindow.getBounds();
  if (cur.x !== next.x || cur.y !== next.y || cur.width !== next.width || cur.height !== next.height) {
    // A pure move avoids the resize that makes transparent windows flash.
    if (cur.width === next.width && cur.height === next.height) mainWindow.setPosition(next.x, next.y);
    else mainWindow.setBounds(next);
  }
  return x - centerX;
}

// Single entry for every "show" path: re-applies the taskbar policy and never steals focus.
function revealWindow(source) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isVisible()) mainWindow.showInactive();
  try { mainWindow.setSkipTaskbar(true); } catch {}
  debugLog('window', `reveal source=${source}`);
}

// Windows reports RRGGBBAA; the renderer only needs the opaque RGB part.
function getAccentColor() {
  try {
    const hex = systemPreferences.getAccentColor();
    if (typeof hex === 'string' && /^[0-9a-fA-F]{6}/.test(hex)) return '#' + hex.substring(0, 6);
  } catch {}
  return null;
}

// register() returns false when another app owns the accelerator; those are reported in the health panel.
function registerShortcuts() {
  try { globalShortcut.unregisterAll(); } catch {}
  const failed = [];
  const reg = (accel, action) => {
    if (!accel) return;
    try {
      const ok = globalShortcut.register(accel, () => {
        revealWindow('shortcut');
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
        sendToRenderer('shortcut', action);
      });
      if (!ok) failed.push(accel);
    } catch { failed.push(accel); }
  };
  reg(config.get('shortcutToggle'), 'toggle');
  reg(config.get('shortcutNext'), 'next');
  shortcutConflicts = failed;
  if (failed.length) debugLog('shortcut', `register failed: ${failed.join(', ')}`);
}

// The renderer never needs the encrypted DingTalk secret; remote settings come from remote-get.
function publicConfig() {
  const c = config.get();
  delete c.remoteSecretEnc;
  return c;
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// After away / do-not-disturb ends, one card sums up what piled up instead of replaying every alert.
// Muted projects still land in the inbox; they just never pop up or play a sound on their own.
function isMutedProject(cwd) {
  const k = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const list = config.get('mutedProjects');
  return !!k && Array.isArray(list) && list.includes(k);
}

function sendQuietSummary(since) {
  const st = sessionManager.getState();
  const att = (st.attention || []).filter(a => !isMutedProject(a.cwd));
  const summary = {
    kind: 'summary',
    since,
    questions: st.pendingPermissions.length + st.pendingQuestions.length,
    replies: att.filter(a => a.kind === 'reply' && a.since >= since).length,
    inputs: att.filter(a => a.kind === 'input').length,
    blocked: att.filter(a => a.kind === 'blocked').length,
    timestamp: Date.now()
  };
  if (summary.questions + summary.replies + summary.inputs + summary.blocked === 0) return;
  // New replies alone are not worth a sound; things waiting on the user are.
  summary.sound = false;
  if (summary.questions + summary.inputs + summary.blocked > 0) sessionManager.emit('sound', 'question', {});
  sendToRenderer('completion-notify', summary);
}

app.on('before-quit', () => {
  app.isQuitting = true;
  try { globalShortcut.unregisterAll(); } catch {}
  if (fgWatcher) fgWatcher.stop();
  if (remote) remote.stop();
  if (policy) policy.stop();
  if (sessionScanner) sessionScanner.stop();
  if (sessionManager) sessionManager.destroy();
  if (hookServer) hookServer.stop();
});

app.on('window-all-closed', () => {});
