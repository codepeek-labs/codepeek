'use strict';

const { stubWatcher, respondSpy, decisionOf } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { encodeFrame, FrameParser } = require('../src/main/remote/wsClient');
const { DingTalkStream, TOPIC_ROBOT } = require('../src/main/remote/dingtalk');
const RemoteBridge = require('../src/main/remote/remoteBridge');
const AttentionStore = require('../src/main/attentionStore');
const SessionManager = require('../src/main/sessionManager');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); }
  return false;
}

// Local stand-in for DingTalk: gateway, token, batchSend, a session webhook and the Stream WebSocket.
function mockDingTalk() {
  const m = { gateway: [], sends: [], hooks: [], fromClient: [], sockets: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : null;
      const out = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/v1.0/gateway/connections/open') { m.gateway.push(json); return out({ endpoint: `ws://127.0.0.1:${m.port}/connect`, ticket: 'tk+/=' }); }
      if (req.url.startsWith('/gettoken')) return out({ errcode: 0, access_token: 'tok-1', expires_in: 7200 });
      if (req.url === '/v1.0/robot/oToMessages/batchSend') { m.sends.push({ token: req.headers['x-acs-dingtalk-access-token'], body: json }); return out({ processQueryKey: 'k' }); }
      if (req.url.startsWith('/hook')) { m.hooks.push(json); return out({ errcode: 0 }); }
      res.writeHead(404); res.end();
    });
  });
  server.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    m.lastTicket = new URL(req.url, 'http://x').searchParams.get('ticket');
    const parser = new FrameParser();
    socket.on('data', (d) => {
      for (const f of parser.push(d)) {
        if (f.opcode === 0x1) m.fromClient.push(JSON.parse(f.payload.toString('utf8')));
        if (f.opcode === 0x9) socket.write(encodeFrame(0xA, f.payload, false));
      }
    });
    socket.on('error', () => {});
    m.sockets.push(socket);
  });
  m.send = (obj) => m.sockets[m.sockets.length - 1].write(encodeFrame(0x1, JSON.stringify(obj), false));
  m.start = () => new Promise(r => server.listen(0, '127.0.0.1', () => { m.port = server.address().port; m.base = `http://127.0.0.1:${m.port}`; r(m); }));
  m.close = () => { m.sockets.forEach(s => s.destroy()); server.close(); };
  return m;
}

test('frame codec: masked round trip, extended lengths and split chunks', () => {
  const big = 'x'.repeat(70000);
  const frames = Buffer.concat([encodeFrame(0x1, 'hi', true), encodeFrame(0x1, big, true), encodeFrame(0x9, '', false)]);
  const p = new FrameParser();
  const got = [];
  for (let i = 0; i < frames.length; i += 777) got.push(...p.push(frames.subarray(i, i + 777)));
  assert.deepEqual(got.map(f => [f.opcode, f.payload.length]), [[1, 2], [1, 70000], [9, 0]]);
  assert.equal(got[1].payload.toString(), big);
});

