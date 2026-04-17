'use strict';

// Hook installer — manages hook entries inside Claude Code's settings.json,
// and deploys bridge.js to ~/.codepeek/.

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOOK_EVENTS = {
  UserPromptSubmit: { timeout: 5 },
  PreToolUse: { timeout: 5 },
  PostToolUse: { timeout: 5 },
  PostToolUseFailure: { timeout: 5 },
  PermissionRequest: { timeout: 86400 },
  PermissionDenied: { timeout: 5 },
  Stop: { timeout: 5 },
  SubagentStart: { timeout: 5 },
  SubagentStop: { timeout: 5 },
  SessionStart: { timeout: 5 },
  SessionEnd: { timeout: 5 },
  Notification: { timeout: 86400 },
  PreCompact: { timeout: 5 }
};

function getClaudeSettingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function getCodePeekDir() {
  return path.join(os.homedir(), '.codepeek');
}

function getBridgePath() {
  return path.join(getCodePeekDir(), 'bridge.js');
}

function getBridgeCommand(source) {
  const bridgePath = getBridgePath().replace(/\\/g, '/');
  // One bridge.js binary; --source selects which agent it is serving.
  return `node "${bridgePath}" --source ${source || 'claude'}`;
}

// Match our own hook entries precisely so unrelated hooks that happen to include "bridge.js" are left alone.
// Also matches the legacy ".codeisland/bridge.js" path so upgrades clean up old entries.
function isCodePeekHook(hh) {
  if (!hh || !hh.command) return false;
  const cmd = String(hh.command).toLowerCase();
  const ours = getBridgePath().toLowerCase();
  if (cmd.includes(ours) || cmd.includes(ours.replace(/\\/g, '/'))) return true;
  // Legacy path: ~/.codeisland/bridge.js
  const legacy = path.join(os.homedir(), '.codeisland', 'bridge.js').toLowerCase();
  return cmd.includes(legacy) || cmd.includes(legacy.replace(/\\/g, '/'));
}

// ========== Codex hook support ==========
// 5 events / flat schema / timeout=5 / config.toml sets [features].codex_hooks=true.

const CODEX_HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'Stop'];
const CODEX_HOOK_TIMEOUT = 5;

function getCodexDir() { return path.join(os.homedir(), '.codex'); }
function getCodexHooksPath() { return path.join(getCodexDir(), 'hooks.json'); }
function getCodexConfigTomlPath() { return path.join(getCodexDir(), 'config.toml'); }

function readCodexHooks() {
  const p = getCodexHooksPath();
  if (!fs.existsSync(p)) return {};
  const raw = fs.readFileSync(p, 'utf8');
  try { return JSON.parse(raw); }
  catch (err) {
    throw new Error(`Failed to parse ${p}: ${err.message}. Refusing to overwrite to protect existing config.`);
  }
}

function writeCodexHooks(obj) {
  const p = getCodexHooksPath();
  ensureDir(path.dirname(p));
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

// Set codex_hooks = true under the [features] section in config.toml (idempotent; preserves everything else).
function enableCodexHooksConfig() {
  const p = getCodexConfigTomlPath();
  ensureDir(path.dirname(p));
  let text = '';
  if (fs.existsSync(p)) text = fs.readFileSync(p, 'utf8');

  const trueRe = /^\s*codex_hooks\s*=\s*true\s*$/m;
  const anyRe  = /^\s*codex_hooks\s*=.*$/m;
  if (trueRe.test(text)) return; // already true, nothing to do
  if (anyRe.test(text)) {
    text = text.replace(anyRe, 'codex_hooks = true');
  } else {
    // Insert under an existing [features] section if present, otherwise append a new section at EOF.
    const featRe = /^\s*\[features\]\s*$/m;
    if (featRe.test(text)) {
      text = text.replace(featRe, m => `${m}\ncodex_hooks = true`);
    } else {
      const sep = text.length === 0 ? '' : (text.endsWith('\n') ? '\n' : '\n\n');
      text = text + sep + '[features]\ncodex_hooks = true\n';
    }
  }
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, p);
}

