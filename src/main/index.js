'use strict';

const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, globalShortcut, shell } = require('electron');
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

let mainWindow = null;
let tray = null;
let sessionManager = null;
let hookServer = null;
let sessionScanner = null;
let isExpanded = false;

// Window size = expanded dimensions + shadow padding. Visual changes are driven by
// CSS animations on the island element so we never call setBounds at runtime; that
// avoids the system's window animation jitter and prevents the shadow from being
// clipped against the window's boundaries.
const WINDOW_PADDING = 16; // reserved space for the box-shadow

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

app.on('second-instance', () => {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
});

// Absolute path of the renderer entry. Used as the single allow-listed URL for IPC.
const RENDERER_INDEX_PATH = path.resolve(path.join(__dirname, '..', 'renderer', 'index.html'));
const RENDERER_INDEX_URL = 'file:///' + RENDERER_INDEX_PATH.replace(/\\/g, '/');

app.whenReady().then(async () => {
  try { setElectronLocale(app.getLocale()); } catch {}

  // If hooks are already installed, refresh bridge.js so the protocol version stays in sync.
  try {
    if (hookInstaller.isInstalled()) hookInstaller.deployBridge();
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
  });

  sessionManager.on('state-changed', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('state-changed', sessionManager.getState());
    }
  });

  // Forward completion events to the renderer.
  // When suppressNotifications=true we skip the UI card entirely.
  sessionManager.on('completion', (payload) => {
    if (config.get('suppressNotifications') === true) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('completion-notify', payload);
    }
  });

  // Forward sound events to the renderer
  sessionManager.on('sound', (type, meta) => {
    if (!config.get('soundEnabled')) return;
    const keyMap = {
      sessionStart: 'soundOnSessionStart',
      toolUse: 'soundOnToolUse',
      permission: 'soundOnPermission',
      question: 'soundOnQuestion',
      complete: 'soundOnComplete'
    };
    if (!config.get(keyMap[type])) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('play-sound', type);
    }
  });

  // On config change: notify the renderer and rebuild Windows-side resources that depend on config.
  config.on('changed', (key, value) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('config-changed', config.get());
      // Sound pack changed: push the new data URLs to the renderer.
      if (!key || key === 'soundPack' || (value && value.soundPack !== undefined)) {
        mainWindow.webContents.send('sounds-changed', getAllSounds(config.get('soundPack') || 'soft'));
      }
    }
    // Language changed: rebuild the tray menu.
    if (!key || key === 'language' || (value && value.language !== undefined)) {
      rebuildTrayMenu();
    }
    // Shortcut changed: re-register.
    if (!key || key === 'shortcutToggle' || (value && value.shortcutToggle !== undefined)) {
      registerShortcuts();
    }
    // Panel size changed: adjust the window.
    if (!key || key === 'panelWidth' || key === 'panelHeight'
        || (value && (value.panelWidth !== undefined || value.panelHeight !== undefined))) {
      repositionWindow();
    }
  });

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
  mainWindow.webContents.on('console-message', (_, level, message) => {
    if (message.startsWith('[completion]') || message.startsWith('[jump-debug]') || message.startsWith('[perm]') || message.startsWith('[notif]')) {
      require('fs').appendFile(
        require('path').join(require('os').homedir(), '.codepeek', 'debug.log'),
        `${new Date().toISOString()} ${message}\n`, () => {}
      );
    }
  });

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
    if (url && !url.startsWith('file:')) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });
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
  // Prefer the packaged build/icon.png; fall back to a runtime-generated icon in dev.
  const fs = require('fs');
  const iconPath = path.join(__dirname, '..', '..', 'build', 'icon.png');
  let icon;
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath);
  } else {
    icon = nativeImage.createFromBuffer(createTrayIconBuffer(), { width: 32, height: 32 });
  }
  tray = new Tray(icon);
  tray.setToolTip('CodePeek');
  rebuildTrayMenu();
  tray.on('click', () => {
    if (mainWindow.isVisible()) mainWindow.focus();
    else mainWindow.show();
  });
}

