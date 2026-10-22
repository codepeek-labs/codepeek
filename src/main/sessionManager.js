'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const config = require('./config');
const { detectAgentFromEvent } = require('./agents');
const { normalizeEvent } = require('./eventNormalizer');
const TranscriptWatcher = require('./transcriptWatcher');
const AttentionStore = require('./attentionStore');
const { debugLog } = require('./debugLog');

// Stale-session cleanup timeout (configurable).
function getSessionTimeout() {
  const s = config.get('cleanupStaleAfter');
  return (s || 300) * 1000;
}

const QUESTION_TTL = 10 * 60 * 1000;
const RESOLVED_KEEP_MS = 3000;
const MAX_REPLY = 20000;
// Claude Notification types that mean "go to the terminal": nothing CodePeek can answer itself.
const NEEDS_INPUT_TYPES = new Set(['agent_needs_input', 'elicitation_dialog', 'elicitation_url_dialog']);
const MAX_CALLS_PER_SESSION = 200;
const MAX_TEXT = 8000;
const MAX_ANSWER = 4000;
const BUILTIN_AUTO_APPROVE = ['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop',
  'TodoRead', 'TodoWrite', 'EnterPlanMode', 'ExitPlanMode'];

const DENY = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } } });
// No decision: Claude keeps its own prompt. Background subagents cannot prompt and treat this as a deny.
const NO_DECISION = '{}';

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function inputKeyOf(toolInput) {
  return crypto.createHash('sha1').update(stableStringify(toolInput || null)).digest('hex');
}

// Subagent hook events carry agent_id; older CLIs may only send agent_transcript_path or agent_type.
function actorOf(event) {
  if (event.agent_id) return String(event.agent_id);
  if (event.agent_transcript_path || event.agent_type) return 'sub:' + String(event.agent_transcript_path || event.agent_type);
  return 'main';
}

function clip(v, n = MAX_TEXT) {
  if (v === undefined || v === null) return '';
  return String(v).substring(0, n);
}

// Picks one scoped rule so "always allow" never grants more than the label shows.
function pickSessionRule(suggestions) {
  if (!Array.isArray(suggestions)) return null;
  for (const s of suggestions) {
    if (!s || s.type !== 'addRules' || s.behavior !== 'allow' || !Array.isArray(s.rules) || s.rules.length === 0) continue;
    const rules = s.rules.filter(r => r && typeof r.toolName === 'string' && r.toolName);
    if (rules.length === 0) continue;
    const label = rules.map(r => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName)).join(', ');
    return { update: { type: 'addRules', rules, behavior: 'allow', destination: 'session' }, label: label.substring(0, 160) };
  }
  return null;
}

function buildDisplay(toolName, input, cwd) {
  const d = { title: toolName || '', command: '', description: '', path: '', detail: '', cwd: cwd || '' };
  if (!input || typeof input !== 'object') {
    d.command = clip(typeof input === 'string' ? input : '');
    return d;
  }
  switch (toolName) {
    case 'Bash':
    case 'PowerShell':
      d.command = clip(input.command);
      d.description = clip(input.description, 400);
      break;
    case 'Edit':
    case 'MultiEdit':
      d.path = clip(input.file_path, 1000);
      if (typeof input.old_string === 'string' || typeof input.new_string === 'string') {
        const minus = clip(input.old_string, 2000).split('\n').map(l => '- ' + l).join('\n');
        const plus = clip(input.new_string, 2000).split('\n').map(l => '+ ' + l).join('\n');
        d.detail = clip(minus + '\n' + plus);
      } else if (Array.isArray(input.edits)) {
        d.description = `${input.edits.length} edits`;
      }
      break;
    case 'Write':
      d.path = clip(input.file_path, 1000);
      d.detail = clip(input.content, 3000);
      break;
    case 'Read':
    case 'NotebookEdit':
      d.path = clip(input.file_path || input.notebook_path, 1000);
      break;
    case 'WebFetch':
      d.command = clip(input.url, 2000);
      d.description = clip(input.prompt, 400);
      break;
    case 'WebSearch':
      d.command = clip(input.query, 1000);
      break;
    case 'Grep':
    case 'Glob':
      d.command = clip(input.pattern, 1000);
      d.path = clip(input.path, 1000);
      break;
    case 'Task':
    case 'Agent':
      d.description = clip(input.description, 400);
      d.command = clip(input.prompt, 2000);
      break;
    default:
      try { d.command = clip(JSON.stringify(input, null, 2)); } catch {}
  }
  return d;
}