// Inverse: flip codex_hooks=true to false. Keep the line so the user can easily re-enable later.
function disableCodexHooksConfig() {
  const p = getCodexConfigTomlPath();
  if (!fs.existsSync(p)) return;
  let text = fs.readFileSync(p, 'utf8');
  if (!/codex_hooks\s*=\s*true/.test(text)) return;
  text = text.replace(/^\s*codex_hooks\s*=\s*true\s*$/m, 'codex_hooks = false');
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, p);
}

function installCodexHooks() {
  deployBridge();

  let hooksObj;
  try { hooksObj = readCodexHooks(); }
  catch (err) { throw err; }
  if (!hooksObj.hooks || typeof hooksObj.hooks !== 'object') hooksObj.hooks = {};

  const command = getBridgeCommand('codex');

  for (const eventName of CODEX_HOOK_EVENTS) {
    const entry = {
      hooks: [{ type: 'command', command, timeout: CODEX_HOOK_TIMEOUT }]
    };
    if (!Array.isArray(hooksObj.hooks[eventName])) hooksObj.hooks[eventName] = [];
    // Remove our own previous entries first so install is idempotent.
    hooksObj.hooks[eventName] = hooksObj.hooks[eventName].filter(h =>
      !(h && h.hooks && h.hooks.some(isCodePeekHook))
    );
    hooksObj.hooks[eventName].push(entry);
  }

  writeCodexHooks(hooksObj);
  enableCodexHooksConfig();
  return true;
}

function uninstallCodexHooks() {
  // hooks.json: drop our entries; remove event arrays that become empty.
  if (fs.existsSync(getCodexHooksPath())) {
    let hooksObj;
    try { hooksObj = readCodexHooks(); }
    catch (err) { throw err; }
    if (hooksObj.hooks) {
      for (const eventName of CODEX_HOOK_EVENTS) {
        if (Array.isArray(hooksObj.hooks[eventName])) {
          hooksObj.hooks[eventName] = hooksObj.hooks[eventName].filter(h =>
            !(h && h.hooks && h.hooks.some(isCodePeekHook))
          );
          if (hooksObj.hooks[eventName].length === 0) delete hooksObj.hooks[eventName];
        }
      }
      if (Object.keys(hooksObj.hooks).length === 0) delete hooksObj.hooks;
    }
    writeCodexHooks(hooksObj);
  }
  // config.toml: flip codex_hooks back to false rather than deleting the line.
  disableCodexHooksConfig();
  return true;
}

