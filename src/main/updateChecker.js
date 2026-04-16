'use strict';

// Auto-update checker: queries GitHub Releases API for new versions.
// Does not download/install automatically; opens the release page in the browser.

const https = require('https');

const REPO = 'codepeek-labs/codepeek';
const CHECK_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

let _state = { status: 'idle' }; // idle | checking | upToDate | available | failed
let _listeners = [];

function getState() { return { ..._state }; }

function onChange(fn) {
  _listeners.push(fn);
  return () => { _listeners = _listeners.filter(f => f !== fn); };
}

function _setState(s) {
  _state = s;
  for (const fn of _listeners) try { fn(_state); } catch {}
}

function isNewer(remote, local) {
  const r = (remote || '').replace(/^v/i, '').split('.').map(Number);
  const l = (local || '').replace(/^v/i, '').split('.').map(Number);
  const len = Math.max(r.length, l.length);
  for (let i = 0; i < len; i++) {
    const rv = r[i] || 0, lv = l[i] || 0;
    if (rv > lv) return true;
    if (rv < lv) return false;
  }
  return false;
}

function check(currentVersion) {
  if (_state.status === 'checking') return;
  _setState({ status: 'checking' });

  const options = {
    hostname: 'api.github.com',
    path: `/repos/${REPO}/releases/latest`,
    headers: {
      'User-Agent': 'CodePeek-UpdateChecker',
      'Accept': 'application/vnd.github+json'
    },
    timeout: 10000
  };

  const req = https.get(options, (res) => {
    let body = '';
    res.on('data', d => { body += d; });
    res.on('end', () => {
      try {
        if (res.statusCode === 404) {
          _setState({ status: 'upToDate' });
          return;
        }
        if (res.statusCode !== 200) {
          _setState({ status: 'failed', message: `HTTP ${res.statusCode}` });
          return;
        }
        const data = JSON.parse(body);
        const tagName = (data.tag_name || '').replace(/^v/i, '');
        const releaseUrl = data.html_url || `https://github.com/${REPO}/releases`;
        if (isNewer(tagName, currentVersion)) {
          _setState({ status: 'available', version: tagName, releaseUrl });
        } else {
          _setState({ status: 'upToDate' });
        }
      } catch (err) {
        _setState({ status: 'failed', message: err.message });
      }
    });
  });

  req.on('error', (err) => {
    _setState({ status: 'failed', message: err.message });
  });

  req.on('timeout', () => {
    req.destroy();
    _setState({ status: 'failed', message: 'Request timed out' });
  });
}

module.exports = { check, getState, onChange, isNewer };
