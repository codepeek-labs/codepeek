'use strict';

const { TMP_HOME, stubWatcher } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const codexOrigin = require('../src/main/codexOrigin');
const AttentionStore = require('../src/main/attentionStore');
const SessionManager = require('../src/main/sessionManager');

const ROOT = path.join(TMP_HOME, 'codex-sessions');

function v7(ms, tail) {
  const h = ms.toString(16).padStart(12, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7abc-8def-${tail}`;
}

function writeRollout(id, ms, payload) {
  const d = new Date(ms);
  const dir = path.join(ROOT, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-01-01T00-00-00-${id}.jsonl`);
  const meta = { type: 'session_meta', payload: { id, cwd: 'D:/p', base_instructions: 'x'.repeat(40000), ...payload } };
  fs.writeFileSync(file, JSON.stringify(meta) + '\n{"type":"event"}\n');
  return file;
}

test('only interactive Codex front ends count as the user\'s own sessions', () => {
  assert.equal(codexOrigin.isHelper({ originator: 'Codex Desktop', source: 'vscode' }), false);
  assert.equal(codexOrigin.isHelper({ originator: 'codex_cli_rs', source: 'cli' }), false);
  assert.equal(codexOrigin.isHelper({ originator: 'Claude Code', source: 'vscode' }), true);
  assert.equal(codexOrigin.isHelper({ originator: 'codex_exec', source: 'exec' }), true);
  assert.equal(codexOrigin.isHelper({ originator: 'codex_mcp', source: 'mcp' }), true);
  assert.equal(codexOrigin.isHelper({ originator: 'Codex Desktop', source: { subagent: { thread_spawn: {} } } }), true);
});

test('a rollout is found from its v7 id and read past a long first line', () => {
  const ms = Date.now() - 3600 * 1000;
  const id = v7(ms, '000000000001');
  const file = writeRollout(id, ms, { originator: 'Claude Code', source: 'vscode' });
  assert.equal(codexOrigin.findRollout(id, ROOT), file);
  const meta = codexOrigin.lookup(id, undefined, ROOT);
  assert.equal(meta.id, id);
  assert.equal(meta.helper, true);
  assert.equal(codexOrigin.findRollout('not-a-v7-id', ROOT), null);
  assert.equal(codexOrigin.lookup(v7(ms, '000000000099'), undefined, ROOT), null, 'not written yet');
});

test('a transcript describing another thread does not classify the session', () => {
  const ms = Date.now() - 7200 * 1000;
  const root = v7(ms, '000000000002');
  const sub = v7(ms + 1000, '000000000003');
  writeRollout(root, ms, { originator: 'Codex Desktop', source: 'vscode' });
  const subFile = writeRollout(sub, ms + 1000, { originator: 'Codex Desktop', source: { subagent: {} }, session_id: root });
  const meta = codexOrigin.lookup(root, subFile, ROOT);
  assert.equal(meta.id, root);
  assert.equal(meta.helper, false);
});

function mk(metas) {
  return new SessionManager({
    transcriptWatcher: stubWatcher(),
    attentionStore: new AttentionStore({ path: null }),
    presenceProbe: () => null,
    codexMeta: (id) => metas[id] || null
  });
}

const claudeActive = { hook_event_name: 'PreToolUse', session_id: 'claude-1', _source: 'claude', cwd: 'D:/p', tool_use_id: 'x', tool_name: 'Read', tool_input: {} };

test('an agent-run Codex reply never enters the inbox or alerts', () => {
  const sm = mk({ 'cx-helper': { helper: true } });
  const done = [];
  sm.on('completion', (c) => done.push(c));
  sm.handleEvent({ hook_event_name: 'Stop', session_id: 'cx-helper', _source: 'codex', cwd: 'D:/elsewhere', last_assistant_message: 'review done' }, null);
  assert.equal(done.length, 0);
  assert.equal(sm.getState().attention.length, 0);
  const s = sm.getState().sessions.find(x => x.id === 'cx-helper');
  assert.equal(s.helper, true);
  assert.equal(s.lastResponse, 'review done');
  sm.destroy();
});

