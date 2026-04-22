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

  // Actions
  approvePermission: (requestId, behavior) =>
    ipcRenderer.invoke('approve-permission', requestId, behavior),
  answerQuestion: (requestId, answer) =>
    ipcRenderer.invoke('answer-question', requestId, answer),

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
  resizeWindow: (params) => ipcRenderer.invoke('resize-window', params),
  setIgnoreMouse: (ignore) => ipcRenderer.invoke('set-ignore-mouse', ignore),
  quitApp: () => ipcRenderer.invoke('quit-app'),
  jumpToTerminal: (pid, sessionName, cwd) => ipcRenderer.invoke('jump-to-terminal', pid, sessionName, cwd),
  launchSession: (sessionId, cwd, agent) => ipcRenderer.invoke('launch-session', sessionId, cwd, agent),
  refreshSessions: () => ipcRenderer.invoke('refresh-sessions'),
  getCursorScreenPoint: () => ipcRenderer.invoke('get-cursor-screen-point'),
  dumpWindowState: () => ipcRenderer.invoke('dump-window-state'),

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
  onCompletionNotify: (cb) => {
    const h = (_, data) => cb(data);
    ipcRenderer.on('completion-notify', h);
    return () => ipcRenderer.removeListener('completion-notify', h);
  }
});
