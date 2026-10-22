'use strict';

// Remote answering over DingTalk: waiting requests are pushed to the bound user while they are away, and their
// one-to-one replies are applied through the same sessionManager calls as the island. "Always allow" is never remote.

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { debugLog } = require('../debugLog');

const PAIR_MS = 5 * 60000;
const PAIR_MAX_MISSES = 5;
const TICK_MS = 5000;
const SETTLED_KEEP_MS = 60 * 60000;
const MAX_SEND_TRIES = 3;
const RATE_PER_MIN = 30;
const PUSH_PER_MIN = 5;
const CMD_LIMIT = 1500;
const NOTICE_TRIES = 3;
const Q_LIMIT = 1000;
const OPT_LIMIT = 200;
const DESC_LIMIT = 300;

const YES = /^(y|yes|ok|允许|同意|批准|可以|好)$/i;
const NO = /^(n|no|拒绝|不行|不|否|取消)$/i;
const LIST = /^(ls|list|列表|待办)$/i;
const HELP = /^(\?|help|帮助|用法)$/i;

const HELP_TEXT = [
  'CodePeek 远程回答用法：',
  '· 「12 y」允许 #12，「12 n」拒绝，「12 n 原因」拒绝并把原因告诉 Claude',
  '· 提问：「13 2」选第 2 项，多选「13 1,3」，多个问题「13 2/1,3」，文字回答「13 ! 内容」',
  '· 「ls」查看待处理，「?」查看本说明',
  '出于安全考虑，远程不支持「总是允许」；内容被截断的请求只能远程拒绝。'
].join('\n');

const OUTCOME_LABEL = { allowed: '已允许', denied: '已拒绝', clarify: '已拒绝', answered: '已回答', ended: '已结束', failed: '未能送达' };
const BLOCKED_LABEL = { rate_limit: '触发限流', billing_error: '额度或账单问题' };
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

// Common credential shapes are masked before anything leaves the machine.
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[私钥已隐藏]'],
  [/\b(authorization\s*[:=]\s*(?:bearer|basic|token)?\s*)[^\s'"]+/gi, '$1***'],
  [/(['"]?\b(?:api[_-]?key|access[_-]?key|secret|token|passwd|password|pwd)\w*['"]?\s*[:=]\s*['"]?)[^\s'"&,}]+/gi, '$1***'],
  [/(--?(?:password|token|secret|api-key)[= ]\s*)\S+/gi, '$1***'],
  [/\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})\b/g, '***'],
  [/(:\/\/[^\s:@/]+:)[^\s@/]+@/g, '$1***@']
];

function redact(s) {
  let v = String(s || '');
  for (const [re, rep] of SECRET_PATTERNS) v = v.replace(re, rep);
  return v;
}

// Tool content is quoted line by line so text inside a command cannot pose as CodePeek's own instructions.
function quote(s) {
  return String(s).split(/\r?\n/).map(l => '｜' + l).join('\n');
}

function clip(s, n = 600) {
  const v = String(s || '');
  return v.length > n ? v.slice(0, n) + '…' : v;
}

// The same fields buildDisplay shows, taken from the raw tool input: display text is silently cut at 8000 chars,
// so completeness must be judged on the original.
function sourceFields(toolName, raw, display) {
  if (!raw || typeof raw !== 'object') return { command: display.command || '', path: display.path || '', description: display.description || '' };
  const str = (v) => (typeof v === 'string' ? v : '');
  switch (toolName) {
    case 'Bash': case 'PowerShell': return { command: str(raw.command), description: str(raw.description) };
    case 'Edit': case 'MultiEdit': case 'Write': case 'Read': case 'NotebookEdit': return { path: str(raw.file_path || raw.notebook_path) };
    case 'WebFetch': return { command: str(raw.url), description: str(raw.prompt) };
    case 'WebSearch': return { command: str(raw.query) };
    case 'Grep': case 'Glob': return { command: str(raw.pattern), path: str(raw.path) };
    case 'Task': case 'Agent': return { command: str(raw.prompt), description: str(raw.description) };
    default: {
      let json = '';
      try { json = JSON.stringify(raw, null, 2); } catch {}
      return { command: json };
    }
  }
}

// Full-width digits, punctuation and spaces from a phone IME become ASCII so "３　ｙ" works like "3 y".
function normalize(text) {
  return String(text || '').normalize('NFKC').replace(/[、]/g, ',').trim();
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// `rest` is the user's original text: free-text answers keep their own punctuation, option numbers are normalised.
function parseAnswers(questions, rest) {
  const qs = Array.isArray(questions) ? questions : [];
  if (/^[!！]/.test(rest)) {
    const text = rest.slice(1).trim();
    if (qs.length !== 1) return { error: '有多个问题时请用选项编号作答' };
    if (!text) return { error: '「!」后面写上你的回答' };
    if (text.length > 4000) return { error: '回答太长了' };
    return { answers: { [qs[0].question]: qs[0].multiSelect ? [text] : text } };
  }
  const groups = normalize(rest).split('/').map(s => s.trim());
  if (groups.length !== qs.length) return { error: qs.length > 1 ? `共 ${qs.length} 个问题，请用 / 分隔每题的答案` : '请回复选项编号' };
  const answers = {};
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i];
    const opts = Array.isArray(q.options) ? q.options : [];
    const nums = groups[i].split(/[\s,]+/).filter(Boolean);
    const tag = qs.length > 1 ? `第 ${i + 1} 题` : '';
    if (!nums.length || nums.some(n => !/^\d{1,2}$/.test(n))) return { error: `${tag}请填选项编号` };
    const idx = [...new Set(nums.map(Number))];
    if (idx.some(n => n < 1 || n > opts.length)) return { error: `${tag}只有 1–${opts.length} 号选项` };
    if (!q.multiSelect && idx.length !== 1) return { error: `${tag}是单选，只能选一项` };
    const labels = idx.map(n => String(opts[n - 1].label));
    answers[q.question] = q.multiSelect ? labels : labels[0];
  }
  return { answers };
}