function isCodexInstalled() {
  let hooksObj;
  try { hooksObj = readCodexHooks(); }
  catch { return false; }
  if (!hooksObj.hooks) return false;
  for (const eventName of CODEX_HOOK_EVENTS) {
    const arr = hooksObj.hooks[eventName];
    if (Array.isArray(arr) && arr.some(h => h && h.hooks && h.hooks.some(isCodePeekHook))) {
      return true;
    }
  }
  return false;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readSettings() {
  const settingsPath = getClaudeSettingsPath();
  if (!fs.existsSync(settingsPath)) {
    return {};
  }
  // On parse failure, throw instead of returning {} — callers must not overwrite a corrupted file and wipe the user's other settings.
  const raw = fs.readFileSync(settingsPath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse Claude settings.json: ${err.message}. Refusing to overwrite to protect existing config.`);
  }
}

function writeSettings(settings) {
  const settingsPath = getClaudeSettingsPath();
  const dir = path.dirname(settingsPath);
  ensureDir(dir);
  // Atomic write: write to a .tmp and rename, so a crash mid-write never leaves a half-written file.
  const tmpPath = settingsPath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(tmpPath, settingsPath);
}

function deployBridge() {
  const dir = getCodePeekDir();
  ensureDir(dir);

  // Copy bridge.js into ~/.codepeek/
  const srcBridge = path.join(__dirname, '..', 'bridge', 'bridge.js');
  const destBridge = getBridgePath();
  fs.copyFileSync(srcBridge, destBridge);

  return destBridge;
}

function installHooks() {
  // Deploy the bridge binary
  deployBridge();

  // Read the existing settings file
  const settings = readSettings();
  if (!settings.hooks) {
    settings.hooks = {};
  }

  const command = getBridgeCommand('claude');

  // Register a hook for each supported event
  for (const [eventName, config] of Object.entries(HOOK_EVENTS)) {
    const hookEntry = {
      matcher: '',
      hooks: [{
        type: 'command',
        command: command,
        timeout: config.timeout
      }]
    };

    if (!settings.hooks[eventName]) {
      settings.hooks[eventName] = [hookEntry];
    } else {
      // Check whether we already registered a hook for this event.
      const existing = settings.hooks[eventName].find(h =>
        h.hooks && h.hooks.some(isCodePeekHook)
      );
      if (!existing) {
        settings.hooks[eventName].push(hookEntry);
      } else {
        // Update the existing entry.
        existing.hooks = hookEntry.hooks;
      }
    }
  }

  writeSettings(settings);
  return true;
}

function uninstallHooks() {
  const settings = readSettings();
  if (!settings.hooks) return true;

  // Remove our hook entries
  for (const eventName of Object.keys(HOOK_EVENTS)) {
    if (settings.hooks[eventName]) {
      settings.hooks[eventName] = settings.hooks[eventName].filter(h =>
        !(h.hooks && h.hooks.some(isCodePeekHook))
      );
      if (settings.hooks[eventName].length === 0) {
        delete settings.hooks[eventName];
      }
    }
  }

  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  writeSettings(settings);
  return true;
}

function isInstalled() {
  let settings;
  try { settings = readSettings(); }
  catch { return false; } // Treat corrupted config as "not installed" so startup doesn't crash.
  if (!settings.hooks) return false;

  // True if at least one of our hook entries is still registered.
  for (const eventName of Object.keys(HOOK_EVENTS)) {
    const hooks = settings.hooks[eventName];
    if (hooks && hooks.some(h => h.hooks && h.hooks.some(isCodePeekHook))) {
      return true;
    }
  }
  return false;
}

function getAutoStartPath() {
  return path.join(
    os.homedir(),
    'AppData', 'Roaming', 'Microsoft', 'Windows',
    'Start Menu', 'Programs', 'Startup',
    'CodePeek.vbs'
  );
}

function getLegacyAutoStartPath() {
  // Older versions used a .cmd launcher (flashed a console window); clean it up on upgrade.
  return path.join(
    os.homedir(),
    'AppData', 'Roaming', 'Microsoft', 'Windows',
    'Start Menu', 'Programs', 'Startup',
    'CodePeek.cmd'
  );
}

function setAutoStart(enabled, electronPath) {
  const startupPath = getAutoStartPath();
  const legacyPath = getLegacyAutoStartPath();

  // Always remove the legacy .cmd, even when auto-start is being turned off.
  try { if (fs.existsSync(legacyPath)) fs.unlinkSync(legacyPath); } catch {}

  if (enabled) {
    const appPath = path.resolve(path.join(__dirname, '..', '..'));
    const exe = (electronPath || '').replace(/\\/g, '\\\\');
    const appEsc = appPath.replace(/\\/g, '\\\\');
    // VBS silent launch; 0 = hidden window.
    const vbs = `Set WshShell = CreateObject("WScript.Shell")\r\nWshShell.Environment("Process")("NODE_OPTIONS") = ""\r\nWshShell.Run """${exe}"" ""${appEsc}\\.""", 0, False\r\n`;
    fs.writeFileSync(startupPath, vbs, 'utf8');
  } else {
    try { if (fs.existsSync(startupPath)) fs.unlinkSync(startupPath); } catch {}
  }
}

function isAutoStartEnabled() {
  return fs.existsSync(getAutoStartPath());
}

// CLI mode: node hookInstaller.js install|uninstall
if (require.main === module) {
  const action = process.argv[2];
  if (action === 'install') {
    installHooks();
    console.log('Hooks installed successfully.');
    console.log('Bridge deployed to:', getBridgePath());
  } else if (action === 'uninstall') {
    uninstallHooks();
    console.log('Hooks uninstalled successfully.');
  } else {
    console.log('Usage: node hookInstaller.js [install|uninstall]');
  }
}

module.exports = {
  installHooks,
  uninstallHooks,
  isInstalled,
  deployBridge,
  setAutoStart,
  isAutoStartEnabled,
  getClaudeSettingsPath,
  getCodePeekDir,
  // Codex
  installCodexHooks,
  uninstallCodexHooks,
  isCodexInstalled,
  getCodexHooksPath,
  getCodexConfigTomlPath
};
