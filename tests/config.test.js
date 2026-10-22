'use strict';

const { TMP_HOME } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DIR = path.join(TMP_HOME, '.codepeek');
const FILE = path.join(DIR, 'config.json');

test('an unreadable config is kept as .corrupt, and saves replace the file atomically', () => {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, '{"panelWidth": 6', 'utf8');
  const config = require('../src/main/config');
  assert.ok(fs.existsSync(FILE + '.corrupt'), 'the broken file is preserved for recovery');
  assert.equal(fs.readFileSync(FILE + '.corrupt', 'utf8'), '{"panelWidth": 6');
  config.set('followUpMinutes', 7);
  assert.equal(JSON.parse(fs.readFileSync(FILE, 'utf8')).followUpMinutes, 7);
  assert.ok(!fs.existsSync(FILE + '.tmp'), 'no temp file is left behind');
});
