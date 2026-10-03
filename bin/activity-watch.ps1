# volcano-separator :: system-wide activity recorder
#
# Purpose (two, and both matter):
#   1. Transparency -- nothing starts on this machine without leaving a trace you can read.
#   2. Detection    -- persistence surfaces are watched for changes, so the registry-polluting
#                      kind of unwanted software cannot quietly add itself to Run / Startup.
#
# Honesty about scope: this RECORDS, it does not BLOCK. It gives attribution and a timeline,
# not prevention.
#
# Design constraints that decide the shape:
#   * It must be blind to nothing at startup. So it is event-driven and started at BOOT, and it
#     depends on none of the service layer -- not the daemon, not the database, not uv.
#   * A process that lives 80 ms still has to be caught. Polling misses those; WMI process
#     trace events do not.
#   * It writes plain newline-delimited JSON lines, one per event, so the record is readable
#     even when every other part of the stack is down.
param(
    [string]$LogDir = 'E:\DaShaoHuo\cache\tmp\volcano-separator\activity',
    [int]$KeepDays = 7,
    [int]$PersistIntervalSec = 60,
    [int]$TasksEveryNthPass = 10
)

$ErrorActionPreference = 'Continue'
$script:SelfPid = $PID

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Event {
    param([hashtable]$Fields)
    $Fields['t'] = (Get-Date).ToString('o')
    $line = ($Fields.GetEnumerator() |
             ForEach-Object {
                 $v = $_.Value
                 if ($null -eq $v) { $v = '' }
                 $v = ([string]$v) -replace '\\', '\\' -replace '"', '\"' -replace "`r?`n", ' '
                 '"{0}":{1}' -f $_.Key, $(if ($_.Value -is [int] -or $_.Value -is [long]) { $_.Value } else { '"' + $v + '"' })
             }) -join ','
    $file = Join-Path $LogDir (('activity-' + (Get-Date).ToString('yyyy-MM-dd')) + '.ndjson')
    try { Add-Content -LiteralPath $file -Value ('{' + $line + '}') -Encoding UTF8 } catch { }
}

function Prune-Old {
    try {
        $cut = (Get-Date).AddDays(-$KeepDays)
        Get-ChildItem -LiteralPath $LogDir -Filter 'activity-*.ndjson' -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -lt $cut } |
            ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
    } catch { }
}

# ---------------------------------------------------------------- process events
function Get-ProcDetail {
    param([int]$ProcessId)
    $cim = Get-CimInstance Win32_Process -Filter ("ProcessId=$ProcessId") -ErrorAction SilentlyContinue
    if (-not $cim) { return $null }
    $user = ''
    try {
        $o = Invoke-CimMethod -InputObject $cim -MethodName GetOwner -ErrorAction SilentlyContinue
        if ($o -and $o.User) { $user = "$($o.Domain)\$($o.User)" }
    } catch { }
    return @{ cmd = [string]$cim.CommandLine; ppid = [int]$cim.ParentProcessId; user = $user; exe = [string]$cim.ExecutablePath }
}

# Processes whose window title we still want to sample (a window appears slightly after start).
$script:Pending = @{}

function Sample-Windows {
    foreach ($procId in @($script:Pending.Keys)) {
        $entry = $script:Pending[$procId]
        $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if (-not $p) { $script:Pending.Remove($procId); continue }
        $title = ''
        try { $title = $p.MainWindowTitle } catch { }
        if ($title) {
            Write-Event @{ kind = 'window'; pid = [int]$procId; name = $entry.name; title = $title }
            $script:Pending.Remove($procId)
        } elseif (((Get-Date) - $entry.since).TotalSeconds -gt 8) {
            $script:Pending.Remove($procId)
        }
    }
}

# ---------------------------------------------------------------- persistence surfaces
function Get-RunKeys {
    $out = @{}
    foreach ($root in 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run',
                     'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce',
                     'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run',
                     'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce',
                     'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Run') {
        if (-not (Test-Path $root)) { continue }
        $props = Get-ItemProperty -Path $root -ErrorAction SilentlyContinue
        if (-not $props) { continue }
        foreach ($p in $props.PSObject.Properties) {
            if ($p.Name -like 'PS*') { continue }
            $out["$root::$($p.Name)"] = [string]$p.Value
        }
    }
    return $out
}

