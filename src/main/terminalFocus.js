'use strict';

const { spawn } = require('child_process');

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

function buildScript(nodePid, sessionName, cwd) {
  const safeName = (sessionName || '').replace(/['`\$]/g, '').substring(0, 100);
  const cands = buildCandidateNames(sessionName, cwd)
    .map(c => "'" + c.replace(/['`\$]/g, '').substring(0, 200) + "'");
  const candList = cands.length ? cands.join(',') : "''";
  return `
$NodePid = ${nodePid}
$TargetName = '${safeName}'
$Candidates = @(${candList})

$procTable = @{}
$procNames = @{}
$procCmdLines = @{}
try {
  $all = Get-CimInstance Win32_Process -ErrorAction Stop
  foreach ($p in $all) {
    $thisPid = [int]$p.ProcessId
    $procTable[$thisPid] = [int]$p.ParentProcessId
    $procNames[$thisPid] = $p.Name
    $procCmdLines[$thisPid] = if ($p.CommandLine) { $p.CommandLine } else { "" }
  }
} catch {
  Write-Host "CIM_FAIL:$($_.Exception.Message)"
  exit 1
}

# Defense against PID reuse
$cmdLine = if ($procCmdLines.ContainsKey($NodePid)) { $procCmdLines[$NodePid] } else { "" }
$nameCheck = if ($procNames.ContainsKey($NodePid)) { $procNames[$NodePid] } else { "" }
$isNodeProc = $nameCheck -match '^(node|node\\.exe)$'
$isClaudeCmd = $cmdLine -match '(claude-code|cli\\.js)' -or $cmdLine -match 'claude'
if (-not $isNodeProc -or -not $isClaudeCmd) {
  Write-Host "PID_NOT_CLAUDE:pid=$NodePid,name=$nameCheck"
  exit 1
}

# Build the ancestor chain
$ancestors = @()
$current = $NodePid
for ($i = 0; $i -lt 20; $i++) {
  if (-not $procTable.ContainsKey($current)) { break }
  $parent = $procTable[$current]
  if ($parent -le 0 -or $parent -eq $current) { break }
  if ($ancestors -contains $parent) { break }
  $ancestors += $parent
  $current = $parent
}

if ($ancestors.Count -eq 0) {
  Write-Host "NO_ANCESTORS:pid=$NodePid"
  exit 1
}

# Find the first ancestor with a top-level window
$targetHwnd = [IntPtr]::Zero
$targetPid = 0
$isWindowsTerminal = $false

foreach ($apid in $ancestors) {
  try {
    $proc = Get-Process -Id $apid -ErrorAction SilentlyContinue
    if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) {
      $targetHwnd = $proc.MainWindowHandle
      $targetPid = $apid
      if ($procNames[$apid] -match '^WindowsTerminal') { $isWindowsTerminal = $true }
      break
    }
  } catch {}
}

if ($targetHwnd -eq [IntPtr]::Zero) {
  Write-Host "NO_WINDOW:pid=$NodePid"
  exit 1
}

# Activate the window first
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
  Start-Sleep -Milliseconds 100
}
[W]::SetForegroundWindow($targetHwnd) | Out-Null

# For Windows Terminal, try to select the matching tab via UIAutomation.
$tabResult = "no-tab-switch"
if ($isWindowsTerminal -and $TargetName) {
  try {
    Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop

    Start-Sleep -Milliseconds 120

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
      $matchedScore = 0  # 3=exact, 2=substring, 1=normalized substring
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

    const ps = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-Command', buildScript(numericPid, sessionName, cwd)
    ], { windowsHide: true, timeout: 12000 });

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

module.exports = { focusTerminalByPid };
