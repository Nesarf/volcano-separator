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
    # Tiered because the parts differ by three orders of magnitude in cost, measured on this machine:
    #
    #   Get-Process           71 ms     threads, handles, memory, CPU, start time, path
    #   .Modules              64 ms     the loaded module list
    #   window enumeration    61 ms     every top-level window it owns, hidden ones included
    #   Get-NetTCPConnection 1277 ms    the CIM call, and the only expensive one
    #
    # A window meant to be watched cannot spend its refresh budget on the one call that costs more than
    # the refresh interval. So the cheap half is its own tier (about 0.2 s) and the expensive half is
    # another, refreshed less often. A fact that changes every millisecond and a fact that changes every
    # minute do not belong on one timer.
    [ValidateSet('fast', 'slow', 'all')][string]$Tier = 'all',
    [int]$MaxModules = 400
)

$ErrorActionPreference = 'SilentlyContinue'



$p = Get-Process -Id $TargetPid
$wantFast = ($Tier -eq 'fast' -or $Tier -eq 'all')
$wantSlow = ($Tier -eq 'slow' -or $Tier -eq 'all')

# Every key is present in every tier, with the ones this tier did not collect left null. A caller that
# has to branch on which fields exist ends up duplicating the tier logic; a caller that sees `null`
# knows the field was not asked for, which is a different thing from a field that is empty.
$out = [ordered]@{
    tier         = $Tier
    at           = (Get-Date).ToString('o')
    exists       = [bool]$p
    pid          = $TargetPid
    name         = $(if ($p) { [string]$p.ProcessName } else { '' })
    threads      = $null
    handles      = $null
    workingSetMB = $null
    privateMB    = $null
    cpuSeconds   = $null
    startedAt    = $null
    responding   = $null
    hasWindow    = $null
    windowTitle  = $null
    path         = $null
    windows      = $null
    connections  = $null
    modules      = $null
    moduleCount  = $null
    connectionsError = $null
    note         = ''
}

if (-not $p) {
    $out['note'] = 'no process with that pid'
    $out | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $OutFile -Encoding UTF8
    exit 0
}

if ($wantFast) {
    $out['threads'] = $p.Threads.Count
    $out['handles'] = $p.HandleCount
    $out['workingSetMB'] = [math]::Round($p.WorkingSet64 / 1MB, 1)
    $out['privateMB'] = [math]::Round($p.PrivateMemorySize64 / 1MB, 1)
    $out['cpuSeconds'] = [math]::Round($p.CPU, 1)
    $out['startedAt'] = $p.StartTime.ToString('o')
    $out['responding'] = [bool]$p.Responding
    $out['hasWindow'] = [bool]($p.MainWindowHandle -ne 0)
    $out['windowTitle'] = [string]$p.MainWindowTitle
    $out['path'] = [string]$p.Path
}

if (-not $wantSlow) {
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

# The connections query is the one that can fail rather than merely find nothing, and the two must not
# look alike.
#
# `Get-NetTCPConnection -OwningProcess <pid>` THROWS for a process with no matching entries -- it does
# not return an empty set. Under this script's `-ErrorAction SilentlyContinue` that produced a `null`
# where a caller expects an array, so "this process has no connections" and "the query did not run"
# were the same answer. Measured: the message it throws is also mojibake under the console code page,
# so a reader could not have told them apart from the output either.
#
# So the failure is caught explicitly and named. An empty list now means what it says.
$connErr = $null
try {
    $conns = @(Get-NetTCPConnection -OwningProcess $TargetPid -ErrorAction Stop)
    $out['connections'] = @()
    foreach ($c in $conns) {
        $out['connections'] += [ordered]@{
            state  = [string]$c.State
            local  = "$($c.LocalAddress):$($c.LocalPort)"
            remote = "$($c.RemoteAddress):$($c.RemotePort)"
        }
    }
} catch {
    # Left null on purpose, and with the reason attached: a caller must be able to distinguish this
    # from a process that simply has no connections.
    $out['connections'] = $null
    $connErr = [string]$_.Exception.Message
    if ($out['note']) { $out['note'] += '; ' } 
    $out['note'] += 'the connection list could not be read, so connections is null rather than empty'
}
$out['connectionsError'] = $connErr

# Collected into an ArrayList and assigned once, the same way the windows are. The first version
# used `$out["modules"] += ...` from a null, and PowerShell turned that into STRING CONCATENATION --
# so the JSON carried one enormous string instead of an array of paths, and every path after the
# first ran into the next with no separator. The measurement that caught it: `typeof modules` was
# `string` and its length was the module COUNT, which is exactly what a joined string looks like.
$modList = New-Object System.Collections.ArrayList
foreach ($m in ($p.Modules | Select-Object -First $MaxModules)) { [void]$modList.Add([string]$m.FileName) }
$out['modules'] = $modList.ToArray()
if (($p.Modules | Measure-Object).Count -gt $MaxModules) {
    $out['note'] = "modules truncated at $MaxModules"
}

$out | ConvertTo-Json -Depth 5 -Compress | Set-Content -LiteralPath $OutFile -Encoding UTF8
