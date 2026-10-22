'use strict';

// Append-only diagnostic log at ~/.codepeek/debug.log. Never log tokens or user-typed answers.

const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG_PATH = path.join(os.homedir(), '.codepeek', 'debug.log');
const MAX_BYTES = 5 * 1024 * 1024;
const CHECK_EVERY = 500;

let writes = 0;

// Keeps one previous generation (debug.log.1) so the log never grows without bound.
function rotateIfNeeded() {
  try {
    if (fs.statSync(LOG_PATH).size > MAX_BYTES) fs.renameSync(LOG_PATH, LOG_PATH + '.1');
  } catch {}
}

function debugLog(tag, message) {
  try {
    if (writes++ % CHECK_EVERY === 0) rotateIfNeeded();
    fs.appendFile(LOG_PATH, `${new Date().toISOString()} [${tag}] ${message}\n`, () => {});
  } catch {}
}

module.exports = { debugLog, LOG_PATH };
