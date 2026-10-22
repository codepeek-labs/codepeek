'use strict';

// Minimal RFC 6455 client: Electron 33's main process (Node 20) has no global WebSocket.
// Text messages only (binary is dropped); any protocol violation fails the connection instead of being patched up.

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 1024 * 1024;
const MAX_FRAGMENTS = 256;
const MAX_BUFFERED = 1024 * 1024;
const CLOSE_WAIT_MS = 2000;

const utf8 = new TextDecoder('utf-8', { fatal: true });

function encodeFrame(opcode, payload, mask) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '', 'utf8');
  const len = data.length;
  const head = [0x80 | opcode];
  const m = mask ? 0x80 : 0;
  if (len < 126) head.push(m | len);
  else if (len < 65536) head.push(m | 126, len >> 8, len & 0xff);
  else head.push(m | 127, 0, 0, 0, 0, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
  if (!mask) return Buffer.concat([Buffer.from(head), data]);
  const key = crypto.randomBytes(4);
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = data[i] ^ key[i & 3];
  return Buffer.concat([Buffer.from(head), key, out]);
}

// Incremental decoder: push() returns complete frames { fin, rsv, opcode, masked, payload } and keeps the remainder.
class FrameParser {
  constructor() { this.buf = Buffer.alloc(0); }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames = [];
    for (;;) {
      const b = this.buf;
      if (b.length < 2) break;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (b.length < 4) break; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (b.length < 10) break;
        if (b.readUInt32BE(2) !== 0) throw new Error('frame too large');
        len = b.readUInt32BE(6);
        off = 10;
      }
      if (len > MAX_MESSAGE) throw new Error('frame too large');
      const masked = (b[1] & 0x80) !== 0;
      const keyAt = off;
      if (masked) off += 4;
      if (b.length < off + len) break;
      let payload = b.subarray(off, off + len);
      if (masked) {
        const out = Buffer.alloc(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ b[keyAt + (i & 3)];
        payload = out;
      } else {
        payload = Buffer.from(payload);
      }
      frames.push({ fin: (b[0] & 0x80) !== 0, rsv: b[0] & 0x70, opcode: b[0] & 0x0f, masked, payload });
      this.buf = b.subarray(off + len);
    }
    return frames;
  }
}

function validCloseCode(c) {
  return (c >= 1000 && c <= 1003) || (c >= 1007 && c <= 1014) || (c >= 3000 && c <= 4999);
}

// States: connecting -> open -> closing -> closed; 'close' is emitted exactly once, after the socket is gone.
class WsClient extends EventEmitter {
  constructor(url, { headers = {}, timeoutMs = 10000 } = {}) {
    super();
    this.url = url;
    this.headers = headers;
    this.timeoutMs = timeoutMs;
    this.state = 'idle';
    this.socket = null;
    this._req = null;
    this._timer = null;
    this._parser = new FrameParser();
    this._frag = null; // { parts, size }
    this._closeCode = 1006;
    this._closeReason = '';
  }

  get open() { return this.state === 'open'; }

  connect() {
    if (this.state !== 'idle') return;
    this.state = 'connecting';
    let u;
    try { u = new URL(this.url); } catch (e) { process.nextTick(() => this._finish(1006, 'bad url')); return; }
    const secure = u.protocol === 'wss:';
    const key = crypto.randomBytes(16).toString('base64');
    this._timer = setTimeout(() => this._fail(1006, 'handshake timeout'), this.timeoutMs);
    const req = (secure ? https : http).request({
      host: u.hostname,
      port: u.port || (secure ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key, ...this.headers
      }
    });
    this._req = req;
    req.on('upgrade', (res, socket, head) => {
      this._req = null;
      if (this.state !== 'connecting') { socket.destroy(); return; }
      const expect = crypto.createHash('sha1').update(key + GUID).digest('base64');
      const okHeaders = res.statusCode === 101 && String(res.headers.upgrade || '').toLowerCase() === 'websocket'
        && /\bupgrade\b/i.test(String(res.headers.connection || '')) && res.headers['sec-websocket-accept'] === expect
        && !res.headers['sec-websocket-extensions'];
      this.socket = socket;
      socket.on('error', (e) => this.emit('error', e));
      socket.on('close', () => this._finish(this._closeCode, this._closeReason));
      if (!okHeaders) { this._fail(1002, 'bad handshake'); return; }
      clearTimeout(this._timer);
      this._timer = null;
      socket.setNoDelay(true);
      socket.on('data', (d) => this._onData(d));
      this.state = 'open';
      this._emitSafe('open');
      if (head && head.length) this._onData(head);
    });
    req.on('response', (res) => { res.resume(); this._fail(1006, `HTTP ${res.statusCode}`); });
    req.on('error', (e) => this._fail(1006, e.message));
    req.end();
  }

