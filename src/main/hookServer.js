'use strict';

// Hook HTTP server — accepts events forwarded by bridge.js.
// Hardened with: body size limit, token auth, pending-request cap, disconnect cleanup.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_BODY_BYTES = 1 * 1024 * 1024;        // 1 MB cap per request
const MAX_PENDING = 200;                        // global pending cap; new requests are rejected beyond this
const TOKEN_PATH = path.join(os.homedir(), '.codepeek', 'token');

function getOrCreateToken() {
  try {
    if (fs.existsSync(TOKEN_PATH)) {
      const t = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
      if (t && t.length >= 16) return t;
    }
    const dir = path.dirname(TOKEN_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const token = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(TOKEN_PATH, token, { encoding: 'utf8', mode: 0o600 });
    return token;
  } catch {
    return crypto.randomBytes(24).toString('hex');
  }
}

class HookServer {
  constructor(sessionManager, port = 31311) {
    this.sessionManager = sessionManager;
    this.port = port;
    this.server = null;
    this.token = getOrCreateToken();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/hook') {
          this._handleHook(req, res);
        } else if (req.method === 'GET' && req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', version: '1.0.0' }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      this.server.on('error', err => {
        if (err.code === 'EADDRINUSE') {
          console.error(`Port ${this.port} is already in use. Is another CodePeek instance running?`);
        }
        reject(err);
      });

      // Bind to localhost only; external machines cannot reach this socket.
      this.server.listen(this.port, '127.0.0.1', () => {
        console.log(`CodePeek hook server listening on 127.0.0.1:${this.port}`);
        resolve();
      });
    });
  }

  stop() {
    return new Promise(resolve => {
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }

  _validateToken(req) {
    const sent = req.headers['x-codepeek-token'];
    if (!sent || typeof sent !== 'string') return false;
    // Constant-time comparison to avoid timing attacks.
    try {
      const a = Buffer.from(sent);
      const b = Buffer.from(this.token);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch { return false; }
  }

  _handleHook(req, res) {
    // Auth: the request must carry the correct token.
    if (!this._validateToken(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    // Pending-count gate
    const totalPending =
      this.sessionManager.pendingPermissions.size + this.sessionManager.pendingQuestions.size;
    if (totalPending >= MAX_PENDING) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many pending requests' }));
      return;
    }

    const chunks = [];
    let bodyBytes = 0;
    let aborted = false;

    req.on('data', chunk => {
      if (aborted) return;
      // chunk is a Buffer, .length gives bytes. Accumulating bytes (not characters) prevents multi-byte chars from bypassing MAX_BODY_BYTES.
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_BODY_BYTES) {
        aborted = true;
        try {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload too large' }));
        } catch {}
        try { req.destroy(); } catch {}
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) return;

      const body = Buffer.concat(chunks).toString('utf8');
      let event;
      try {
        event = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const eventName = event.hook_event_name || event.event_name || event.event || '';
      const isBlocking = eventName === 'PermissionRequest' || eventName === 'Notification';

      if (isBlocking) {
        let settled = false;
        const respond = (response) => {
          if (settled) return;
          settled = true;
          try {
            if (!res.writableEnded) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(response || '{}');
            }
          } catch {}
        };

        this.sessionManager.handleEvent(event, respond);

        req.setTimeout(86400000);
        res.setTimeout(86400000);

        // bridge disconnected: clean up any pending so the UI isn't stuck waiting.
        const onDisconnect = () => {
          if (!settled) {
            settled = true;
            try { this.sessionManager.cancelPendingByRespond(respond); } catch {}
          }
        };
        req.on('close', onDisconnect);
        req.on('aborted', onDisconnect);
        res.on('close', onDisconnect);
      } else {
        this.sessionManager.handleEvent(event, null);
        try {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
        } catch {}
      }
    });

    req.on('error', () => { try { res.end(); } catch {} });
  }
}

module.exports = HookServer;
module.exports.getOrCreateToken = getOrCreateToken;
module.exports.TOKEN_PATH = TOKEN_PATH;