function Get-StartupFiles {
    $out = @{}
    foreach ($d in "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup",
                   "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\Startup") {
        Get-ChildItem -LiteralPath $d -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -ne 'desktop.ini' } |
            ForEach-Object { $out["$d::$($_.Name)"] = $_.FullName }
    }
    return $out
}

function Get-TaskList {
    $out = @{}
    Get-ScheduledTask -ErrorAction SilentlyContinue | ForEach-Object {
        $act = ($_.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' | '
        $out[$_.TaskName] = $act
    }
    return $out
}

function Compare-Surface {
    param([string]$Surface, [hashtable]$Before, [hashtable]$After)
    foreach ($k in $After.Keys) {
        if (-not $Before.ContainsKey($k)) {
            Write-Event @{ kind = 'persist'; surface = $Surface; action = 'added'; name = $k; value = $After[$k] }
        } elseif ($Before[$k] -ne $After[$k]) {
            Write-Event @{ kind = 'persist'; surface = $Surface; action = 'changed'; name = $k; value = $After[$k] }
        }
    }
    foreach ($k in $Before.Keys) {
        if (-not $After.ContainsKey($k)) {
            Write-Event @{ kind = 'persist'; surface = $Surface; action = 'removed'; name = $k; value = $Before[$k] }
        }
    }
}

# ---------------------------------------------------------------- main
Write-Event @{ kind = 'watcher'; action = 'start'; pid = $script:SelfPid; note = 'activity recorder online' }

$runBefore = Get-RunKeys
$startupBefore = Get-StartupFiles
$tasksBefore = Get-TaskList
Write-Event @{ kind = 'baseline'; run = $runBefore.Count; startup = $startupBefore.Count; tasks = $tasksBefore.Count }

Register-CimIndicationEvent -Query 'SELECT * FROM Win32_ProcessStartTrace' -SourceIdentifier VSProcStart -ErrorAction SilentlyContinue | Out-Null
Register-CimIndicationEvent -Query 'SELECT * FROM Win32_ProcessStopTrace'  -SourceIdentifier VSProcStop  -ErrorAction SilentlyContinue | Out-Null

if (-not (Get-EventSubscriber -SourceIdentifier VSProcStart -ErrorAction SilentlyContinue)) {
    Write-Event @{ kind = 'watcher'; action = 'error'; note = 'could not subscribe to process trace (needs elevation?)' }
}

$pass = 0
$lastPrune = Get-Date

while ($true) {
    $ev = Wait-Event -Timeout 2
    if ($ev) {
        foreach ($e in $ev) {
            try {
                $d = $e.SourceEventArgs.NewEvent
                $procId = [int]$d.ProcessID
                if ($procId -eq $script:SelfPid) { continue }
                if ($e.SourceIdentifier -eq 'VSProcStart') {
                    $detail = Get-ProcDetail -ProcessId $procId
                    Write-Event @{
                        kind = 'proc-start'; pid = $procId
                        ppid = $(if ($detail) { $detail.ppid } else { [int]$d.ParentProcessID })
                        name = [string]$d.ProcessName
                        user = $(if ($detail) { $detail.user } else { '' })
                        cmd  = $(if ($detail) { $detail.cmd } else { '' })
                    }
                    $script:Pending[$procId] = @{ name = [string]$d.ProcessName; since = (Get-Date) }
                } else {
                    Write-Event @{ kind = 'proc-stop'; pid = $procId; name = [string]$d.ProcessName }
                }
            } catch { }
            Remove-Event -EventIdentifier $e.EventIdentifier -ErrorAction SilentlyContinue
        }
    }

    Sample-Windows

    # Persistence surfaces are the part that catches the quiet kind. Cheap keys every pass,
    # scheduled tasks less often because enumerating them is not free.
    $pass++
    if ($pass % 30 -eq 0) {
        $runNow = Get-RunKeys
        Compare-Surface -Surface 'RunKeys' -Before $runBefore -After $runNow
        $runBefore = $runNow
        $startupNow = Get-StartupFiles
        Compare-Surface -Surface 'StartupFolder' -Before $startupBefore -After $startupNow
        $startupBefore = $startupNow
    }
    if ($pass % (30 * $TasksEveryNthPass) -eq 0) {
        $tasksNow = Get-TaskList
        Compare-Surface -Surface 'ScheduledTasks' -Before $tasksBefore -After $tasksNow
        $tasksBefore = $tasksNow
    }

    if (((Get-Date) - $lastPrune).TotalMinutes -gt 30) { Prune-Old; $lastPrune = Get-Date }
}
