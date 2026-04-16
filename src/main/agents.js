'use strict';

// Multi-agent definitions: hook config paths, event names, icons, etc.

const path = require('path');
const os = require('os');

const HOME = os.homedir();

// SVG mascot library — 24x24 viewBox.
// Structure convention:  <g class="m-body"> body, <g class="m-eyes"> eyes, <g class="m-limb"> extras.
// CSS targets those classes for float / blink animations; there is no per-frame JS driver.
// All shapes are original geometry; no third-party logos are reused.
const ICONS = {
  // Claude: orange octopus-ish blob (half-round head + 4 tentacles + big round eyes).
  claude: `
    <g class="m-body">
      <path d="M 4 10 Q 4 3 12 3 Q 20 3 20 10 L 20 13
               Q 19 16 17.5 14 Q 16 16 14.5 14
               Q 13 16 11.5 14 Q 10 16 8.5 14
               Q 7 16 5.5 14 Q 4 16 4 13 Z" fill="currentColor"/>
    </g>
    <g class="m-eyes">
      <circle cx="9" cy="9" r="1.8" fill="white"/>
      <circle cx="15" cy="9" r="1.8" fill="white"/>
      <circle cx="9.3" cy="9.3" r="0.9" fill="#1c1c1e"/>
      <circle cx="15.3" cy="9.3" r="0.9" fill="#1c1c1e"/>
      <circle cx="9.7" cy="8.8" r="0.3" fill="white"/>
      <circle cx="15.7" cy="8.8" r="0.3" fill="white"/>
    </g>
    <g class="m-mouth">
      <path d="M 10.5 12 Q 12 13 13.5 12" stroke="#1c1c1e" stroke-width="0.8" stroke-linecap="round" fill="none"/>
    </g>`,

  // Codex: green six-petal flower (rotating petals + face in the center).
  codex: `
    <g class="m-petals">
      <g fill="currentColor">
        <ellipse cx="12" cy="5"  rx="2.2" ry="3.2"/>
        <ellipse cx="12" cy="19" rx="2.2" ry="3.2"/>
        <ellipse cx="5"  cy="12" rx="3.2" ry="2.2"/>
        <ellipse cx="19" cy="12" rx="3.2" ry="2.2"/>
        <ellipse cx="7"  cy="7"  rx="2.5" ry="2.5" opacity="0.85"/>
        <ellipse cx="17" cy="17" rx="2.5" ry="2.5" opacity="0.85"/>
      </g>
    </g>
    <g class="m-body">
      <circle cx="12" cy="12" r="4.2" fill="#0b2e20"/>
    </g>
    <g class="m-eyes">
      <circle cx="10.5" cy="11.5" r="0.9" fill="white"/>
      <circle cx="13.5" cy="11.5" r="0.9" fill="white"/>
      <path d="M 10.8 13.3 Q 12 14.3 13.2 13.3" stroke="white" stroke-width="0.7" stroke-linecap="round" fill="none"/>
    </g>`,

  // Gemini: blue twins — two little buddies stuck together.
  gemini: `
    <g class="m-body">
      <circle cx="8.5" cy="12" r="6" fill="currentColor"/>
      <circle cx="15.5" cy="12" r="6" fill="currentColor" opacity="0.85"/>
    </g>
    <g class="m-eyes">
      <circle cx="7" cy="11" r="1.4" fill="white"/>
      <circle cx="17" cy="11" r="1.4" fill="white"/>
      <circle cx="7.3" cy="11.3" r="0.7" fill="#1c1c1e"/>
      <circle cx="17.3" cy="11.3" r="0.7" fill="#1c1c1e"/>
    </g>
    <g class="m-mouth">
      <path d="M 6 14 Q 7 15 8 14" stroke="#1c1c1e" stroke-width="0.7" stroke-linecap="round" fill="none"/>
      <path d="M 16 14 Q 17 15 18 14" stroke="#1c1c1e" stroke-width="0.7" stroke-linecap="round" fill="none"/>
    </g>`,

  // Cursor: black arrow sprite (arrow body + one curious eye).
  cursor: `
    <g class="m-body">
      <path d="M 6 4 L 6 18 L 10 14.5 L 12.5 20 L 15 19 L 12.5 13.5 L 18 13.5 Z" fill="currentColor"/>
    </g>
    <g class="m-eyes">
      <circle cx="9" cy="9" r="1.6" fill="white"/>
      <circle cx="9.4" cy="9.2" r="0.8" fill="#1c1c1e"/>
      <circle cx="9.7" cy="8.9" r="0.25" fill="white"/>
    </g>`,

  // Copilot: violet bird (round body + flapping wings + one big eye).
  copilot: `
    <g class="m-limb m-wing-left">
      <path d="M 3 11 Q 5 8 8 11 L 7 13 Q 4 13 3 11 Z" fill="currentColor" opacity="0.7"/>
    </g>
    <g class="m-limb m-wing-right">
      <path d="M 21 11 Q 19 8 16 11 L 17 13 Q 20 13 21 11 Z" fill="currentColor" opacity="0.7"/>
    </g>
    <g class="m-body">
      <ellipse cx="12" cy="13" rx="6.5" ry="6" fill="currentColor"/>
    </g>
    <g class="m-eyes">
      <circle cx="10.5" cy="11.5" r="2.2" fill="white"/>
      <circle cx="11" cy="12" r="1.1" fill="#1c1c1e"/>
      <circle cx="11.3" cy="11.7" r="0.4" fill="white"/>
    </g>
    <path d="M 14 13.5 L 16 14 L 14 14.5 Z" fill="#FF9F0A"/>`,

  // Qoder: orange question-mark critter (Q shape + eyes).
  qoder: `
    <g class="m-body">
      <circle cx="11" cy="11" r="7" fill="currentColor"/>
      <path d="M 15 15 L 20 20" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
    </g>
    <g class="m-eyes">
      <circle cx="9" cy="10" r="1.3" fill="white"/>
      <circle cx="13" cy="10" r="1.3" fill="white"/>
      <circle cx="9.2" cy="10.2" r="0.6" fill="#1c1c1e"/>
      <circle cx="13.2" cy="10.2" r="0.6" fill="#1c1c1e"/>
    </g>`,

  // Factory: cyan robot (square head + antenna + LED eyes).
  factory: `
    <g class="m-limb m-antenna">
      <line x1="12" y1="3" x2="12" y2="6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      <circle cx="12" cy="2.5" r="1" fill="currentColor"/>
    </g>
    <g class="m-body">
      <rect x="5" y="6" width="14" height="14" rx="3" fill="currentColor"/>
    </g>
    <g class="m-eyes">
      <rect x="7.5" y="10" width="3" height="3" rx="0.8" fill="white"/>
      <rect x="13.5" y="10" width="3" height="3" rx="0.8" fill="white"/>
      <rect x="8.5" y="11" width="1" height="1" fill="#1c1c1e"/>
      <rect x="14.5" y="11" width="1" height="1" fill="#1c1c1e"/>
    </g>
    <rect x="9" y="16" width="6" height="1.2" rx="0.6" fill="#1c1c1e" opacity="0.6"/>`,

  // CodeBuddy: yellow smiley sphere (big circle + wide grin).
  codebuddy: `
    <g class="m-body">
      <circle cx="12" cy="12" r="8.5" fill="currentColor"/>
    </g>
    <g class="m-eyes">
      <circle cx="9" cy="10" r="1.3" fill="#3a2a00"/>
      <circle cx="15" cy="10" r="1.3" fill="#3a2a00"/>
      <circle cx="9.3" cy="9.7" r="0.4" fill="white"/>
      <circle cx="15.3" cy="9.7" r="0.4" fill="white"/>
    </g>
    <g class="m-mouth">
      <path d="M 8 14 Q 12 18 16 14" stroke="#3a2a00" stroke-width="1.4" stroke-linecap="round" fill="none"/>
    </g>`,

  // OpenCode: green terminal sprite (screen + blinking cursor).
  opencode: `
    <g class="m-body">
      <rect x="3" y="5" width="18" height="14" rx="2.5" fill="currentColor"/>
      <rect x="3" y="5" width="18" height="3" rx="2.5" fill="#0b2e0b"/>
    </g>
    <g class="m-eyes">
      <circle cx="5.5" cy="6.5" r="0.6" fill="#FF453A"/>
      <circle cx="7.5" cy="6.5" r="0.6" fill="#FF9F0A"/>
      <circle cx="9.5" cy="6.5" r="0.6" fill="#30D158"/>
    </g>
    <g class="m-mouth">
      <path d="M 6 13 L 9 15 L 6 17" stroke="white" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
      <rect class="m-cursor" x="11" y="15" width="4" height="1.4" fill="white"/>
    </g>`
};
function getIconSvg(id) {
  return ICONS[id] || `<text x="12" y="16" font-size="13" font-weight="700" text-anchor="middle" fill="currentColor">${(id||'?').charAt(0).toUpperCase()}</text>`;
}

