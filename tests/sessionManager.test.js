'use strict';

const { stubWatcher, respondSpy, decisionOf } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const SessionManager = require('../src/main/sessionManager');

function mk() {
  const watcher = stubWatcher();
  const sm = new SessionManager({ transcriptWatcher: watcher });
  sm.watcher = watcher;
  return sm;
}

function perm(sm, extra = {}) {
  const respond = respondSpy();
  sm.handleEvent({
    hook_event_name: 'PermissionRequest', session_id: 's1', _source: 'claude',
    tool_name: 'Bash', tool_input: { command: 'npm test' }, transcript_path: 'C:/x.jsonl', ...extra
  }, respond);
  const id = Array.from(sm.pendingPermissions.keys()).pop();
  return { id, respond };
}

function ev(sm, name, extra = {}) {
  sm.handleEvent({ hook_event_name: name, session_id: 's1', _source: 'claude', ...extra }, null);
}

test('approving twice answers the hook exactly once', () => {
  const sm = mk();
  const { id, respond } = perm(sm);
  assert.deepEqual(sm.approvePermission(id, 'allow'), { ok: true, status: 'accepted' });
  assert.deepEqual(sm.approvePermission(id, 'allow'), { ok: false, status: 'already-settled' });
  assert.equal(respond.sent.length, 1);
  assert.equal(decisionOf(respond.sent[0]).behavior, 'allow');
  sm.destroy();
});

test('answering one of two requests keeps the session waiting', () => {
  const sm = mk();
  const a = perm(sm);
  perm(sm, { tool_input: { command: 'npm run build' } });
  sm.approvePermission(a.id, 'deny');
  assert.equal(sm.sessions.get('s1').status, 'waiting_permission');
  sm.destroy();
});

test('deny with a reason uses decision.message, never feedback', () => {
  const sm = mk();
  const { id, respond } = perm(sm);
  sm.approvePermission(id, 'deny', null, 'clarify please');
  const d = decisionOf(respond.sent[0]);
  assert.equal(d.behavior, 'deny');
  assert.equal(d.message, 'clarify please');
  assert.equal(d.feedback, undefined);
  assert.equal(d.interrupt, undefined);
  sm.destroy();
});

test('AskUserQuestion: multi-select joins labels and echoes the original questions', () => {
  const sm = mk();
  const questions = [
    { question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] },
    { question: 'Pick many', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] }
  ];
  const { id, respond } = perm(sm, { tool_name: 'AskUserQuestion', tool_input: { questions, metadata: { k: 1 } } });
  assert.equal(sm.approvePermission(id, 'allow', { 'Pick one': 'A' }).status, 'invalid');
  const r = sm.approvePermission(id, 'allow', { 'Pick one': 'A', 'Pick many': ['X', 'Y'] });
  assert.equal(r.status, 'accepted');
  const d = decisionOf(respond.sent[0]);
  assert.deepEqual(d.updatedInput.answers, { 'Pick one': 'A', 'Pick many': 'X, Y' });
  assert.deepEqual(d.updatedInput.questions, questions);
  assert.deepEqual(d.updatedInput.metadata, { k: 1 });
  sm.destroy();
});

test('always-allow uses one scoped session rule and is rejected without a suggestion', () => {
  const sm = mk();
  const suggestions = [
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
    { type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }] }
  ];
  const a = perm(sm, { permission_suggestions: suggestions });
  assert.equal(sm.getState().pendingPermissions[0].alwaysLabel, 'Bash(npm test:*)');
  sm.approvePermission(a.id, 'always');
  const upd = decisionOf(a.respond.sent[0]).updatedPermissions;
  assert.equal(upd.length, 1);
  assert.equal(upd[0].destination, 'session');
  assert.equal(upd[0].type, 'addRules');

  const b = perm(sm);
  assert.equal(sm.approvePermission(b.id, 'always').status, 'invalid');
  assert.equal(b.respond.sent.length, 0);
  sm.destroy();
});

