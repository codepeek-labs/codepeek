'use strict';

// Watches Claude transcripts for a tool_use id's tool_result, which a terminal answer writes even without a hook event.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');
const POLL_MS = 1000;
const LOOKBACK_BYTES = 64 * 1024;
const MAX_READ_PER_TICK = 1024 * 1024;
const MAX_PENDING_LINE = 4 * 1024 * 1024;
const REJECT_MARKER = 'User rejected tool use';

// Resolves symlinks/junctions before the containment check so a crafted path cannot escape the root.
function resolveTranscriptPath(p, root = PROJECTS_ROOT) {
  if (typeof p !== 'string' || !p.toLowerCase().endsWith('.jsonl')) return null;
  try {
    const real = fs.realpathSync.native(p);
    const realRoot = fs.realpathSync.native(root);
    const rel = path.relative(realRoot.toLowerCase(), real.toLowerCase());
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (!fs.statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

// Only real user records count: API request snapshots embed old tool ids and must not match.
function matchToolResult(line, toolUseId) {
  if (!line.includes(toolUseId) || !line.includes('"tool_result"')) return null;
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }
  if (!obj || obj.type !== 'user' || !obj.message || !Array.isArray(obj.message.content)) return null;
  const hit = obj.message.content.some(c => c && c.type === 'tool_result' && c.tool_use_id === toolUseId);
  if (!hit) return null;
  const tur = obj.toolUseResult;
  const rejected = tur === REJECT_MARKER || (typeof tur === 'string' && tur.startsWith(REJECT_MARKER));
  return { rejected };
}

class TranscriptWatcher {
  constructor(onResult, opts = {}) {
    this._onResult = onResult;
    this._root = opts.root || PROJECTS_ROOT;
    this._pollMs = opts.pollMs || POLL_MS;
    this._watches = new Map(); // key -> { file, toolUseId }
    this._files = new Map();   // realpath -> { offset, rest: Buffer, skipFirst }
    this._timer = null;
    this._busy = false;
  }

  watch(key, transcriptPath, toolUseId) {
    if (!toolUseId) return false;
    const file = resolveTranscriptPath(transcriptPath, this._root);
    if (!file) return false;
    if (!this._files.has(file)) {
      let st = null;
      try { st = fs.statSync(file); } catch {}
      const state = { offset: 0, rest: Buffer.alloc(0), skipFirst: false, id: '' };
      this._rewind(state, st);
      this._files.set(file, state);
    }
    this._watches.set(key, { file, toolUseId });
    if (!this._timer) {
      this._timer = setInterval(() => { this.tick(); }, this._pollMs);
      if (this._timer.unref) this._timer.unref();
    }
    return true;
  }

  unwatch(key) {
    const w = this._watches.get(key);
    if (!w) return;
    this._watches.delete(key);
    const stillUsed = Array.from(this._watches.values()).some(x => x.file === w.file);
    if (!stillUsed) this._files.delete(w.file);
    if (this._watches.size === 0 && this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  stop() {
    this._watches.clear();
    this._files.clear();
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  async tick() {
    if (this._busy) return;
    this._busy = true;
    try {
      for (const [file, state] of Array.from(this._files)) {
        const lines = await this._readNewLines(file, state);
        if (lines.length) this._dispatch(file, lines);
      }
    } finally {
      this._busy = false;
    }
  }

  // Starts reading near the tail; anything earlier predates the watch.
  _rewind(state, st) {
    const size = st ? st.size : 0;
    state.offset = Math.max(0, size - LOOKBACK_BYTES);
    state.rest = Buffer.alloc(0);
    state.skipFirst = state.offset > 0;
    state.id = st ? `${st.ino}:${st.birthtimeMs}` : '';
  }

  async _readNewLines(file, state) {
    let st;
    try { st = await fsp.stat(file); } catch { return []; }
    const size = st.size;
    // A replaced file (new identity) or a truncated one invalidates the old offset.
    if (`${st.ino}:${st.birthtimeMs}` !== state.id || size < state.offset) this._rewind(state, st);
    if (size === state.offset) return [];
    const len = Math.min(size - state.offset, MAX_READ_PER_TICK);
    let buf = Buffer.alloc(len);
    let fh;
    let bytesRead = 0;
    try {
      fh = await fsp.open(file, 'r');
      ({ bytesRead } = await fh.read(buf, 0, len, state.offset));
    } catch {
      return [];
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
    if (!this._files.has(file) || bytesRead <= 0) return [];
    buf = buf.subarray(0, bytesRead);
    state.offset += bytesRead;
    // Split on raw newline bytes so a multi-byte character cut by the read boundary stays intact.
    const chunk = state.rest.length ? Buffer.concat([state.rest, buf]) : buf;
    const lastNl = chunk.lastIndexOf(0x0A);
    if (lastNl < 0) {
      state.rest = chunk.length > MAX_PENDING_LINE ? Buffer.alloc(0) : chunk;
      if (chunk.length > MAX_PENDING_LINE) state.skipFirst = true;
      return [];
    }
    state.rest = chunk.subarray(lastNl + 1);
    const lines = chunk.subarray(0, lastNl).toString('utf8').split('\n');
    if (state.skipFirst) { lines.shift(); state.skipFirst = false; }
    return lines;
  }

  _dispatch(file, lines) {
    for (const [key, w] of Array.from(this._watches)) {
      if (w.file !== file) continue;
      for (const line of lines) {
        const m = matchToolResult(line, w.toolUseId);
        if (m) {
          try { this._onResult(key, w.toolUseId, m); } catch {}
          break;
        }
      }
    }
  }
}

module.exports = TranscriptWatcher;
module.exports.resolveTranscriptPath = resolveTranscriptPath;
module.exports.matchToolResult = matchToolResult;
module.exports.REJECT_MARKER = REJECT_MARKER;
