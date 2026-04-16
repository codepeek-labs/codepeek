'use strict';

// Launch a new terminal and resume a previous session.
// Used when the user clicks a stale session card in the island.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Detect an available terminal in priority order.
function detectTerminal() {
  const candidates = [
    {
      type: 'wt',
      path: path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WindowsApps', 'wt.exe')
    },
    {
      type: 'wt', // may also be on PATH
      path: 'wt.exe'
    }
  ];
  for (const c of candidates) {
    if (c.path === 'wt.exe') {
      // Probe with the `where` command
      try {
        require('child_process').execSync('where wt.exe', { stdio: 'ignore', timeout: 2000 });
        return { type: 'wt', exe: 'wt.exe' };
      } catch {}
      continue;
    }
    try { fs.accessSync(c.path); return { type: 'wt', exe: c.path }; } catch {}
  }
  // Fallback: plain cmd.exe
  return { type: 'cmd', exe: 'cmd.exe' };
}

// Normalize cwd (handles mixed Windows drive letters and forward slashes).
function normalizeCwd(cwd) {
  if (!cwd) return os.homedir();
  try {
    const resolved = path.resolve(cwd);
    if (fs.existsSync(resolved)) return resolved;
  } catch {}
  return os.homedir();
}

// Allow only safe characters to prevent shell injection.
function sanitizeSessionId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9\-_]/g, '').substring(0, 100);
}

function launchSession({ sessionId, cwd, agent }) {
  const cleanId = sanitizeSessionId(sessionId);
  if (!cleanId) return { success: false, error: 'Invalid session ID' };

  const workDir = normalizeCwd(cwd);
  const term = detectTerminal();
  // Pick the resume command for the target agent.
  let cliCmd, resumeArgs;
  if (agent === 'codex') {
    cliCmd = 'codex';
    resumeArgs = ['resume', cleanId];
  } else {
    cliCmd = 'claude';
    resumeArgs = ['--resume', cleanId];
  }

  try {
    if (term.type === 'wt') {
      // Windows Terminal: prefer adding a tab to the most recently used window; if no WT window
      // exists, a new one is created automatically.
      // Args: -w last new-tab -d <cwd> --title <title> cmd /k claude --resume <id>
      const titlePrefix = agent === 'codex' ? 'Codex' : 'Claude';
      const child = spawn(term.exe, [
        '-w', 'last',
        'new-tab',
        '-d', workDir,
        '--title', `${titlePrefix} · ${cleanId.substring(0, 8)}`,
        'cmd.exe', '/k', cliCmd, ...resumeArgs
      ], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      });
      child.unref();
      return { success: true, terminal: 'wt' };
    } else {
      // cmd.exe fallback: open a new window via `start`.
      // Note: the first quoted argument to `start` is treated as the window title, so we pass an empty "".
      const child = spawn('cmd.exe', [
        '/c', 'start', '""',
        '/D', workDir,
        'cmd.exe', '/k', cliCmd, ...resumeArgs
      ], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      });
      child.unref();
      return { success: true, terminal: 'cmd' };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { launchSession, detectTerminal };
