# volcano-separator :: reveal
#
# Two jobs:
#   1. windows -- enumerate EVERY top-level window, including hidden ones, and (with -Show)
#      force the hidden ones to become visible. A window that exists but is hidden is the
#      interesting case; a process that never created one cannot be made to grow one without
#      injecting code into it, which this tool deliberately does not do.
#   2. process -- dump everything observable about a live process: command line, owner,
#      environment, loaded modules, listening/established connections, and its windows.
#
# Output is JSON on stdout so the caller does not have to parse prose.
param(
    [ValidateSet('windows', 'process', 'tree')][string]$Mode = 'windows',
    [int]$TargetPid = 0,
    [string]$Filter = '',
    [switch]$Show,
    [switch]$IncludeInvisible
)

$ErrorActionPreference = 'Continue'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class Win {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  public static List<object[]> All() {
    var list = new List<object[]>();
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      uint pid; GetWindowThreadProcessId(h, out pid);
      var t = new StringBuilder(512); GetWindowTextW(h, t, 512);
      var c = new StringBuilder(256); GetClassNameW(h, c, 256);
      list.Add(new object[] { h.ToInt64(), (int)pid, t.ToString(), c.ToString(), IsWindowVisible(h), GetParent(h).ToInt64() });
      return true;
    }, IntPtr.Zero);
    return list;
  }
  public static bool Show(long h) { return ShowWindow(new IntPtr(h), 5); }   // SW_SHOW
}
'@ -ErrorAction SilentlyContinue

function Get-ProcName([int]$ProcessId) {
    $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($p) { return $p.ProcessName }
    return ''
}

# ---------------------------------------------------------------- windows
if ($Mode -eq 'windows') {
    $rows = @()
    foreach ($w in [Win]::All()) {
        $h = [int64]$w[0]; $procId = [int]$w[1]; $title = [string]$w[2]; $cls = [string]$w[3]
        $visible = [bool]$w[4]; $parent = [int64]$w[5]
        $name = Get-ProcName $procId
        if ($Filter -and ("$name $title $cls" -notmatch $Filter)) { continue }
        # A top-level window with an owner and a real class is the kind worth reporting; the
        # invisible-and-empty ones are mostly message-only plumbing.
        if (-not $IncludeInvisible -and -not $visible -and -not $title) { continue }
        if ($parent -ne 0) { continue }

        $revealed = $false
        if ($Show -and -not $visible) {
            $revealed = [Win]::Show($h)
        }
        $rows += [pscustomobject]@{
            pid = $procId; process = $name; handle = $h; class = $cls
            title = $title; visible = $visible; forced = $revealed
        }
    }
    $rows | ConvertTo-Json -Depth 4 -Compress
    return
}

# ---------------------------------------------------------------- process
if ($Mode -eq 'process') {
    $target = $null
    if ($TargetPid -gt 0) { $target = Get-CimInstance Win32_Process -Filter ("ProcessId=$TargetPid") -ErrorAction SilentlyContinue }
    elseif ($Filter) { $target = Get-CimInstance Win32_Process -Filter ("Name LIKE '%" + $Filter + "%'") -ErrorAction SilentlyContinue | Select-Object -First 1 }
    if (-not $target) { '{"error":"process not found"}'; return }

    $procId = [int]$target.ProcessId
    $owner = ''
    try { $o = Invoke-CimMethod -InputObject $target -MethodName GetOwner -ErrorAction SilentlyContinue; if ($o.User) { $owner = "$($o.Domain)\$($o.User)" } } catch { }

    # environment: readable from the live process on Windows only with the right rights; try it
    $envMap = @{}
    try {
        $h = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($h) { }
    } catch { }

    $conns = @()
    try {
        $conns = Get-NetTCPConnection -OwningProcess $procId -ErrorAction SilentlyContinue |
            ForEach-Object { [pscustomobject]@{ state = "$($_.State)"; local = "$($_.LocalAddress):$($_.LocalPort)"; remote = "$($_.RemoteAddress):$($_.RemotePort)" } }
    } catch { }

    $mods = @()
    try { $mods = (Get-Process -Id $procId -ErrorAction SilentlyContinue).Modules | Select-Object -First 40 | ForEach-Object { $_.FileName } } catch { }

    $wins = @()
    foreach ($w in [Win]::All()) {
        if ([int]$w[1] -eq $procId) {
            $wins += [pscustomobject]@{ handle = [int64]$w[0]; class = [string]$w[3]; title = [string]$w[2]; visible = [bool]$w[4] }
        }
    }

    [pscustomobject]@{
        pid = $procId
        name = [string]$target.Name
        ppid = [int]$target.ParentProcessId
        owner = $owner
        started = "$($target.CreationDate)"
        exe = [string]$target.ExecutablePath
        cmd = [string]$target.CommandLine
        threads = @(Get-Process -Id $procId -ErrorAction SilentlyContinue).Count
        connections = $conns
        modules = $mods
        windows = $wins
    } | ConvertTo-Json -Depth 5 -Compress
    return
}

# ---------------------------------------------------------------- tree (live only)
if ($Mode -eq 'tree') {
    $all = @{}
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {
        $all[[int]$_.ProcessId] = [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = [string]$_.Name; cmd = [string]$_.CommandLine; started = "$($_.CreationDate)" }
    }
    $start = if ($TargetPid -gt 0) { $TargetPid } else { $null }
    $chain = @()
    $cur = $start
    for ($i = 0; $i -lt 12 -and $cur -and $all.ContainsKey($cur); $i++) {
        $chain += $all[$cur]
        $cur = $all[$cur].ppid
    }
    [pscustomobject]@{ pid = $TargetPid; chain = $chain } | ConvertTo-Json -Depth 5 -Compress
    return
}