test('a Codex launched from Claude\'s environment is agent-run even without a rollout', () => {
  const sm = mk({});
  const done = [];
  sm.on('completion', (c) => done.push(c));
  sm.handleEvent({ hook_event_name: 'Stop', session_id: 'cx-eph', _source: 'codex', bridge_spawned_by: 'claude', cwd: 'D:/p/sub', last_assistant_message: '{"verdict":"ok"}' }, null);
  assert.equal(done.length, 0);
  assert.equal(sm.getState().attention.length, 0);
  sm.destroy();
});

test('the user\'s own Codex session alerts even beside an active Claude session', () => {
  const sm = mk({ 'cx-own': { helper: false } });
  const done = [];
  sm.on('completion', (c) => done.push(c));
  sm.handleEvent(claudeActive, null);
  sm.handleEvent({ hook_event_name: 'Stop', session_id: 'cx-own', _source: 'codex', cwd: 'D:/p', last_assistant_message: 'hi' }, null);
  assert.equal(done.length, 1);
  assert.equal(sm.getState().attention.length, 1);
  sm.destroy();
});

test('alert-next still reports an agent-run Codex reply', () => {
  const sm = mk({ 'cx-helper': { helper: true } });
  const done = [];
  sm.on('completion', (c) => done.push(c));
  sm.attention.setAlertNext('cx-helper', true);
  sm.handleEvent({ hook_event_name: 'Stop', session_id: 'cx-helper', _source: 'codex', cwd: 'D:/p', last_assistant_message: 'x' }, null);
  assert.equal(done.length, 1);
  assert.equal(sm.getState().attention.length, 1);
  sm.destroy();
});

test('a reply recorded before its origin was known is dropped once it is', () => {
  const metas = {};
  const sm = mk(metas);
  sm.handleEvent({ hook_event_name: 'Stop', session_id: 'cx-late', _source: 'codex', cwd: 'D:/q', last_assistant_message: 'x' }, null);
  assert.equal(sm.getState().attention.length, 1, 'unknown origin keeps the reply');
  metas['cx-late'] = { helper: true };
  sm.handleEvent({ hook_event_name: 'PostToolUse', session_id: 'cx-late', _source: 'codex', tool_use_id: 'y', tool_name: 'Bash' }, null);
  assert.equal(sm.getState().attention.length, 0);
  sm.destroy();
});

test('stored agent-run Codex replies are swept, alert-next ones kept', () => {
  const store = new AttentionStore({ path: null });
  store.reply('cx-a', { agent: 'codex' }, 'a');
  store.reply('cx-b', { agent: 'codex' }, 'b');
  store.setAlertNext('cx-b', true);
  store.reply('cx-c', { agent: 'codex' }, 'c');
  store.reply('cl-d', { agent: 'claude' }, 'd');
  const sm = new SessionManager({
    transcriptWatcher: stubWatcher(), attentionStore: store, presenceProbe: () => null,
    codexMeta: (id) => ({ 'cx-a': { helper: true }, 'cx-b': { helper: true }, 'cx-c': { helper: false } })[id] || null
  });
  assert.equal(sm.dropHelperRecords(), 1);
  assert.deepEqual(sm.getState().attention.map(a => a.sessionId).sort(), ['cl-d', 'cx-b', 'cx-c']);
  sm.destroy();
});

test('a scanned agent-run session clears its inbox entry', () => {
  const sm = mk({});
  sm.handleEvent({ hook_event_name: 'Stop', session_id: 'cx-s', _source: 'codex', cwd: 'D:/q', last_assistant_message: 'x' }, null);
  assert.equal(sm.getState().attention.length, 1);
  sm.updateScannedSessions([{ id: 'cx-s', agent: 'codex', helper: true }]);
  assert.equal(sm.getState().attention.length, 0);
  sm.destroy();
});
