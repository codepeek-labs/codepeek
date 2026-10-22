'use strict';

// User config persistence at ~/.codepeek/config.json

const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

const CONFIG_DIR = path.join(os.homedir(), '.codepeek');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG = {
  // General
  language: 'auto',          // auto | en | zh
  startOnLogin: false,
  displayId: null,           // null = primary

  // Behavior
  autoHidePanel: true,
  hoverExpand: true,
  hoverCollapseDelay: 1500,    // ms to wait after mouse leaves before auto-collapsing (0 = immediate)
  hoverExpandDelay: 80,        // ms of hover before auto-expanding
  suppressNotifications: false, // legacy: true forces the quiet completion mode
  completionAlert: 'quiet',    // quiet (inbox only) | smart (not watching and turn >= shortTurnSeconds) | always
  shortTurnSeconds: 20,
  awayIdleSeconds: 120,        // no input for this long counts as away: no auto-expand, no sounds
  dndUntil: 0,                 // 0 = off, -1 = until turned off, otherwise epoch ms
  dndSince: 0,                 // when the current DND began, so a restart still summarises from there
  followUpMinutes: 5,          // re-alert an unanswered request after this many minutes (and 3x later); 0 = off
  mutedProjects: [],           // normalised cwds whose completions / needs-input never pop up or sound

  // Remote answering (DingTalk). Written only by the remote-* IPC handlers; the secret is safeStorage-encrypted.
  remoteEnabled: false,
  remoteClientId: '',
  remoteRobotCode: '',         // '' = same as the client id
  remoteSecretEnc: '',
  remoteStaffId: '',           // the one DingTalk user allowed to answer, set by pairing
  remoteNick: '',
  remoteCorpId: '',
  remotePushWhen: 'away',      // away (locked / idle >= remoteAwaySeconds) | always (after remoteDelaySeconds)
  remoteAwaySeconds: 120,
  remoteDelaySeconds: 60,
  remoteSeq: 0,                // last short id handed out, so ids keep increasing across restarts
  completionDisplayTime: 5,    // seconds the completion card stays visible (1-30)
  cleanupStaleAfter: 300,      // seconds; 0 = never clean up

  // Appearance
  panelWidth: 600,
  panelHeight: 560,
  fontSize: 13,
  responseLines: 2,
  mascotEnabled: true,
  peekHeight: 6,             // pixels of the top strip exposed when collapsed
  sessionGrouping: 'status', // status | cli | all
  panelOffsetX: 0,           // horizontal drag offset in px
  collapsedMode: 'smart',    // smart (strip, pill while a request waits) | pill | strip
  followAccent: true,        // use the Windows accent color for neutral selection/controls
  reduceMotion: false,       // true forces reduced motion even if Windows animations are on
  animationDuration: 300,    // ms for expanding; collapsing takes two thirds of it
  animationEasing: 'snappy', // snappy (fast start, long settle) | smooth (gentle start)

  // Sound
  soundEnabled: true,
  soundPack: 'soft',          // soft | chime | 8bit | minimal | silent
  soundVolume: 0.5,
  soundOnSessionStart: true,
  soundOnToolUse: false,
  soundOnPermission: true,
  soundOnQuestion: true,
  soundOnComplete: true,

  // Hooks
  autoApproveTools: ['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList',
                     'TaskOutput', 'TaskStop', 'TodoRead', 'TodoWrite',
                     'EnterPlanMode', 'ExitPlanMode'],

  // Shortcuts
  shortcutToggle: 'Control+Shift+I',
  shortcutNext: 'Control+Shift+J',
  shortcutApprove: 'Control+Y',
  shortcutDeny: 'Control+N',

  configVersion: 4,

  // Agents (supported tools enabled/disabled)
  agents: {
    claude: true,
    codex: true,
    gemini: true,
    cursor: false,
    copilot: false,
    qoder: false,
    factory: false,
    codebuddy: false,
    opencode: false
  }
};

class Config extends EventEmitter {
  constructor() {
    super();
    this._data = { ...DEFAULT_CONFIG };
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
      }
      if (fs.existsSync(CONFIG_PATH)) {
        let loaded;
        try { loaded = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) {
          // Keep the unreadable file for recovery instead of silently overwriting it with defaults.
          try { fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.corrupt'); } catch {}
          throw e;
        }
        const migrated = this._migrate(loaded);
        // Merge with defaults so newly added fields are always present.
        this._data = this._deepMerge(DEFAULT_CONFIG, loaded);
        if (migrated) this._save();
      }
    } catch {}
  }

  // v1 files stored every default verbatim, so the old defaults are treated as "never customized".
  _migrate(loaded) {
    if (!loaded || typeof loaded !== 'object') return false;
    const from = loaded.configVersion || 1;
    if (from >= 4) return false;
    if (from < 2) {
      if (loaded.panelWidth === 420) loaded.panelWidth = 600;
      if (loaded.sessionGrouping === 'all') loaded.sessionGrouping = 'status';
    }
    // v4: v3 forced the prompt chime off behind the user's back; sound switches are the user's to change.
    if (from === 3 && loaded.soundOnSessionStart === false) loaded.soundOnSessionStart = true;
    loaded.configVersion = 4;
    return true;
  }

  _save() {
    try {
      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
      }
      // Atomic replace: a crash mid-write must never leave a truncated file that resets every setting.
      const tmp = CONFIG_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this._data, null, 2), 'utf8');
      fs.renameSync(tmp, CONFIG_PATH);
    } catch {}
  }

  _deepMerge(defaults, overrides) {
    const result = { ...defaults };
    for (const key of Object.keys(overrides)) {
      if (overrides[key] && typeof overrides[key] === 'object' && !Array.isArray(overrides[key])) {
        result[key] = this._deepMerge(defaults[key] || {}, overrides[key]);
      } else {
        result[key] = overrides[key];
      }
    }
    return result;
  }

  get(key) {
    if (key === undefined) return { ...this._data };
    return this._data[key];
  }

  set(key, value) {
    this._data[key] = value;
    this._save();
    this.emit('changed', key, value);
  }

  setMultiple(patch) {
    Object.assign(this._data, patch);
    this._save();
    this.emit('changed', null, patch);
  }

  reset() {
    this._data = { ...DEFAULT_CONFIG };
    this._save();
    this.emit('changed', null, this._data);
  }

  static getDefaults() {
    return { ...DEFAULT_CONFIG };
  }
}

module.exports = new Config();