  // A throwing listener must not escape into the socket callback (an uncaught error in Electron's main process).
  _emitSafe(name, ...args) {
    try { this.emit(name, ...args); } catch (e) { console.error(`[ws] ${name} listener failed:`, e); }
  }

  _onData(chunk) {
    if (this.state !== 'open' && this.state !== 'closing') return;
    let frames;
    try { frames = this._parser.push(chunk); } catch { this._fail(1009, 'frame too large'); return; }
    for (const f of frames) {
      if (this.state === 'closed' || this._gotClose) return;
      if (!this._onFrame(f)) return;
    }
  }

  // Returns false once the connection must stop reading this batch.
  _onFrame({ fin, rsv, opcode, masked, payload }) {
    if (masked || rsv) return this._fail(1002, masked ? 'masked server frame' : 'reserved bits set');
    const control = opcode >= 0x8;
    if (control && (!fin || payload.length > 125)) return this._fail(1002, 'bad control frame');
    if (opcode === 0x8) {
      this._gotClose = true;
      if (payload.length === 1) return this._fail(1002, 'bad close payload');
      let code = 1005;
      let reason = '';
      if (payload.length >= 2) {
        code = payload.readUInt16BE(0);
        try { reason = utf8.decode(payload.subarray(2)); } catch { return this._fail(1007, 'bad close reason'); }
        if (!validCloseCode(code)) return this._fail(1002, 'bad close code');
      }
      this._closeCode = code;
      this._closeReason = reason;
      if (this.state === 'open') this._write(0x8, payload.subarray(0, 2));
      this.state = 'closing';
      this._armCloseTimer();
      if (this.socket) this.socket.end();
      return false;
    }
    if (opcode === 0x9) { if (this.state === 'open') this._write(0xA, payload); return true; }
    if (opcode === 0xA) { this._emitSafe('pong'); return true; }
    if (opcode === 0x1 || opcode === 0x2) {
      if (this._frag) return this._fail(1002, 'interleaved message');
      if (!fin) { this._frag = { opcode, parts: [payload], size: payload.length, count: 1 }; return true; }
      return this._deliver(opcode, payload);
    }
    if (opcode === 0x0) {
      if (!this._frag) return this._fail(1002, 'orphan continuation');
      const f = this._frag;
      f.size += payload.length;
      f.count += 1;
      if (f.size > MAX_MESSAGE || f.count > MAX_FRAGMENTS) return this._fail(1009, 'message too large');
      if (payload.length) f.parts.push(payload);
      if (!fin) return true;
      this._frag = null;
      return this._deliver(f.opcode, Buffer.concat(f.parts));
    }
    return this._fail(1002, 'reserved opcode');
  }

  _deliver(opcode, data) {
    if (opcode === 0x2 || this.state !== 'open') return true;
    let text;
    try { text = utf8.decode(data); } catch { return this._fail(1007, 'invalid utf-8'); }
    this._emitSafe('message', text);
    return this.state === 'open';
  }

  _write(opcode, payload) {
    const s = this.socket;
    if (!s || s.destroyed || !s.writable) return false;
    // A peer that stops reading must not make us buffer without bound.
    if (s.writableLength > MAX_BUFFERED) { this._fail(1008, 'send buffer full'); return false; }
    s.write(encodeFrame(opcode, payload, true));
    return true;
  }

  send(text) { return this.state === 'open' && this._write(0x1, Buffer.from(String(text), 'utf8')); }

  ping() { return this.state === 'open' && this._write(0x9, Buffer.alloc(0)); }

  close(code = 1000) {
    if (this.state === 'closing' || this.state === 'closed') return;
    if (this.state !== 'open') { this._fail(code, 'closed before open'); return; }
    this.state = 'closing';
    const b = Buffer.alloc(2);
    b.writeUInt16BE(code, 0);
    this._write(0x8, b);
    this._armCloseTimer();
  }

  _armCloseTimer() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.terminate(), CLOSE_WAIT_MS);
    if (this._timer.unref) this._timer.unref();
  }

  terminate() { this._fail(this._closeCode || 1006, this._closeReason || ''); }

  _fail(code, reason) {
    if (this.state === 'closed') return false;
    if (this._closeCode === 1006 || !this._gotClose) { this._closeCode = code; this._closeReason = reason; }
    this.state = 'closing';
    this._frag = null;
    if (this._req) { this._req.destroy(); this._req = null; }
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
    else this._finish(code, reason);
    return false;
  }

  _finish(code, reason) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    clearTimeout(this._timer);
    this._timer = null;
    this._frag = null;
    this._emitSafe('close', code, reason);
  }
}

module.exports = { WsClient, encodeFrame, FrameParser };