// Validates AskUserQuestion answers against the original questions; multi-select joins labels with ", ".
function normalizeAnswers(questions, answers) {
  if (!Array.isArray(questions) || !answers || typeof answers !== 'object') return null;
  const out = {};
  for (const q of questions) {
    const key = q && typeof q.question === 'string' ? q.question : null;
    if (!key) return null;
    let v = answers[key];
    if (Array.isArray(v)) v = v.filter(x => typeof x === 'string' && x.trim()).join(', ');
    if (typeof v !== 'string' || !v.trim() || v.length > MAX_ANSWER) return null;
    out[key] = v;
  }
  return out;
}

class SessionManager extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.sessions = new Map();
    this.pendingPermissions = new Map();
    this.pendingQuestions = new Map();
    this.scannedSessions = [];
    this._requestCounter = 0;
    this._calls = new Map(); // sessionId -> Map(tool_use_id -> { actor, toolName, inputKey, boundTo, ts })
    this._recentlyResolved = [];
    this._lastCompletionTs = new Map();
    this._turnStart = new Map();
    this._orphanMisses = new Map();
    this._lastProcRefresh = 0;
    this.lastEventAt = 0;
    this.attention = opts.attentionStore || new AttentionStore();
    // (sessionId) => true | false | null: is the user at that session's terminal right now (null = unknown).
    this._presenceProbe = opts.presenceProbe || (() => null);
    this._transcripts = opts.transcriptWatcher
      || new TranscriptWatcher((key, toolUseId, m) => this._onTranscriptResult(key, toolUseId, m));
    this._cleanupTimer = setInterval(() => this._cleanupStaleSessions(), 15000);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  handleEvent(event, respond) {
    normalizeEvent(event);
    const eventName = event.hook_event_name;
    const sessionId = event.session_id;

    if (!sessionId) { if (respond) respond(null); return; }

    this.lastEventAt = Date.now();
    this._touchSession(sessionId, event);

    switch (eventName) {
      case 'SessionStart':
        this._updateSessionStatus(sessionId, 'active');
        break;
      case 'SessionEnd':
        this._onSessionEnd(sessionId);
        break;
      case 'UserPromptSubmit':
        this._settleMainTurn(sessionId, event, 'new-prompt');
        this._onUserPrompt(sessionId, event);
        this.emit('sound', 'sessionStart', { sessionId, agent: this.sessions.get(sessionId)?.agent });
        break;
      case 'PreToolUse':
        this._trackCallStart(sessionId, event);
        if (this.attention.clearFlag(sessionId, 'input', actorOf(event))) this.emit('state-changed');
        this._onPreToolUse(sessionId, event);
        this.emit('sound', 'toolUse', { sessionId, agent: this.sessions.get(sessionId)?.agent });
        break;
      case 'PostToolUse':
        this._trackCallEnd(sessionId, event, false);
        this._onPostToolUse(sessionId, event, false);
        break;
      case 'PostToolUseFailure':
        this._trackCallEnd(sessionId, event, true);
        this._onPostToolUse(sessionId, event, true);
        break;
      case 'PermissionRequest':
        this._onPermissionRequest(sessionId, event, respond);
        return;
      case 'PermissionDenied':
        this._refreshWaitingStatus(sessionId, 'thinking');
        break;
      case 'Notification':
        this._onNotification(sessionId, event, respond);
        return;
      case 'Stop':
        this._settleMainTurn(sessionId, event, 'turn-ended');
        this._onStop(sessionId, event);
        break;
      case 'StopFailure':
        this._settleMainTurn(sessionId, event, 'turn-ended');
        this._onStopFailure(sessionId, event);
        break;
      case 'SubagentStart':
        this._onSubagentStart(sessionId, event);
        break;
      case 'SubagentStop':
        this._onSubagentStop(sessionId);
        break;
      case 'PreCompact':
        this._updateSessionStatus(sessionId, 'compacting');
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

  // Returns { ok, status } where status is accepted | already-settled | invalid | delivery-failed.
  approvePermission(requestId, behavior, answers, message) {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return { ok: false, status: 'already-settled' };
    let decision;
    let outcome;
    if (pending.questions && behavior === 'allow') {
      const normalized = normalizeAnswers(pending.questions, answers);
      if (!normalized) return { ok: false, status: 'invalid' };
      const base = pending.rawInput && typeof pending.rawInput === 'object' ? pending.rawInput : {};
      decision = { behavior: 'allow', updatedInput: { ...base, questions: pending.questions, answers: normalized } };
      outcome = 'answered';
    } else if (behavior === 'allow') {
      decision = { behavior: 'allow' };
      outcome = 'allowed';
    } else if (behavior === 'always') {
      if (!pending.sessionRule) return { ok: false, status: 'invalid' };
      decision = { behavior: 'allow', updatedPermissions: [pending.sessionRule.update] };
      outcome = 'allowed';
    } else if (behavior === 'deny') {
      decision = { behavior: 'deny' };
      if (message) decision.message = message;
      outcome = message ? 'clarify' : 'denied';
    } else {
      return { ok: false, status: 'invalid' };
    }
    const response = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
    const status = this._settlePending(requestId, { response, outcome, reason: 'island' });
    return { ok: status === 'accepted', status };
  }

  answerQuestion(requestId, answer) {
    const pending = this.pendingQuestions.get(requestId);
    if (!pending) return { ok: false, status: 'already-settled' };
    const response = JSON.stringify({ hookSpecificOutput: { hookEventName: 'Notification', answer } });
    this.pendingQuestions.delete(requestId);
    let delivered = false;
    try { delivered = pending.respond(response) !== false; } catch {}
    this._pushResolved(requestId, pending.sessionId, 'answered', 'island');
    this._refreshWaitingStatus(pending.sessionId);
    this.emit('state-changed');
    return { ok: delivered, status: delivered ? 'accepted' : 'delivery-failed' };
  }

  // Called by hookServer when the bridge connection drops before we answered.
  cancelPendingByRespond(respondFn) {
    for (const [id, p] of this.pendingPermissions) {
      if (p.respond === respondFn) {
        this._settlePending(id, { response: null, outcome: 'ended', reason: 'disconnect' });
        return;
      }
    }
    for (const [id, q] of this.pendingQuestions) {
      if (q.respond === respondFn) {
        this.pendingQuestions.delete(id);
        this._pushResolved(id, q.sessionId, 'ended', 'disconnect');
        this._refreshWaitingStatus(q.sessionId);
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
          status: hs.status,
          currentTool: hs.currentTool,
          toolInput: hs.toolInput,
          lastError: hs.lastError,
          name: scanned.name || hs.name || '',
          model: scanned.model || hs.model || '',
          gitBranch: scanned.gitBranch || '',
          // Hook text is exact for the finished turn; the transcript tail is fresher while a turn runs.
          lastPrompt: hs.lastPrompt || scanned.lastPrompt || '',
          lastResponse: (hs.status === 'idle' && typeof hs.lastResponse === 'string') ? hs.lastResponse : (scanned.lastResponse || hs.lastResponse || ''),
          timeAgo: this._formatTimeAgo(Math.max(hs.lastActivity || 0, scanned.lastActivityAt || 0)),
          // Scanner pid is the real CLI; bridge_ppid may be a shell wrapper that has already exited.
          pid: scanned.pid || hs.pid,
          isRunning: hookRecentlyActive ? true : (scanned.isRunning !== undefined ? scanned.isRunning : true),
          projectName: scanned.projectName || ''
        };
      }
      return { ...hs, timeAgo: this._formatTimeAgo(hs.lastActivity) };
    });

    const scanOnlyFresh = scanOnly.map(s => ({
      ...s,
      timeAgo: this._formatTimeAgo(s.lastActivityAt || s.startedAt)
    }));

    const allSessions = [...mergedHook, ...scanOnlyFresh].sort((a, b) => {
      if (a.isRunning === false && b.isRunning !== false) return 1;
      if (a.isRunning !== false && b.isRunning === false) return -1;
      const aTime = a.lastActivity || a.lastActivityAt || a.startedAt || 0;
      const bTime = b.lastActivity || b.lastActivityAt || b.startedAt || 0;
      return bTime - aTime;
    });

    const now = Date.now();
    this._recentlyResolved = this._recentlyResolved.filter(r => now - r.at < RESOLVED_KEEP_MS);

    return {
      sessions: allSessions,
      pendingPermissions: Array.from(this.pendingPermissions.entries()).map(([id, p]) => ({
        id, sessionId: p.sessionId, toolName: p.toolName, toolInput: p.toolInput,
        display: p.display,
        questions: p.questions || null,
        alwaysLabel: p.sessionRule ? p.sessionRule.label : null,
        isSubagent: p.actor !== 'main',
        timestamp: p.timestamp
      })),
      pendingQuestions: Array.from(this.pendingQuestions.entries()).map(([id, q]) => ({
        id, sessionId: q.sessionId, question: q.question, timestamp: q.timestamp
      })),
      recentlyResolved: this._recentlyResolved.slice(),
      attention: this.attention.list(),
      alertNext: this.attention.alertNextIds(),
      lastEventAt: this.lastEventAt
    };
  }

  setPresenceProbe(fn) { this._presenceProbe = typeof fn === 'function' ? fn : () => null; }

  markSeen(sessionId, version) {
    if (this.attention.markSeen(sessionId, version)) this.emit('state-changed');
  }

  setAlertNext(sessionId, on) {
    const s = this.sessions.get(sessionId) || (this.scannedSessions || []).find(x => x.id === sessionId) || {};
    this.attention.setAlertNext(sessionId, on, this._metaOf(sessionId, s));
    this.emit('state-changed');
  }

  // A pending request whose CLI process is gone across two process-table refreshes can never be answered.
  reapOrphans(procMap, generation) {
    if (!(procMap instanceof Map) || procMap.size === 0 || !generation || generation === this._lastProcRefresh) return;
    this._lastProcRefresh = generation;
    for (const [id, p] of Array.from(this.pendingPermissions)) {
      const scanned = (this.scannedSessions || []).find(x => x.id === p.sessionId);
      const pid = (scanned && scanned.pid) || 0;
      if (!pid || procMap.has(pid)) { this._orphanMisses.delete(id); continue; }
      const misses = (this._orphanMisses.get(id) || 0) + 1;
      this._orphanMisses.set(id, misses);
      if (misses >= 2) {
        this._orphanMisses.delete(id);
        this._settlePending(id, { response: DENY, outcome: 'ended', reason: 'process-gone' });
      }
    }
  }

  _metaOf(sessionId, s) {
    const scanned = (this.scannedSessions || []).find(x => x.id === sessionId) || {};
    const cwd = (s && s.cwd) || scanned.cwd || '';
    return {
      agent: (s && s.agent) || scanned.agent || 'claude',
      name: scanned.name || (s && s.name) || scanned.projectName || (cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : ''),
      cwd,
      gitBranch: scanned.gitBranch || ''
    };
  }

  destroy() {
    clearInterval(this._cleanupTimer);
    for (const id of Array.from(this.pendingPermissions.keys())) {
      this._settlePending(id, { response: DENY, outcome: 'ended', reason: 'shutdown', silent: true });
    }
    for (const [, q] of this.pendingQuestions) {
      try { q.respond('{}'); } catch {}
    }
    this.pendingQuestions.clear();
    this._transcripts.stop();
    this.attention.flush();
  }

  // ========== Pending lifecycle ==========

  // Single exit for every pending permission: responds at most once, then re-derives the session status.
  _settlePending(id, { response, outcome, reason, silent }) {
    const p = this.pendingPermissions.get(id);
    if (!p) return 'already-settled';
    this.pendingPermissions.delete(id);
    // A call id is consumed once its card settles; reusing it could bind a later identical request wrongly.
    if (p.binding.toolUseId) {
      const call = this._calls.get(p.sessionId)?.get(p.binding.toolUseId);
      if (call && call.boundTo === id) call.consumed = true;
    }
    this._transcripts.unwatch(id);
    let delivered = true;
    if (response !== null) {
      try { delivered = p.respond(response) !== false; } catch { delivered = false; }
    }
    debugLog('perm', `settled id=${id} outcome=${outcome} reason=${reason} delivered=${delivered} binding=${p.binding.state}`);
    if (silent) return delivered ? 'accepted' : 'delivery-failed';
    this._pushResolved(id, p.sessionId, outcome, reason);
    this._refreshWaitingStatus(p.sessionId);
    this.emit('state-changed');
    return delivered ? 'accepted' : 'delivery-failed';
  }

  _pushResolved(id, sessionId, outcome, reason) {
    this._recentlyResolved.push({ id, sessionId, outcome, reason, at: Date.now() });
    if (this._recentlyResolved.length > 50) this._recentlyResolved.shift();
  }

  _refreshWaitingStatus(sessionId, fallback = 'thinking') {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const hasPerm = Array.from(this.pendingPermissions.values()).some(p => p.sessionId === sessionId);
    const hasQuestion = Array.from(this.pendingQuestions.values()).some(q => q.sessionId === sessionId);
    if (hasPerm) s.status = 'waiting_permission';
    else if (hasQuestion) s.status = 'waiting_answer';
    else if (s.status === 'waiting_permission' || s.status === 'waiting_answer') s.status = fallback;
  }

  _isWaiting(sessionId) {
    const s = this.sessions.get(sessionId);
    return s && (s.status === 'waiting_permission' || s.status === 'waiting_answer');
  }

  // ========== Call correlation ==========

  _trackCallStart(sessionId, event) {
    const id = event.tool_use_id;
    if (!id || typeof id !== 'string') return;
    let calls = this._calls.get(sessionId);
    if (!calls) { calls = new Map(); this._calls.set(sessionId, calls); }
    calls.set(id, {
      actor: actorOf(event),
      toolName: event.tool_name || '',
      inputKey: inputKeyOf(event.tool_input),
      boundTo: null,
      consumed: false,
      ts: Date.now()
    });
    while (calls.size > MAX_CALLS_PER_SESSION) calls.delete(calls.keys().next().value);
  }

  // A finished call proves its permission was decided elsewhere, so the bound card can be retired.
  _trackCallEnd(sessionId, event, isFailure) {
    const id = event.tool_use_id;
    const calls = this._calls.get(sessionId);
    if (!id || !calls) return;
    const call = calls.get(id);
    calls.delete(id);
    if (call && call.boundTo && !call.consumed) {
      this._settlePending(call.boundTo, { response: NO_DECISION, outcome: isFailure ? 'failed' : 'executed', reason: 'tool-finished' });
    }
  }

  // Binds only when exactly one unbound in-flight call matches; PreToolUse always lands before its PermissionRequest.
  _bindPending(requestId, sessionId, actor, toolName, inputKey) {
    const calls = this._calls.get(sessionId);
    if (!calls) return { state: 'unbound', toolUseId: null };
    const candidates = [];
    for (const [toolUseId, c] of calls) {
      if (!c.boundTo && !c.consumed && c.actor === actor && c.toolName === toolName && c.inputKey === inputKey) candidates.push(toolUseId);
    }
    if (candidates.length !== 1) return { state: candidates.length ? 'ambiguous' : 'unbound', toolUseId: null };
    calls.get(candidates[0]).boundTo = requestId;
    return { state: 'confirmed', toolUseId: candidates[0] };
  }

  _onTranscriptResult(key, toolUseId, m) {
    const p = this.pendingPermissions.get(key);
    if (!p || p.binding.toolUseId !== toolUseId) return;
    this._settlePending(key, { response: NO_DECISION, outcome: m.rejected ? 'rejected' : 'external', reason: 'transcript' });
  }

  // Claude awaits UserPromptSubmit/Stop hooks, so a main-agent permission still pending here was answered already.
  _settleMainTurn(sessionId, event, reason) {
    const calls = this._calls.get(sessionId);
    if (calls) {
      for (const [toolUseId, c] of Array.from(calls)) if (c.actor === 'main') calls.delete(toolUseId);
    }
    for (const [id, p] of Array.from(this.pendingPermissions)) {
      if (p.sessionId !== sessionId || p.actor !== 'main') continue;
      if (event.prompt_id && p.promptId) {
        if (reason === 'new-prompt' && event.prompt_id === p.promptId) continue;
        if (reason === 'turn-ended' && event.prompt_id !== p.promptId) continue;
      }
      this._settlePending(id, { response: NO_DECISION, outcome: 'external', reason });
    }
  }

  // ========== Internal event handlers ==========

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

  _onSessionEnd(sessionId) {
    for (const [id, p] of Array.from(this.pendingPermissions)) {
      if (p.sessionId === sessionId) this._settlePending(id, { response: DENY, outcome: 'ended', reason: 'session-end' });
    }
    for (const [id, q] of this.pendingQuestions) {
      if (q.sessionId === sessionId) {
        try { q.respond('{}'); } catch {}
        this.pendingQuestions.delete(id);
      }
    }
    this._dropSession(sessionId);
    // The user exited the CLI on purpose; nothing in it is waiting for them any more.
    this.attention.remove(sessionId);
    this.emit('state-changed');
  }

  _dropSession(sessionId) {
    this.sessions.delete(sessionId);
    this._calls.delete(sessionId);
    this._lastCompletionTs.delete(sessionId);
    this._turnStart.delete(sessionId);
  }

  _onUserPrompt(sessionId, event) {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (!this._isWaiting(sessionId)) session.status = 'thinking';
      session.currentTool = null;
      session.toolInput = null;
      if (typeof event.prompt === 'string' && event.prompt.trim()) session.lastPrompt = event.prompt.substring(0, 2000);
    }
    this._turnStart.set(sessionId, Date.now());
    // A new turn's Stop must not be merged into the previous turn's duplicate-Stop window.
    this._lastCompletionTs.delete(sessionId);
    // Turns Claude starts on its own (loops, background reports) also fire this hook; they must not mark a reply read.
    const rec = this.attention.get(sessionId);
    let present = null;
    try { present = this._presenceProbe(sessionId); } catch {}
    if (rec && rec.kind === 'reply' && present !== true) this.attention.clearFlags(sessionId);
    else this.attention.clear(sessionId);
    this.emit('state-changed');
  }

  _onPreToolUse(sessionId, event) {
    const toolName = event.tool_name || '';
    const session = this.sessions.get(sessionId);
    if (session) {
      session.currentTool = toolName;
      if (!this._isWaiting(sessionId)) session.status = 'tool_use';
      session.toolInput = this._formatToolInput(toolName, event.tool_input);
    }
    this.emit('state-changed');
  }

  _onPostToolUse(sessionId, event, isFailure) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.currentTool = null;
      session.toolInput = null;
      if (!this._isWaiting(sessionId)) session.status = 'thinking';
      if (isFailure) session.lastError = event.error || event.message || 'Tool failed';
      else delete session.lastError;
    }
    this.emit('state-changed');
  }

  _onPermissionRequest(sessionId, event, respond) {
    const toolName = event.tool_name || '';
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
    const actor = actorOf(event);
    const rawInput = event.tool_input && typeof event.tool_input === 'object' ? event.tool_input : null;
    const isAskUser = toolName === 'AskUserQuestion';
    const questions = isAskUser && rawInput && Array.isArray(rawInput.questions) ? rawInput.questions : null;
    const session = this.sessions.get(sessionId);
    const binding = this._bindPending(requestId, sessionId, actor, toolName, inputKeyOf(event.tool_input));

    this.pendingPermissions.set(requestId, {
      sessionId, toolName, actor,
      toolInput: this._formatToolInput(toolName, event.tool_input),
      display: buildDisplay(toolName, rawInput || event.tool_input, session ? session.cwd : event.cwd),
      rawInput,
      questions,
      sessionRule: isAskUser ? null : pickSessionRule(event.permission_suggestions),
      promptId: event.prompt_id || null,
      binding,
      timestamp: Date.now(),
      respond: respond || (() => false)
    });

    // Transcript records only cover the main conversation unless the event names the subagent's own file.
    if (binding.state === 'confirmed' && event._source === 'claude') {
      const transcriptPath = actor === 'main' ? event.transcript_path : event.agent_transcript_path;
      if (transcriptPath) this._transcripts.watch(requestId, transcriptPath, binding.toolUseId);
    }

    debugLog('perm', `received id=${requestId} sid=${sessionId} tool=${toolName} actor=${actor === 'main' ? 'main' : 'sub'} binding=${binding.state} req=${event.bridge_request_id || '-'}`);
    this._refreshWaitingStatus(sessionId);
    this.emit('state-changed');
  }

  _onNotification(sessionId, event, respond) {
    const question = event.message || event.notification || event.content || event.question || '';
    // Claude's Notification hook only carries idle pings; real questions arrive as AskUserQuestion permissions.
    if (event._source === 'claude') {
      if (respond) respond('{}');
      this._onClaudeNotification(sessionId, event, question);
      return;
    }
    if (!question) {
      if (respond) respond(null);
      return;
    }
    const requestId = `q_${++this._requestCounter}`;
    this.pendingQuestions.set(requestId, {
      sessionId, question, timestamp: Date.now(),
      respond: respond || (() => false)
    });
    this._refreshWaitingStatus(sessionId);
    this.emit('state-changed');
  }

  // Claude notifications are informational; only "go to the terminal" kinds become inbox entries.
  _onClaudeNotification(sessionId, event, message) {
    const type = String(event.notification_type || '');
    const meta = this._metaOf(sessionId, this.sessions.get(sessionId));
    const actor = actorOf(event);
    let flagged = false;
    if (type === 'idle_prompt') {
      const s = this.sessions.get(sessionId);
      if (s) s.idlePromptAt = Date.now();
    } else if (type === 'permission_prompt') {
      // Fires when the terminal prompt waited ~6s; our own card already covers requests we hold.
      const held = Array.from(this.pendingPermissions.values()).some(p => p.sessionId === sessionId);
      if (!held) { this.attention.flag(sessionId, meta, 'input', type, message, actor); flagged = true; }
    } else if (NEEDS_INPUT_TYPES.has(type)) {
      this.attention.flag(sessionId, meta, 'input', type, message, actor);
      flagged = true;
    } else if (type === 'elicitation_complete' || type === 'elicitation_response') {
      if (this.attention.clearFlag(sessionId, 'input', actor)) this.emit('state-changed');
    }
    if (flagged) {
      this.emit('attention', { sessionId, kind: 'input', reason: type });
      this.emit('state-changed');
    }
  }

  _onStop(sessionId, event) {
    const session = this.sessions.get(sessionId);
    const hasText = typeof event.last_assistant_message === 'string';
    const text = hasText ? event.last_assistant_message.substring(0, MAX_REPLY) : undefined;
    if (session && hasText) {
      session.lastResponse = text;
      session.lastResponseAt = Date.now();
    }
    // background_tasks distinguishes "paused waiting for background work" from "done".
    const background = Array.isArray(event.background_tasks) ? event.background_tasks.length : 0;
    if (background > 0) {
      this._updateSessionStatus(sessionId, 'background', String(background));
      return;
    }
    this._updateSessionStatus(sessionId, 'idle');
    this._emitCompletion(sessionId, text);
  }

  _onStopFailure(sessionId, event) {
    const reason = String(event.error || 'error');
    const detail = [event.error_details, event.last_assistant_message, event.error_message].find(v => typeof v === 'string' && v) || '';
    this.attention.flag(sessionId, this._metaOf(sessionId, this.sessions.get(sessionId)), 'blocked', reason, detail, actorOf(event));
    this._updateSessionStatus(sessionId, 'blocked', reason);
    this.emit('attention', { sessionId, kind: 'blocked', reason });
  }

  _emitCompletion(sessionId, text) {
    // Merge duplicate Stop events within 1 second for the same session (e.g. cascading SubagentStop events).
    const now = Date.now();
    const last = this._lastCompletionTs.get(sessionId) || 0;
    if (now - last < 1000) return;
    this._lastCompletionTs.set(sessionId, now);

    const session = this.sessions.get(sessionId) || {};
    const scanned = (this.scannedSessions || []).find(s => s.id === sessionId) || {};
    const cwd = session.cwd || scanned.cwd || '';
    const reply = text !== undefined ? text : (session.lastResponse || '');
    // Always recorded: the cwd heuristic below may only silence the alert, never drop an independent reply.
    const record = this.attention.reply(sessionId, this._metaOf(sessionId, session), reply);
    this.emit('state-changed');

    // Codex in the same cwd as an active Claude session is usually Claude's /codex helper, so it stays quiet.
    const detectedAgent = session.agent || scanned.agent;
    if (detectedAgent === 'codex' && cwd && !record.alertNext) {
      const CLAUDE_ACTIVE_WINDOW_MS = 2 * 60 * 1000;
      for (const [, s] of this.sessions) {
        if (s.id !== sessionId && s.agent === 'claude' && s.cwd === cwd
            && s.lastActivity && (now - s.lastActivity) < CLAUDE_ACTIVE_WINDOW_MS) {
          debugLog('emit', `SUPPRESS codex completion (active Claude parent) sid=${sessionId}`);
          return;
        }
      }
    }
    const projectName = scanned.projectName || (cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() : '') || '';
    const started = this._turnStart.get(sessionId) || 0;
    this.emit('completion', {
      sessionId,
      projectName,
      sessionTitle: scanned.name || session.name || '',
      gitBranch: scanned.gitBranch || '',
      cwd,
      lastResponse: reply,
      version: record.version,
      turnMs: started ? now - started : null,
      agent: session.agent || scanned.agent || 'claude',
      timestamp: now
    });
  }

  _onSubagentStart(sessionId, event) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.subagentDepth = (session.subagentDepth || 0) + 1;
      if (!this._isWaiting(sessionId)) session.status = 'subagent';
      session.statusDetail = event.subagent_type || event.agent_type || 'agent';
    }
    this.emit('state-changed');
  }

  _onSubagentStop(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.subagentDepth = Math.max(0, (session.subagentDepth || 1) - 1);
      if (session.subagentDepth === 0) {
        if (!this._isWaiting(sessionId)) session.status = 'thinking';
        delete session.statusDetail;
      }
    }
    this.emit('state-changed');
  }

  _updateSessionStatus(sessionId, status, detail) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = status;
      if (detail) session.statusDetail = detail;
      else delete session.statusDetail;
      this._refreshWaitingStatus(sessionId, status);
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
    const now = Date.now();
    if (timeout > 0) {
      for (const [id, session] of this.sessions) {
        if (now - session.lastActivity <= timeout) continue;
        const hasPending = Array.from(this.pendingPermissions.values()).some(p => p.sessionId === id)
          || Array.from(this.pendingQuestions.values()).some(q => q.sessionId === id);
        if (hasPending) continue;
        this._dropSession(id);
      }
    }
    // Permission requests never expire by age; only disconnect, session end, process death or an outside answer settle them.
    for (const [id, q] of this.pendingQuestions) {
      if (q.timestamp && now - q.timestamp > QUESTION_TTL) {
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
        this._dropSession(id);
        removed++;
      }
    }
    if (removed > 0) this.emit('state-changed');
    return removed;
  }
}

module.exports = SessionManager;
module.exports.inputKeyOf = inputKeyOf;
module.exports.normalizeAnswers = normalizeAnswers;
module.exports.pickSessionRule = pickSessionRule;
module.exports.buildDisplay = buildDisplay;
