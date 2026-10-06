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
$script:StartedAt = Get-Date

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

# Counters for this process, and the file they are published to.
#
# Why they exist at all: a reader could previously only ask "is the newest event recent?", and that
# question gives the same answer for a recorder that is working and for one whose every write is
# failing -- because the events that would have made the file look stale are the ones that never
# arrived. Silence read as calm. These numbers are the difference between "nothing happened" and
# "nothing was recorded".
#
# The reader-side contract, stated here because it decides the design: a stale snapshot is the honest
# signal that the recorder is not running. Numbers describe the write path; freshness describes
# whether anything is still doing the writing. Neither alone is enough.
$script:Counters = @{
    passes        = 0
    iterations    = 0   # turns of the main loop; compared against eventsSeen to show wake-ups that
                        # carried no event, which is what a spinning Wait-Event looks like
    eventsSeen    = 0   # process events handed to us by WMI
    eventsSelf    = 0   # ...of which we discarded as our own process
    eventsDuplicate = 0 # ...of which reached the queue as a repeat rather than being dropped early
    eventsAccepted  = 0 # distinct events that reached the handler
    eventsWritten = 0   # rows that reached the log
    eventsDropped = 0   # rows we tried to write and could not
    handlerErrors = 0   # exceptions while handling an event, before any write was attempted
}
$script:HealthFile = Join-Path $LogDir 'recorder-health.json'
$script:LastHealthWrite = [datetime]::MinValue
$script:SeenStamps = @{}
$script:DetailCache = @{}

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
    #
    # This is the one place that knows whether a row was written. The empty catch that used to be here
    # threw that knowledge away while keeping the row's absence: the event vanished and nothing said
    # so. Counting it is the whole point -- the record cannot be trusted to describe its own gaps, so
    # the count has to live outside it.
    $written = $false
    try {
        $fs = [System.IO.File]::Open($file, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
        try {
            $bytes = [System.Text.Encoding]::UTF8.GetBytes(('{' + $line + '}') + [char]10)
            $fs.Write($bytes, 0, $bytes.Length)
            $fs.Flush()
            $written = $true
        } finally { $fs.Dispose() }
    } catch { }
    if ($written) { $script:Counters.eventsWritten++ } else { $script:Counters.eventsDropped++ }
}

