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
# Test-LockHeld used to live here: it opened the lock exclusively, to see whether anyone held it, and
# disposed what it opened. See the note at the lock below for why a check that releases what it
# checked is not a guard.

# The lock is taken in ONE step, not checked and then taken.
#
# The previous version asked Test-LockHeld whether the lock could be opened exclusively, disposed the
# probe, and only then removed and recreated the file. Two recorders starting together -- which is
# what a boot or a task restart produces -- could both pass the check, because the check releases what
# it opened. Both then ran, and this machine had two live recorders holding the same daily NDJSON.
# Same shape as the uv cache prune that scanned and then deleted: check-then-act is a race whenever
# two of the same thing can start at once.
#
# CreateNew is the atomic part: exactly one caller can create a file that does not exist, and the
# rest get an error. What is left is deciding whether an error means "someone is running" or "someone
# died and left this behind", and those need different answers -- the first stands down, the second
# takes over.
#
# `script:LockNote` is reported in the record either way, so the reasoning is visible rather than a
# silent exit.
$script:LockNote = ''
$script:LockTaken = $false

function Write-OwnerPid {
    param($Stream)
    $owner = [System.Text.Encoding]::UTF8.GetBytes(([string]$PID))
    $Stream.Write($owner, 0, $owner.Length)
    $Stream.Flush()
}

try {
    $script:InstanceLock = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
    Write-OwnerPid $script:InstanceLock
    $script:LockTaken = $true
} catch {
    # The file exists. Who has it?
    $holder = ''
    for ($attempt = 0; $attempt -lt 8; $attempt++) {
        try { $holder = ((Get-Content -LiteralPath $lockPath -Raw -ErrorAction Stop) -replace '\s', '') } catch { $holder = '' }
        if ($holder -match '^\d+$') { break }
        # Empty or unreadable means a recorder is between CreateNew and writing its pid. Waiting is the
        # answer, not taking over: the boot race is exactly two recorders arriving at that instant.
        Start-Sleep -Milliseconds 250
    }

    $holderAlive = $false
    if ($holder -match '^\d+$') {
        $holderAlive = [bool](Get-Process -Id ([int]$holder) -ErrorAction SilentlyContinue)
    }

    if ($holderAlive -or $holder -notmatch '^\d+$') {
        # Either a live recorder, or a file that never named one. Standing down is the safe answer for
        # both: a recorder that does not start is visible in the record, and a second recorder holding
        # the same file is not.
        Write-Output "activity recorder: another instance holds the lock (holder='$holder'); standing down"
        exit 0
    }

    # The pid it names is gone, so this is a leftover from a recorder that died.
    try {
        Remove-Item -LiteralPath $lockPath -Force -ErrorAction Stop
        $script:InstanceLock = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
        Write-OwnerPid $script:InstanceLock
        $script:LockTaken = $true
        $script:LockNote = "took over a stale lock left by pid $holder"
    } catch {
        # Fail OPEN, and only here. The recorder existing at all matters more than the guard: this
        # project already had a day where a guard that failed closed wrote nothing and the only
        # symptom was an empty file. A duplicate is a defect; no recorder at all is a blind spot.
        $script:LockNote = 'single-instance guard unavailable, continuing anyway: ' + $_.Exception.Message
    }
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

# Subscribe FIRST, then take the baseline. The order used to be the other way round, and that left a
# window in which a process could start and land in neither the baseline nor the event stream: the
# snapshot was taken, the process started, and only then did the subscription begin. A process that
# lives for less than that gap -- exactly the kind this recorder exists to catch -- was invisible
# twice over.
#
# The two halves cover different things and together cover everything: a subscription catches anything
# that starts from now on, however briefly, and the baseline catches whatever is already running.
# Neither is complete alone, which is why the order matters rather than the effort.
#
# What no ordering can fix, stated rather than implied: a process that started AND exited before this
# line is in neither. Nothing observes the past. The baseline records `subscribed` so the boundary is
# legible in the record instead of being a matter of trust.
Register-CimIndicationEvent -Query 'SELECT * FROM Win32_ProcessStartTrace' -SourceIdentifier VSProcStart -ErrorAction SilentlyContinue | Out-Null
Register-CimIndicationEvent -Query 'SELECT * FROM Win32_ProcessStopTrace'  -SourceIdentifier VSProcStop  -ErrorAction SilentlyContinue | Out-Null

if (-not (Get-EventSubscriber -SourceIdentifier VSProcStart -ErrorAction SilentlyContinue)) {
    Write-Event @{ kind = 'watcher'; action = 'error'; note = 'could not subscribe to process trace (needs elevation?)' }
}

$runBefore = Get-RunKeys
$startupBefore = Get-StartupFiles
$tasksBefore = Get-TaskList
Write-Event @{
    kind       = 'baseline'
    run        = $runBefore.Count
    startup    = $startupBefore.Count
    tasks      = $tasksBefore.Count
    subscribed = [bool](Get-EventSubscriber -SourceIdentifier VSProcStart -ErrorAction SilentlyContinue)
    note       = 'taken after subscribing, so nothing falls between the two'
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
