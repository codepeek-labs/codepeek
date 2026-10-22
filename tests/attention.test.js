'use strict';

const { TMP_HOME, stubWatcher, respondSpy } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const AttentionStore = require('../src/main/attentionStore');
const AttentionPolicy = require('../src/main/attentionPolicy');
const SessionManager = require('../src/main/sessionManager');
const { matchForegroundSession, cleanTitle } = AttentionPolicy;

const memConfig = (init = {}) => {
  const data = { ...init };
  return { get: (k) => data[k], set: (k, v) => { data[k] = v; }, data };
};

test('an older read receipt never hides a newer reply', () => {
  const st = new AttentionStore({ path: null });
  const v1 = st.reply('s1', { name: 'a' }, 'first').version;
  st.reply('s1', null, 'second');
  st.markSeen('s1', v1);
  assert.equal(st.list().length, 1);
  st.markSeen('s1');
  assert.equal(st.list().length, 0);
});

test('needs-input and blocked stay until the session moves on', () => {
  const st = new AttentionStore({ path: null });
  st.flag('s1', null, 'blocked', 'rate_limit');
  assert.equal(st.markSeen('s1'), false);
  assert.equal(st.list()[0].kind, 'blocked');
  st.clear('s1');
  assert.equal(st.list().length, 0);
});

test('records survive a restart and alert-next is consumed once', () => {
  const file = path.join(TMP_HOME, 'attention-test.json');
  const a = new AttentionStore({ path: file });
  a.reply('s1', { name: 'proj', cwd: 'D:/p' }, 'done');
  a.setAlertNext('s2', true);
  a.flush();
  const b = new AttentionStore({ path: file });
  assert.equal(b.list()[0].name, 'proj');
  assert.equal(b.consumeAlertNext('s2'), true);
  assert.equal(b.consumeAlertNext('s2'), false);
});

test('foreground match ignores the status glyph and needs a unique, ancestry-backed session', () => {
  assert.equal(cleanTitle('◑ DEMO新功能'), 'demo新功能');
  const procMap = new Map([[300, { parentPid: 200, createdAt: 3 }], [200, { parentPid: 100, createdAt: 2 }], [100, { parentPid: 1, createdAt: 1 }]]);
  const sessions = [{ id: 'a', name: 'DEMO新功能', pid: 300 }, { id: 'b', name: '代码分析', pid: 999 }];
  assert.deepEqual(matchForegroundSession({ title: '✳ DEMO新功能', pid: 100 }, sessions, procMap), { sessionId: 'a', confidence: 'confirmed' });
  assert.deepEqual(matchForegroundSession({ title: '✳ DEMO新功能', pid: 555 }, sessions, procMap), { sessionId: 'a', confidence: 'likely' });
  assert.equal(matchForegroundSession({ title: 'Windows Terminal', pid: 100 }, sessions, procMap), null);
  const dup = sessions.concat({ id: 'c', name: 'demo新功能', pid: 300 });
  assert.equal(matchForegroundSession({ title: 'DEMO新功能', pid: 100 }, dup, procMap), null);
});

test('completion alert modes', () => {
  const cfg = memConfig({ completionAlert: 'quiet', shortTurnSeconds: 20 });
  const p = new AttentionPolicy({ config: cfg });
  assert.equal(p.shouldExpandCompletion({ turnMs: 600000, looking: false, alertNext: false }), false);
  assert.equal(p.shouldExpandCompletion({ turnMs: 1000, looking: false, alertNext: true }), true);
  cfg.data.completionAlert = 'smart';
  assert.equal(p.shouldExpandCompletion({ turnMs: 5000, looking: false }), false);
  assert.equal(p.shouldExpandCompletion({ turnMs: 60000, looking: true }), false);
  assert.equal(p.shouldExpandCompletion({ turnMs: 60000, looking: false }), true);
  cfg.data.completionAlert = 'always';
  assert.equal(p.shouldExpandCompletion({ turnMs: 1, looking: true }), true);
  p.setAway(true, 'lock');
  assert.equal(p.shouldExpandCompletion({ turnMs: 1, looking: false, alertNext: true }), false);
  cfg.data.suppressNotifications = true;
  p.setAway(false);
  assert.equal(p.shouldExpandCompletion({ turnMs: 60000, looking: false }), false);
});

