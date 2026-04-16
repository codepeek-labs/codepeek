'use strict';

const { EventEmitter } = require('events');
const config = require('./config');
const { detectAgentFromEvent } = require('./agents');
const { normalizeEvent } = require('./eventNormalizer');

// Stale-session cleanup timeout (configurable).
function getSessionTimeout() {
  const s = config.get('cleanupStaleAfter');
  return (s || 300) * 1000;
}

class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.pendingPermissions = new Map();
    this.pendingQuestions = new Map();
    this.scannedSessions = [];
    this._requestCounter = 0;
    this._cleanupTimer = setInterval(() => this._cleanupStaleSessions(), 15000);
  }

  handleEvent(event, respond) {
    normalizeEvent(event);
    const eventName = event.hook_event_name;
    const sessionId = event.session_id;

    if (!sessionId) { if (respond) respond(null); return; }

    this._touchSession(sessionId, event);

    switch (eventName) {
      case 'SessionStart':
        this._onSessionStart(sessionId, event);
        break;
      case 'SessionEnd':
        this._onSessionEnd(sessionId);
        break;
      case 'UserPromptSubmit':
        this._onUserPrompt(sessionId, event);
        this.emit('sound', 'sessionStart');
        break;
      case 'PreToolUse':
        this._onPreToolUse(sessionId, event);
        this.emit('sound', 'toolUse');
        break;
      case 'PostToolUse':
        this._onPostToolUse(sessionId, event, false);
        break;
      case 'PostToolUseFailure':
        this._onPostToolUse(sessionId, event, true);
        break;
      case 'PermissionRequest':
        this._onPermissionRequest(sessionId, event, respond);
        return;
      case 'PermissionDenied':
        this._onPermissionDenied(sessionId, event);
        break;
      case 'Notification':
        this._onNotification(sessionId, event, respond);
        return;
      case 'Stop':
        this._onStop(sessionId, event);
        this.emit('sound', 'complete');
        break;
      case 'SubagentStart':
        this._onSubagentStart(sessionId, event);
        break;
      case 'SubagentStop':
        this._onSubagentStop(sessionId, event);
        break;
      case 'PreCompact':
        this._onPreCompact(sessionId, event);
        break;
      default:
        break;
    }

    if (respond) respond(null);
  }

  updateScannedSessions(scanned) {
    this.scannedSessions = scanned;
    this.emit('state-changed');
  }

  approvePermission(requestId, behavior) {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    let response;
    if (behavior === 'allow') {
      response = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
    } else if (behavior === 'always') {
      response = {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'allow',
            updatedPermissions: [{
              type: 'addRules',
              rules: [{ toolName: pending.toolName || '', ruleContent: '*' }],
              behavior: 'allow',
              destination: 'session'
            }]
          }
        }
      };
    } else {
      response = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } } };
    }
    // try/finally guarantees the pending entry is cleaned up even if respond throws.
    try {
      pending.respond(JSON.stringify(response));
    } catch {}
    this.pendingPermissions.delete(requestId);
    this._updateSessionStatus(pending.sessionId, 'thinking');
    this.emit('state-changed');
  }

  answerQuestion(requestId, answer) {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending) return;
    const response = {
      hookSpecificOutput: { hookEventName: 'Notification', answer }
    };
    try {
      pending.respond(JSON.stringify(response));
    } catch {}
    this.pendingQuestions.delete(requestId);
    this._updateSessionStatus(pending.sessionId, 'thinking');
    this.emit('state-changed');
  }

  // Called by hookServer when the bridge disconnects; cleans up the matching pending entry.
  cancelPendingByRespond(respondFn) {
    for (const [id, p] of this.pendingPermissions) {
      if (p.respond === respondFn) {
        this.pendingPermissions.delete(id);
        this._updateSessionStatus(p.sessionId, 'thinking');
        this.emit('state-changed');
        return;
      }
    }
    for (const [id, q] of this.pendingQuestions) {
      if (q.respond === respondFn) {
        this.pendingQuestions.delete(id);
        this._updateSessionStatus(q.sessionId, 'thinking');
        this.emit('state-changed');
        return;
      }
    }
  }

  getState() {
    const hookSessions = Array.from(this.sessions.values());
    const hookSessionIds = new Set(hookSessions.map(s => s.id));
    const scanOnly = (this.scannedSessions || []).filter(s => !hookSessionIds.has(s.id));

    const mergedHook = hookSessions.map(hs => {
      const scanned = (this.scannedSessions || []).find(s => s.id === hs.id);
      if (scanned) {
        return {
          ...scanned,
          ...hs,
          // Fields where the hook data wins (live runtime state).
          status: hs.status,
          currentTool: hs.currentTool,
          toolInput: hs.toolInput,
          lastError: hs.lastError,
          // Fields where scanner data wins (static metadata).
          name: scanned.name || hs.name || '',
          model: scanned.model || hs.model || '',
          lastPrompt: scanned.lastPrompt || hs.lastPrompt || '',
          lastResponse: scanned.lastResponse || hs.lastResponse || '',
          timeAgo: scanned.timeAgo || '',
          pid: scanned.pid || hs.pid,
          isRunning: scanned.isRunning !== undefined ? scanned.isRunning : true,
          projectName: scanned.projectName || ''
        };
      }
      return hs;
    });

    const allSessions = [...mergedHook, ...scanOnly].sort((a, b) => {
      if (a.isRunning === false && b.isRunning !== false) return 1;
      if (a.isRunning !== false && b.isRunning === false) return -1;
      return (b.startedAt || 0) - (a.startedAt || 0);
    });

    return {
      sessions: allSessions,
      pendingPermissions: Array.from(this.pendingPermissions.entries()).map(([id, p]) => ({
        id, sessionId: p.sessionId, toolName: p.toolName, toolInput: p.toolInput, timestamp: p.timestamp
      })),
      pendingQuestions: Array.from(this.pendingQuestions.entries()).map(([id, q]) => ({
        id, sessionId: q.sessionId, question: q.question, timestamp: q.timestamp
      }))
    };
  }

  destroy() {
    clearInterval(this._cleanupTimer);
    for (const [id, p] of this.pendingPermissions) {
      try {
        p.respond(JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } }
        }));
      } catch {}
    }
    this.pendingPermissions.clear();
    for (const [id, q] of this.pendingQuestions) {
      try { q.respond('{}'); } catch {}
    }
    this.pendingQuestions.clear();
  }

  // ========== Internal event handlers ==========

  _isWaiting(sessionId) {
    const s = this.sessions.get(sessionId);
    return s && (s.status === 'waiting_permission' || s.status === 'waiting_answer');
  }

  _touchSession(sessionId, event) {
    // bridge.js stamps the event with _source ('claude' | 'codex'); prefer that for agent detection.
    const sourceAgent = event._source === 'codex' ? 'codex'
      : event._source === 'claude' ? 'claude'
      : null;
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        id: sessionId,
        status: 'active',
        currentTool: null,
        toolInput: null,
        cwd: event.cwd || '',
        startedAt: Date.now(),
        lastActivity: Date.now(),
        subagentDepth: 0,
        agent: sourceAgent || detectAgentFromEvent(event)
      };
      this.sessions.set(sessionId, session);
    } else if (sourceAgent && session.agent !== sourceAgent) {
      session.agent = sourceAgent;
    }
    session.lastActivity = Date.now();
    if (event.cwd) session.cwd = event.cwd;
  }

  _onSessionStart(sessionId, event) {
    this._updateSessionStatus(sessionId, 'active');
  }

  _onSessionEnd(sessionId) {
    for (const [id, p] of this.pendingPermissions) {
      if (p.sessionId === sessionId) {
        try { p.respond(JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } }
        })); } catch {}
        this.pendingPermissions.delete(id);
      }
    }
    for (const [id, q] of this.pendingQuestions) {
      if (q.sessionId === sessionId) {
        try { q.respond('{}'); } catch {}
        this.pendingQuestions.delete(id);
      }
    }
    this.sessions.delete(sessionId);
    this.emit('state-changed');
  }

  _onUserPrompt(sessionId, event) {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (!this._isWaiting(sessionId)) {
        session.status = 'thinking';
      }
      session.currentTool = null;
      session.toolInput = null;
    }
    this.emit('state-changed');
  }

  _onPreToolUse(sessionId, event) {
    const toolName = event.tool_name || '';
    const session = this.sessions.get(sessionId);
    if (session) {
      session.currentTool = toolName;
      if (!this._isWaiting(sessionId)) {
        session.status = 'tool_use';
      }
      session.toolInput = this._formatToolInput(toolName, event.tool_input);
    }
    this.emit('state-changed');
  }

  _onPostToolUse(sessionId, event, isFailure) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.currentTool = null;
      session.toolInput = null;
      if (!this._isWaiting(sessionId)) {
        session.status = 'thinking';
      }
      if (isFailure) {
        session.lastError = event.error || event.message || 'Tool failed';
      } else {
        delete session.lastError;
      }
    }
    this.emit('state-changed');
  }

  _onPermissionRequest(sessionId, event, respond) {
    const toolName = event.tool_name || '';
    const BUILTIN_AUTO_APPROVE = ['TaskCreate','TaskUpdate','TaskGet','TaskList','TaskOutput','TaskStop','TodoRead','TodoWrite','EnterPlanMode','ExitPlanMode'];
    const userApprove = config.get('autoApproveTools') || [];

    if (BUILTIN_AUTO_APPROVE.includes(toolName) || userApprove.includes(toolName)) {
      if (respond) {
        respond(JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } }
        }));
      }
      return;
    }

    const requestId = `perm_${++this._requestCounter}`;
    this.pendingPermissions.set(requestId, {
      sessionId, toolName,
      toolInput: this._formatToolInput(toolName, event.tool_input),
      timestamp: Date.now(),
      respond: respond || (() => {})
    });

    this._updateSessionStatus(sessionId, 'waiting_permission');
    this.emit('sound', 'permission');
    this.emit('state-changed');
  }

  _onPermissionDenied(sessionId, event) {
    this._updateSessionStatus(sessionId, 'thinking');
  }

  _onNotification(sessionId, event, respond) {
    const question = event.message || event.notification || event.content || event.question || '';
    if (!question) {
      if (respond) respond(null);
      return;
    }
    const requestId = `q_${++this._requestCounter}`;
    this.pendingQuestions.set(requestId, {
      sessionId, question, timestamp: Date.now(),
      respond: respond || (() => {})
    });
    this._updateSessionStatus(sessionId, 'waiting_answer');
    this.emit('sound', 'question');
    this.emit('state-changed');
  }

  _onStop(sessionId, event) {
    this._updateSessionStatus(sessionId, 'idle');
    this._emitCompletion(sessionId);
  }

  _emitCompletion(sessionId) {
    // Merge duplicate Stop events within 1 second for the same session (e.g. cascading SubagentStop events).
    if (!this._lastCompletionTs) this._lastCompletionTs = new Map();
    const now = Date.now();
    const last = this._lastCompletionTs.get(sessionId) || 0;
    if (now - last < 1000) return;
    this._lastCompletionTs.set(sessionId, now);

    const session = this.sessions.get(sessionId) || {};
    const scanned = (this.scannedSessions || []).find(s => s.id === sessionId) || {};
    const cwd = session.cwd || scanned.cwd || '';
    const projectName = scanned.projectName || (cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : '') || '';
    const sessionTitle = scanned.name || session.name || '';
    const lastResponse = scanned.lastResponse || session.lastResponse || '';
    this.emit('completion', {
      sessionId,
      projectName,
      sessionTitle,
      cwd,
      lastResponse,
      agent: session.agent || scanned.agent || 'claude',
      timestamp: now
    });
  }

  _onSubagentStart(sessionId, event) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.subagentDepth = (session.subagentDepth || 0) + 1;
      session.status = 'subagent';
      session.statusDetail = event.subagent_type || 'agent';
    }
    this.emit('state-changed');
  }

  _onSubagentStop(sessionId, event) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.subagentDepth = Math.max(0, (session.subagentDepth || 1) - 1);
      if (session.subagentDepth === 0) {
        session.status = 'thinking';
        delete session.statusDetail;
      }
    }
    this.emit('state-changed');
  }

  _onPreCompact(sessionId, event) {
    this._updateSessionStatus(sessionId, 'compacting');
  }

  _updateSessionStatus(sessionId, status, detail) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = status;
      if (detail) session.statusDetail = detail;
      else delete session.statusDetail;
    }
    this.emit('state-changed');
  }

  _formatToolInput(toolName, toolInput) {
    if (!toolInput) return '';
    try {
      if (typeof toolInput === 'string') return toolInput.substring(0, 300);
      switch (toolName) {
        case 'Bash': {
          const desc = toolInput.description;
          if (desc && typeof desc === 'string') return desc.substring(0, 120);
          const cmd = toolInput.command || '';
          return cmd.split('\n')[0].substring(0, 80);
        }
        case 'Edit':
        case 'Write': {
          const fp = toolInput.file_path || '';
          return fp.split(/[\\/]/).pop() || fp;
        }
        case 'Read': {
          const fp = toolInput.file_path || '';
          const name = fp.split(/[\\/]/).pop() || fp;
          return toolInput.offset ? `${name}:${toolInput.offset}` : name;
        }
        case 'Grep': {
          const pat = toolInput.pattern || '';
          const p = toolInput.path || '';
          const fname = p.split(/[\\/]/).pop() || p;
          return fname ? `${pat} in ${fname}` : pat;
        }
        case 'Glob': return toolInput.pattern || '';
        case 'WebSearch': return toolInput.query || '';
        case 'WebFetch': {
          try { return new URL(toolInput.url || '').hostname; }
          catch { return toolInput.url || ''; }
        }
        case 'Task':
        case 'Agent': return toolInput.description || (toolInput.prompt || '').substring(0, 60);
        case 'TodoWrite': return 'Updating tasks';
        default: {
          const fp = toolInput.file_path || toolInput.pattern || toolInput.command || toolInput.prompt || '';
          if (fp) return String(fp).substring(0, 120);
          return JSON.stringify(toolInput).substring(0, 200);
        }
      }
    } catch { return ''; }
  }

  _cleanupStaleSessions() {
    const timeout = getSessionTimeout();
    if (timeout <= 0) return;
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity > timeout) {
        this.sessions.delete(id);
      }
    }
    this.emit('state-changed');
  }
}

module.exports = SessionManager;
