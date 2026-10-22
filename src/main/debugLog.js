'use strict';

// Append-only diagnostic log at ~/.codepeek/debug.log. Never log tokens or user-typed answers.

const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG_PATH = path.join(os.homedir(), '.codepeek', 'debug.log');

function debugLog(tag, message) {
  try {
    fs.appendFile(LOG_PATH, `${new Date().toISOString()} [${tag}] ${message}\n`, () => {});
  } catch {}
}

module.exports = { debugLog, LOG_PATH };