test('leaving away or do-not-disturb emits exactly one summary edge', () => {
  const cfg = memConfig({ dndUntil: 0, awayIdleSeconds: 120 });
  let idle = 0;
  const p = new AttentionPolicy({ config: cfg, getIdleSeconds: () => idle });
  const edges = [];
  p.on('quiet-ended', (e) => edges.push(e));
  idle = 300; p.pollIdle();
  assert.equal(p.away, true);
  p.setDnd(30);
  idle = 0; p.pollIdle();
  assert.equal(edges.length, 0, 'still in DND');
  p.setDnd(0);
  assert.equal(edges.length, 1);
  assert.ok(edges[0].since > 0);
  p.stop();
});

function mk(presence = true) {
  return new SessionManager({ transcriptWatcher: stubWatcher(), attentionStore: new AttentionStore({ path: null }), presenceProbe: () => presence });
}
const ev = (sm, name, extra = {}) => sm.handleEvent({ hook_event_name: name, session_id: 's1', _source: 'claude', ...extra }, null);

test('Stop records its own final message; a turn ending with background work still alerts', () => {
  const sm = mk();
  const done = [];
  sm.on('completion', (c) => done.push(c));
  ev(sm, 'UserPromptSubmit', { prompt: 'do it' });
  ev(sm, 'Stop', { last_assistant_message: '全部完成', background_tasks: [{ id: 'x' }] });
  assert.equal(done.length, 1, 'the reply is a finished turn even while background work runs');
  assert.equal(sm.sessions.get('s1').status, 'background');
  ev(sm, 'Stop', { last_assistant_message: '全部完成' });
  assert.equal(done.length, 1, 'a second Stop within a second is merged');
  assert.equal(sm.sessions.get('s1').status, 'idle');
  assert.equal(done[0].lastResponse, '全部完成');
  assert.ok(done[0].turnMs >= 0);
  const att = sm.getState().attention;
  assert.equal(att[0].kind, 'reply');
  assert.equal(att[0].text, '全部完成');
  assert.equal(sm.getState().sessions[0].lastPrompt, 'do it');
  ev(sm, 'UserPromptSubmit', { prompt: 'next' });
  assert.equal(sm.getState().attention.length, 0);
  sm.destroy();
});

test('Claude notifications become inbox entries only when the terminal needs the user', () => {
  const sm = mk();
  ev(sm, 'Notification', { notification_type: 'idle_prompt', message: 'waiting' });
  assert.equal(sm.getState().attention.length, 0);
  sm.handleEvent({ hook_event_name: 'PermissionRequest', session_id: 's1', _source: 'claude', tool_name: 'Bash', tool_input: { command: 'ls' } }, respondSpy());
  ev(sm, 'Notification', { notification_type: 'permission_prompt', message: 'needs approval' });
  assert.equal(sm.getState().attention.length, 0, 'our own card already covers it');
  ev(sm, 'Notification', { notification_type: 'agent_needs_input', message: 'background agent asks' });
  assert.equal(sm.getState().attention[0].kind, 'input');
  ev(sm, 'PreToolUse', { tool_use_id: 't9', tool_name: 'Read', tool_input: {} });
  assert.equal(sm.getState().attention.length, 0);
  sm.destroy();
});

test('StopFailure marks the session blocked until the next prompt', () => {
  const sm = mk();
  ev(sm, 'StopFailure', { error: 'rate_limit' });
  const a = sm.getState().attention[0];
  assert.equal(a.kind, 'blocked');
  assert.equal(a.reason, 'rate_limit');
  ev(sm, 'UserPromptSubmit', { prompt: 'retry' });
  assert.equal(sm.getState().attention.length, 0);
  sm.destroy();
});

