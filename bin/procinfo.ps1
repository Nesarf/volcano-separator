# volcano-separator :: what is observable about one process
#
# The other half of the picture is the activity record, which is read on the Node side. This script is
# only the live half.
#
# Why it is a -File rather than a -Command with an inline script: the output is large (a running
# process has hundreds of loaded modules and dozens of connections), and passing that back through a
# command pipeline truncated it -- the first version returned JSON that could not be parsed, which
# looked like a probe bug rather than a transport limit.
#
# Why the answer goes to a FILE rather than to stdout: same reason, and it is this project's existing
# convention -- anything with paths, quotes or bulk in it travels through a file.
#
# What this can and cannot see, stated here because the caller relies on it:
#   * every top-level window the process owns, INCLUDING hidden ones. Hiding is exactly what a process
#     that does not want to be seen would do, so an invisible window is a fact worth reporting.
#   * its threads, handles, memory, CPU, start time, executable path, TCP connections and modules.
#   * NOT its internal state. It does not inject, so it cannot say what the process is "thinking".
#     A process with no window at all has nothing to reveal, and everything above is still true of it.
# `$Out` / `$out` is PowerShell's automatic variable for the output stream, and parameter names are
# case-insensitive -- so declaring one shadowed it. The symptom was a script that exited 0 with no
# stdout and wrote no file, while the value that should have gone into the file was pushed to the
# output stream and an OrderedDictionary's type name ended up as a FILE in the working directory. Two
# rounds were spent on the wrong cause (`[ordered]` and `ConvertTo-Json`, both of which are fine on
# 5.1) before the error was made to speak.
param(
    [Parameter(Mandatory = $true)][int]$TargetPid,
    [Parameter(Mandatory = $true)][string]$OutFile,
    [int]$MaxModules = 400
)

$ErrorActionPreference = 'SilentlyContinue'



$p = Get-Process -Id $TargetPid
$out = [ordered]@{
    exists       = [bool]$p
    pid          = $TargetPid
    name         = $(if ($p) { [string]$p.ProcessName } else { '' })
    threads      = $(if ($p) { $p.Threads.Count } else { $null })
    handles      = $(if ($p) { $p.HandleCount } else { $null })
    workingSetMB = $(if ($p) { [math]::Round($p.WorkingSet64 / 1MB, 1) } else { $null })
    privateMB    = $(if ($p) { [math]::Round($p.PrivateMemorySize64 / 1MB, 1) } else { $null })
    cpuSeconds   = $(if ($p) { [math]::Round($p.CPU, 1) } else { $null })
    startedAt    = $(if ($p) { $p.StartTime.ToString('o') } else { $null })
    responding   = $(if ($p) { [bool]$p.Responding } else { $null })
    hasWindow    = $(if ($p) { [bool]($p.MainWindowHandle -ne 0) } else { $null })
    windowTitle  = $(if ($p) { [string]$p.MainWindowTitle } else { '' })
    path         = $(if ($p) { [string]$p.Path } else { '' })
    windows      = @()
    connections  = @()
    modules      = @()
    note         = ''
}

if (-not $p) {
    $out['note'] = 'no process with that pid'
    $out | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $OutFile -Encoding UTF8
    exit 0
}

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class VsWindows {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
}
"@

$list = New-Object System.Collections.ArrayList
$cb = [VsWindows+EnumProc] {
    param($h, $l)
    $owner = 0
    [void][VsWindows]::GetWindowThreadProcessId($h, [ref]$owner)
    if ($owner -eq $TargetPid) {
        $t = New-Object System.Text.StringBuilder 512
        [void][VsWindows]::GetWindowText($h, $t, 512)
        $c = New-Object System.Text.StringBuilder 256
        [void][VsWindows]::GetClassName($h, $c, 256)
        [void]$list.Add([ordered]@{
            handle  = $h.ToInt64()
            visible = [bool][VsWindows]::IsWindowVisible($h)
            title   = $t.ToString()
            class   = $c.ToString()
        })
    }
    return $true
}
[void][VsWindows]::EnumWindows($cb, [IntPtr]::Zero)
$out['windows'] = $list.ToArray()

foreach ($c in (Get-NetTCPConnection -OwningProcess $TargetPid)) {
    $out['connections'] += [ordered]@{
        state  = [string]$c.State
        local  = "$($c.LocalAddress):$($c.LocalPort)"
        remote = "$($c.RemoteAddress):$($c.RemotePort)"
    }
}

foreach ($m in ($p.Modules | Select-Object -First $MaxModules)) { $out['modules'] += [string]$m.FileName }
if (($p.Modules | Measure-Object).Count -gt $MaxModules) {
    $out['note'] = "modules truncated at $MaxModules"
}

$out | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $OutFile -Encoding UTF8
