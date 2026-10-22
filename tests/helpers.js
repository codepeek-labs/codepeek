'use strict';

// Isolates os.homedir() so requiring config/hookServer never touches the real ~/.codepeek.
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'codepeek-test-'));
process.env.USERPROFILE = TMP_HOME;
process.env.HOME = TMP_HOME;

function stubWatcher() {
  const calls = [];
  return {
    calls,
    watch(key, file, id) { calls.push(['watch', key, file, id]); return true; },
    unwatch(key) { calls.push(['unwatch', key]); },
    stop() {}
  };
}

function respondSpy() {
  const sent = [];
  const fn = (r) => { sent.push(r); return true; };
  fn.sent = sent;
  return fn;
}

function decisionOf(json) {
  return JSON.parse(json).hookSpecificOutput.decision;
}

module.exports = { TMP_HOME, stubWatcher, respondSpy, decisionOf };