const AGENTS = {
  claude: {
    id: 'claude',
    name: 'Claude Code',
    color: '#D97757',
    icon: 'C',
    supported: true, // Hook integration wired up.
    hookConfigPath: path.join(HOME, '.claude', 'settings.json'),
    hookEvents: [
      'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
      'PermissionRequest', 'PermissionDenied', 'Stop', 'SubagentStart',
      'SubagentStop', 'SessionStart', 'SessionEnd', 'Notification', 'PreCompact'
    ],
    blockingEvents: ['PermissionRequest', 'Notification'],
    longTimeouts: { PermissionRequest: 86400, Notification: 86400 }
  },

  codex: {
    id: 'codex',
    // Read-only support: sessions are listed by scanning ~/.codex/sessions/, hooks are optional and installable on demand.
    supported: true,
    name: 'Codex',
    color: '#10A37F',
    icon: 'X',
    hookConfigPath: path.join(HOME, '.codex', 'config.toml'),
    hookEvents: [],
    blockingEvents: [],
    longTimeouts: { PermissionRequest: 86400 }
  },

  gemini: {
    id: 'gemini',
    supported: false,
    name: 'Gemini CLI',
    color: '#4285F4',
    icon: 'G',
    hookConfigPath: path.join(HOME, '.gemini', 'config.json'),
    hookEvents: ['SessionStart', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'SessionEnd'],
    blockingEvents: ['PermissionRequest'],
    longTimeouts: { PermissionRequest: 86400 }
  },

  cursor: {
    id: 'cursor',
    supported: false,
    name: 'Cursor',
    color: '#000000',
    icon: 'Cu',
    hookConfigPath: path.join(HOME, '.cursor', 'hooks.json'),
    hookEvents: ['SessionStart', 'PreToolUse', 'PostToolUse', 'PermissionRequest',
                 'UserPromptSubmit', 'Stop', 'SessionEnd', 'Notification', 'SubagentStart', 'SubagentStop'],
    blockingEvents: ['PermissionRequest', 'Notification'],
    longTimeouts: { PermissionRequest: 86400, Notification: 86400 }
  },

  copilot: {
    id: 'copilot',
    supported: false,
    name: 'GitHub Copilot',
    color: '#6E40C9',
    icon: 'Co',
    hookConfigPath: path.join(HOME, '.copilot', 'hooks.json'),
    hookEvents: ['SessionStart', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'SessionEnd'],
    blockingEvents: ['PermissionRequest'],
    longTimeouts: { PermissionRequest: 86400 }
  },

  qoder: {
    id: 'qoder',
    supported: false,
    name: 'Qoder',
    color: '#FF6B35',
    icon: 'Q',
    hookConfigPath: path.join(HOME, '.qoder', 'config.json'),
    hookEvents: ['SessionStart', 'PreToolUse', 'PostToolUse', 'PermissionRequest',
                 'UserPromptSubmit', 'Stop', 'SessionEnd', 'Notification', 'SubagentStart', 'SubagentStop'],
    blockingEvents: ['PermissionRequest', 'Notification'],
    longTimeouts: { PermissionRequest: 86400, Notification: 86400 }
  },

  factory: {
    id: 'factory',
    supported: false,
    name: 'Factory',
    color: '#00D9FF',
    icon: 'F',
    hookConfigPath: path.join(HOME, '.factory', 'hooks.json'),
    hookEvents: ['SessionStart', 'PreToolUse', 'PostToolUse', 'PermissionRequest',
                 'UserPromptSubmit', 'Stop', 'SessionEnd', 'Notification', 'SubagentStart', 'SubagentStop'],
    blockingEvents: ['PermissionRequest', 'Notification'],
    longTimeouts: { PermissionRequest: 86400, Notification: 86400 }
  },

  codebuddy: {
    id: 'codebuddy',
    supported: false,
    name: 'CodeBuddy',
    color: '#FFB800',
    icon: 'B',
    hookConfigPath: path.join(HOME, '.codebuddy', 'config.json'),
    hookEvents: ['SessionStart', 'PreToolUse', 'PostToolUse', 'PermissionRequest',
                 'UserPromptSubmit', 'Stop', 'SessionEnd', 'Notification', 'SubagentStart', 'SubagentStop'],
    blockingEvents: ['PermissionRequest', 'Notification'],
    longTimeouts: { PermissionRequest: 86400, Notification: 86400 }
  },

  opencode: {
    id: 'opencode',
    supported: false,
    name: 'OpenCode',
    color: '#3DDC84',
    icon: 'O',
    hookConfigPath: path.join(HOME, '.opencode', 'plugin.json'),
    usesPlugin: true, // Uses a JS plugin; no bridge needed.
    hookEvents: [],
    blockingEvents: [],
    longTimeouts: {}
  }
};

// Heuristic agent inference from event payload (fallback when _source is not set by the bridge).
function detectAgentFromEvent(event) {
  if (event.agent) return event.agent.toLowerCase();
  if (event.tool_provider) return event.tool_provider.toLowerCase();
  if (event.bridge_source) return event.bridge_source;
  const model = event.model || (event.message && event.message.model) || '';
  if (model.includes('claude')) return 'claude';
  if (model.includes('gpt') || model.includes('codex')) return 'codex';
  if (model.includes('gemini')) return 'gemini';
  return 'claude';
}

function getAgent(id) {
  return AGENTS[id] || null;
}

function getAllAgents() {
  // Inject iconSvg (constant string from the main process, IPC-safe).
  return Object.values(AGENTS).map(a => ({ ...a, iconSvg: getIconSvg(a.id) }));
}

function getEnabledAgents(config) {
  const enabled = config.get('agents') || {};
  return Object.values(AGENTS).filter(a => enabled[a.id]);
}

module.exports = { AGENTS, getAgent, getAllAgents, getEnabledAgents, detectAgentFromEvent, getIconSvg };
