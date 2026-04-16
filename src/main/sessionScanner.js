'use strict';

// Session scanner — actively scans local Claude Code session data.
// Reads ~/.claude/sessions/*.json for session metadata, and the conversation JSONL for
// the last prompt / response pair.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const config = require('./config');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

// Codex CLI data directory (@openai/codex)
const CODEX_DIR = path.join(os.homedir(), '.codex');
const CODEX_SESSIONS_DIR = path.join(CODEX_DIR, 'sessions');
// Only surface codex sessions touched in the last 12h, up to N of them, to avoid flooding the UI with old history.
const CODEX_RECENT_WINDOW_MS = 12 * 60 * 60 * 1000;
const CODEX_MAX_SESSIONS = 10;
// Treat a codex session as active if codex.exe is running AND the jsonl mtime is within 5 minutes.
const CODEX_ACTIVE_WINDOW_MS = 5 * 60 * 1000;

// Scan every 1s so the UI tracks session changes in near real time.
const SCAN_INTERVAL = 1000;
// Scanning recently-closed sessions is expensive; once every 30s is enough.
const HISTORY_SCAN_INTERVAL = 30000;
// Max number of recently-closed sessions to surface
const RECENT_CLOSED_LIMIT = 5;


class SessionScanner {
  constructor() {
    this._timer = null;
    this._onUpdate = null;
    this._conversationCache = new Map();

    // Process table: PID -> { name, parentPid, createdAt(ms) }
    this._procMap = new Map();
    this._procTableRefreshing = false;
    this._procTableLastRefresh = 0;
    // Cache for recently-closed sessions
    this._historyCache = [];
    this._historyLastScan = 0;
    this._refreshProcTable();
  }

