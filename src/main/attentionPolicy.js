'use strict';

// Presence (away / DND / fullscreen), the watched session, and whether an ordinary completion may interrupt.

const { EventEmitter } = require('events');

const GLYPH_PREFIX = /^[^\p{L}\p{N}]+/u;
const SEEN_DWELL_MS = 1500;
const IDLE_POLL_MS = 5000;
const BACK_IDLE_S = 5;

// Claude Code prefixes the terminal title with a status glyph (e.g. "◑ name"); compare without it.
function cleanTitle(t) {
  return String(t || '').replace(GLYPH_PREFIX, '').trim().toLowerCase();
}

function isAncestor(procMap, ancestorPid, pid) {
  let cur = pid;
  let lastCreated = 0;
  for (let i = 0; i < 25 && cur; i++) {
    const info = procMap.get(cur);
    if (!info) return false;
    if (lastCreated && info.createdAt && info.createdAt > lastCreated) return false;
    lastCreated = info.createdAt || 0;
    if (info.parentPid === ancestorPid) return true;
    if (!info.parentPid || info.parentPid === cur) return false;
    cur = info.parentPid;
  }
  return false;
}

// "confirmed" = unique title match and the CLI runs under the foreground process; "likely" never clears unread.
function matchForegroundSession(fg, sessions, procMap) {
  if (!fg || !fg.title) return null;
  const title = cleanTitle(fg.title);
  if (!title) return null;
  const cands = (sessions || []).filter(s => s.isRunning !== false && s.name && cleanTitle(s.name) === title);
  if (cands.length !== 1) return null;
  const s = cands[0];
  const confirmed = !!(s.pid && fg.pid && procMap instanceof Map && isAncestor(procMap, fg.pid, s.pid));
  return { sessionId: s.id, confidence: confirmed ? 'confirmed' : 'likely' };
}

class AttentionPolicy extends EventEmitter {
  constructor({ config, getIdleSeconds } = {}) {
    super();
    this._config = config;
    this._getIdle = getIdleSeconds || (() => 0);
    this.away = false;
    this.awayReason = '';
    this.fullscreen = false;
    this.foreground = null; // { sessionId, confidence, since }
    this._ownForeground = false;
    this._quietSince = 0;
    this._seenTimer = null;
    this._dndTimer = null;
    this._idleTimer = null;
  }

  start() {
    this._idleTimer = setInterval(() => this.pollIdle(), IDLE_POLL_MS);
    if (this._idleTimer.unref) this._idleTimer.unref();
    this._armDnd();
    // A DND carried over from the last run still needs a summary when it ends.
    if (this._quietNow()) this._quietSince = (this.dndActive() && Number(this.cfg('dndSince', 0))) || Date.now();
  }

  _quietNow() { return this.away || this.dndActive() || this.fullscreen; }

  stop() {
    clearInterval(this._idleTimer);
    clearTimeout(this._dndTimer);
    clearTimeout(this._seenTimer);
  }

  cfg(key, fallback) {
    const v = this._config ? this._config.get(key) : undefined;
    return v === undefined || v === null ? fallback : v;
  }

  // dndUntil: 0 = off, -1 = until turned off, otherwise an epoch-ms deadline.
  dndActive() {
    const until = Number(this.cfg('dndUntil', 0)) || 0;
    return until === -1 || until > Date.now();
  }

  isQuiet() { return this.away || this.dndActive() || this.fullscreen; }

  focusState() {
    return {
      away: this.away,
      awayReason: this.awayReason,
      dnd: this.dndActive(),
      dndUntil: Number(this.cfg('dndUntil', 0)) || 0,
      fullscreen: this.fullscreen,
      suppress: this.isQuiet(),
      foregroundSessionId: this.foreground && this.foreground.confidence === 'confirmed' ? this.foreground.sessionId : null
    };
  }

  // An unattended terminal or CodePeek itself in front does not mean the user is reading that session.
  isLookingAt(sessionId) {
    return !!(!this.away && !this._ownForeground && this.foreground && this.foreground.confidence === 'confirmed'
      && this.foreground.sessionId === sessionId);
  }

  // For UserPromptSubmit: null when we cannot tell (helper not running), else whether the user is at that session.
  presenceAt(sessionId, watcherAlive) {
    if (!watcherAlive) return null;
    return !!(!this.away && this.foreground && this.foreground.sessionId === sessionId);
  }