function whereLabel(reason) {
  if (reason === 'island') return '在电脑上';
  if (reason === 'remote') return '在钉钉上';
  return '在终端里或会话已结束';
}

class RemoteBridge extends EventEmitter {
  constructor({ sessionManager, policy, config, secrets, createChannel, isMuted, log } = {}) {
    super();
    this.sm = sessionManager;
    this.policy = policy;
    this.config = config;
    this.secrets = secrets;
    this.createChannel = createChannel;
    this.isMuted = isMuted || (() => false);
    this.log = log || debugLog;
    this.channel = null;
    this._map = new Map();       // short id -> { requestId, kind, sessionId, incomplete }
    this._byReq = new Map();     // request id -> short id
    this._settled = new Map();   // short id -> { outcome, reason, at }
    this._sendFails = new Map(); // request id -> failed attempts
    this._noticed = new Map();   // session id -> attention version already pushed
    this._noticing = new Map();  // `${sid}:${version}` -> failed attempts (present while not yet delivered)
    this._pushLog = [];
    this._backlogNoticeAt = 0;
    this._pairing = null;
    this._rx = [];
    this._timer = null;
    this._evalTimer = null;
    this._lastError = '';
    // Hook events arrive in bursts; one evaluation per 200 ms is plenty for a push decision.
    this._onState = () => {
      if (this._evalTimer) return;
      this._evalTimer = setTimeout(() => { this._evalTimer = null; this.evaluate(); }, 200);
    };
    this._onResolved = ({ id, outcome, reason }) => {
      const shortId = this._byReq.get(id);
      if (shortId) this._settle(shortId, outcome, reason);
    };
  }

  cfg(key, fallback) {
    const v = this.config.get(key);
    return v === undefined || v === null ? fallback : v;
  }

  start() {
    this.reload();
    this.sm.on('state-changed', this._onState);
    this.sm.on('resolved', this._onResolved);
    this._timer = setInterval(() => this.evaluate(), TICK_MS);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    clearInterval(this._timer);
    clearTimeout(this._evalTimer);
    this.sm.removeListener('state-changed', this._onState);
    this.sm.removeListener('resolved', this._onResolved);
    this._stopChannel();
  }

  _stopChannel() {
    if (!this.channel) return;
    this.channel.removeAllListeners();
    this.channel.stop();
    this.channel = null;
  }

