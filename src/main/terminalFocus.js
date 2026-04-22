'use strict';

const { spawn } = require('child_process');

// Process table injected by the main module (from sessionScanner._procMap).
let _procMap = new Map();

function setProcMap(map) {
  _procMap = map;
}

function buildCandidateNames(sessionName, cwd) {
  const out = [];
  const push = (s) => {
    if (!s) return;
    const v = String(s).trim();
    if (v.length < 2) return;
    if (!out.includes(v)) out.push(v);
  };
  push(sessionName);
  if (cwd) {
    const norm = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '');
    const segs = norm.split('/').filter(Boolean);
    if (segs.length) {
      push(segs[segs.length - 1]); // basename
      if (segs.length >= 2) push(segs[segs.length - 2] + '/' + segs[segs.length - 1]);
    }
    push(norm);
    push(String(cwd));
  }
  return out.slice(0, 8);
}

// Build ancestor chain in Node.js using the cached process table (no WMI needed).
function getAncestorChain(pid) {
  const ancestors = [];
  let current = pid;
  let lastCreatedAt = 0;
  for (let i = 0; i < 20; i++) {
    const info = _procMap.get(current);
    if (!info) break;
    // PID reuse guard: parent must have been created before the child.
    if (lastCreatedAt > 0 && info.createdAt > 0 && info.createdAt > lastCreatedAt) break;
    lastCreatedAt = info.createdAt || 0;
    const parent = info.parentPid;
    if (!parent || parent <= 0 || parent === current) break;
    if (ancestors.includes(parent)) break;
    ancestors.push(parent);
    current = parent;
  }
  return ancestors;
}

// Minimal PowerShell script: only does window focusing + tab switching.
// No CIM queries, no process validation — all done in Node.js already.
function buildFocusScript(ancestorPids, sessionName, cwd) {
  const safeName = (sessionName || '').replace(/['`\$]/g, '').substring(0, 100);
  const cands = buildCandidateNames(sessionName, cwd)
    .map(c => "'" + c.replace(/['`\$]/g, '').substring(0, 200) + "'");
  const candList = cands.length ? cands.join(',') : "''";
  const pidArray = ancestorPids.join(',');
  return `
$AncestorPids = @(${pidArray})
$TargetName = '${safeName}'
$Candidates = @(${candList})

# Find the first ancestor with a top-level window
$targetHwnd = [IntPtr]::Zero
$targetPid = 0
$isWindowsTerminal = $false

foreach ($apid in $AncestorPids) {
  try {
    $proc = Get-Process -Id $apid -ErrorAction SilentlyContinue
    if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
      $targetHwnd = $proc.MainWindowHandle
      $targetPid = $apid
      if ($proc.ProcessName -match '^WindowsTerminal') { $isWindowsTerminal = $true }
      break
    }
  } catch {}
}

if ($targetHwnd -eq [IntPtr]::Zero) {
  Write-Host "NO_WINDOW"
  exit 1
}

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
}
"@

if (-not [W]::IsWindow($targetHwnd)) { Write-Host "INVALID_HWND"; exit 1 }

if ([W]::IsIconic($targetHwnd)) {
  [W]::ShowWindowAsync($targetHwnd, 9) | Out-Null
  Start-Sleep -Milliseconds 50
}
[W]::SetForegroundWindow($targetHwnd) | Out-Null

$tabResult = "no-tab-switch"
if ($isWindowsTerminal -and $TargetName) {
  try {
    Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop

    Start-Sleep -Milliseconds 50

    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $pidCond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $targetPid)
    $windowEl = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $pidCond)

    if ($windowEl) {
      $tabCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::TabItem)
      $tabs = $windowEl.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCond)

      $matched = $null
      $matchedScore = 0
      foreach ($tab in $tabs) {
        $tabName = $tab.Current.Name
        if (-not $tabName) { continue }
        $tabLower = $tabName.ToLowerInvariant()
        $tabNorm = $tabLower.Replace('\\','/')
        foreach ($cand in $Candidates) {
          if (-not $cand) { continue }
          $cLower = $cand.ToLowerInvariant()
          $cNorm = $cLower.Replace('\\','/')
          $score = 0
          if ($tabLower -eq $cLower) { $score = 3 }
          elseif ($tabLower.Contains($cLower)) { $score = 2 }
          elseif ($tabNorm.Contains($cNorm)) { $score = 1 }
          if ($score -gt $matchedScore) {
            $matched = $tab
            $matchedScore = $score
            if ($score -eq 3) { break }
          }
        }
        if ($matchedScore -eq 3) { break }
      }

      if ($matched) {
        $selPattern = $matched.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
        if ($selPattern) {
          $selPattern.Select()
          $tabResult = "tab-switched:$($matched.Current.Name)"
        } else {
          $tabResult = "tab-no-pattern"
        }
      } else {
        $tabResult = "tab-not-found(tabs=$($tabs.Count))"
      }
    } else {
      $tabResult = "no-automation-window"
    }
  } catch {
    $tabResult = "ua-err:$($_.Exception.Message.Substring(0, [Math]::Min(80, $_.Exception.Message.Length)))"
  }
}

Write-Host "OK:$targetPid;$tabResult"
`;
}

function focusTerminalByPid(pid, sessionName, cwd) {
  return new Promise((resolve) => {
    const numericPid = parseInt(pid);
    if (!numericPid || numericPid <= 0) {
      return resolve({ success: false, error: `Invalid PID: ${pid}` });
    }

    // Build ancestor chain in Node.js (instant, no WMI).
    const ancestors = getAncestorChain(numericPid);
    if (ancestors.length === 0) {
      return resolve({ success: false, error: `No ancestors for PID ${pid}` });
    }

    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass',
      '-Command', buildFocusScript(ancestors, sessionName, cwd)
    ], { windowsHide: true, timeout: 8000 });

    let output = '';
    ps.stdout.on('data', d => { output += d.toString(); });
    ps.stderr.on('data', d => { output += d.toString(); });

    ps.on('close', (code) => {
      const result = output.trim();
      if (code === 0 && result.startsWith('OK:')) {
        resolve({ success: true, detail: result.slice(3) });
      } else {
        resolve({ success: false, error: result || `Exit ${code}` });
      }
    });

    ps.on('error', err => resolve({ success: false, error: err.message }));
  });
}

module.exports = { focusTerminalByPid, setProcMap };