test('stream: registers the robot topic, echoes ping, ACKs and de-duplicates callbacks, sends and replies', async () => {
  const m = await mockDingTalk().start();
  const ch = new DingTalkStream({ clientId: 'cid', clientSecret: 'sec', apiBase: m.base, oapiBase: m.base });
  const msgs = [];
  ch.on('message', (x) => msgs.push(x));
  ch.start();
  assert.ok(await until(() => ch.state === 'connected'));
  assert.deepEqual(m.gateway[0].subscriptions, [{ type: 'CALLBACK', topic: TOPIC_ROBOT }]);
  assert.equal(m.lastTicket, 'tk+/=');

  m.send({ specVersion: '1.0', type: 'SYSTEM', headers: { topic: 'ping', messageId: 'p1', contentType: 'application/json' }, data: '{"opaque":"1"}' });
  assert.ok(await until(() => m.fromClient.some(f => f.headers && f.headers.messageId === 'p1')));
  const pong = m.fromClient.find(f => f.headers.messageId === 'p1');
  assert.equal(pong.code, 200);
  assert.equal(pong.data, '{"opaque":"1"}');

  const robot = { senderStaffId: 'u1', senderNick: '王', conversationType: '1', msgtype: 'text', text: { content: ' 3 y ' }, msgId: 'mid', sessionWebhook: `${m.base}/hook?s=1`, sessionWebhookExpiredTime: Date.now() + 60000 };
  const cb = { type: 'CALLBACK', headers: { topic: TOPIC_ROBOT, messageId: 'c1' }, data: JSON.stringify(robot) };
  m.send(cb);
  m.send(cb);
  assert.ok(await until(() => m.fromClient.filter(f => f.headers && f.headers.messageId === 'c1').length === 2));
  await sleep(50);
  assert.equal(msgs.length, 1, 'redelivery is acknowledged but not handled twice');
  assert.equal(JSON.parse(m.fromClient.find(f => f.headers.messageId === 'c1').data).response, null);
  assert.deepEqual([msgs[0].staffId, msgs[0].single, msgs[0].text], ['u1', true, ' 3 y ']);

  await ch.sendText('u1', 'hello');
  assert.equal(m.sends[0].token, 'tok-1');
  assert.deepEqual(m.sends[0].body.userIds, ['u1']);
  assert.equal(m.sends[0].body.robotCode, 'cid');
  assert.equal(JSON.parse(m.sends[0].body.msgParam).content, 'hello');

  await ch.reply(msgs[0], 'ok');
  assert.equal(m.hooks[0].text.content, 'ok');
  await ch.reply({ ...msgs[0], webhook: 'https://evil.example.com/x' }, 'fallback');
  assert.equal(JSON.parse(m.sends[1].body.msgParam).content, 'fallback', 'unknown webhook hosts are never called');
  ch.stop();
  m.close();
});

test('stream: reconnects after the server drops the socket', async () => {
  const m = await mockDingTalk().start();
  const ch = new DingTalkStream({ clientId: 'cid', clientSecret: 'sec', apiBase: m.base, oapiBase: m.base });
  ch.start();
  assert.ok(await until(() => ch.state === 'connected'));
  m.sockets[0].destroy();
  assert.ok(await until(() => ch.state !== 'connected', 1000));
  assert.ok(await until(() => ch.state === 'connected' && m.gateway.length === 2, 5000));
  ch.stop();
  m.close();
});

// ---------- bridge ----------
const memConfig = (init = {}) => {
  const data = { ...init };
  return { get: (k) => data[k], set: (k, v) => { data[k] = v; }, data };
};

function fakeChannel() {
  const ch = new EventEmitter();
  ch.state = 'connected';
  ch.error = '';
  ch.sent = [];
  ch.replies = [];
  ch.start = () => {};
  ch.stop = () => {};
  ch.sendText = async (staffId, text) => { ch.sent.push({ staffId, text }); };
  ch.reply = async (msg, text) => { ch.replies.push(text); };
  return ch;
}

function setup(extra = {}) {
  const sm = new SessionManager({ transcriptWatcher: stubWatcher(), attentionStore: new AttentionStore({ path: null }), presenceProbe: () => true });
  const policy = { away: false, awayReason: '', idle: 0, idleSeconds() { return this.idle; } };
  const config = memConfig({ remoteEnabled: true, remoteClientId: 'cid', remoteSecretEnc: 'enc', remoteStaffId: 'u1', remotePushWhen: 'away', remoteAwaySeconds: 120, ...extra });
  const ch = fakeChannel();
  const bridge = new RemoteBridge({ sessionManager: sm, policy, config, secrets: { available: () => true, decrypt: () => 'sec' }, createChannel: () => ch, log: () => {} });
  bridge.reload();
  sm.on('resolved', bridge._onResolved);
  return { sm, policy, config, ch, bridge };
}
const dm = (text, staffId = 'u1', single = true) => ({ staffId, single, text, nick: 'n', msgtype: 'text' });
const age = (sm, ms) => { for (const p of sm.pendingPermissions.values()) p.timestamp -= ms; };

test('pairing binds only the sender of the right code; strangers and group chats are ignored', async () => {
  const { bridge, ch, config } = setup({ remoteStaffId: '' });
  const { code } = bridge.startPairing();
  await bridge.handle(dm('000000' === code ? '111111' : '000000', 'x'));
  assert.equal(config.data.remoteStaffId, '');
  await bridge.handle(dm(code, 'u9', false));
  assert.equal(config.data.remoteStaffId, '', 'group chats never bind');
  await bridge.handle(dm(code, 'u9'));
  assert.equal(config.data.remoteStaffId, 'u9');
  assert.match(ch.replies[0], /绑定成功/);
  await bridge.handle(dm('ls', 'u1'));
  assert.equal(ch.replies.length, 1, 'a different staff id gets nothing');
});

