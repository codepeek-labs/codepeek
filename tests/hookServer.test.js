'use strict';

const { stubWatcher } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const HookServer = require('../src/main/hookServer');
const SessionManager = require('../src/main/sessionManager');

async function boot() {
  const sm = new SessionManager({ transcriptWatcher: stubWatcher() });
  const server = new HookServer(sm, 0);
  await server.start();
  server.port = server.server.address().port;
  return { sm, server };
}

function post(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: '/hook', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } }, res => {
      let out = '';
      res.on('data', d => { out += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('rejects missing token, bad JSON and oversize bodies', async () => {
  const { sm, server } = await boot();
  const auth = { 'X-CodePeek-Token': server.token };
  assert.equal((await post(server.port, { session_id: 's' })).status, 401);
  assert.equal((await post(server.port, '{nope', auth)).status, 400);
  const big = JSON.stringify({ session_id: 's', pad: '字'.repeat(400 * 1024) });
  const r = await post(server.port, big, auth).catch(() => ({ status: 413 }));
  assert.equal(r.status, 413);
  await server.stop();
  sm.destroy();
});

test('a dropped blocking connection cancels its pending card', async () => {
  const { sm, server } = await boot();
  const data = JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 's', _source: 'claude', tool_name: 'Bash', tool_input: { command: 'ls' } });
  const req = http.request({ host: '127.0.0.1', port: server.port, path: '/hook', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-CodePeek-Token': server.token } });
  req.on('error', () => {});
  req.end(data);
  await new Promise(r => setTimeout(r, 150));
  assert.equal(sm.pendingPermissions.size, 1);
  req.destroy();
  await new Promise(r => setTimeout(r, 150));
  assert.equal(sm.pendingPermissions.size, 0);
  await server.stop();
  sm.destroy();
});

test('non-blocking events still get in when the pending cap is reached', async () => {
  const { sm, server } = await boot();
  for (let i = 0; i < 200; i++) sm.pendingPermissions.set('fake' + i, { sessionId: 'z', binding: {}, respond: () => false });
  const auth = { 'X-CodePeek-Token': server.token };
  const blocked = await post(server.port, { hook_event_name: 'PermissionRequest', session_id: 's', tool_name: 'Bash' }, auth);
  assert.equal(blocked.status, 503);
  const ok = await post(server.port, { hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Bash' }, auth);
  assert.equal(ok.status, 200);
  sm.pendingPermissions.clear();
  await server.stop();
  sm.destroy();
});
