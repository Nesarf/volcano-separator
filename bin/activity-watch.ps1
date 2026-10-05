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
    [string]$LogDir = (Join-Path $env:TEMP (Join-Path 'volcano-separator' 'activity')),
    [int]$KeepDays = 7,
    [int]$PersistIntervalSec = 60,
    [int]$TasksEveryNthPass = 10
)

$ErrorActionPreference = 'Continue'
$script:SelfPid = $PID

# Redaction lives in its own file so the smoke suite can exercise the rules without starting the
# recorder (the main loop below runs on load, so this script cannot be dot-sourced).
#
# If it is missing, do NOT fall back to recording the raw command line: this log is append-only and
# several views read it, so a secret written once is written for good. Falling back to the
# executable alone keeps the record useful -- exeFromCmd, the signals rules and the custody
# timeline all work from the executable path -- so a missing file degrades transparency rather
# than leaking credentials.
$redactPath = Join-Path $PSScriptRoot 'redact.ps1'
if (Test-Path $redactPath) {
    . $redactPath
} else {
    function Protect-CommandLine {
        param([AllowNull()][string]$CommandLine)
        if ([string]::IsNullOrEmpty($CommandLine)) { return $CommandLine }
        $t = $CommandLine.Trim()
        $i = $t.IndexOf(' ')
        if ($i -lt 0) { return $t }
        return $t.Substring(0, $i) + ' <arguments withheld: redact.ps1 missing>'
    }
}

# The directory must exist before anything tries to create a file in it. Getting this order wrong
# is what silently disabled this recorder: the guard ran first, failed to open its lock file because
# the directory was missing, and treated that as 'another instance holds it' -- so the script exited 0
# and wrote nothing, and nothing anywhere said so.
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# Only one recorder may exist. Two of them do not merely duplicate rows: each can hold the day's
# file open, and a reader then gets EBUSY and is told there is no record at all -- the invisible
# state this tool exists to remove.
#
# The guard fails OPEN. It stops a second instance, and it never stops the first: a lock that cannot
# be created for any reason other than 'somebody holds it' must not be allowed to switch the recorder
# off, because a safeguard that silently disables the thing it guards is worse than no safeguard.
$lockPath = Join-Path $LogDir 'recorder.lock'
$script:InstanceLock = $null
$script:LockNote = ''

# Reading the lock must not be fooled by an empty one. [int]('') throws, and treating that as
# 'stale' would delete a live holder's lock and let a second recorder in -- a guard that quietly
# stops guarding. Emptiness is therefore judged by age: recent and unreadable means held, old and
# unreadable means the holder died before it could write.
# Is the lock held? Ask the filesystem, not the file's contents.
#
# The first version wrote the holder's pid and read it back. That failed in two ways at once: the
# pid never reached disk (the file stayed 0 bytes), and reading an empty file threw, which the
# caller took for 'stale'. An age heuristic was no better -- a lock that is genuinely held open
# looks exactly like an abandoned one. Trying to open it exclusively answers the real question
# directly, and needs no pid and no clock.
function Test-LockHeld {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    try {
        $probe = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        $probe.Dispose()
        return $false   # we could take it exclusively, so nobody else holds it
    } catch {
        return $true    # somebody holds it open
    }
}

$script:HeldByOther = Test-LockHeld -Path $lockPath
if ($script:HeldByOther) {
    exit 0
}

# Ours to take. Remove whatever was there (stale, or empty) and create it atomically.
Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
try {
    $script:InstanceLock = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
    $owner = [System.Text.Encoding]::UTF8.GetBytes(([string]$PID))
    $script:InstanceLock.Write($owner, 0, $owner.Length)
    $script:InstanceLock.Flush()
    if (-not (Get-Item -LiteralPath $lockPath).Length) {
        $script:LockNote = 'lock created but the holder pid did not persist'
    }
} catch {
    # Could not take the lock at all. Fail OPEN: never let a lock failure switch off the recorder.
    $script:LockNote = 'single-instance guard unavailable: ' + $_.Exception.Message
}

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
    # Open, write, close -- and allow readers in while we do it. Add-Content can end up holding
    # an exclusive handle, and a record nobody can read is not a record: the reader gets EBUSY,
    # concludes there is no recorder, and the tool reproduces the invisibility it exists to fix.
    try {
        $fs = [System.IO.File]::Open($file, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
        try {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes(('{' + $line + '}') + [char]10)
            $fs.Write($bytes, 0, $bytes.Length)
            $fs.Flush()
        } finally { $fs.Dispose() }
    } catch { }
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
    # Redacted here, at the point the command line enters the record. Secrets travel in command
    # lines -- --token, AWS_SECRET_ACCESS_KEY=, Authorization: Bearer ... -- and this log is
    # append-only and read by several views, so this is the last place the value can be removed.
    # The executable token is preserved: exeFromCmd parses it back out to decide what ran.
    return @{ cmd = (Protect-CommandLine ([string]$cim.CommandLine)); ppid = [int]$cim.ParentProcessId; user = $user; exe = [string]$cim.ExecutablePath }
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