  start(onUpdate) {
    this._onUpdate = onUpdate;
    // Scan once immediately. If procMap hasn't loaded yet, we optimistically mark sessions as active so the list isn't empty on first render.
    this._scan();
    this._timer = setInterval(() => this._scan(), SCAN_INTERVAL);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  // Force an immediate scan. Called when the panel expands to ensure fresh data.
  refreshNow() {
    this._scan();
  }

  _scan() {
    try {
      if (Date.now() - this._procTableLastRefresh > 3000) {
        this._refreshProcTable();
      }
      const sessions = this._readSessions();
      const enriched = sessions.map(s => this._enrichSession(s));

      // Merge recently-closed sessions in. Disk is rescanned every 30s; the result is cached in between.
      const activeIds = new Set(enriched.filter(s => s.isRunning !== false).map(s => s.id));
      if (Date.now() - this._historyLastScan > HISTORY_SCAN_INTERVAL || this._historyCache.length === 0) {
        this._historyLastScan = Date.now();
        this._historyCache = this._scanRecentClosedSessions(activeIds, RECENT_CLOSED_LIMIT * 3);
      }
      const enrichedIds = new Set(enriched.map(s => s.id));
      const recentClosed = this._historyCache
        .filter(s => !enrichedIds.has(s.id) && !activeIds.has(s.id))
        .slice(0, RECENT_CLOSED_LIMIT)
        .map(s => ({ ...s, timeAgo: this._formatTimeAgo(s.lastActivityAt) }));

      // Codex sessions (scanned independently; never mixed with Claude).
      const codexSessions = this._scanCodexSessions();

      if (this._onUpdate) this._onUpdate([...enriched, ...recentClosed, ...codexSessions]);
    } catch {}
  }

  // Scan ~/.codex/sessions/<Y>/<M>/<D>/rollout-*.jsonl, sort by mtime desc, take the top N.
  // A session is active iff codex.exe is running AND its jsonl mtime is within 5 minutes.
  _scanCodexSessions() {
    if (!fs.existsSync(CODEX_SESSIONS_DIR)) return [];

    const cutoff = Date.now() - CODEX_RECENT_WINDOW_MS;
    const files = [];

    // Only descend into today's and yesterday's date folders; don't walk the entire history.
    const now = new Date();
    const candidates = [now, new Date(now.getTime() - 86400000)];
    for (const d of candidates) {
      const yyyy = d.getFullYear().toString();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const dayDir = path.join(CODEX_SESSIONS_DIR, yyyy, mm, dd);
      if (!fs.existsSync(dayDir)) continue;
      try {
        for (const f of fs.readdirSync(dayDir)) {
          if (!f.endsWith('.jsonl')) continue;
          const fp = path.join(dayDir, f);
          try {
            const st = fs.statSync(fp);
            if (st.mtimeMs >= cutoff) files.push({ path: fp, mtime: st.mtimeMs });
          } catch {}
        }
      } catch {}
    }

    files.sort((a, b) => b.mtime - a.mtime);
    const top = files.slice(0, CODEX_MAX_SESSIONS);

    // Any codex.exe in the process table is treated as "at least one session may be active".
    let hasCodexProc = false;
    for (const [, info] of this._procMap) {
      if (/^codex(\.exe)?$/i.test(info.name || '')) { hasCodexProc = true; break; }
    }

    const sessions = [];
    for (const f of top) {
      const meta = this._readCodexSessionMeta(f.path);
      if (!meta || !meta.id) continue;
      const isFresh = (Date.now() - f.mtime) <= CODEX_ACTIVE_WINDOW_MS;
      const isRunning = hasCodexProc && isFresh;
      const cwd = meta.cwd || '';
      const projectName = this._getProjectName(cwd);
      sessions.push({
        id: meta.id,
        pid: 0, // codex.exe has no reliable PID<->session mapping, so jump-to-tab is disabled for now.
        name: meta.title || projectName || meta.id.substring(0, 8),
        cwd,
        projectName,
        startedAt: meta.startedAt || f.mtime,
        lastActivityAt: f.mtime,
        timeAgo: this._formatTimeAgo(f.mtime),
        isRunning,
        status: isRunning ? 'active' : 'stale',
        model: meta.model || '',
        lastPrompt: '',
        lastResponse: '',
        agent: 'codex',
        source: 'scanner-codex'
      });
    }
    return sessions;
  }

  _readCodexSessionMeta(jsonlPath) {
    // The first line of codex session_meta includes the full system prompt (>15KB),
    // so a fixed 8KB read would truncate the JSON. Read in chunks until the first newline;
    // cap total bytes at 1MB so a malformed file cannot blow up memory.
    try {
      const fd = fs.openSync(jsonlPath, 'r');
      try {
        const CHUNK = 16384;
        const MAX = 1024 * 1024;
        const chunks = [];
        let total = 0;
        let nlOffset = -1;
        const tmp = Buffer.alloc(CHUNK);
        while (total < MAX) {
          const n = fs.readSync(fd, tmp, 0, CHUNK, total);
          if (n === 0) break;
          chunks.push(Buffer.from(tmp.slice(0, n)));
          for (let i = 0; i < n; i++) {
            if (tmp[i] === 0x0a) { nlOffset = total + i; break; }
          }
          total += n;
          if (nlOffset >= 0) break;
        }
        const all = Buffer.concat(chunks);
        const firstLine = (nlOffset >= 0 ? all.slice(0, nlOffset) : all).toString('utf8').trim();
        if (!firstLine) return null;
        const obj = JSON.parse(firstLine);
        if (obj.type !== 'session_meta' || !obj.payload) return null;
        const p = obj.payload;
        return {
          id: p.id || '',
          cwd: p.cwd || '',
          startedAt: p.timestamp ? Date.parse(p.timestamp) : 0,
          model: p.model || p.model_provider || '',
          title: ''
        };
      } finally {
        fs.closeSync(fd);
      }
    } catch { return null; }
  }

  // Walk ~/.claude/projects/<dir>/*.jsonl, sort by mtime desc, and take the top N that aren't already active.
  _scanRecentClosedSessions(activeIds, limit) {
    if (!fs.existsSync(PROJECTS_DIR)) return [];
    const files = [];
    let projDirs;
    try { projDirs = fs.readdirSync(PROJECTS_DIR); } catch { return []; }
    for (const projDir of projDirs) {
      const projPath = path.join(PROJECTS_DIR, projDir);
      let entries;
      try {
        if (!fs.statSync(projPath).isDirectory()) continue;
        entries = fs.readdirSync(projPath);
      } catch { continue; }
      for (const f of entries) {
        if (!f.endsWith('.jsonl')) continue;
        const sessionId = f.slice(0, -6);
        if (activeIds.has(sessionId)) continue;
        const fp = path.join(projPath, f);
        try {
          const st = fs.statSync(fp);
          files.push({ path: fp, sessionId, projDir, mtime: st.mtimeMs });
        } catch {}
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    return files.slice(0, limit).map(f => this._enrichClosedSession(f)).filter(Boolean);
  }

  _enrichClosedSession({ path: jsonlPath, sessionId, projDir, mtime }) {
    let cwd = '';
    let model = '';
    let lastPrompt = '';
    let lastResponse = '';
    let customTitle = '';
    let aiTitle = '';
    try {
      const { headLines, tailLines } = this._readHeadTailLines(jsonlPath, 65536);
      // Look for cwd near the head; the first record usually carries it.
      for (const line of headLines) {
        try {
          const obj = JSON.parse(line);
          if (obj.cwd && !cwd) { cwd = obj.cwd; }
          if (obj.type === 'custom-title' && obj.customTitle) customTitle = String(obj.customTitle).trim();
          if (obj.type === 'ai-title' && obj.aiTitle) aiTitle = String(obj.aiTitle).trim();
          if (cwd && (customTitle || aiTitle)) break;
        } catch {}
      }
      // Scan the tail for the latest prompt/response, model id, and any fallback title.
      for (let i = tailLines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(tailLines[i]);
          if (entry.cwd && !cwd) cwd = entry.cwd;
          if (entry.type === 'custom-title' && entry.customTitle) customTitle = customTitle || String(entry.customTitle).trim();
          if (entry.type === 'ai-title' && entry.aiTitle) aiTitle = aiTitle || String(entry.aiTitle).trim();
          const msg = entry.message;
          if (msg) {
            if (msg.role === 'assistant' && !lastResponse) {
              model = msg.model || model;
              lastResponse = this._extractTextContent(msg.content);
            }
            if (msg.role === 'user' && !lastPrompt) {
              lastPrompt = this._extractTextContent(msg.content);
            }
          }
          if (lastPrompt && lastResponse && cwd) break;
        } catch {}
      }
    } catch {}

    if (!cwd) cwd = this._projectDirToCwd(projDir);
    const projectName = this._getProjectName(cwd) || projDir;
    const name = customTitle || aiTitle || projectName || sessionId.substring(0, 8);

    return {
      id: sessionId,
      pid: 0,
      name,
      cwd,
      projectName,
      startedAt: mtime,
      lastActivityAt: mtime,
      timeAgo: this._formatTimeAgo(mtime),
      isRunning: false,
      status: 'stale',
      model,
      lastPrompt,
      lastResponse,
      source: 'history'
    };
  }

  // Best-effort inverse of Claude's project-dir encoding: "D-myProject-codeIsland" -> "D:\myProject\codeIsland".
  // Not 100% reversible (dashes in the original path are ambiguous), but launchSession falls back to $HOME
  // if the recovered cwd doesn't exist, so errors are harmless.
  _projectDirToCwd(projDir) {
    if (!projDir) return '';
    let s = String(projDir);
    // A leading "D-" / "C-" encodes a drive letter.
    s = s.replace(/^([A-Za-z])-/, '$1:\\');
    // The remaining dashes become path separators.
    if (s.includes(':')) {
      const idx = s.indexOf(':') + 2; // skip past "D:\"
      s = s.substring(0, idx) + s.substring(idx).replace(/-/g, '\\');
    } else {
      s = '\\' + s.replace(/-/g, '\\');
    }
    return s;
  }

  // Pull the full process list once via PowerShell: PID; ParentPID; Name; CreatedAt(ms since epoch).
  _refreshProcTable() {
    if (this._procTableRefreshing) return;
    this._procTableRefreshing = true;
    this._procTableLastRefresh = Date.now();

    const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
$procs = Get-CimInstance Win32_Process
foreach ($p in $procs) {
  $pid2 = [int]$p.ProcessId
  $par = [int]$p.ParentProcessId
  $name = "$($p.Name)"
  $ct = 0
  try {
    if ($p.CreationDate -ne $null) {
      $ct = [long](([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds())
    }
  } catch {}
  Write-Output "$pid2;$par;$name;$ct"
}
`;
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript
    ], { windowsHide: true, timeout: 8000 });

    let buf = '';
    ps.stdout.on('data', d => { buf += d.toString(); });
    ps.stderr.on('data', () => {});
    ps.on('close', () => {
      this._procTableRefreshing = false;
      const next = new Map();
      for (const line of buf.split('\n')) {
        const parts = line.trim().split(';');
        if (parts.length >= 4) {
          const pid = parseInt(parts[0]);
          if (!pid) continue;
          next.set(pid, {
            name: parts[2] || '',
            parentPid: parseInt(parts[1]) || 0,
            createdAt: parseInt(parts[3]) || 0
          });
        }
      }
      if (next.size > 0) this._procMap = next;
    });
    ps.on('error', () => { this._procTableRefreshing = false; });
  }

  // Liveness detection with orphan-process guard.
  // An active session must satisfy, in order:
  //   1) its node.exe is present and its create-time matches session.startedAt (PID reuse guard)
  //   2) the parent shell is still alive and not itself a reused PID (on Windows, closing the terminal means
  //      the shell exits, turning the node process into an orphan)
  //   3) any failure -> stale.
  _isSessionActive(session) {
    const pid = session.pid;
    if (!pid || pid <= 0) return null;
    if (this._procMap.size === 0) return null; // process table not loaded yet

    const node = this._procMap.get(pid);
    if (!node) return false;                            // node process has exited
    if (!/^node(\.exe)?$/i.test(node.name)) return false; // PID was recycled into another program

    // Second PID-reuse guard: the node process must have started close to session.startedAt.
    // Claude CLI writes session.json immediately before forking node, so the delta is tiny.
    if (node.createdAt > 0 && session.startedAt > 0) {
      const drift = Math.abs(node.createdAt - session.startedAt);
      if (drift > 5 * 60 * 1000) return false; // >5 min drift -> almost certainly a reused PID
    }

    // Parent (shell) liveness check
    const parentPid = node.parentPid;
    if (parentPid <= 0 || parentPid === pid) return false;
    const parent = this._procMap.get(parentPid);
    if (!parent) return false;                           // parent gone = terminal was closed
    if (parent.createdAt > 0 && node.createdAt > 0 &&
        parent.createdAt > node.createdAt) {
      return false;                                      // parent started after the child -> PID reused
    }
    return true;
  }

  // Source of truth: Claude CLI's own ~/.claude/sessions/{pid}.json files (effectively its live process list).
  // Only live sessions are surfaced; historical ones are handled separately.
  _readSessions() {
    const sessions = [];
    if (!fs.existsSync(SESSIONS_DIR)) return sessions;

    try {
      const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
          if (data.sessionId && data.pid) sessions.push(data);
        } catch {}
      }
    } catch {}
    return sessions;
  }

  // Fallback: just check whether the PID is alive, without consulting the process table.
  _isProcessRunning(pid) {
    if (!pid || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch (err) { return err.code === 'EPERM'; }
  }

  _enrichSession(session) {
    const projectName = this._getProjectName(session.cwd);
    const lastConversation = this._getLastConversation(session);

    // Activity is determined purely by process liveness (is the terminal still open?).
    // We deliberately do NOT fall back to jsonl silence, which would misclassify active-but-quiet sessions as stale.
    const alive = this._isSessionActive(session);
    // Optimistically assume active while the process table hasn't loaded yet; this self-corrects within 1s.
    const isRunning = (alive === null) ? true : alive;

    const jsonlMtime = lastConversation.mtime || 0;
    const activityTs = jsonlMtime || session.startedAt || 0;

    // Title priority: session.json name > custom-title (jsonl) > ai-title (jsonl) > project name.
    const name = session.name
      || lastConversation.customTitle
      || lastConversation.aiTitle
      || projectName
      || session.sessionId?.substring(0, 8)
      || '';

    return {
      id: session.sessionId,
      pid: session.pid,
      name,
      cwd: session.cwd || '',
      projectName,
      startedAt: session.startedAt,
      lastActivityAt: jsonlMtime,
      timeAgo: this._formatTimeAgo(activityTs),
      isRunning,
      status: isRunning ? 'active' : 'stale',
      model: lastConversation.model || '',
      lastPrompt: lastConversation.lastPrompt || '',
      lastResponse: lastConversation.lastResponse || '',
      source: 'scanner'
    };
  }

  _getProjectName(cwd) {
    if (!cwd) return '';
    return cwd.split(/[/\\]/).filter(Boolean).pop() || '';
  }

  _getLastConversation(session) {
    const result = {
      model: '', lastPrompt: '', lastResponse: '',
      customTitle: '', aiTitle: '',  // two title flavors read directly from the jsonl
      mtime: 0
    };

    try {
      const jsonlPath = this._findConversationFile(session);
      if (!jsonlPath || !fs.existsSync(jsonlPath)) return result;

      const stat = fs.statSync(jsonlPath);
      result.mtime = stat.mtimeMs;

      const cacheKey = jsonlPath;
      const cached = this._conversationCache.get(cacheKey);
      if (cached && cached.mtime === stat.mtimeMs) {
        return { ...cached.data, mtime: stat.mtimeMs };
      }

      // Titles can appear anywhere in the file, so read both the head and tail (64KB each).
      const { headLines, tailLines } = this._readHeadTailLines(jsonlPath, 65536);

      // Scan the tail first for the latest conversation content (lastPrompt / lastResponse).
      for (let i = tailLines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(tailLines[i]);
          const msg = entry.message;
          if (!msg) continue;
          if (msg.role === 'assistant' && !result.lastResponse) {
            result.model = msg.model || '';
            result.lastResponse = this._extractTextContent(msg.content);
          }
          if (msg.role === 'user' && !result.lastPrompt) {
            result.lastPrompt = this._extractTextContent(msg.content);
          }
          if (result.lastPrompt && result.lastResponse) break;
        } catch {}
      }

      // Then scan tail and head for custom-title / ai-title; keep the most recent one.
      const scanTitles = (lines) => {
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            const t = obj.type;
            if (t === 'custom-title' && obj.customTitle) {
              result.customTitle = String(obj.customTitle).trim();
            } else if (t === 'ai-title' && obj.aiTitle) {
              result.aiTitle = String(obj.aiTitle).trim();
            }
          } catch {}
        }
      };
      scanTitles(tailLines);
      if (!result.customTitle) scanTitles(headLines);

      this._conversationCache.set(cacheKey, {
        mtime: stat.mtimeMs,
        data: {
          model: result.model,
          lastPrompt: result.lastPrompt,
          lastResponse: result.lastResponse,
          customTitle: result.customTitle,
          aiTitle: result.aiTitle
        }
      });
    } catch {}

    return result;
  }

  // Read the first readSize bytes + the last readSize bytes and return both as arrays of lines.
  _readHeadTailLines(filePath, readSize) {
    const result = { headLines: [], tailLines: [] };
    try {
      const fd = fs.openSync(filePath, 'r');
      try {
        const stat = fs.fstatSync(fd);
        const fileSize = stat.size;
        const actualReadSize = Math.min(readSize, fileSize);

        const head = Buffer.alloc(actualReadSize);
        fs.readSync(fd, head, 0, actualReadSize, 0);
        result.headLines = head.toString('utf8').split('\n').filter(l => l.trim());

        if (fileSize > actualReadSize) {
          const tail = Buffer.alloc(actualReadSize);
          fs.readSync(fd, tail, 0, actualReadSize, fileSize - actualReadSize);
          result.tailLines = tail.toString('utf8').split('\n').filter(l => l.trim());
        } else {
          result.tailLines = result.headLines;
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {}
    return result;
  }

  _findConversationFile(session) {
    if (!fs.existsSync(PROJECTS_DIR)) return null;

    // Convert cwd to Claude's project-dir name (Claude replaces path separators with '-').
    const cwdNormalized = (session.cwd || '')
      .replace(/^([A-Z]):/, '$1-')  // D: -> D-
      .replace(/[/\\]/g, '-')        // path separators -> '-'
      .replace(/^-+/, '')            // strip leading dashes
      .replace(/-+$/, '');           // strip trailing dashes

    // Try an exact match first.
    const exactDir = path.join(PROJECTS_DIR, cwdNormalized);
    const jsonl = path.join(exactDir, `${session.sessionId}.jsonl`);
    if (fs.existsSync(jsonl)) return jsonl;

    // Otherwise iterate every project directory.
    try {
      const dirs = fs.readdirSync(PROJECTS_DIR);
      for (const dir of dirs) {
        const candidate = path.join(PROJECTS_DIR, dir, `${session.sessionId}.jsonl`);
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {}

    return null;
  }

  _readLastLines(filePath, n) {
    try {
      const stat = fs.statSync(filePath);
      const bufSize = Math.min(stat.size, 50000); // at most 50 KB
      const buf = Buffer.alloc(bufSize);
      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, buf, 0, bufSize, stat.size - bufSize);
      fs.closeSync(fd);

      const text = buf.toString('utf8');
      const lines = text.split('\n').filter(l => l.trim());
      return lines.slice(-n);
    } catch {
      return [];
    }
  }

  _extractTextContent(content) {
    if (!content) return '';
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          text = block.text;
          break;
        }
      }
    }
    return this._stripDirectives(text).substring(0, 200);
  }

  _stripDirectives(text) {
    if (!text) return '';
    let cleaned = text.replace(/<(system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-caveat|task-notification|antml:[a-z_]+)[^>]*>[\s\S]*?<\/\1>/gi, '');
    cleaned = cleaned.replace(/<\/?(system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-caveat|task-notification|antml:[a-z_]+)[^>]*>/gi, '');
    cleaned = cleaned.replace(/::[\w-]+\{[^}]*\}/g, '');
    return cleaned.trim();
  }

  _formatTimeAgo(timestamp) {
    if (!timestamp) return '';
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'now';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  }
}

module.exports = SessionScanner;