test('waiting long never auto-denies; a vanished CLI process does after two refreshes', () => {
  const sm = mk();
  const respond = respondSpy();
  sm.handleEvent({ hook_event_name: 'PermissionRequest', session_id: 's1', _source: 'claude', tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] } }, respond);
  const id = Array.from(sm.pendingPermissions.keys())[0];
  sm.pendingPermissions.get(id).timestamp = Date.now() - 3600 * 1000;
  sm._cleanupStaleSessions();
  assert.equal(sm.pendingPermissions.has(id), true);
  assert.equal(respond.sent.length, 0);

  sm.scannedSessions = [{ id: 's1', pid: 4242 }];
  const procMap = new Map([[1, { parentPid: 0 }]]);
  sm.reapOrphans(procMap, 1);
  sm.reapOrphans(procMap, 1);
  assert.equal(sm.pendingPermissions.has(id), true, 'same refresh counted once');
  sm.reapOrphans(procMap, 2);
  assert.equal(sm.pendingPermissions.has(id), false);
  assert.equal(JSON.parse(respond.sent[0]).hookSpecificOutput.decision.behavior, 'deny');
  sm.destroy();
});

test('hook repair keeps third-party handlers that share a group with ours', () => {
  const fs = require('fs');
  const hookInstaller = require('../src/main/hookInstaller');
  const settingsPath = path.join(TMP_HOME, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const bridge = path.join(TMP_HOME, '.codepeek', 'bridge.js').split(path.sep).join('/');
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [
    { type: 'command', command: `node "${bridge}" --source claude`, timeout: 1 },
    { type: 'command', command: 'audit.sh', timeout: 3 }
  ] }] } }));
  hookInstaller.installHooks();
  const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const stop = after.hooks.Stop[0].hooks;
  assert.equal(stop.length, 2);
  assert.ok(stop.some(h => h.command === 'audit.sh'));
  assert.equal(stop.find(h => h.command.includes('bridge.js')).timeout, 5);
  assert.ok(after.hooks.StopFailure);
  assert.deepEqual(hookInstaller.getHookHealth().missing, []);
});

test('an unattended or CodePeek-covered terminal is not "looking"', () => {
  const p = new AttentionPolicy({ config: memConfig({}) });
  const procMap = new Map([[300, { parentPid: 100, createdAt: 2 }], [100, { parentPid: 1, createdAt: 1 }]]);
  const sessions = [{ id: 'a', name: 'proj', pid: 300 }];
  p.setForeground({ title: '✳ proj', pid: 100 }, sessions, procMap, new Set([42]));
  assert.equal(p.isLookingAt('a'), true);
  p.setAway(true, 'idle');
  assert.equal(p.isLookingAt('a'), false);
  p.setAway(false);
  p.setForeground({ title: 'CodePeek', pid: 42 }, sessions, procMap, new Set([42]));
  assert.equal(p.isLookingAt('a'), false);
  p.stop();
});

test('fullscreen is part of the quiet period and the summary waits for the last source', () => {
  const p = new AttentionPolicy({ config: memConfig({ dndUntil: 0 }) });
  const edges = [];
  p.on('quiet-ended', (e) => edges.push(e));
  p.setDnd(30);
  p.setForeground({ title: 'game', pid: 7, fullscreen: true }, [], new Map(), new Set());
  p.setDnd(0);
  assert.equal(edges.length, 0);
  p.setForeground({ title: 'desk', pid: 8, fullscreen: false }, [], new Map(), new Set());
  assert.equal(edges.length, 1);
  p.stop();
});

test('an automatic turn does not mark the reply read; a present user does', () => {
  let present = false;
  const sm = new SessionManager({ transcriptWatcher: stubWatcher(), attentionStore: new AttentionStore({ path: null }), presenceProbe: () => present });
  ev(sm, 'Stop', { last_assistant_message: 'r1' });
  ev(sm, 'UserPromptSubmit', { prompt: '/loop tick' });
  assert.equal(sm.getState().attention.length, 1, 'kept unread');
  present = true;
  ev(sm, 'UserPromptSubmit', { prompt: 'thanks' });
  assert.equal(sm.getState().attention.length, 0);
  sm.destroy();
});