  // Re-reads credentials; called at start and whenever the remote settings change.
  reload() {
    this._stopChannel();
    this._lastError = '';
    const clientId = this.cfg('remoteClientId', '');
    const enc = this.cfg('remoteSecretEnc', '');
    if (this.cfg('remoteEnabled', false) && clientId && enc) {
      let secret = '';
      try { secret = this.secrets.decrypt(enc); } catch { this._lastError = 'secret-unreadable'; }
      if (secret) {
        this.channel = this.createChannel({ clientId, clientSecret: secret, robotCode: this._robotCode() });
        this.channel.on('status', (s) => {
          this.log('remote', `channel ${s.state}${s.error ? ' ' + s.error : ''}`);
          this.emit('status', this.status());
          if (s.state === 'connected') this.evaluate();
        });
        this.channel.on('message', (m) => { this.handle(m).catch(e => this.log('remote', `handle failed: ${e.message}`)); });
        this.channel.start();
      }
    }
    this.emit('status', this.status());
  }

  _robotCode() { return this.cfg('remoteRobotCode', '') || this.cfg('remoteClientId', ''); }

  status() {
    const pairing = this._pairing && Date.now() < this._pairing.exp ? { code: this._pairing.code, expiresAt: this._pairing.exp } : null;
    return {
      enabled: !!this.cfg('remoteEnabled', false),
      clientId: this.cfg('remoteClientId', ''),
      robotCode: this.cfg('remoteRobotCode', ''),
      hasSecret: !!this.cfg('remoteSecretEnc', ''),
      secureStorage: !!(this.secrets && this.secrets.available()),
      bound: !!this.cfg('remoteStaffId', ''),
      nick: this.cfg('remoteNick', ''),
      pushWhen: this.cfg('remotePushWhen', 'away'),
      awaySeconds: Number(this.cfg('remoteAwaySeconds', 120)) || 120,
      delaySeconds: Number(this.cfg('remoteDelaySeconds', 60)) || 0,
      paused: !!(this.policy.dndActive && this.policy.dndActive()),
      state: this.channel ? this.channel.state : 'off',
      error: this.channel ? this.channel.error : this._lastError,
      pairing
    };
  }

  // A new code replaces any earlier one and is consumed by its first correct use.
  startPairing() {
    this._pairing = { code: String(crypto.randomInt(0, 1000000)).padStart(6, '0'), exp: Date.now() + PAIR_MS, misses: 0 };
    this.log('remote', 'pairing started');
    this.emit('status', this.status());
    return { code: this._pairing.code, expiresAt: this._pairing.exp };
  }

  // Short ids handed to the previous account must not be answerable by the next one.
  _forgetRequests() {
    this._map.clear();
    this._byReq.clear();
    this._settled.clear();
    this._noticed.clear();
    this._noticing.clear();
  }

  unbind() {
    this.config.set('remoteStaffId', '');
    this.config.set('remoteNick', '');
    this.config.set('remoteCorpId', '');
    this._pairing = null;
    this._forgetRequests();
    this.log('remote', 'unbound');
    this.emit('status', this.status());
  }

  async sendTest() {
    const staffId = this.cfg('remoteStaffId', '');
    if (!this.channel || this.channel.state !== 'connected' || !staffId) throw new Error('not-ready');
    await this.channel.sendText(staffId, 'CodePeek 测试消息：连接正常。离开电脑时，待处理的请求会推送到这里。回复「?」查看用法。');
  }

  _ready() {
    return !!(this.channel && this.channel.state === 'connected' && this.cfg('remoteStaffId', ''));
  }

  // Locked or asleep counts at once; otherwise the remote's own idle threshold applies, not the island's.
  _away() {
    const p = this.policy;
    if (p.away && p.awayReason !== 'idle') return true;
    const limit = Math.max(30, Number(this.cfg('remoteAwaySeconds', 120)) || 120);
    return p.idleSeconds() >= limit;
  }

  _budgetLeft() {
    const now = Date.now();
    this._pushLog = this._pushLog.filter(t => now - t < 60000);
    return PUSH_PER_MIN - this._pushLog.length;
  }

