#!/usr/bin/env node
'use strict';

// CodePeek Bridge — multi-agent hook relay.
// Invoked by Claude Code / Codex hook mechanisms; forwards events over HTTP to the CodePeek main process.
// Usage: node bridge.js --source <claude|codex>
// stdin: agent-provided hook event JSON.
// stdout: response JSON for blocking events (only Claude's PermissionRequest / Notification).

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Parse the --source argument (defaults to 'claude' for backward compatibility with older deployments).
function parseSource() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--source') return String(args[i + 1] || '').toLowerCase();
  }
  return 'claude';
}
const SOURCE = parseSource();

const PORT = 31311;
const HOST = '127.0.0.1';
const NON_BLOCKING_TIMEOUT = 5000;
const BLOCKING_TIMEOUT = 86400000; // 24h
const TOKEN_PATH = path.join(os.homedir(), '.codepeek', 'token');

function readToken() {
  try { return fs.readFileSync(TOKEN_PATH, 'utf8').trim(); }
  catch { return ''; }
}

const BLOCKING_EVENTS = new Set([
  'PermissionRequest',
  'Notification'
]);

// Opt-out flag (honored by the user's environment)
if (process.env.CODEPEEK_SKIP === '1') {
  process.exit(0);
}

// Read stdin
let input = '';
const stdinTimeout = setTimeout(() => {
  process.exit(0);
}, NON_BLOCKING_TIMEOUT);

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);

  if (!input.trim()) {
    process.exit(0);
  }

  let event;
  try {
    event = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  // Validate session_id presence
  const sessionId = event.session_id;
  if (!sessionId) {
    process.exit(0);
  }

  // Inject bridge metadata
  event.bridge_version = '1.1.0';
  event.bridge_platform = 'windows';
  event.bridge_timestamp = new Date().toISOString();
  event.bridge_pid = process.pid;
  event._source = SOURCE; // 'claude' | 'codex'

  // Only Claude's PermissionRequest and Notification are blocking.
  // All 5 Codex events are non-blocking.
  const eventName = event.hook_event_name || event.event_name || event.event || '';
  const isBlocking = SOURCE === 'claude' && BLOCKING_EVENTS.has(eventName);

  const timeout = isBlocking ? BLOCKING_TIMEOUT : NON_BLOCKING_TIMEOUT;
  const body = JSON.stringify(event);

  const token = readToken();
  const req = http.request({
    hostname: HOST,
    port: PORT,
    path: '/hook',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'X-CodePeek-Token': token
    },
    timeout: timeout
  }, res => {
    let responseBody = '';
    res.on('data', d => { responseBody += d; });
    res.on('end', () => {
      if (responseBody && isBlocking) {
        process.stdout.write(responseBody);
      }
      process.exit(0);
    });
  });

  req.on('error', () => {
    // Swallow errors silently so the host CLI is never blocked.
    process.exit(0);
  });

  req.on('timeout', () => {
    req.destroy();
    process.exit(0);
  });

  req.write(body);
  req.end();
});

process.stdin.on('error', () => {
  process.exit(0);
});