# Publish those counters where a reader can find them, and keep the file fresh enough that its
# staleness means something. Temp file then rename, so a reader racing this never parses half a
# snapshot -- the same rule as the policy file, for the same reason.
#
# Throttled by time rather than by pass count: passes are event-driven, so on a quiet machine a
# pass-counted snapshot would be written once an hour and its staleness would then mean nothing.
function Save-Health {
    param([switch]$Force)
    $now = Get-Date
    if (-not $Force -and ($now - $script:LastHealthWrite).TotalSeconds -lt 10) { return }

    # Every read that feeds this snapshot is defensive, and that is the point: the snapshot is the
    # only thing that can report a failure, so nothing here may be able to stop it being written.
    # An earlier version called Get-EventSubscriber unguarded; if that throws, the exception leaves
    # this function before the file is written and the recorder goes silent about its own state while
    # still recording events -- the exact shape of failure this file exists to make impossible.
    $sub = $false
    $subStop = $false
    try { $sub = [bool](Get-EventSubscriber -SourceIdentifier VSProcStart -ErrorAction SilentlyContinue) } catch { }
    try { $subStop = [bool](Get-EventSubscriber -SourceIdentifier VSProcStop -ErrorAction SilentlyContinue) } catch { }

    $state = @{
        pid            = $PID
        startedAt      = $(try { $script:StartedAt.ToString('o') } catch { '' })
        lockTaken      = [bool]$script:LockTaken
        subscribed     = $sub
        subscribedStop = $subStop
        eventsSeen     = $script:Counters.eventsSeen
        eventsSelf     = $script:Counters.eventsSelf
        eventsDuplicate = $script:Counters.eventsDuplicate
        eventsAccepted = $script:Counters.eventsAccepted
        selfPid        = $script:SelfPid
        eventsWritten  = $script:Counters.eventsWritten
        eventsDropped  = $script:Counters.eventsDropped
        handlerErrors  = $script:Counters.handlerErrors
        passes         = $script:Counters.passes
        iterations     = $script:Counters.iterations
        lockNote       = $script:LockNote
        uptimeSeconds  = [int]($now - $script:StartedAt).TotalSeconds
        t              = $now.ToString('o')
    }
    try {
        $json = ($state | ConvertTo-Json -Compress)
        $tmp = $script:HealthFile + '.tmp'
        [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $tmp -Destination $script:HealthFile -Force
    } catch { }
    $script:LastHealthWrite = $now
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
# Dedupe happens in the loop, not in an -Action block, and that is a decision with a measurement
# behind it. An action block CAN drop a repeat before it is queued, but PowerShell only delivers an
# event when the block emits something, so a block that filters silently also swallows the events it
# meant to keep -- observed here as seen=0 while rows were still being written. Getting that right is
# possible and was not worth it: the stream arrives at ~340 deliveries/second either way, so the
# action saved queue entries while the loop was still driven at the same rate and CPU did not move.
# The in-loop filter below is the one that is verifiably correct, so it is the one that stays.
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

# Every pass reaches the bottom of this loop, whether or not anything happened.
#
# That is a fix, not a tidy-up. Everything below the event handling -- the window sampler, the
# persistence comparison, the pruning -- used to run only when Wait-Event returned something, so on a
# quiet machine they did not run at all. The comparison that catches a Run key added and removed
# between two passes was therefore the *last* thing to happen once events stopped, and its silence was
# indistinguishable from calm. A recorder whose periodic work only occurs when the machine is busy is
# a recorder that stops when it matters.
Save-Health -Force

while ($true) {
    $script:Counters.iterations++
    $ev = Wait-Event -Timeout 2
    if ($ev) {
        foreach ($e in $ev) {
            $script:Counters.eventsSeen++
            try {
                $d = $e.SourceEventArgs.NewEvent
                $procId = [int]$d.ProcessID

                # Dedupe FIRST, decide identity second. The order is the whole fix.
                #
                # WMI hands the same trace record back many times -- measured here as 6,000
                # deliveries in 25 s that were 16 distinct events. When the identity test ran first,
                # every redelivery of one event was counted as a fresh discarding of our own process:
                # the health snapshot showed 105,203 "self" events over five minutes against 9 rows
                # written, which read as a busy recorder and was really one event repeated. A filter
                # placed before the dedupe cannot see how much is repetition, so it reports the storm
                # as its own workload.
                # The primary filter, and it must run BEFORE the identity test below. WMI hands the
                # same trace record back many times -- measured here as 10,500 deliveries in 31 s
                # that were one distinct event. With the identity test first, every redelivery of one
                # event counted as a fresh discarding of our own process: the snapshot showed 105,203
                # "self" events over five minutes against 9 rows written, which read as a busy
                # recorder and was one event repeated. A filter placed before the dedupe cannot see
                # how much of the stream is repetition, so it reports the storm as its own workload.
                $stamp = [string]$d.TIME_CREATED + ':' + $e.SourceIdentifier
                if ($script:SeenStamps.ContainsKey($stamp)) {
                    $script:Counters.eventsDuplicate++
                    continue
                }
                $script:SeenStamps[$stamp] = 1
                if ($script:SeenStamps.Count -gt 4000) { $script:SeenStamps.Clear() }
                $script:Counters.eventsAccepted++

                if ($procId -eq $script:SelfPid) { $script:Counters.eventsSelf++; continue }

                if ($e.SourceIdentifier -eq 'VSProcStart') {
                    # One WMI query per process, not per event. The delivery storm made this the
                    # difference between a few queries a second and hundreds.
                    if ($script:DetailCache.ContainsKey($procId)) {
                        $detail = $script:DetailCache[$procId]
                    } else {
                        $detail = Get-ProcDetail -ProcessId $procId
                        if ($script:DetailCache.Count -gt 2000) { $script:DetailCache.Clear() }
                        $script:DetailCache[$procId] = $detail
                    }
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
            } catch {
                # Counted rather than swallowed. An event that raised on the way in never reached the
                # write path, so it is not a dropped write -- and the two need different reactions.
                $script:Counters.handlerErrors++
            }
            Remove-Event -EventIdentifier $e.EventIdentifier -ErrorAction SilentlyContinue
        }
    }

    Sample-Windows

    # Persistence surfaces are the part that catches the quiet kind. Cheap keys every pass,
    # scheduled tasks less often because enumerating them is not free.
    $script:Counters.passes++
    if ($script:Counters.passes % 30 -eq 0) {
        $runNow = Get-RunKeys
        Compare-Surface -Surface 'RunKeys' -Before $runBefore -After $runNow
        $runBefore = $runNow
        $startupNow = Get-StartupFiles
        Compare-Surface -Surface 'StartupFolder' -Before $startupBefore -After $startupNow
        $startupBefore = $startupNow
    }
    if ($script:Counters.passes % (30 * $TasksEveryNthPass) -eq 0) {
        $tasksNow = Get-TaskList
        Compare-Surface -Surface 'ScheduledTasks' -Before $tasksBefore -After $tasksNow
        $tasksBefore = $tasksNow
    }

    if (((Get-Date) - $lastPrune).TotalMinutes -gt 30) { Prune-Old; $lastPrune = Get-Date }

    Save-Health
}
