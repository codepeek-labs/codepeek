'use strict';

// Tells the user's own Codex sessions apart from agent-run ones (Claude's codex plugin, `codex exec`, sub-agents).

const fs = require('fs');
const path = require('path');
const os = require('os');

const SESSIONS_DIR = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
const MAX_LINE = 1024 * 1024;
const CHUNK = 16384;
const DAY_MS = 86400000;
const CACHE_MAX = 1000;

const byFile = new Map(); // rollout path -> meta; the first line never changes once written

// session_meta embeds the full system prompt, so the line is read up to its newline, capped at 1 MB.
function readFirstLine(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const chunks = [];
    const tmp = Buffer.alloc(CHUNK);
    let total = 0;
    while (total < MAX_LINE) {
      const n = fs.readSync(fd, tmp, 0, CHUNK, total);
      if (n === 0) break;
      const nl = tmp.subarray(0, n).indexOf(0x0a);
      chunks.push(Buffer.from(tmp.subarray(0, nl >= 0 ? nl : n)));
      total += n;
      if (nl >= 0) break;
    }
    return Buffer.concat(chunks).toString('utf8').trim();
  } finally {
    fs.closeSync(fd);
  }
}

// TUI, IDE and desktop sessions are the user's; exec/MCP runs, spawned threads and Claude-driven ones are not.
function isHelper(p) {
  const src = p.source;
  if (src && typeof src === 'object' && src.subagent) return true;
  if (src === 'exec' || src === 'mcp') return true;
  return /claude/i.test(String(p.originator || ''));
}

function readSessionMeta(file) {
  if (byFile.has(file)) return byFile.get(file);
  let meta = null;
  try {
    const obj = JSON.parse(readFirstLine(file));
    if (obj && obj.type === 'session_meta' && obj.payload) {
      const p = obj.payload;
      meta = {
        id: p.id || '',
        cwd: p.cwd || '',
        startedAt: p.timestamp ? Date.parse(p.timestamp) : 0,
        model: p.model || p.model_provider || '',
        originator: String(p.originator || ''),
        helper: isHelper(p)
      };
    }
  } catch {}
  if (meta) {
    if (byFile.size >= CACHE_MAX) byFile.delete(byFile.keys().next().value);
    byFile.set(file, meta);
  }
  return meta;
}

// Rollouts sit in <root>/YYYY/MM/DD by local creation date, named rollout-<time>-<id>.jsonl; a v7 id encodes that time.
function findRollout(id, root = SESSIONS_DIR) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || ''))) return null;
  const ms = parseInt(id.replace(/-/g, '').slice(0, 12), 16);
  if (!(ms > Date.UTC(2020, 0, 1) && ms < Date.now() + DAY_MS)) return null;
  const suffix = `-${id}.jsonl`;
  for (const off of [0, -DAY_MS, DAY_MS]) {
    const d = new Date(ms + off);
    const dir = path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    try {
      const f = fs.readdirSync(dir).find(n => n.endsWith(suffix));
      if (f) return path.join(dir, f);
    } catch {}
  }
  return null;
}

// Null until the session's own rollout exists. Sub-agent events carry the root id, so other threads' files are skipped.
function lookup(sessionId, transcriptPath, root = SESSIONS_DIR) {
  if (!sessionId) return null;
  if (typeof transcriptPath === 'string' && transcriptPath.endsWith('.jsonl')) {
    const meta = readSessionMeta(transcriptPath);
    if (meta && meta.id === sessionId) return meta;
  }
  const file = findRollout(sessionId, root);
  const meta = file ? readSessionMeta(file) : null;
  return meta && meta.id === sessionId ? meta : null;
}

module.exports = { lookup, readSessionMeta, findRollout, isHelper, SESSIONS_DIR };
