#!/usr/bin/env node
'use strict';

// Replays scripted hook events against a running CodePeek for manual UI checks; run without args to list them.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORT = 31311;
const TOKEN = (() => {
  try { return fs.readFileSync(path.join(os.homedir(), '.codepeek', 'token'), 'utf8').trim(); } catch { return ''; }
})();
const SID = 'sim-' + crypto.randomBytes(3).toString('hex');
const CWD = process.cwd();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function send(event) {
  const body = JSON.stringify({ session_id: SID, cwd: CWD, _source: 'claude', bridge_timestamp: new Date().toISOString(), ...event });
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/hook', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-CodePeek-Token': TOKEN }
    }, (res) => {
      let out = '';
      res.on('data', d => { out += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.end(body);
  });
}

function log(msg) { console.log(`[${new Date().toISOString().substring(11, 19)}] ${msg}`); }

async function blocking(event) {
  log(`→ ${event.hook_event_name} ${event.tool_name || ''} (waiting for an answer in CodePeek)`);
  const r = await send(event);
  log(`← ${r.status} ${r.body}`);
  return r;
}

const bash = (command, description) => ({ tool_name: 'Bash', tool_input: { command, description } });

// Simulated transcripts live in a throwaway project dir so the real Claude history is never touched.
function simTranscript() {
  const dir = path.join(os.homedir(), '.claude', 'projects', 'codepeek-sim');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, SID + '.jsonl');
  fs.writeFileSync(file, '');
  return { dir, file };
}

const SCENARIOS = {
  async session() {
    await send({ hook_event_name: 'SessionStart' });
    await send({ hook_event_name: 'UserPromptSubmit', prompt: '模拟：优化查询规划器' });
    await send({ hook_event_name: 'PreToolUse', tool_use_id: 'toolu_sim1', ...bash('cargo test -p planner', 'Run planner tests') });
    log('session is now running a Bash tool');
  },

  async perm() {
    await send({ hook_event_name: 'UserPromptSubmit', prompt: '模拟授权' });
    await blocking({ hook_event_name: 'PermissionRequest', ...bash('mvn -q -f app/pom.xml compile -DskipTests', '编译 app 模块'),
      permission_suggestions: [{ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'mvn:*' }] }] });
  },

  async 'perm-then-post'() {
    const call = bash('npm run build', 'Build the app');
    await send({ hook_event_name: 'PreToolUse', tool_use_id: 'toolu_sim_post', ...call });
    const pending = blocking({ hook_event_name: 'PermissionRequest', ...call });
    await sleep(3000);
    log('simulating: user allowed in the terminal → PostToolUse');
    await send({ hook_event_name: 'PostToolUse', tool_use_id: 'toolu_sim_post', ...call });
    await pending;
  },

  async 'perm-then-reject'() {
    const { dir, file } = simTranscript();
    const call = bash('rm -rf build', 'Clean build output');
    fs.appendFileSync(file, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_sim_rej', name: 'Bash', input: call.tool_input }] } }) + '\n');
    await send({ hook_event_name: 'PreToolUse', tool_use_id: 'toolu_sim_rej', transcript_path: file, ...call });
    const pending = blocking({ hook_event_name: 'PermissionRequest', transcript_path: file, ...call });
    await sleep(3000);
    log('simulating: user rejected in the terminal → transcript tool_result');
    fs.appendFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_sim_rej', is_error: true, content: "The user doesn't want to proceed with this tool use." }] }, toolUseResult: 'User rejected tool use' }) + '\n');
    await pending;
    fs.rmSync(dir, { recursive: true, force: true });
  },

  async 'perm-then-prompt'() {
    const pending = blocking({ hook_event_name: 'PermissionRequest', ...bash('git push', 'Push branch') });
    await sleep(3000);
    log('simulating: user typed a new prompt → UserPromptSubmit');
    await send({ hook_event_name: 'UserPromptSubmit', prompt: '算了，先别推' });
    await pending;
  },

  async ask() {
    await blocking({
      hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion',
      tool_input: { questions: [
        { header: '布局', question: '会话列表默认按什么分组？', multiSelect: false, options: [
          { label: '按状态 (Recommended)', description: '需要处理 → 运行中 → 空闲 → 已结束' },
          { label: '按客户端', description: 'Claude Code、Codex 分开显示' },
          { label: '平铺', description: '按最近活动排序' }] },
        { header: '提醒', question: '哪些事件需要声音？', multiSelect: true, options: [
          { label: '权限请求' }, { label: '完成' }, { label: '会话开始' }] }
      ] }
    });
  },

  async dup() {
    const call = bash('npm test', 'Run tests');
    await Promise.all([blocking({ hook_event_name: 'PermissionRequest', ...call }), blocking({ hook_event_name: 'PermissionRequest', ...call })]);
  },

  async complete() {
    await send({ hook_event_name: 'UserPromptSubmit', prompt: '模拟完成' });
    await sleep(500);
    await send({ hook_event_name: 'Stop' });
    log('completion card should appear');
  },

  async end() {
    await send({ hook_event_name: 'SessionEnd' });
  }
};

(async () => {
  const name = process.argv[2];
  if (!name || !SCENARIOS[name]) {
    console.log('Scenarios:\n  ' + Object.keys(SCENARIOS).join('\n  '));
    process.exit(name ? 1 : 0);
  }
  if (!TOKEN) { console.error('No ~/.codepeek/token found. Start CodePeek first.'); process.exit(1); }
  log(`session ${SID}`);
  await SCENARIOS[name]();
})();