function rebuildTrayMenu() {
  if (!tray) return;
  const dict = getDict(config.get('language'));
  const menu = Menu.buildFromTemplate([
    { label: (dict.menuSettings === '设置' ? '显示' : 'Show'), click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: 'separator' },
    { label: dict.btnInstall, click: () => { try { hookInstaller.installHooks(); } catch {} } },
    { label: dict.btnUninstall, click: () => { try { hookInstaller.uninstallHooks(); } catch {} } },
    { type: 'separator' },
    { label: dict.menuQuit, click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
}

// CodePeek tray icon: 32x32 rounded capsule (Dynamic Island silhouette) with a green pulse in the center.
// Drawing at 32 and letting Electron downsample to 16 looks sharper than drawing directly at 16 on hi-DPI displays.
function createTrayIconBuffer() {
  const W = 32, H = 32;
  // Capsule: 26w x 14h, vertically centered, radius = h/2.
  const capsuleW = 26, capsuleH = 14;
  const capX = (W - capsuleW) / 2, capY = (H - capsuleH) / 2;
  const radius = capsuleH / 2;
  // Capsule background: deep space gray; good contrast against the Win11 taskbar.
  const BG = [0x1C, 0x1C, 0x1E];
  // Center pulse: CodePeek brand green.
  const DOT = [0x30, 0xD1, 0x58];

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
  secureHandle('get-config', () => config.get());
  secureHandle('get-dict', () => getDict(config.get('language')));
  secureHandle('get-agents', () => getAllAgents());
  secureHandle('get-sounds', () => getAllSounds(config.get('soundPack') || 'soft'));
  secureHandle('get-sound-packs', () => listPacks());
  secureHandle('get-displays', () => screen.getAllDisplays().map(d => ({
    id: d.id,
    label: d.label || `Display ${d.id}`,
    bounds: d.bounds,
    primary: d.id === screen.getPrimaryDisplay().id
  })));

  secureHandle('set-config', (_, patch) => {
    if (!patch || typeof patch !== 'object') return config.get();
    config.setMultiple(patch);
    if (patch.displayId !== undefined) repositionWindow();
    return config.get();
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

  secureHandle('dump-window-state', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return { error: 'destroyed' };
    const b = mainWindow.getBounds();
    const disp = screen.getDisplayMatching(b);
    const all = screen.getAllDisplays().map(d => ({ id: d.id, bounds: d.bounds, wa: d.workArea, primary: d === screen.getPrimaryDisplay() }));
    return {
      bounds: b, visible: mainWindow.isVisible(), minimized: mainWindow.isMinimized(),
      focused: mainWindow.isFocused(), alwaysOnTop: mainWindow.isAlwaysOnTop(),
      display: { id: disp.id, bounds: disp.bounds, workArea: disp.workArea },
      allDisplays: all
    };
  });

  secureHandle('approve-permission', (_, requestId, behavior) => {
    if (typeof requestId !== 'string') return;
    if (!['allow', 'deny', 'always'].includes(behavior)) return;
    sessionManager.approvePermission(requestId, behavior);
  });

  secureHandle('answer-question', (_, requestId, answer) => {
    if (typeof requestId !== 'string' || typeof answer !== 'string') return;
    if (answer.length > 10000) answer = answer.substring(0, 10000);
    sessionManager.answerQuestion(requestId, answer);
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

  secureHandle('resize-window', (_, opts) => {
    if (!mainWindow || !opts) return;
    isExpanded = !!opts.expanded;
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
    if (diag.config) delete diag.config.token;
    return diag;
  });
}

function repositionWindow() {
  if (!mainWindow) return;
  const display = getTargetDisplay();
  const bounds = display.workArea;
  const { width: screenWidth } = display.workAreaSize;
  const { width: winW, height: winH } = getWindowSize();
  const x = bounds.x + Math.round((screenWidth - winW) / 2);
  mainWindow.setBounds({ x, y: bounds.y, width: winW, height: winH });
}

function registerShortcuts() {
  try {
    globalShortcut.unregisterAll();
    const toggle = config.get('shortcutToggle');
    if (toggle) {
      globalShortcut.register(toggle, () => {
        if (!mainWindow) return;
        if (mainWindow.isVisible()) mainWindow.hide();
        else { mainWindow.show(); mainWindow.focus(); }
      });
    }
  } catch {}
}

app.on('before-quit', () => {
  app.isQuitting = true;
  try { globalShortcut.unregisterAll(); } catch {}
  if (sessionScanner) sessionScanner.stop();
  if (sessionManager) sessionManager.destroy();
  if (hookServer) hookServer.stop();
});

app.on('window-all-closed', () => {});
