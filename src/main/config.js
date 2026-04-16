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
  suppressNotifications: false, // true = never show completion card; default is to show
  completionDisplayTime: 5,    // seconds the completion card stays visible (1-30)
  cleanupStaleAfter: 300,      // seconds; 0 = never clean up

  // Appearance
  panelWidth: 420,
  panelHeight: 560,
  fontSize: 13,
  responseLines: 2,
  mascotEnabled: true,
  peekHeight: 6,             // pixels of the top strip exposed when collapsed
  sessionGrouping: 'all',    // all | status | cli
  panelOffsetX: 0,           // horizontal drag offset in px

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
  shortcutApprove: 'Control+Y',
  shortcutDeny: 'Control+N',

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
        const loaded = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        // Merge with defaults so newly added fields are always present.
        this._data = this._deepMerge(DEFAULT_CONFIG, loaded);
      }
    } catch {}
  }

  _save() {
    try {
      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
      }
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(this._data, null, 2), 'utf8');
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