  // Re-scans the authoritative state every tick, so requests that arrived while offline or during DND still go out.
  evaluate() {
    if (!this.channel && !this._map.size) return;
    const st = this.sm.getState();
    this._prune(st);
    if (!this._ready()) return;
    if (this.policy.dndActive && this.policy.dndActive()) return;
    const mode = this.cfg('remotePushWhen', 'away');
    if (mode !== 'away' && mode !== 'always') return;
    const now = Date.now();
    const away = mode === 'away' && this._away();
    const delay = Math.max(0, Number(this.cfg('remoteDelaySeconds', 60)) || 0) * 1000;
    // A short grace keeps a card answered at the desk in the same instant from buzzing the phone.
    const due = (since) => (mode === 'always' ? now - (since || now) >= delay : away && now - (since || now) >= 3000);
    const queue = [];
    for (const p of st.pendingPermissions) {
      if (!this._byReq.has(p.id) && due(p.timestamp) && (this._sendFails.get(p.id) || 0) < MAX_SEND_TRIES) queue.push([p.questions ? 'ask' : 'perm', p]);
    }
    for (const q of st.pendingQuestions) {
      if (!this._byReq.has(q.id) && due(q.timestamp) && (this._sendFails.get(q.id) || 0) < MAX_SEND_TRIES) queue.push(['question', q]);
    }
    for (const [kind, item] of queue) {
      if (this._budgetLeft() <= 0) break;
      this._push(kind, item);
    }
    const backlog = queue.filter(([, item]) => !this._byReq.has(item.id)).length;
    if (backlog && now - this._backlogNoticeAt > 60000) {
      this._backlogNoticeAt = now;
      this._send(`【CodePeek】还有 ${backlog} 个请求在排队，稍后逐条推送；回复「ls」可立即查看。`, `backlog n=${backlog}`, true);
    }
    for (const a of st.attention) {
      if ((a.kind !== 'input' && a.kind !== 'blocked') || this._noticed.get(a.sessionId) === a.version || !due(a.since)) continue;
      if (this.isMuted(a.cwd)) { this._noticed.set(a.sessionId, a.version); continue; }
      const key = `${a.sessionId}:${a.version}`;
      const tries = this._noticing.get(key);
      if (tries === -1 || tries >= NOTICE_TRIES) continue;
      if (this._budgetLeft() <= 0) break;
      this._noticing.set(key, -1);
      this._pushLog.push(Date.now());
      this.channel.sendText(this.cfg('remoteStaffId', ''), this._noticeText(a, st)).then(() => {
        this._noticing.delete(key);
        this._noticed.set(a.sessionId, a.version);
        this.log('remote', `sent notice sid=${a.sessionId} kind=${a.kind}`);
      }, (err) => {
        this._noticing.set(key, (tries || 0) + 1);
        this.log('remote', `notice sid=${a.sessionId} failed: ${err.message}`);
      });
    }
  }

  // Requests that ended without a resolved event (e.g. dropped sessions) still leave the map.
  _prune(st) {
    const live = new Set([...st.pendingPermissions, ...st.pendingQuestions].map(x => x.id));
    for (const [id, e] of this._map) if (!live.has(e.requestId)) this._settle(id, 'ended', '');
    const now = Date.now();
    for (const [id, s] of this._settled) if (now - s.at > SETTLED_KEEP_MS) this._settled.delete(id);
    for (const id of this._sendFails.keys()) if (!live.has(id)) this._sendFails.delete(id);
  }

  _settle(shortId, outcome, reason) {
    const e = this._map.get(shortId);
    if (!e) return;
    this._map.delete(shortId);
    this._byReq.delete(e.requestId);
    this._settled.set(shortId, { outcome, reason: reason || '', at: Date.now() });
  }

  // Ids only ever increase, across restarts too (persisted), so an old message's number never names a new request.
  _nextId() {
    const seq = (Number(this.cfg('remoteSeq', 0)) || 0) + 1;
    this.config.set('remoteSeq', seq);
    return seq;
  }

