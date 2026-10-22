'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codePeek', {
  // State
  getState: () => ipcRenderer.invoke('get-state'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: (patch) => ipcRenderer.invoke('set-config', patch),
  getDict: () => ipcRenderer.invoke('get-dict'),
  getAgents: () => ipcRenderer.invoke('get-agents'),
  getSounds: () => ipcRenderer.invoke('get-sounds'),
  getSoundPacks: () => ipcRenderer.invoke('get-sound-packs'),
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  getAccentColor: () => ipcRenderer.invoke('get-accent-color'),

  // Actions
  approvePermission: (requestId, behavior, answers, message) =>
    ipcRenderer.invoke('approve-permission', requestId, behavior, answers, message),
  answerQuestion: (requestId, answer) =>
    ipcRenderer.invoke('answer-question', requestId, answer),
  markSeen: (sessionId, version) => ipcRenderer.invoke('mark-seen', sessionId, version),
  setAlertNext: (sessionId, on) => ipcRenderer.invoke('set-alert-next', sessionId, on),
  setDnd: (minutes) => ipcRenderer.invoke('set-dnd', minutes),
  getFocusState: () => ipcRenderer.invoke('get-focus-state'),
  getHealth: () => ipcRenderer.invoke('get-health'),
  repairHooks: () => ipcRenderer.invoke('repair-hooks'),
  remoteGet: () => ipcRenderer.invoke('remote-get'),
  remoteSave: (patch) => ipcRenderer.invoke('remote-save', patch),
  remotePair: () => ipcRenderer.invoke('remote-pair'),
  remoteUnbind: () => ipcRenderer.invoke('remote-unbind'),
  remoteTest: () => ipcRenderer.invoke('remote-test'),

  // Hooks - Claude
  installHooks: () => ipcRenderer.invoke('install-hooks'),
  uninstallHooks: () => ipcRenderer.invoke('uninstall-hooks'),
  isHooksInstalled: () => ipcRenderer.invoke('is-hooks-installed'),
  // Hooks - Codex
  installCodexHooks: () => ipcRenderer.invoke('install-codex-hooks'),
  uninstallCodexHooks: () => ipcRenderer.invoke('uninstall-codex-hooks'),
  isCodexHooksInstalled: () => ipcRenderer.invoke('is-codex-hooks-installed'),
  // One-shot install for all supported agents.
  installAllHooks: () => ipcRenderer.invoke('install-all-hooks'),

  // Window
  setIgnoreMouse: (ignore) => ipcRenderer.invoke('set-ignore-mouse', ignore),
  dragWindow: (dx) => ipcRenderer.invoke('drag-window', dx),
  focusWindow: () => ipcRenderer.invoke('focus-window'),
  quitApp: () => ipcRenderer.invoke('quit-app'),
  jumpToTerminal: (pid, sessionName, cwd) => ipcRenderer.invoke('jump-to-terminal', pid, sessionName, cwd),
  launchSession: (sessionId, cwd, agent) => ipcRenderer.invoke('launch-session', sessionId, cwd, agent),
  refreshSessions: () => ipcRenderer.invoke('refresh-sessions'),
  getCursorScreenPoint: () => ipcRenderer.invoke('get-cursor-screen-point'),

  // Autostart
  toggleAutoStart: (enabled) => ipcRenderer.invoke('toggle-autostart', enabled),
  isAutoStart: () => ipcRenderer.invoke('is-autostart'),
  exportDiagnostics: () => ipcRenderer.invoke('export-diagnostics'),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  getUpdateState: () => ipcRenderer.invoke('get-update-state'),

  // Listeners
  onStateChanged: (cb) => {
    const h = (_, state) => cb(state);
    ipcRenderer.on('state-changed', h);
    return () => ipcRenderer.removeListener('state-changed', h);
  },
  onConfigChanged: (cb) => {
    const h = (_, cfg) => cb(cfg);
    ipcRenderer.on('config-changed', h);
    return () => ipcRenderer.removeListener('config-changed', h);
  },
  onPlaySound: (cb) => {
    const h = (_, type) => cb(type);
    ipcRenderer.on('play-sound', h);
    return () => ipcRenderer.removeListener('play-sound', h);
  },
  onSoundsChanged: (cb) => {
    const h = (_, sounds) => cb(sounds);
    ipcRenderer.on('sounds-changed', h);
    return () => ipcRenderer.removeListener('sounds-changed', h);
  },
  onCollapse: (cb) => {
    const h = () => cb();
    ipcRenderer.on('collapse', h);
    return () => ipcRenderer.removeListener('collapse', h);
  },
  onNotification: (cb) => {
    const h = (_, data) => cb(data);
    ipcRenderer.on('notification', h);
    return () => ipcRenderer.removeListener('notification', h);
  },
  onShortcut: (cb) => {
    const h = (_, action) => cb(action);
    ipcRenderer.on('shortcut', h);
    return () => ipcRenderer.removeListener('shortcut', h);
  },
  onRemoteStatus: (cb) => {
    const h = (_, st) => cb(st);
    ipcRenderer.on('remote-status', h);
    return () => ipcRenderer.removeListener('remote-status', h);
  },
  onFocusState: (cb) => {
    const h = (_, st) => cb(st);
    ipcRenderer.on('focus-state', h);
    return () => ipcRenderer.removeListener('focus-state', h);
  },
  onAccentChanged: (cb) => {
    const h = (_, color) => cb(color);
    ipcRenderer.on('accent-changed', h);
    return () => ipcRenderer.removeListener('accent-changed', h);
  },
  onCompletionNotify: (cb) => {
    const h = (_, data) => cb(data);
    ipcRenderer.on('completion-notify', h);
    return () => ipcRenderer.removeListener('completion-notify', h);
  }
});
