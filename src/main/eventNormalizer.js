'use strict';

// Normalize event names from various CLI tools into internal PascalCase format.
// Different CLIs use different naming conventions (camelCase, PascalCase, snake_case).

const EVENT_MAP = {
  // Cursor (camelCase)
  'beforeSubmitPrompt': 'UserPromptSubmit',
  'beforeShellExecution': 'PreToolUse',
  'beforeReadFile': 'PreToolUse',
  'beforeMCPExecution': 'PreToolUse',
  'afterShellExecution': 'PostToolUse',
  'afterFileEdit': 'PostToolUse',
  'afterMCPExecution': 'PostToolUse',
  'afterAgentThought': 'Notification',
  'afterAgentResponse': 'Stop',
  'stop': 'Stop',

  // Gemini CLI
  'BeforeTool': 'PreToolUse',
  'AfterTool': 'PostToolUse',
  'BeforeAgent': 'SubagentStart',
  'AfterAgent': 'SubagentStop',

  // GitHub Copilot
  'sessionStart': 'SessionStart',
  'sessionEnd': 'SessionEnd',
  'userPromptSubmitted': 'UserPromptSubmit',
  'preToolUse': 'PreToolUse',
  'postToolUse': 'PostToolUse',
  'errorOccurred': 'Notification',
};

function normalizeEventName(rawName) {
  return EVENT_MAP[rawName] || rawName;
}

// Normalize field names: different CLIs use different keys for the same data.
function normalizeEvent(event) {
  const eventName = event.hook_event_name || event.hookEventName || event.event_name || event.eventName || event.event || '';
  const normalized = normalizeEventName(eventName);

  // Write back the canonical name so downstream code only checks one key.
  event.hook_event_name = normalized;

  // Normalize tool_name from various field names
  if (!event.tool_name) {
    event.tool_name = event.toolName || event.tool || '';
  }

  // Normalize tool_input from various field names
  if (!event.tool_input) {
    event.tool_input = event.toolInput || event.toolArgs || event.input || null;
  }

  // Normalize session_id from various sources
  if (!event.session_id) {
    event.session_id = event.sessionId || event.session || '';
  }

  // Normalize message/notification content
  if (!event.message && !event.notification) {
    event.message = event.content || event.text || '';
  }

  return event;
}

module.exports = { normalizeEvent, normalizeEventName };