test('pushes while away, applies "N y", and explains a repeated or stale reply', async () => {
  const { sm, policy, ch, bridge, config } = setup();
  const spy = respondSpy();
  sm.handleEvent({ hook_event_name: 'PermissionRequest', session_id: 's1', _source: 'claude', cwd: 'D:/w/proj', tool_name: 'Bash', tool_input: { command: 'npm test' } }, spy);
  age(sm, 10000);
  bridge.evaluate();
  assert.equal(ch.sent.length, 0, 'not away yet');
  policy.idle = 300;
  bridge.evaluate();
  bridge.evaluate();
  assert.equal(ch.sent.length, 1, 'pushed once');
  const id = Number(/#(\d+)/.exec(ch.sent[0].text)[1]);
  assert.match(ch.sent[0].text, /npm test/);
  assert.equal(config.data.remoteSeq, id);
  await bridge.handle(dm(`${id} 允许`));
  assert.equal(decisionOf(spy.sent[0]).behavior, 'allow');
  assert.match(ch.replies.pop(), /已允许/);
  assert.equal(sm.getState().recentlyResolved[0].reason, 'remote');
  await bridge.handle(dm(`${id} y`));
  assert.match(ch.replies.pop(), /无需再处理/);
});

test('deny with a reason; a request answered at the desk first reports as already handled', async () => {
  const { sm, policy, ch, bridge } = setup();
  policy.away = true; policy.awayReason = 'lock';
  const a = respondSpy(), b = respondSpy();
  sm.handleEvent({ hook_event_name: 'PermissionRequest', session_id: 's1', _source: 'claude', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }, a);
  sm.handleEvent({ hook_event_name: 'PermissionRequest', session_id: 's2', _source: 'claude', tool_name: 'Write', tool_input: { file_path: 'D:/x.txt', content: 'x' } }, b);
  age(sm, 10000);
  bridge.evaluate();
  const ids = ch.sent.map(s => Number(/#(\d+)/.exec(s.text)[1]));
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  await bridge.handle(dm(`${ids[0]} n 先别删，改用 git clean`));
  const d = decisionOf(a.sent[0]);
  assert.equal(d.behavior, 'deny');
  assert.equal(d.message, '先别删，改用 git clean');
  const permId = Array.from(sm.pendingPermissions.keys())[0];
  sm.approvePermission(permId, 'allow', null, null);
  await bridge.handle(dm(`${ids[1]} y`));
  assert.match(ch.replies.pop(), /已在电脑上处理（已允许）/);
  await bridge.handle(dm('y'));
  assert.match(ch.replies.pop(), /没看懂/, 'an action without an id is refused');
});

test('AskUserQuestion: per-question answers, validation hints and free text', async () => {
  const { sm, policy, ch, bridge } = setup();
  policy.idle = 999;
  const spy = respondSpy();
  const questions = [
    { question: '用哪个数据库？', header: 'DB', multiSelect: false, options: [{ label: 'Postgres' }, { label: 'MySQL' }] },
    { question: '要哪些功能？', header: 'F', multiSelect: true, options: [{ label: '缓存' }, { label: '日志' }, { label: '监控' }] }
  ];
  sm.handleEvent({ hook_event_name: 'PermissionRequest', session_id: 's1', _source: 'claude', tool_name: 'AskUserQuestion', tool_input: { questions } }, spy);
  age(sm, 10000);
  bridge.evaluate();
  const id = Number(/#(\d+)/.exec(ch.sent[0].text)[1]);
  assert.match(ch.sent[0].text, /2\. MySQL/);
  await bridge.handle(dm(`${id} 3/1`));
  assert.match(ch.replies.pop(), /只有 1–2 号/);
  await bridge.handle(dm(`${id} 1,2/1`));
  assert.match(ch.replies.pop(), /单选/);
  await bridge.handle(dm(`${id} ! 随便`));
  assert.match(ch.replies.pop(), /多个问题/);
  await bridge.handle(dm(`${id}　２／１，３`));
  const d = decisionOf(spy.sent[0]);
  assert.deepEqual(d.updatedInput.answers, { '用哪个数据库？': 'MySQL', '要哪些功能？': '缓存, 监控' });
  assert.match(ch.replies.pop(), /已回答/);
});

test('"always" mode waits for the delay; blocked sessions get one notice per occurrence', async () => {
  const { sm, ch, bridge } = setup({ remotePushWhen: 'always', remoteDelaySeconds: 60 });
  sm.handleEvent({ hook_event_name: 'PermissionRequest', session_id: 's1', _source: 'claude', tool_name: 'Bash', tool_input: { command: 'ls' } }, respondSpy());
  age(sm, 30000);
  bridge.evaluate();
  assert.equal(ch.sent.length, 0);
  age(sm, 40000);
  bridge.evaluate();
  assert.equal(ch.sent.length, 1);
  sm.handleEvent({ hook_event_name: 'StopFailure', session_id: 's3', _source: 'claude', error: 'rate_limit', error_details: '429' }, null);
  sm.attention.get('s3').since -= 120000;
  bridge.evaluate();
  bridge.evaluate();
  const notes = ch.sent.filter(s => /受阻/.test(s.text));
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /触发限流/);
});

test('nothing is pushed or accepted when remote answering is off', async () => {
  const { sm, policy, ch, bridge, config } = setup({ remoteEnabled: false });
  policy.idle = 999;
  sm.handleEvent({ hook_event_name: 'PermissionRequest', session_id: 's1', _source: 'claude', tool_name: 'Bash', tool_input: { command: 'ls' } }, respondSpy());
  age(sm, 10000);
  bridge.evaluate();
  assert.equal(ch.sent.length, 0);
  assert.equal(bridge.status().state, 'off');
  config.data.remoteEnabled = true;
  bridge.reload();
  bridge.evaluate();
  assert.equal(ch.sent.length, 1);
});

// ---------- hardening ----------
// A raw server that answers the handshake and then writes exactly the given bytes (independent of our encoder).
function rawServer(bytes) {
  const s = { events: [] };
  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    if (bytes) socket.write(Buffer.from(bytes));
    socket.on('error', () => {});
  });
  s.start = () => new Promise(r => server.listen(0, '127.0.0.1', () => { s.url = `ws://127.0.0.1:${server.address().port}/`; r(s); }));
  s.close = () => server.close();
  return s;
}

async function runRaw(bytes) {
  const { WsClient } = require('../src/main/remote/wsClient');
  const srv = await rawServer(bytes).start();
  const ws = new WsClient(srv.url);
  const out = { msgs: [], open: false, close: null };
  ws.on('open', () => { out.open = true; });
  ws.on('message', (t) => out.msgs.push(t));
  ws.on('close', (code) => { out.close = code; });
  ws.connect();
  await until(() => out.close !== null, 3000);
  srv.close();
  return out;
}

test('ws: hand-built frames — text ok, protocol violations fail the connection', async () => {
  const hi = [0x81, 0x02, 0x68, 0x69];
  const closeFrame = [0x88, 0x02, 0x03, 0xe8];
  let r = await runRaw([...hi, ...closeFrame, 0x81, 0x01, 0x58]);
  assert.deepEqual(r.msgs, ['hi'], 'nothing after Close is delivered');
  assert.equal(r.close, 1000);
  r = await runRaw([0x81, 0x82, 1, 2, 3, 4, 0x69, 0x6b]);
  assert.deepEqual([r.msgs.length, r.close], [0, 1002], 'masked server frame');
  r = await runRaw([0x01, 0x01, 0x41, 0x81, 0x01, 0x42, 0x80, 0x01, 0x43]);
  assert.deepEqual([r.msgs.length, r.close], [0, 1002], 'interleaved message');
  r = await runRaw([0x81, 0x01, 0xff]);
  assert.equal(r.close, 1007, 'invalid UTF-8');
  r = await runRaw([0xc1, 0x00]);
  assert.equal(r.close, 1002, 'reserved bit');
  const flood = [0x01, 0x00];
  for (let i = 0; i < 300; i++) flood.push(0x00, 0x00);
  r = await runRaw(flood);
  assert.equal(r.close, 1009, 'empty-fragment flood');
});

test('ws: closing before the handshake completes never opens', async () => {
  const { WsClient } = require('../src/main/remote/wsClient');
  const srv = await rawServer(null).start();
  const ws = new WsClient(srv.url);
  const ev = [];
  ws.on('open', () => ev.push('open'));
  ws.on('close', () => ev.push('close'));
  ws.connect();
  ws.close();
  await sleep(300);
  assert.deepEqual(ev, ['close']);
  assert.equal(ws.send('x'), false);
  srv.close();
});

test('pushes mask secrets, and a truncated command can only be denied remotely', async () => {
  const { sm, policy, ch, bridge } = setup();
  policy.idle = 999;
  const a = respondSpy(), b = respondSpy();
  sm.handleEvent({ hook_event_name: 'PermissionRequest', session_id: 's1', _source: 'claude', tool_name: 'Bash', tool_input: { command: 'curl -H "Authorization: Bearer abc.def.ghi" https://x --token=s3cr3t sk-ABCDEFGHIJKLMNOPQRSTU' } }, a);
  sm.handleEvent({ hook_event_name: 'PermissionRequest', session_id: 's2', _source: 'claude', tool_name: 'Bash', tool_input: { command: 'echo ' + 'x'.repeat(3000) } }, b);
  age(sm, 10000);
  bridge.evaluate();
  const [m1, m2] = ch.sent.map(s => s.text);
  assert.ok(!/abc\.def\.ghi|s3cr3t|sk-ABCDEF/.test(m1), m1);
  assert.match(m1, /｜curl/);
  assert.match(m2, /只能拒绝/);
  const id2 = Number(/#(\d+)/.exec(m2)[1]);
  await bridge.handle(dm(`${id2} y`));
  assert.match(ch.replies.pop(), /不能远程允许/);
  assert.equal(b.sent.length, 0);
  await bridge.handle(dm(`${id2} n`));
  assert.equal(decisionOf(b.sent[0]).behavior, 'deny');
});

test('a burst is capped per minute with one backlog note; unbinding retires old ids', async () => {
  const { sm, policy, ch, bridge, config } = setup();
  policy.idle = 999;
  for (let i = 0; i < 8; i++) sm.handleEvent({ hook_event_name: 'PermissionRequest', session_id: 's' + i, _source: 'claude', tool_name: 'Bash', tool_input: { command: 'ls ' + i } }, respondSpy());
  age(sm, 10000);
  bridge.evaluate();
  bridge.evaluate();
  const pushes = ch.sent.filter(s => /授权/.test(s.text));
  assert.equal(pushes.length, 5);
  assert.equal(ch.sent.filter(s => /排队/.test(s.text)).length, 1);
  const id = Number(/#(\d+)/.exec(pushes[0].text)[1]);
  bridge.unbind();
  config.data.remoteStaffId = 'u1';
  await bridge.handle(dm(`${id} y`));
  assert.match(ch.replies.pop(), /没有 #/);
});

test('messages for another robot, non-text messages and DND are ignored', async () => {
  const { sm, policy, ch, bridge } = setup();
  await bridge.handle({ ...dm('ls'), robotCode: 'other' });
  await bridge.handle({ ...dm('ls'), msgtype: 'picture' });
  assert.equal(ch.replies.length, 0);
  policy.idle = 999;
  policy.dndActive = () => true;
  sm.handleEvent({ hook_event_name: 'PermissionRequest', session_id: 's1', _source: 'claude', tool_name: 'Bash', tool_input: { command: 'ls' } }, respondSpy());
  age(sm, 10000);
  bridge.evaluate();
  assert.equal(ch.sent.length, 0);
  await bridge.handle(dm('ls'));
  assert.match(ch.replies.pop(), /授权|待处理|逐条/, 'answers still work during DND');
});

test('Codex counter-examples: cut-then-masked commands, JSON secrets, cut questions', async () => {
  const { sm, policy, ch, bridge } = setup();
  policy.idle = 999;
  const a = respondSpy(), b = respondSpy(), c = respondSpy();
  sm.handleEvent({ hook_event_name: 'PermissionRequest', session_id: 's1', _source: 'claude', tool_name: 'Bash', tool_input: { command: 'token=' + 'x'.repeat(9000) + '; rm -rf dangerous' } }, a);
  sm.handleEvent({ hook_event_name: 'PermissionRequest', session_id: 's2', _source: 'claude', tool_name: 'mcp__db__query', tool_input: { sql: 'select 1', token: 'tk-123456', password: 'hunter22' } }, b);
  sm.handleEvent({ hook_event_name: 'PermissionRequest', session_id: 's3', _source: 'claude', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Q' + 'q'.repeat(1200), header: 'h', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }] } }, c);
  age(sm, 10000);
  bridge.evaluate();
  const [m1, m2, m3] = ch.sent.map(x => x.text);
  const id = (m) => Number(/#(\d+)/.exec(m)[1]);
  assert.match(m1, /只能拒绝/);
  await bridge.handle(dm(`${id(m1)} y`));
  assert.equal(a.sent.length, 0, 'a cut command is never approved remotely, even after masking shortened it');
  assert.ok(!/tk-123456|hunter22/.test(m2), m2);
  assert.match(m3, /只能「\d+ n」取消/);
  await bridge.handle(dm(`${id(m3)} 1`));
  assert.equal(c.sent.length, 0);
  await bridge.handle(dm(`${id(m3)} n`));
  assert.equal(decisionOf(c.sent[0]).behavior, 'deny');
});

test('a failed notice is retried; ls respects the push budget; a lost delivery is reported honestly', async () => {
  const { sm, policy, ch, bridge } = setup();
  policy.idle = 999;
  let fail = true;
  const realSend = ch.sendText;
  ch.sendText = async (staffId, text) => { if (fail && /受阻/.test(text)) throw new Error('net'); return realSend(staffId, text); };
  sm.handleEvent({ hook_event_name: 'StopFailure', session_id: 's9', _source: 'claude', error: 'rate_limit' }, null);
  sm.attention.get('s9').since -= 60000;
  bridge.evaluate();
  await sleep(10);
  fail = false;
  bridge.evaluate();
  await sleep(10);
  assert.equal(ch.sent.filter(x => /受阻/.test(x.text)).length, 1, 'retried after the failure');

  for (let i = 0; i < 9; i++) sm.handleEvent({ hook_event_name: 'PermissionRequest', session_id: 'p' + i, _source: 'claude', tool_name: 'Bash', tool_input: { command: 'ls ' + i } }, respondSpy());
  bridge._pushLog = [];
  await bridge.handle(dm('ls'));
  assert.ok(ch.sent.filter(x => /授权/.test(x.text)).length <= 5);
  assert.match(ch.replies.pop(), /排队/);

  const dead = () => false;
  sm.handleEvent({ hook_event_name: 'PermissionRequest', session_id: 'z', _source: 'claude', tool_name: 'Bash', tool_input: { command: 'pwd' } }, dead);
  const zid = Array.from(sm.pendingPermissions.entries()).find(([, p]) => p.sessionId === 'z')[0];
  bridge._push('perm', { id: zid, sessionId: 'z', toolName: 'Bash', display: { command: 'pwd' } });
  const shortId = bridge._byReq.get(zid);
  await bridge.handle(dm(`${shortId} y`));
  assert.match(ch.replies.pop(), /没能送达/);
  await bridge.handle(dm(`${shortId} y`));
  assert.match(ch.replies.pop(), /上次没能送达/);
});

test('a message without a text type is ignored', async () => {
  const { ch, bridge } = setup();
  await bridge.handle({ staffId: 'u1', single: true, text: 'ls', nick: 'n' });
  assert.equal(ch.replies.length, 0);
});

test('masking covers quoted JSON keys, values with spaces, and nested structured inputs', () => {
  const { redact, redactObject } = RemoteBridge;
  const s = redact('{"Authorization": "Bearer abc def", "password": "a b c", "user": "me"}');
  assert.ok(!/abc def|a b c/.test(s), s);
  assert.match(s, /"user": "me"/);
  const o = redactObject({ db: { password: 'p w', host: 'h' }, headers: [{ 'X-Api-Key': 'k1' }], sql: 'select 1' });
  assert.deepEqual(o, { db: { password: '***', host: 'h' }, headers: [{ 'X-Api-Key': '***' }], sql: 'select 1' });
});