  _push(kind, item) {
    const id = this._nextId();
    const msg = this._requestText(id, kind, item);
    this._map.set(id, { requestId: item.id, kind, sessionId: item.sessionId, incomplete: msg.incomplete });
    this._byReq.set(item.id, id);
    this._pushLog.push(Date.now());
    this.channel.sendText(this.cfg('remoteStaffId', ''), msg.text).then(() => {
      this.log('remote', `push #${id} req=${item.id} kind=${kind}${msg.incomplete ? ' incomplete' : ''}`);
    }, (err) => {
      // Forget the id so the next tick retries, up to a few attempts per request.
      if (this._map.get(id) && this._map.get(id).requestId === item.id) { this._map.delete(id); this._byReq.delete(item.id); }
      this._sendFails.set(item.id, (this._sendFails.get(item.id) || 0) + 1);
      this.log('remote', `push #${id} req=${item.id} failed: ${err.message}`);
    });
  }

  _send(text, what, free) {
    if (!free) this._pushLog.push(Date.now());
    this.channel.sendText(this.cfg('remoteStaffId', ''), text).then(
      () => this.log('remote', `sent ${what}`),
      (err) => this.log('remote', `send ${what} failed: ${err.message}`)
    );
  }

  _label(sessionId, st) {
    const s = (st || this.sm.getState()).sessions.find(x => x.id === sessionId) || {};
    const base = s.cwd ? String(s.cwd).split(/[\\/]/).filter(Boolean).pop() : '';
    return clip(redact(s.name || s.projectName || base || String(sessionId || '').slice(0, 8)), 60);
  }

  // Returns { text, incomplete }; an incomplete request (content cut) can only be denied remotely.
  _requestText(id, kind, item) {
    const head = `【CodePeek #${id}】`;
    const who = this._label(item.sessionId) + (item.isSubagent ? '（子代理）' : '');
    if (kind === 'question') {
      return { text: `${head}Codex 提问 · ${who}\n${quote(clip(redact(item.question), 1500))}\n—\n回复「${id} 你的回答」`, incomplete: false };
    }
    if (kind === 'ask') {
      const qs = item.questions || [];
      const lines = [`${head}提问 · ${who}`];
      let incomplete = false;
      const part = (v, limit) => { const s = String(v || ''); if (s.length > limit) incomplete = true; return clip(redact(s), limit); };
      qs.forEach((q, i) => {
        lines.push(quote(`${qs.length > 1 ? `Q${i + 1} ` : ''}${part(q.question, Q_LIMIT)}（${q.multiSelect ? '多选' : '单选'}）`));
        (q.options || []).forEach((o, k) => lines.push(quote(`  ${k + 1}. ${part(o.label, OPT_LIMIT)}${o.description ? ' — ' + part(o.description, DESC_LIMIT) : ''}`)));
      });
      lines.push('—');
      if (incomplete) lines.push(`内容过长已截断，远程只能「${id} n」取消；要作答请回电脑。`);
      else if (qs.length > 1) lines.push(`回复「${id} 2/1,3」：按题目顺序用 / 分隔，多选用逗号；「${id} n」取消`);
      else lines.push(`回复「${id} 2」选择${qs[0] && qs[0].multiSelect ? `，多选「${id} 1,3」` : ''}；「${id} ! 文字」用文字回答；「${id} n」取消`);
      return { text: lines.join('\n'), incomplete };
    }
    const pending = this.sm.pendingPermissions.get(item.id);
    const src = sourceFields(item.toolName, pending && pending.rawInput, item.display || {});
    const lines = [`${head}授权 · ${who}`, `工具：${item.toolName}`];
    let incomplete = false;
    // Judged on the original length: masking can shorten text, but must never hide that it was cut.
    const field = (label, value, limit) => {
      const raw = String(value);
      if (raw.length > limit) incomplete = true;
      lines.push(`${label}：`, quote(clip(redact(raw), limit)));
    };
    if (src.command) field('命令', src.command, CMD_LIMIT);
    if (src.path) field('文件', src.path, 400);
    if (src.description) field('说明', src.description, DESC_LIMIT);
    if (!src.command && !src.path && item.toolInput) field('内容', item.toolInput, CMD_LIMIT);
    if (EDIT_TOOLS.has(item.toolName)) lines.push('（改动内容未展示，需要时请回电脑查看）');
    lines.push('—');
    if (incomplete) lines.push(`内容过长已截断，远程只能拒绝：「${id} n」拒绝，「${id} n 原因」拒绝并说明；要允许请回电脑。`);
    else lines.push(`回复「${id} y」允许，「${id} n」拒绝，「${id} n 原因」拒绝并告诉 Claude 原因`);
    return { text: lines.join('\n'), incomplete };
  }