  shouldExpandCompletion({ turnMs, looking, alertNext }) {
    if (this.isQuiet()) return false;
    if (alertNext) return true;
    const mode = this.cfg('suppressNotifications', false) ? 'quiet' : this.cfg('completionAlert', 'quiet');
    if (mode === 'always') return true;
    if (mode === 'smart') {
      const shortMs = Math.max(0, Number(this.cfg('shortTurnSeconds', 20)) || 0) * 1000;
      return !looking && (turnMs === null || turnMs === undefined || turnMs >= shortMs);
    }
    return false;
  }

  setForeground(fg, sessions, procMap, ownPids) {
    const wasQuiet = this._quietNow();
    const own = !!(fg && ownPids && ownPids.has(fg.pid));
    this._ownForeground = own;
    // Clicking the island itself must not count as leaving fullscreen or the watched terminal.
    if (!own) this.fullscreen = !!(fg && fg.fullscreen);
    const match = own ? this.foreground : matchForegroundSession(fg, sessions, procMap);
    const prev = this.foreground;
    const same = prev && match && prev.sessionId === match.sessionId && prev.confidence === match.confidence;
    if (!same) {
      this.foreground = match ? { ...match, since: Date.now() } : null;
      clearTimeout(this._seenTimer);
      if (match && match.confidence === 'confirmed') {
        const id = match.sessionId;
        this._seenTimer = setTimeout(() => {
          if (this.isLookingAt(id)) this.emit('seen', id);
        }, SEEN_DWELL_MS);
      }
    }
    const quietChanged = wasQuiet !== this._quietNow();
    if (quietChanged) this._quietEdge(wasQuiet);
    if (!same || quietChanged) this._changed('foreground');
  }

  pollIdle() {
    let idle = 0;
    try { idle = Number(this._getIdle()) || 0; } catch {}
    const limit = Math.max(30, Number(this.cfg('awayIdleSeconds', 120)) || 120);
    if (!this.away && idle >= limit) this.setAway(true, 'idle');
    else if (this.away && this.awayReason === 'idle' && idle < BACK_IDLE_S) this.setAway(false);
  }

  setAway(on, reason) {
    if (on === this.away && (!on || reason === this.awayReason)) return;
    const wasQuiet = this._quietNow();
    this.away = on;
    this.awayReason = on ? reason : '';
    if (on) clearTimeout(this._seenTimer);
    this._quietEdge(wasQuiet);
    this._changed('away');
  }

  setDnd(minutes) {
    const wasQuiet = this._quietNow();
    const wasDnd = this.dndActive();
    const until = minutes === -1 ? -1 : minutes > 0 ? Date.now() + minutes * 60000 : 0;
    if (this._config) {
      this._config.set('dndUntil', until);
      if (!until) this._config.set('dndSince', 0);
      else if (!wasDnd) this._config.set('dndSince', Date.now());
    }
    this._armDnd();
    this._quietEdge(wasQuiet);
    this._changed('dnd');
  }

  _armDnd() {
    clearTimeout(this._dndTimer);
    const until = Number(this.cfg('dndUntil', 0)) || 0;
    if (until > Date.now()) {
      this._dndTimer = setTimeout(() => {
        // By now the deadline has passed, so dndActive() already reads false; DND was on until this moment.
        const wasQuiet = true;
        if (this._config) { this._config.set('dndUntil', 0); this._config.set('dndSince', 0); }
        this._quietEdge(wasQuiet);
        this._changed('dnd');
      }, Math.min(until - Date.now(), 2147483000));
      if (this._dndTimer.unref) this._dndTimer.unref();
    } else if (until > 0 && this._config) {
      this._config.set('dndUntil', 0);
      this._config.set('dndSince', 0);
    }
  }

  // Away, DND and fullscreen form one quiet period; only when the last one ends is a summary due.
  _quietEdge(wasQuiet) {
    const nowQuiet = this._quietNow();
    if (!wasQuiet && nowQuiet) this._quietSince = Date.now();
    if (wasQuiet && !nowQuiet && this._quietSince) {
      const since = this._quietSince;
      this._quietSince = 0;
      this.emit('quiet-ended', { since });
    }
  }

  _changed(reason) {
    this.emit('change', { reason, ...this.focusState() });
  }
}

module.exports = AttentionPolicy;
module.exports.matchForegroundSession = matchForegroundSession;
module.exports.cleanTitle = cleanTitle;
