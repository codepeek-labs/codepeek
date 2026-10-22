'use strict';

// DingTalk enterprise-robot channel in Stream mode: one outbound WebSocket, so no public endpoint is needed.
// Frame handling follows open-dingtalk/dingtalk-stream-sdk-nodejs: echo SYSTEM ping/disconnect, ACK every CALLBACK.
// Robot messages are fire-and-forget: one sent while disconnected may never arrive, so callers re-scan state instead.

const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const { WsClient } = require('./wsClient');

const TOPIC_ROBOT = '/v1.0/im/bot/messages/get';
const KEEPALIVE_MS = 20000;
const SILENT_LIMIT_MS = 65000;
const DEDUPE_MS = 10 * 60000;

function request(method, url, { headers = {}, body, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(e); return; }
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(u, {
      method,
      headers: { Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size <= 1 << 20) chunks.push(c); });
      res.on('aborted', () => done(new Error('response aborted')));
      res.on('error', (e) => done(e));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        done(null, { status: res.statusCode, json, text });
      });
    });
    // One deadline for the whole exchange; the socket idle timeout alone would let a trickling response hang.
    const deadline = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs);
    let settled = false;
    function done(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (err) reject(err); else resolve(value);
    }
    req.on('error', (e) => done(e));
    if (data) req.write(data);
    req.end();
  });
}

// Error text for the status line; responses never echo the secret, the request URL (which may) is never included.
function describe(res) {
  const j = res.json || {};
  const code = j.code || j.errcode || '';
  const msg = j.message || j.errmsg || (res.text || '').slice(0, 120);
  return `HTTP ${res.status}${code ? ' ' + code : ''}${msg ? ': ' + msg : ''}`;
}

class DingTalkStream extends EventEmitter {
  constructor({ clientId, clientSecret, robotCode, apiBase, oapiBase, ua } = {}) {
    super();
    this._customBase = !!oapiBase;
    this.clientId = clientId || '';
    this.clientSecret = clientSecret || '';
    this.robotCode = robotCode || clientId || '';
    this.apiBase = apiBase || 'https://api.dingtalk.com';
    this.oapiBase = oapiBase || 'https://oapi.dingtalk.com';
    this.ua = ua || 'codepeek';
    this.state = 'off';
    this.error = '';
    this._ws = null;
    this._stopped = true;
    this._attempts = 0;
    this._retryTimer = null;
    this._aliveTimer = null;
    this._lastRx = 0;
    this._seen = new Map();
    this._token = null;
  }