  _noticeText(a, st) {
    const who = this._label(a.sessionId, st);
    const body = a.text ? '\n' + quote(clip(redact(a.text), 300)) : '';
    if (a.kind === 'blocked') return `【CodePeek】${who} 受阻：${BLOCKED_LABEL[a.reason] || clip(a.reason, 40) || '出错'}${body}\n不能远程处理，需要回到电脑。`;
    return `【CodePeek】${who} 需要你回到终端操作${body}\n不能远程处理。`;
  }

  _listText() {
    const st = this.sm.getState();
    this._prune(st);
    const lines = [];
    const all = [...st.pendingPermissions, ...st.pendingQuestions];
    let queued = 0;
    let sent = 0;
    for (const item of all) {
      if (!this._byReq.has(item.id)) {
        if (this._budgetLeft() > 0) { this._push(item.questions ? 'ask' : item.id.startsWith('q_') ? 'question' : 'perm', item); sent++; } else queued++;
        continue;
      }
      const id = this._byReq.get(item.id);
      const what = item.questions ? '提问' : item.id.startsWith('q_') ? 'Codex 提问' : `授权 ${item.toolName}`;
      lines.push(`#${id} ${what} · ${this._label(item.sessionId, st)}`);
    }
    if (!all.length) return '现在没有待处理的请求。';
    if (sent) lines.push(`另有 ${sent} 个刚逐条发给你。`);
    if (queued) lines.push(`还有 ${queued} 个在排队，稍后推送。`);
    return '待处理：\n' + lines.join('\n');
  }

  _rateOk() {
    const now = Date.now();
    this._rx = this._rx.filter(t => now - t < 60000);
    if (this._rx.length >= RATE_PER_MIN) return false;
    this._rx.push(now);
    return true;
  }

  // Only plain-text one-to-one messages for our robot (and, once bound, from the bound corp) are considered.
  _acceptable(m) {
    if (!m || !m.single || !m.staffId) return 'not a one-to-one message';
    if (m.msgtype !== 'text') return `unsupported type ${m.msgtype || '-'}`;
    if (m.robotCode && m.robotCode !== this._robotCode()) return 'other robot';
    return '';
  }