test('a finished call retires the card it is bound to', () => {
  const sm = mk();
  ev(sm, 'PreToolUse', { tool_use_id: 'tA', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  const { id, respond } = perm(sm);
  assert.equal(sm.pendingPermissions.get(id).binding.state, 'confirmed');
  assert.deepEqual(sm.watcher.calls[0], ['watch', id, 'C:/x.jsonl', 'tA']);
  ev(sm, 'PostToolUse', { tool_use_id: 'tA', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  assert.equal(sm.pendingPermissions.has(id), false);
  assert.deepEqual(respond.sent, ['{}']);
  const r = sm.getState().recentlyResolved.find(x => x.id === id);
  assert.equal(r.outcome, 'executed');
  sm.destroy();
});

test('a different call finishing never retires an unrelated card', () => {
  const sm = mk();
  ev(sm, 'PreToolUse', { tool_use_id: 'tA', tool_name: 'Bash', tool_input: { command: 'ls' } });
  ev(sm, 'PreToolUse', { tool_use_id: 'tB', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  const { id } = perm(sm);
  assert.equal(sm.pendingPermissions.get(id).binding.toolUseId, 'tB');
  ev(sm, 'PostToolUse', { tool_use_id: 'tA', tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.equal(sm.pendingPermissions.has(id), true);
  sm.destroy();
});

test('identical parallel calls stay ambiguous and are not inferred', () => {
  const sm = mk();
  ev(sm, 'PreToolUse', { tool_use_id: 'tA', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  ev(sm, 'PreToolUse', { tool_use_id: 'tB', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  const { id } = perm(sm);
  assert.equal(sm.pendingPermissions.get(id).binding.state, 'ambiguous');
  ev(sm, 'PostToolUse', { tool_use_id: 'tA', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  assert.equal(sm.pendingPermissions.has(id), true);
  assert.equal(sm.watcher.calls.length, 0);
  sm.destroy();
});

test('one call id binds at most one card', () => {
  const sm = mk();
  ev(sm, 'PreToolUse', { tool_use_id: 'tA', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  const p1 = perm(sm);
  ev(sm, 'PreToolUse', { tool_use_id: 'tB', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  const p2 = perm(sm);
  assert.equal(sm.pendingPermissions.get(p1.id).binding.toolUseId, 'tA');
  assert.equal(sm.pendingPermissions.get(p2.id).binding.toolUseId, 'tB');
  ev(sm, 'PostToolUse', { tool_use_id: 'tB', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  assert.equal(sm.pendingPermissions.has(p1.id), true);
  assert.equal(sm.pendingPermissions.has(p2.id), false);
  sm.destroy();
});

test('a new prompt retires main-agent cards but never subagent ones', () => {
  const sm = mk();
  const main = perm(sm);
  const sub = perm(sm, { agent_id: 'agent-1', tool_input: { command: 'npm run lint' } });
  ev(sm, 'UserPromptSubmit', { prompt: 'next' });
  assert.equal(sm.pendingPermissions.has(main.id), false);
  assert.deepEqual(main.respond.sent, ['{}']);
  assert.equal(sm.pendingPermissions.has(sub.id), true);
  assert.equal(sm.sessions.get('s1').status, 'waiting_permission');
  sm.destroy();
});

test('Stop only retires cards from its own prompt when prompt ids are known', () => {
  const sm = mk();
  const p = perm(sm, { prompt_id: 'p2' });
  ev(sm, 'Stop', { prompt_id: 'p1' });
  assert.equal(sm.pendingPermissions.has(p.id), true);
  ev(sm, 'Stop', { prompt_id: 'p2' });
  assert.equal(sm.pendingPermissions.has(p.id), false);
  sm.destroy();
});

test('bridge disconnect settles without writing a response', () => {
  const sm = mk();
  const { id, respond } = perm(sm);
  sm.cancelPendingByRespond(respond);
  assert.equal(sm.pendingPermissions.has(id), false);
  assert.equal(respond.sent.length, 0);
  assert.equal(sm.getState().recentlyResolved.find(x => x.id === id).reason, 'disconnect');
  assert.equal(sm.sessions.get('s1').status, 'thinking');
  sm.destroy();
});

test('transcript rejection settles the bound card as rejected', () => {
  const sm = mk();
  ev(sm, 'PreToolUse', { tool_use_id: 'tA', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  const { id, respond } = perm(sm);
  sm._onTranscriptResult(id, 'tWRONG', { rejected: true });
  assert.equal(sm.pendingPermissions.has(id), true);
  sm._onTranscriptResult(id, 'tA', { rejected: true });
  assert.equal(sm.pendingPermissions.has(id), false);
  assert.deepEqual(respond.sent, ['{}']);
  assert.equal(sm.getState().recentlyResolved.find(x => x.id === id).outcome, 'rejected');
  sm.destroy();
});

test('display contract carries the full command, not the summary', () => {
  const sm = mk();
  const long = 'mvn -q -f D:/a/very/long/path/pom.xml compile -DskipTests && echo done';
  perm(sm, { tool_input: { command: long, description: 'compile' } });
  const p = sm.getState().pendingPermissions[0];
  assert.equal(p.display.command, long);
  assert.equal(p.display.description, 'compile');
  assert.equal(p.toolInput, 'compile');
  sm.destroy();
});

test('a consumed call id never binds a later identical request', () => {
  const sm = mk();
  const sub = { agent_id: 'agent-1' };
  ev(sm, 'PreToolUse', { tool_use_id: 'tA', tool_name: 'Bash', tool_input: { command: 'npm test' }, ...sub });
  const p1 = perm(sm, sub);
  sm.approvePermission(p1.id, 'allow');
  const p2 = perm(sm, sub);
  assert.equal(sm.pendingPermissions.get(p2.id).binding.state, 'unbound');
  ev(sm, 'PostToolUse', { tool_use_id: 'tA', tool_name: 'Bash', tool_input: { command: 'npm test' }, ...sub });
  assert.equal(sm.pendingPermissions.has(p2.id), true);
  sm.destroy();
});

test('a denied call does not make the next identical request ambiguous', () => {
  const sm = mk();
  ev(sm, 'PreToolUse', { tool_use_id: 'tA', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  const p1 = perm(sm);
  sm.approvePermission(p1.id, 'deny');
  ev(sm, 'PreToolUse', { tool_use_id: 'tB', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  const p2 = perm(sm);
  assert.equal(sm.pendingPermissions.get(p2.id).binding.toolUseId, 'tB');
  ev(sm, 'PostToolUse', { tool_use_id: 'tB', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  assert.equal(sm.pendingPermissions.has(p2.id), false);
  sm.destroy();
});

test('over-long answers are rejected instead of truncated', () => {
  const sm = mk();
  const questions = [{ question: 'Why?', options: [{ label: 'A' }] }];
  const { id, respond } = perm(sm, { tool_name: 'AskUserQuestion', tool_input: { questions } });
  assert.equal(sm.approvePermission(id, 'allow', { 'Why?': 'x'.repeat(4001) }).status, 'invalid');
  assert.equal(respond.sent.length, 0);
  assert.equal(sm.pendingPermissions.has(id), true);
  sm.destroy();
});
