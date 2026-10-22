'use strict';

// Foreground window (pid, title, fullscreen) from one hidden PowerShell helper that prints only changes.

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SCRIPT_PATH = path.join(os.homedir(), '.codepeek', 'fgwatch.ps1');

// The helper exits on its own when CodePeek's pid disappears, so a crash never leaves it running.
const SCRIPT = String.raw`
param([int]$ParentPid)
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CpFg {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  public static string Probe() {
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) return "0\t0\t0\t\t";
    var t = new StringBuilder(512); GetWindowText(h, t, 512);
    var c = new StringBuilder(256); GetClassName(h, c, 256);
    uint pid; GetWindowThreadProcessId(h, out pid);
    string cls = c.ToString();
    bool full = false;
    RECT r;
    var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    if (cls != "Progman" && cls != "WorkerW" && cls != "Shell_TrayWnd" && GetWindowRect(h, out r)
        && GetMonitorInfo(MonitorFromWindow(h, 2), ref mi)) {
      full = r.L <= mi.rcMonitor.L && r.T <= mi.rcMonitor.T && r.R >= mi.rcMonitor.R && r.B >= mi.rcMonitor.B;
    }
    string title = t.ToString().Replace("\t", " ").Replace("\r", " ").Replace("\n", " ");
    return h.ToInt64() + "\t" + pid + "\t" + (full ? 1 : 0) + "\t" + cls + "\t" + title;
  }
}
"@
$last = ''
$tick = 0
while ($true) {
  $line = [CpFg]::Probe()
  if ($line -ne $last) { [Console]::Out.WriteLine($line); [Console]::Out.Flush(); $last = $line }
  Start-Sleep -Milliseconds 400
  $tick++
  if ($tick % 10 -eq 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit 0 }
}
`;

class ForegroundWatcher extends EventEmitter {
  constructor() {
    super();
    this._child = null;
    this._buf = '';
    this._stopped = false;
    this._restarts = 0;
    this.current = null;
  }

  start() {
    if (process.platform !== 'win32' || this._child) return;
    this._stopped = false;
    try {
      fs.mkdirSync(path.dirname(SCRIPT_PATH), { recursive: true });
      fs.writeFileSync(SCRIPT_PATH, SCRIPT, 'utf8');
    } catch { return; }
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT_PATH, '-ParentPid', String(process.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    this._child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => this._onData(d));
    child.on('exit', () => {
      this._child = null;
      this._buf = '';
      // A stale sample would keep a closed terminal "in front" (marking replies read) or a game "fullscreen" (silencing).
      if (this.current) { this.current = null; this.emit('change', null); }
      if (this._stopped || this._restarts > 5) return;
      // Back off so a helper that keeps dying (e.g. blocked PowerShell) does not spin.
      const delay = Math.min(60000, 2000 * Math.pow(2, this._restarts++));
      this._retry = setTimeout(() => { this._retry = null; if (!this._stopped) this.start(); }, delay);
      this._retry.unref();
    });
    child.on('error', () => {});
  }

  stop() {
    this._stopped = true;
    clearTimeout(this._retry);
    this._retry = null;
    if (this._child) { try { this._child.kill(); } catch {} }
    this._child = null;
  }

  _onData(chunk) {
    this._buf += chunk;
    let nl;
    while ((nl = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, nl).replace(/\r$/, '');
      this._buf = this._buf.slice(nl + 1);
      const parts = line.split('\t');
      if (parts.length < 5) continue;
      this._restarts = 0;
      this.current = {
        hwnd: Number(parts[0]) || 0,
        pid: Number(parts[1]) || 0,
        fullscreen: parts[2] === '1',
        className: parts[3],
        title: parts.slice(4).join(' ')
      };
      this.emit('change', this.current);
    }
    if (this._buf.length > 65536) this._buf = '';
  }
}

module.exports = ForegroundWatcher;
