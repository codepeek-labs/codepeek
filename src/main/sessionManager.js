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
        this.emit('sound', 'sessionStart', { sessionId, agent: this.sessions.get(sessionId)?.agent });
        break;
      case 'PreToolUse':
        this._onPreToolUse(sessionId, event);
        this.emit('sound', 'toolUse', { sessionId, agent: this.sessions.get(sessionId)?.agent });
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
        // Sound is played by the renderer only when the completion card is actually shown,
        // so we do NOT emit 'sound' here (it would desync with suppressed cards).
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
      // A hook session that's seen events recently proves its CLI process is alive — bridge.js is
      // a child of the CLI and can't fire otherwise. Trust this over stale PID files on disk.
      const hookRecentlyActive = hs.lastActivity && (Date.now() - hs.lastActivity < 60000);
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
          timeAgo: this._formatTimeAgo(Math.max(hs.lastActivity || 0, scanned.lastActivityAt || 0)),
          // Scanner reads pid from ~/.claude/sessions/{pid}.json — that's the real claude.exe PID.
          // hs.pid comes from bridge_ppid, which on Windows can be a short-lived shell wrapper
          // that's already exited by the time the user clicks (procMap won't have it -> "No ancestors").
          // Scanner's dedup already picks the alive pidfile, so its pid is trustworthy.
          pid: scanned.pid || hs.pid,
          isRunning: hookRecentlyActive ? true : (scanned.isRunning !== undefined ? scanned.isRunning : true),
          projectName: scanned.projectName || ''
        };
      }
      return { ...hs, timeAgo: this._formatTimeAgo(hs.lastActivity) };
    });

    // Recalculate timeAgo for scan-only sessions (scanner caches it at scan time, not query time).
    const scanOnlyFresh = scanOnly.map(s => ({
      ...s,
      timeAgo: this._formatTimeAgo(s.lastActivityAt || s.startedAt)
    }));

    const allSessions = [...mergedHook, ...scanOnlyFresh].sort((a, b) => {
      if (a.isRunning === false && b.isRunning !== false) return 1;
      if (a.isRunning !== false && b.isRunning === false) return -1;
      // Sort by last activity (most recent first), fallback to startedAt.
      const aTime = a.lastActivity || a.lastActivityAt || a.startedAt || 0;
      const bTime = b.lastActivity || b.lastActivityAt || b.startedAt || 0;
      return bTime - aTime;
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
    // bridge_ppid is the PID of the CLI process that spawned the bridge (Claude/Codex).
    if (event.bridge_ppid && !session.pid) session.pid = event.bridge_ppid;
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
    if (this._lastCompletionTs) this._lastCompletionTs.delete(sessionId);
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
    try { require('fs').appendFile(require('path').join(require('os').homedir(), '.codepeek', 'debug.log'),
      `${new Date().toISOString()} [perm] received sid=${sessionId} tool=${toolName}\n`, () => {}); } catch {}
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
    // Sound is played by the renderer only when the permission card is actually rendered.
    this.emit('state-changed');
  }

  _onPermissionDenied(sessionId, event) {
    this._updateSessionStatus(sessionId, 'thinking');
  }

  _onNotification(sessionId, event, respond) {
    const question = event.message || event.notification || event.content || event.question || '';
    try { require('fs').appendFile(require('path').join(require('os').homedir(), '.codepeek', 'debug.log'),
      `${new Date().toISOString()} [notif] sid=${sessionId} src=${event._source} type=${event.notification_type} msg=${JSON.stringify(String(question).substring(0, 200))}\n`, () => {}); } catch {}
    // Claude CLI uses its own terminal TUI for any real question requiring user input. The
    // Notification hook is fired for idle pings ("Claude is waiting for your input"), tool-result
    // announcements, etc. — none of which we should surface as a blocking question card. If we
    // kept any of them, the card would re-expand on every state-changed tick until TTL cleans up.
    // Drop all Claude Notifications here; Codex Notifications (if they ever arrive) still flow
    // through below.
    if (event._source === 'claude') {
      if (respond) respond('{}');
      return;
    }
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
    // Sound is played by the renderer only when the question card is actually rendered.
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

    // Suppress completion for Codex sessions spawned by Claude via /codex plugin.
    // If there's an active Claude session with the same cwd, this Codex session is
    // just an intermediate step — the user cares about Claude's completion, not Codex's.
    const detectedAgent = session.agent || scanned.agent;
    if (detectedAgent === 'codex' && cwd) {
      // Only suppress if the sibling Claude session is actually active — a long-idle sibling
      // shouldn't claim parenthood over this Codex completion. Consider it active if we've seen
      // any hook event from it within the last 2 minutes.
      const CLAUDE_ACTIVE_WINDOW_MS = 2 * 60 * 1000;
      const nowTs = Date.now();
      for (const [, s] of this.sessions) {
        if (s.id !== sessionId && s.agent === 'claude' && s.cwd === cwd
            && s.lastActivity && (nowTs - s.lastActivity) < CLAUDE_ACTIVE_WINDOW_MS) {
          try { require('fs').appendFile(require('path').join(require('os').homedir(), '.codepeek', 'debug.log'),
            `${new Date().toISOString()} [emit] SUPPRESS codex completion (active Claude parent) sid=${sessionId} cwd=${cwd}\n`, () => {}); } catch {}
          return;
        }
      }
      try { require('fs').appendFile(require('path').join(require('os').homedir(), '.codepeek', 'debug.log'),
        `${new Date().toISOString()} [emit] NOT SUPPRESSED codex sid=${sessionId} cwd=${cwd} activeSessions=${Array.from(this.sessions.values()).map(x => x.agent+':'+(x.cwd||'')).join(' | ')}\n`, () => {}); } catch {}
    }
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

  _formatTimeAgo(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const min = Math.floor(diff / 60000);
    if (min < 1) return '<1m';
    if (min < 60) return min + 'm';
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr + 'h';
    return Math.floor(hr / 24) + 'd';
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
    // Also age out pending permissions/questions. bridge.js blocks for up to 24h waiting
    // for a response; if the user hasn't seen or answered the card within 10 minutes,
    // it's almost certainly orphaned (session ended silently, UI got shadowed, etc.)
    // and would otherwise hang the "question" surface forever.
    const PENDING_TTL = 10 * 60 * 1000;
    for (const [id, p] of this.pendingPermissions) {
      if (p.timestamp && now - p.timestamp > PENDING_TTL) {
        try { p.respond(JSON.stringify({
          hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } }
        })); } catch {}
        this.pendingPermissions.delete(id);
      }
    }
    for (const [id, q] of this.pendingQuestions) {
      if (q.timestamp && now - q.timestamp > PENDING_TTL) {
        try { q.respond('{}'); } catch {}
        this.pendingQuestions.delete(id);
      }
    }
    this.emit('state-changed');
  }

  // Remove hook sessions whose backing process is no longer in procMap or is orphaned.
  // Called after a forced process-table refresh (e.g. when jump-to-terminal fails).
  pruneDeadSessions(procMap, orphanedPids) {
    if (!procMap || !(procMap instanceof Map)) return 0;
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (!session.pid) continue;
      const gone = !procMap.has(session.pid);
      const orphan = orphanedPids && orphanedPids.has(session.pid);
      if (gone || orphan) {
        this.sessions.delete(id);
        if (this._lastCompletionTs) this._lastCompletionTs.delete(id);
        removed++;
      }
    }
    if (removed > 0) this.emit('state-changed');
    return removed;
  }
}

module.exports = SessionManager;