test('needs-input raised by one agent is not cleared by another agent', () => {
  const sm = mk();
  ev(sm, 'Notification', { notification_type: 'agent_needs_input', agent_id: 'bg-1', message: 'which db?' });
  ev(sm, 'PreToolUse', { tool_use_id: 'm1', tool_name: 'Read', tool_input: {} });
  assert.equal(sm.getState().attention.length, 1);
  ev(sm, 'PreToolUse', { tool_use_id: 'b1', tool_name: 'Read', tool_input: {}, agent_id: 'bg-1' });
  assert.equal(sm.getState().attention.length, 0);
  sm.destroy();
});

test('reply text: explicit empty message wins, StopFailure uses error_details, resolved elicitation is silent', () => {
  const sm = mk();
  const done = [], att = [];
  sm.on('completion', (c) => done.push(c));
  sm.on('attention', (a) => att.push(a));
  ev(sm, 'Stop', { last_assistant_message: 'first' });
  ev(sm, 'UserPromptSubmit', { prompt: 'again' });
  ev(sm, 'Stop', { last_assistant_message: '' });
  assert.equal(done[1].lastResponse, '');
  ev(sm, 'StopFailure', { error: 'rate_limit', error_details: '429 too many requests' });
  assert.equal(sm.getState().attention[0].text, '429 too many requests');
  ev(sm, 'UserPromptSubmit', { prompt: 'x' });
  ev(sm, 'Notification', { notification_type: 'elicitation_dialog', message: 'pick' });
  ev(sm, 'Notification', { notification_type: 'elicitation_response' });
  assert.equal(att.filter(a => a.kind === 'input').length, 1);
  assert.equal(sm.getState().attention.length, 0);
  sm.destroy();
});

test('an independent Codex reply is recorded even when its alert is suppressed as a helper', () => {
  const sm = mk();
  const done = [];
  sm.on('completion', (c) => done.push(c));
  sm.handleEvent({ hook_event_name: 'PreToolUse', session_id: 'claude-1', _source: 'claude', cwd: 'D:/p', tool_use_id: 'x', tool_name: 'Read', tool_input: {} }, null);
  sm.handleEvent({ hook_event_name: 'Stop', session_id: 'codex-1', _source: 'codex', cwd: 'D:/p' }, null);
  assert.equal(done.length, 0);
  assert.ok(sm.getState().attention.some(a => a.sessionId === 'codex-1'));
  sm.destroy();
});

test('orphan reaping needs two distinct successful snapshots', () => {
  const sm = mk();
  sm.handleEvent({ hook_event_name: 'PermissionRequest', session_id: 's1', _source: 'claude', tool_name: 'Bash', tool_input: { command: 'x' } }, respondSpy());
  sm.scannedSessions = [{ id: 's1', pid: 777 }];
  const procMap = new Map([[1, { parentPid: 0 }]]);
  sm.reapOrphans(procMap, 0);
  sm.reapOrphans(procMap, 5);
  sm.reapOrphans(procMap, 5);
  assert.equal(sm.pendingPermissions.size, 1);
  sm.reapOrphans(procMap, 6);
  assert.equal(sm.pendingPermissions.size, 0);
  sm.destroy();
});

test('unknown presence keeps the reply unread', () => {
  const sm = mk(null);
  ev(sm, 'Stop', { last_assistant_message: 'r1' });
  ev(sm, 'UserPromptSubmit', { prompt: 'tick' });
  assert.equal(sm.getState().attention.length, 1);
  sm.destroy();
});

test('a needs-input flag hidden by another agent comes back when that agent is done', () => {
  const st = new AttentionStore({ path: null });
  st.flag('s1', null, 'input', 'agent_needs_input', 'A asks', 'a');
  st.flag('s1', null, 'input', 'agent_needs_input', 'B asks', 'b');
  assert.equal(st.list()[0].text, 'B asks');
  assert.equal(st.clearFlag('s1', 'input', 'b'), true);
  assert.equal(st.list()[0].text, 'A asks');
  assert.equal(st.list()[0].actor, 'a');
  st.flag('s1', null, 'input', 'agent_needs_input', 'B again', 'b');
  st.clearFlag('s1', 'input', 'a');
  assert.equal(st.clearFlag('s1', 'input', 'b'), true);
  assert.equal(st.list().length, 0, 'A already answered while parked');
});