  async handle(m) {
    const bad = this._acceptable(m);
    if (bad) { this.log('remote', `ignored: ${bad}`); return; }
    const raw = String(m.text || '').trim();
    const text = normalize(raw);
    if (this._pairing) {
      if (Date.now() > this._pairing.exp) this._pairing = null;
      else if (/^\d{6}$/.test(text)) {
        if (safeEqual(text, this._pairing.code)) {
          this._pairing = null;
          this._forgetRequests();
          this.config.set('remoteStaffId', m.staffId);
          this.config.set('remoteNick', m.nick || '');
          this.config.set('remoteCorpId', m.corpId || '');
          this.log('remote', 'bound');
          this.emit('status', this.status());
          await this.channel.reply(m, '绑定成功。之后离开电脑时，待处理的请求会推送到这里。\n\n' + HELP_TEXT);
          this.evaluate();
          return;
        }
        if (++this._pairing.misses >= PAIR_MAX_MISSES) { this._pairing = null; this.emit('status', this.status()); }
        this.log('remote', 'pairing code mismatch');
        return;
      }
    }
    const bound = this.cfg('remoteStaffId', '');
    const corp = this.cfg('remoteCorpId', '');
    if (!bound || m.staffId !== bound || (corp && m.corpId && m.corpId !== corp)) { this.log('remote', 'ignored: sender is not the bound user'); return; }
    if (!this._rateOk()) { this.log('remote', 'ignored: rate limit'); return; }
    const reply = (s) => this.channel.reply(m, s).catch(e => this.log('remote', `reply failed: ${e.message}`));
    if (!text || HELP.test(text)) return reply(HELP_TEXT);
    if (LIST.test(text)) return reply(this._listText());
    const mm = /^[#＃]?([0-9０-９]{1,7})[\s　]*([\s\S]*)$/.exec(raw);
    if (!mm) return reply('没看懂。回复「编号 y」允许、「编号 n」拒绝，「ls」查看待处理，「?」查看用法。');
    const id = Number(normalize(mm[1]));
    const rest = mm[2].trim();
    this._prune(this.sm.getState());
    const e = this._map.get(id);
    if (!e) {
      const s = this._settled.get(id);
      if (!s) return reply(`没有 #${id}，或它已经过期。回复「ls」查看待处理。`);
      if (s.outcome === 'failed') return reply(`#${id} 上次没能送达终端，这个请求已经结束，请回电脑确认。`);
      const how = OUTCOME_LABEL[s.outcome];
      return reply(how && s.reason ? `#${id} 已${whereLabel(s.reason)}处理（${how}），无需再处理。` : `#${id} 已经结束，无需再处理。`);
    }
    const r = this._apply(id, e, rest);
    if (r.hint) return reply(r.hint);
    const status = r.res && r.res.status;
    this.log('remote', `answer #${id} req=${e.requestId} action=${r.action} status=${status}`);
    if (status === 'accepted') { this._settle(id, r.outcome, 'remote'); return reply(`#${id} ${r.done}，已交给终端。`); }
    if (status === 'already-settled') {
      const s = this._settled.get(id);
      return reply(s && s.reason ? `#${id} 已${whereLabel(s.reason)}处理过了。` : `#${id} 已经结束，无需再处理。`);
    }
    if (status === 'invalid') return reply(`#${id} 回答格式不对，回复「?」查看用法。`);
    this._settled.set(id, { outcome: 'failed', reason: 'remote', at: Date.now() });
    return reply(`#${id} 没能送达终端，这个请求可能已经结束，请回电脑确认。`);
  }

  _apply(id, e, rest) {
    if (e.kind === 'question') {
      if (!rest) return { hint: `回复「${id} 你的回答」` };
      if (rest.length > 10000) return { hint: `#${id} 回答太长了` };
      return { action: 'answer', outcome: 'answered', done: '已回答', res: this.sm.answerQuestion(e.requestId, rest, 'remote') };
    }
    const word = rest.split(/[\s　]+/)[0] || '';
    if (NO.test(normalize(word))) {
      const msg = rest.slice(word.length).trim() || null;
      if (msg && msg.length > 8000) return { hint: `#${id} 原因太长了` };
      return {
        action: 'deny', outcome: msg ? 'clarify' : 'denied', done: msg ? '已拒绝，并把原因转告 Claude' : '已拒绝',
        res: this.sm.approvePermission(e.requestId, 'deny', null, msg, 'remote')
      };
    }
    if (e.kind === 'perm') {
      if (!YES.test(normalize(rest))) return { hint: e.incomplete ? `#${id} 内容不完整，只能远程拒绝；要允许请回电脑。` : `回复「${id} y」允许，「${id} n」拒绝` };
      if (e.incomplete) return { hint: `#${id} 内容被截断，为安全起见不能远程允许，请回电脑处理；或回复「${id} n」拒绝。` };
      return { action: 'allow', outcome: 'allowed', done: '已允许', res: this.sm.approvePermission(e.requestId, 'allow', null, null, 'remote') };
    }
    if (e.incomplete) return { hint: `#${id} 内容被截断，为安全起见不能远程作答，请回电脑处理；或回复「${id} n」取消。` };
    const pending = this.sm.pendingPermissions.get(e.requestId);
    if (!pending) return { action: 'answer', res: { status: 'already-settled' } };
    if (!rest) return { hint: `回复「${id} 选项编号」，例如「${id} 1」` };
    const parsed = parseAnswers(pending.questions, rest);
    if (parsed.error) return { hint: `#${id} ${parsed.error}` };
    return { action: 'answer', outcome: 'answered', done: '已回答', res: this.sm.approvePermission(e.requestId, 'allow', parsed.answers, null, 'remote') };
  }
}

module.exports = RemoteBridge;
module.exports.parseAnswers = parseAnswers;
module.exports.normalize = normalize;
module.exports.redact = redact;