  start() {
    if (!this._stopped) return;
    this._stopped = false;
    this._connect();
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._retryTimer);
    clearInterval(this._aliveTimer);
    const ws = this._ws;
    this._ws = null;
    if (ws) ws.close();
    this._setState('off', '');
  }

  _setState(state, error) {
    if (state === this.state && (error || '') === this.error) return;
    this.state = state;
    this.error = error || '';
    this.emit('status', { state, error: this.error });
  }

  async _connect() {
    if (this._stopped) return;
    this._setState('connecting', this.error);
    let gw;
    try {
      const res = await request('POST', this.apiBase + '/v1.0/gateway/connections/open', {
        body: { clientId: this.clientId, clientSecret: this.clientSecret, ua: this.ua, subscriptions: [{ type: 'CALLBACK', topic: TOPIC_ROBOT }] }
      });
      if (!res.json || !res.json.endpoint || !res.json.ticket) throw new Error(describe(res));
      gw = res.json;
    } catch (e) {
      this._retry(e.message);
      return;
    }
    if (this._stopped) return;
    const ws = new WsClient(`${gw.endpoint}${gw.endpoint.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(gw.ticket)}`);
    this._ws = ws;
    ws.on('open', () => {
      if (this._ws !== ws) return;
      this._attempts = 0;
      this._lastRx = Date.now();
      this._setState('connected', '');
      this._keepalive(ws);
    });
    ws.on('message', (m) => { if (this._ws === ws) { this._lastRx = Date.now(); this._onFrame(ws, m); } });
    ws.on('pong', () => { if (this._ws === ws) this._lastRx = Date.now(); });
    ws.on('error', () => {});
    ws.on('close', (code, reason) => {
      if (this._ws !== ws) return;
      this._ws = null;
      clearInterval(this._aliveTimer);
      this._retry(`closed ${code}${reason ? ' ' + reason : ''}`);
    });
    ws.connect();
  }

  _retry(err) {
    if (this._stopped) return;
    this._setState('error', err);
    const delay = Math.min(1000 * 2 ** this._attempts + Math.random() * 1000, 60000);
    this._attempts = Math.min(this._attempts + 1, 10);
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => this._connect(), delay);
    if (this._retryTimer.unref) this._retryTimer.unref();
  }

  // A half-open TCP connection never fires close; silence past the limit forces a reconnect.
  _keepalive(ws) {
    clearInterval(this._aliveTimer);
    this._aliveTimer = setInterval(() => {
      if (Date.now() - this._lastRx > SILENT_LIMIT_MS) { ws.terminate(); return; }
      ws.ping();
    }, KEEPALIVE_MS);
    if (this._aliveTimer.unref) this._aliveTimer.unref();
  }

  _onFrame(ws, text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    const h = msg.headers && typeof msg.headers === 'object' ? msg.headers : {};
    if (msg.type === 'SYSTEM') {
      if (h.topic === 'ping' || h.topic === 'disconnect') ws.send(JSON.stringify({ code: 200, headers: h, message: 'OK', data: msg.data }));
      if (h.topic === 'disconnect') ws.close();
      return;
    }
    const ack = (data) => ws.send(JSON.stringify({
      code: 200, headers: { contentType: 'application/json', messageId: h.messageId }, message: 'OK', data: JSON.stringify(data)
    }));
    if (msg.type === 'EVENT') { ack({ status: 'SUCCESS' }); return; }
    if (msg.type !== 'CALLBACK') return;
    // The ACK only confirms receipt; repeats of one messageId are dropped, business idempotency lives in the caller.
    ack({ response: null });
    if (h.topic !== TOPIC_ROBOT || this._isRepeat(h.messageId)) return;
    let d;
    try { d = JSON.parse(msg.data); } catch { return; }
    if (!d || typeof d !== 'object') return;
    this.emit('message', {
      staffId: String(d.senderStaffId || ''),
      nick: String(d.senderNick || '').slice(0, 64),
      single: String(d.conversationType) === '1',
      text: d.text && typeof d.text.content === 'string' ? d.text.content : '',
      msgId: String(d.msgId || h.messageId || ''),
      webhook: typeof d.sessionWebhook === 'string' ? d.sessionWebhook : '',
      webhookExpires: Number(d.sessionWebhookExpiredTime) || 0,
      msgtype: String(d.msgtype || ''),
      robotCode: String(d.robotCode || ''),
      corpId: String(d.senderCorpId || d.chatbotCorpId || '')
    });
  }

  _isRepeat(id) {
    if (!id) return false;
    const now = Date.now();
    for (const [k, t] of this._seen) { if (now - t > DEDUPE_MS || this._seen.size > 2000) this._seen.delete(k); else break; }
    if (this._seen.has(id)) return true;
    this._seen.set(id, now);
    return false;
  }

  // Concurrent callers share one refresh.
  _accessToken() {
    if (this._token && Date.now() < this._token.exp) return Promise.resolve(this._token.value);
    if (!this._tokenP) this._tokenP = this._fetchToken().finally(() => { this._tokenP = null; });
    return this._tokenP;
  }

  async _fetchToken() {
    const url = `${this.oapiBase}/gettoken?appkey=${encodeURIComponent(this.clientId)}&appsecret=${encodeURIComponent(this.clientSecret)}`;
    const res = await request('GET', url);
    const j = res.json || {};
    if (j.errcode !== 0 || !j.access_token) throw new Error(describe(res));
    this._token = { value: j.access_token, exp: Date.now() + Math.max(60, (Number(j.expires_in) || 7200) - 300) * 1000 };
    return this._token.value;
  }

  // Plain text on purpose: tool input is untrusted and must not render as DingTalk Markdown (fake links, layout).
  async sendText(staffId, content) {
    const token = await this._accessToken();
    const res = await request('POST', this.apiBase + '/v1.0/robot/oToMessages/batchSend', {
      headers: { 'x-acs-dingtalk-access-token': token },
      body: { robotCode: this.robotCode, userIds: [staffId], msgKey: 'sampleText', msgParam: JSON.stringify({ content }) }
    });
    const j = res.json && typeof res.json === 'object' ? res.json : null;
    if (res.status === 401 || res.status === 403 || (j && /token/i.test(String(j.code || j.message || '')))) this._token = null;
    if (res.status !== 200 || !j || (j.errcode && j.errcode !== 0) || (j.code && !j.processQueryKey)) throw new Error(describe(res));
    // HTTP 200 still means "not delivered" for a recipient listed as invalid, filtered or flow-controlled.
    for (const k of ['invalidStaffIdList', 'filteredStaffIdList', 'flowControlledStaffIdList']) {
      if (Array.isArray(j[k]) && j[k].includes(staffId)) throw new Error(`${k.replace('StaffIdList', '')} recipient`);
    }
    return j;
  }

  // The session webhook is a short-lived bearer URL: only DingTalk's own origin, never logged or stored.
  _webhookAllowed(url) {
    try {
      const u = new URL(url);
      const base = new URL(this.oapiBase);
      if (u.username || u.password || u.protocol !== base.protocol || u.host !== base.host) return false;
      return this._customBase || u.pathname.startsWith('/robot/');
    } catch { return false; }
  }

  // Answers in the same chat via its session webhook while valid, otherwise as a normal one-to-one message.
  async reply(msg, content) {
    if (msg.webhook && this._webhookAllowed(msg.webhook) && msg.webhookExpires && Date.now() < msg.webhookExpires - 5000) {
      try {
        const res = await request('POST', msg.webhook, { body: { msgtype: 'text', text: { content } } });
        if (res.status === 200 && !(res.json && res.json.errcode)) return;
      } catch {}
    }
    await this.sendText(msg.staffId, content);
  }
}

module.exports = { DingTalkStream, TOPIC_ROBOT, request };