test('a timed do-not-disturb that runs out still sends the summary, from when it began', async () => {
  const began = Date.now() - 60000;
  const cfg = memConfig({ dndUntil: Date.now() + 40, dndSince: began });
  const p = new AttentionPolicy({ config: cfg });
  const edges = [];
  p.on('quiet-ended', (e) => edges.push(e));
  p.start();
  await new Promise(r => setTimeout(r, 120));
  assert.equal(edges.length, 1);
  assert.equal(edges[0].since, began);
  assert.equal(cfg.data.dndSince, 0);
  p.stop();
});

test('alert-next on a Codex session overrides the helper suppression', () => {
  const sm = mk();
  const done = [];
  sm.on('completion', (c) => done.push(c));
  sm.handleEvent({ hook_event_name: 'PreToolUse', session_id: 'claude-1', _source: 'claude', cwd: 'D:/p', tool_use_id: 'x', tool_name: 'Read', tool_input: {} }, null);
  sm.attention.setAlertNext('codex-1', true);
  sm.handleEvent({ hook_event_name: 'Stop', session_id: 'codex-1', _source: 'codex', cwd: 'D:/p' }, null);
  assert.equal(done.length, 1);
  sm.destroy();
});

test('an explicit empty final message is not replaced by an older transcript tail', () => {
  const sm = mk();
  ev(sm, 'Stop', { last_assistant_message: '' });
  sm.scannedSessions = [{ id: 's1', lastResponse: 'older text' }];
  assert.equal(sm.getState().sessions.find(s => s.id === 's1').lastResponse, '');
  sm.destroy();
});

test('a fullscreen terminal is not a quiet period; a fullscreen game is', () => {
  const p = new AttentionPolicy({ config: memConfig({ dndUntil: 0 }) });
  p.setForeground({ title: 'x', pid: 7, fullscreen: true, className: 'CASCADIA_HOSTING_WINDOW_CLASS' }, [], new Map(), new Set());
  assert.equal(p.isQuiet(), false);
  p.setForeground({ title: 'game', pid: 8, fullscreen: true, className: 'UnityWndClass' }, [], new Map(), new Set());
  assert.equal(p.isQuiet(), true);
  p.stop();
});

test('config v4 restores the prompt chime that v3 forced off, and leaves other choices alone', () => {
  const config = require('../src/main/config');
  const a = { configVersion: 3, soundOnSessionStart: false, soundOnComplete: false };
  assert.equal(config._migrate(a), true);
  assert.equal(a.soundOnSessionStart, true);
  assert.equal(a.soundOnComplete, false);
  assert.equal(a.configVersion, 4);
  const b = { configVersion: 2, soundOnSessionStart: false };
  config._migrate(b);
  assert.equal(b.soundOnSessionStart, false, 'a v2 user who turned it off keeps it off');
});

test('sounds: new requests emit their sound; only DND and fullscreen silence, being away does not', () => {
  const sm = mk();
  const sounds = [];
  sm.on('sound', (type) => sounds.push(type));
  sm.handleEvent({ hook_event_name: 'PermissionRequest', session_id: 's1', _source: 'claude', tool_name: 'Bash', tool_input: { command: 'ls' } }, respondSpy());
  sm.handleEvent({ hook_event_name: 'Notification', session_id: 'c1', _source: 'codex', message: 'which one?' }, respondSpy());
  assert.deepEqual(sounds, ['permission', 'question']);
  sm.destroy();

  const p = new AttentionPolicy({ config: memConfig({ dndUntil: 0 }) });
  p.setAway(true, 'idle');
  assert.equal(p.isQuiet(), true);
  assert.equal(p.isSilent(), false, 'away holds back pop-ups, not sounds');
  p.setAway(false);
  p.setDnd(30);
  assert.equal(p.isSilent(), true);
  p.setDnd(0);
  const sessions = [{ id: 'a', name: 'Budget', pid: 300 }];
  p.setForeground({ title: 'Budget', pid: 999, fullscreen: true, className: 'Chrome_WidgetWin_1' }, sessions, new Map(), new Set());
  assert.equal(p.isSilent(), true, 'a fullscreen window that only shares a title is not the terminal');
  p.stop();
});
