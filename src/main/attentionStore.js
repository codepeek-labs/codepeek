'use strict';

// Persisted per-session inbox (new reply / needs input / blocked); live requests are excluded, their callbacks die on restart.

const fs = require('fs');
const path = require('path');
const os = require('os');

const STORE_PATH = path.join(os.homedir(), '.codepeek', 'attention.json');
const KEEP_MS = 7 * 24 * 3600 * 1000;
const MAX_TEXT = 20000;
const SAVE_DEBOUNCE_MS = 500;
const MAX_RECORDS = 300;

class AttentionStore {
  constructor(opts = {}) {
    this._path = opts.path === undefined ? STORE_PATH : opts.path;
    this._records = new Map(); // sessionId -> record
    this._saveTimer = null;
    this._load();
  }

  _load() {
    if (!this._path) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this._path, 'utf8'));
      const now = Date.now();
      for (const r of (raw && raw.records) || []) {
        if (r && r.sessionId && (r.alertNext || now - (r.since || 0) < KEEP_MS)) this._records.set(r.sessionId, r);
      }
    } catch {}
  }

  _scheduleSave() {
    if (!this._path || this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flush();
    }, SAVE_DEBOUNCE_MS);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  // Expired records go, and the oldest read ones once the store grows large; alert-next flags are always kept.
  _prune() {
    const now = Date.now();
    for (const [id, r] of this._records) if (!r.alertNext && now - (r.since || 0) > KEEP_MS) this._records.delete(id);
    if (this._records.size <= MAX_RECORDS) return;
    const idle = Array.from(this._records.values())
      .filter(r => !r.alertNext && (!r.kind || (r.kind === 'reply' && r.seenVersion >= r.version)))
      .sort((a, b) => (a.since || 0) - (b.since || 0));
    for (const r of idle.slice(0, this._records.size - MAX_RECORDS)) this._records.delete(r.sessionId);
  }

  // Atomic write so a crash mid-save never leaves a truncated file.
  flush() {
    if (!this._path) return;
    this._prune();
    try {
      fs.mkdirSync(path.dirname(this._path), { recursive: true });
      const tmp = this._path + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, records: Array.from(this._records.values()) }), 'utf8');
      fs.renameSync(tmp, this._path);
    } catch {}
  }

  _record(sessionId, meta) {
    let r = this._records.get(sessionId);
    if (!r) {
      r = { sessionId, kind: null, version: 0, seenVersion: 0, since: 0, text: '', reason: '', alertNext: false };
      this._records.set(sessionId, r);
    }
    if (meta) {
      for (const k of ['agent', 'name', 'cwd', 'gitBranch']) if (meta[k]) r[k] = String(meta[k]).substring(0, 500);
    }
    return r;
  }

  // A finished turn becomes a new reply; `seen` marks it read at once (the user was already looking).
  reply(sessionId, meta, text, { seen = false } = {}) {
    const r = this._record(sessionId, meta);
    // A background agent still waiting on the user is parked, and returns once this reply has been read.
    if ((r.kind === 'input' || r.kind === 'blocked') && r.actor && r.actor !== 'main') {
      r.stash = { ...(r.stash || {}), [r.actor]: { kind: r.kind, reason: r.reason, text: r.text, since: r.since } };
    }
    r.kind = 'reply';
    r.version += 1;
    r.since = Date.now();
    r.text = typeof text === 'string' ? text.substring(0, MAX_TEXT) : '';
    r.reason = '';
    r.actor = 'main';
    if (seen) this._afterSeen(r);
    this._scheduleSave();
    return r;
  }

  _afterSeen(r) {
    r.seenVersion = r.version;
    this._restoreParked(r);
  }

  // Brings back the most recent parked flag, if any, as the record's current state.
  _restoreParked(r) {
    const rest = Object.keys(r.stash || {});
    if (!rest.length) return false;
    const who = rest[rest.length - 1];
    const prev = r.stash[who];
    delete r.stash[who];
    Object.assign(r, { kind: prev.kind, reason: prev.reason, text: prev.text, since: prev.since, actor: who });
    r.version += 1;
    return true;
  }

  // Needs-input and blocked records stay until the session moves on, regardless of "seen".
  flag(sessionId, meta, kind, reason, text, actor) {
    const r = this._record(sessionId, meta);
    const who = actor || '';
    // Another agent's open flag is set aside and comes back once this one is resolved.
    if ((r.kind === 'input' || r.kind === 'blocked') && (r.actor || '') !== who) {
      r.stash = { ...(r.stash || {}), [r.actor || '']: { kind: r.kind, reason: r.reason, text: r.text, since: r.since } };
    }
    if (r.stash) delete r.stash[who];
    r.kind = kind;
    r.version += 1;
    r.since = Date.now();
    r.reason = String(reason || '').substring(0, 120);
    r.text = typeof text === 'string' ? text.substring(0, MAX_TEXT) : '';
    r.actor = actor || '';
    this._scheduleSave();
    return r;
  }

  // The user answered in this session (new prompt): nothing is waiting any more.
  clear(sessionId) {
    const r = this._records.get(sessionId);
    if (!r || !r.kind) return false;
    r.kind = null;
    r.reason = '';
    delete r.stash;
    r.seenVersion = r.version;
    this._scheduleSave();
    return true;
  }

  // A flag raised by one agent is only cleared by that agent's own activity.
  clearFlag(sessionId, kind, actor) {
    const r = this._records.get(sessionId);
    if (!r) return false;
    const parked = actor !== undefined && r.stash && r.stash[actor];
    if (parked && parked.kind === kind && r.actor !== actor) {
      delete r.stash[actor];
      this._scheduleSave();
      return false;
    }
    if (r.kind !== kind) return false;
    if (actor !== undefined && r.actor && r.actor !== actor) return false;
    if (!this._restoreParked(r)) return this.clear(sessionId);
    this._scheduleSave();
    return true;
  }

  // Clears blocked / needs-input but keeps an unread reply.
  clearFlags(sessionId) {
    const r = this._records.get(sessionId);
    if (!r || (r.kind !== 'input' && r.kind !== 'blocked')) return false;
    return this.clear(sessionId);
  }

  // Only the version the user actually saw is marked, so an older click cannot hide a newer reply.
  markSeen(sessionId, version) {
    const r = this._records.get(sessionId);
    if (!r || r.kind !== 'reply') return false;
    const v = Number.isFinite(version) ? Math.min(version, r.version) : r.version;
    if (v <= r.seenVersion) return false;
    r.seenVersion = v;
    if (v === r.version) this._restoreParked(r);
    this._scheduleSave();
    return true;
  }

  setAlertNext(sessionId, on, meta) {
    const r = this._record(sessionId, meta);
    r.alertNext = !!on;
    this._scheduleSave();
    return r.alertNext;
  }

  consumeAlertNext(sessionId) {
    const r = this._records.get(sessionId);
    if (!r || !r.alertNext) return false;
    r.alertNext = false;
    this._scheduleSave();
    return true;
  }

  get(sessionId) { return this._records.get(sessionId) || null; }

  remove(sessionId) {
    if (this._records.delete(sessionId)) this._scheduleSave();
  }

  // Unseen replies plus every needs-input / blocked record, oldest first.
  list() {
    const now = Date.now();
    const out = [];
    for (const r of this._records.values()) {
      if (!r.kind || now - r.since > KEEP_MS) continue;
      if (r.kind === 'reply' && r.seenVersion >= r.version) continue;
      out.push({ ...r, unread: r.kind !== 'reply' || r.seenVersion < r.version });
    }
    return out.sort((a, b) => a.since - b.since);
  }

  alertNextIds() {
    return Array.from(this._records.values()).filter(r => r.alertNext).map(r => r.sessionId);
  }
}

module.exports = AttentionStore;
