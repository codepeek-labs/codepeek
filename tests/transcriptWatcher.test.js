'use strict';

require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const TranscriptWatcher = require('../src/main/transcriptWatcher');
const { resolveTranscriptPath, matchToolResult } = TranscriptWatcher;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codepeek-tr-'));
const projDir = path.join(root, 'D--proj');
fs.mkdirSync(projDir);

const toolUse = (id) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test' } }] } });
const toolResult = (id, extra = {}) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: '测试 rejected' }] }, ...extra });

test('path must resolve inside the projects root and be a .jsonl file', () => {
  const inside = path.join(projDir, 'a.jsonl');
  fs.writeFileSync(inside, '');
  const outside = path.join(os.tmpdir(), 'codepeek-outside.jsonl');
  fs.writeFileSync(outside, '');
  assert.ok(resolveTranscriptPath(inside, root));
  assert.equal(resolveTranscriptPath(outside, root), null);
  assert.equal(resolveTranscriptPath(path.join(projDir, 'a.txt'), root), null);
  assert.equal(resolveTranscriptPath(path.join(projDir, '..', '..', 'x.jsonl'), root), null);
});

test('only real user tool_result records match; rejection is detected from toolUseResult', () => {
  assert.deepEqual(matchToolResult(toolResult('t1', { toolUseResult: 'User rejected tool use' }), 't1'), { rejected: true });
  assert.deepEqual(matchToolResult(toolResult('t1', { toolUseResult: 'Error: exit 1' }), 't1'), { rejected: false });
  const snapshot = JSON.stringify({ type: 'api-request-blob', body: { messages: [{ content: [{ type: 'tool_result', tool_use_id: 't1' }] }] } });
  assert.equal(matchToolResult(snapshot, 't1'), null);
  assert.equal(matchToolResult(toolUse('t1'), 't1'), null);
  assert.equal(matchToolResult(toolResult('t2'), 't1'), null);
});

test('detects a result written in two chunks that split a multi-byte character', async () => {
  const file = path.join(projDir, 'b.jsonl');
  fs.writeFileSync(file, toolUse('tX') + '\n');
  const hits = [];
  const w = new TranscriptWatcher((key, id, m) => hits.push([key, id, m.rejected]), { root, pollMs: 60000 });
  assert.equal(w.watch('perm_1', file, 'tX'), true);
  const line = Buffer.from(toolResult('tX', { toolUseResult: 'User rejected tool use' }) + '\n', 'utf8');
  const cut = line.indexOf(Buffer.from('测', 'utf8')) + 1;
  fs.appendFileSync(file, line.subarray(0, cut));
  await w.tick();
  assert.equal(hits.length, 0);
  fs.appendFileSync(file, line.subarray(cut));
  await w.tick();
  assert.deepEqual(hits, [['perm_1', 'tX', true]]);
  w.stop();
});

test('ignores results that predate the lookback window and restarts after truncation', async () => {
  const file = path.join(projDir, 'c.jsonl');
  const filler = 'x'.repeat(70 * 1024);
  fs.writeFileSync(file, toolResult('tOld') + '\n' + JSON.stringify({ type: 'note', filler }) + '\n');
  const hits = [];
  const w = new TranscriptWatcher((key, id) => hits.push(id), { root, pollMs: 60000 });
  w.watch('perm_2', file, 'tOld');
  await w.tick();
  assert.deepEqual(hits, []);
  fs.writeFileSync(file, toolResult('tOld') + '\n');
  await w.tick();
  assert.deepEqual(hits, ['tOld']);
  w.stop();
});

test('unwatch releases the file and stops polling', () => {
  const file = path.join(projDir, 'd.jsonl');
  fs.writeFileSync(file, '');
  const w = new TranscriptWatcher(() => {}, { root, pollMs: 60000 });
  w.watch('k', file, 't');
  assert.ok(w._timer);
  w.unwatch('k');
  assert.equal(w._timer, null);
  assert.equal(w._files.size, 0);
});

test('a same-size replacement file is re-read from its tail', async () => {
  const file = path.join(projDir, 'e.jsonl');
  const resultLine = toolResult('tR', { toolUseResult: 'User rejected tool use' });
  const original = JSON.stringify({ type: 'note', pad: 'y'.repeat(Buffer.byteLength(resultLine)) }) + '\n';
  fs.writeFileSync(file, original);
  const hits = [];
  const w = new TranscriptWatcher((key, id, m) => hits.push(m.rejected), { root, pollMs: 60000 });
  w.watch('k', file, 'tR');
  await w.tick();
  const replacement = resultLine + ' '.repeat(Buffer.byteLength(original) - 1 - Buffer.byteLength(resultLine)) + '\n';
  assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(original));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, replacement);
  fs.rmSync(file);
  fs.renameSync(tmp, file);
  await w.tick();
  assert.deepEqual(hits, [true]);
  w.stop();
});
