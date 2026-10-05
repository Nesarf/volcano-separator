# volcano-separator :: isolate -- deny a binary the right to execute, reversibly
#
# What this actually stops, stated first because it is less than it sounds
# -----------------------------------------------------------------------
# This is a door lock, not a security boundary. It adds one DENY ACE that stops a file being
# launched again. It does not stop:
#   * a process that is already running -- that is `detain`'s job, and the two are complementary
#   * a copy, or a rename, or a move
#   * anyone with administrative rights, who can take ownership and put the ACL back
#
# It exists because the most common unwanted thing on a workstation is not an intrusion, it is a
# program that will not stay closed. A lock that can be undone is a smaller act than a deletion.
#
# Why the undo path is built the way it is
# ----------------------------------------
# The backup is written with icacls /save and can be restored with icacls /restore, both of which are
# the operating system's own tools. That is deliberate: the undo must not depend on this script, this
# tool, or this machine's copy of either. If volcano-separator is deleted, or broken, or the machine
# only boots to a recovery prompt, the restore command still works -- and the journal prints it.
#
# For the same reason the journal does NOT live under the cache directory. A cache is something a
# person is invited to clean, and a cleaned undo is not an undo. It lives beside the policy, because
# it is a decision about this machine rather than an artifact of running a tool.
param(
    [int]$TargetPid = 0,
    [string]$TargetPath = '',
    [string]$JournalDir = (Join-Path $env:USERPROFILE '.volcano-separator\acl'),
    [string]$ActivityDir = '',
    [switch]$Restore,
    [switch]$DryRun,
    [switch]$IncludeSystemRoot
)

$ErrorActionPreference = 'Continue'

$DENY_SPEC = '*S-1-1-0:(X)'   # Everyone, deny execute. SID rather than a name: names are localised.

function Write-Activity {
    param([hashtable]$Event)
    if (-not $ActivityDir) { return }
    try {
        if (-not (Test-Path $ActivityDir)) { New-Item -ItemType Directory -Force -Path $ActivityDir | Out-Null }
        $line = ($Event | ConvertTo-Json -Compress -Depth 6)
        $file = Join-Path $ActivityDir ("activity-" + (Get-Date -Format 'yyyy-MM-dd') + ".ndjson")
        Add-Content -LiteralPath $file -Value $line -Encoding UTF8
    } catch { }
}

function Test-Elevated {
    try {
        $id = [Security.Principal.WindowsIdentity]::GetCurrent()
        $p = New-Object Security.Principal.WindowsPrincipal($id)
        return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { return $false }
}

# The never-list. Refused, not warned about.
#
# %SystemRoot% is separated from %ProgramFiles% on purpose. A bad ACL on an application binary costs
# that application and is restorable. A bad ACL on something Windows itself loads can cost the boot,
# and the machine may then be recoverable only from outside it -- so Windows' own directory needs an
# explicit acknowledgement rather than being caught by a broad rule.
function Get-Refusal {
    param([string]$Path)
    $full = $null
    try { $full = [System.IO.Path]::GetFullPath($Path) } catch { return 'the path cannot be resolved' }
    $low = $full.ToLowerInvariant()

    $win = $env:SystemRoot
    if ($win -and $low.StartsWith($win.ToLowerInvariant())) {
        if (-not $IncludeSystemRoot) {
            return "it is inside %SystemRoot% ($win); pass -IncludeSystemRoot to mean it"
        }
    }
    $installer = Join-Path $env:ProgramData 'Package Cache'
    if ($installer -and $low.StartsWith($installer.ToLowerInvariant())) { return 'it is inside the installer package cache' }

    # Nothing may act on the undo path itself. A mechanism that can disable its own reversal is not
    # reversible, and this is the one rule that has to hold even when the caller insists.
    if ($JournalDir -and $low.StartsWith(([System.IO.Path]::GetFullPath($JournalDir)).ToLowerInvariant())) {
        return 'it is the undo journal itself'
    }
    $self = [System.IO.Path]::GetFullPath($PSScriptRoot)
    if ($low.StartsWith($self.ToLowerInvariant())) { return 'it is this tool' }

    return $null
}

function Get-TargetPath {
    if ($TargetPath) { return $TargetPath }
    if ($TargetPid -gt 0) {
        $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $TargetPid) -ErrorAction SilentlyContinue
        if ($p -and $p.ExecutablePath) { return $p.ExecutablePath }
        return ''
    }
    return ''
}

function Read-DenyState {
    param([string]$Path)
    $out = & icacls "$Path" 2>&1 | Out-String
    return [bool]($out -match 'DENY')
}

# ── restore ─────────────────────────────────────────────────────────────────
if ($Restore) {
    $spec = $null
    try { $spec = Get-Content -Raw -LiteralPath $TargetPath | ConvertFrom-Json } catch { }
    if (-not $spec) { Write-Output (@{ ok = $false; detail = "cannot read a journal at $TargetPath" } | ConvertTo-Json -Compress); exit 1 }

    $backup = [string]$spec.backupFile
    $dir = [System.IO.Path]::GetDirectoryName([string]$spec.path)
    if (-not (Test-Path $backup)) {
        Write-Output (@{ ok = $false; detail = "the ACL backup is missing: $backup"; restoreCommand = [string]$spec.restoreCommand } | ConvertTo-Json -Compress)
        exit 1
    }
    $r = & icacls "$dir" /restore "$backup" 2>&1 | Out-String
    $stillDenied = Read-DenyState -Path ([string]$spec.path)

    Write-Activity @{ kind = 'isolate'; action = 'restored'; path = [string]$spec.path; id = [string]$spec.id; denyStillPresent = $stillDenied }
    Write-Output (@{
        ok = (-not $stillDenied)
        action = 'restored'
        path = [string]$spec.path
        denied = $stillDenied
        detail = if ($stillDenied) { 'the DENY entry is still there -- the restore did not take' } else { 'the DENY entry is gone and the original ACL is back' }
        output = ($r.Trim())
    } | ConvertTo-Json -Compress)
    exit $(if ($stillDenied) { 1 } else { 0 })
}

# ── isolate ─────────────────────────────────────────────────────────────────
$resolved = Get-TargetPath
if (-not $resolved) {
    Write-Output (@{ ok = $false; detail = 'no target: give -TargetPath or a -TargetPid whose executable can be read' } | ConvertTo-Json -Compress)
    exit 1
}
if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
    Write-Output (@{ ok = $false; detail = "not a regular file: $resolved" } | ConvertTo-Json -Compress)
    exit 1
}

$refusal = Get-Refusal -Path $resolved
if ($refusal) {
    Write-Activity @{ kind = 'isolate'; action = 'refused'; path = $resolved; why = $refusal }
    Write-Output (@{ ok = $false; refused = $true; path = $resolved; detail = "refused: $refusal" } | ConvertTo-Json -Compress)
    exit 1
}

# Elevation is required for anything outside the user's own files, and a silent downgrade would be
# the kind of false signal this tool exists to remove.
$elevated = Test-Elevated
if (-not $elevated -and -not $DryRun) {
    Write-Output (@{ ok = $false; path = $resolved; elevated = $false; detail = 'not elevated: a DENY ACE on this file needs administrator rights, and doing nothing quietly would be worse than saying so' } | ConvertTo-Json -Compress)
    exit 1
}

if (-not (Test-Path $JournalDir)) { New-Item -ItemType Directory -Force -Path $JournalDir | Out-Null }
$id = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Math]::Abs($resolved.GetHashCode()).ToString('x8')
$backup = Join-Path $JournalDir ("$id.acl")
$journal = Join-Path $JournalDir ("$id.json")

$alreadyDenied = Read-DenyState -Path $resolved
$before = (& icacls "$resolved" 2>&1 | Out-String).Trim()

if ($alreadyDenied) {
    Write-Output (@{ ok = $true; path = $resolved; alreadyIsolated = $true; elevated = $elevated; detail = 'a DENY entry is already present; nothing to do' } | ConvertTo-Json -Compress)
    exit 0
}

if ($DryRun) {
    Write-Output (@{
        ok = $true
        dryRun = $true
        path = $resolved
        elevated = $elevated
        wouldApply = $DENY_SPEC
        wouldBackupTo = $backup
        detail = 'dry run: nothing was changed'
    } | ConvertTo-Json -Compress)
    exit 0
}

# The journal is written BEFORE the act, and the act is not performed if the journal cannot be
# written. An act that cannot be undone is a deletion with extra steps, and the ordering is the only
# thing that makes the difference.
$saved = & icacls "$resolved" /save "$backup" 2>&1 | Out-String
if (-not (Test-Path $backup)) {
    Write-Output (@{ ok = $false; path = $resolved; detail = "could not write the ACL backup, so nothing was changed: $($saved.Trim())" } | ConvertTo-Json -Compress)
    exit 1
}
$denyDir = [System.IO.Path]::GetDirectoryName($resolved)
$restoreCommand = "icacls `"$denyDir`" /restore `"$backup`""
$entry = @{
    id = $id
    kind = 'isolate'
    path = $resolved
    at = (Get-Date).ToUniversalTime().ToString('o')
    backupFile = $backup
    journalFile = $journal
    denySpec = $DENY_SPEC
    aclBefore = $before
    restoreCommand = $restoreCommand
    elevated = $elevated
    state = 'pending'
}
$entry | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $journal -Encoding UTF8
Write-Activity @{ kind = 'isolate'; action = 'pending'; path = $resolved; id = $id; backupFile = $backup; restoreCommand = $restoreCommand }

$applied = & icacls "$resolved" /deny "$DENY_SPEC" 2>&1 | Out-String
$denied = Read-DenyState -Path $resolved

$entry.state = if ($denied) { 'applied' } else { 'failed' }
$entry | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $journal -Encoding UTF8
Write-Activity @{ kind = 'isolate'; action = $entry.state; path = $resolved; id = $id; backupFile = $backup; restoreCommand = $restoreCommand; denyPresent = $denied }

$running = @(Get-CimInstance Win32_Process -Filter ("Name='" + [System.IO.Path]::GetFileName($resolved) + "'") -ErrorAction SilentlyContinue |
             Where-Object { $_.ExecutablePath -eq $resolved })

Write-Output (@{
    ok = $denied
    path = $resolved
    id = $id
    denied = $denied
    elevated = $elevated
    backupFile = $backup
    journalFile = $journal
    restoreCommand = $restoreCommand
    stillRunning = $running.Count
    detail = if ($denied) {
        "execute denied on $resolved. Undo without this tool: $restoreCommand"
    } else {
        "the DENY entry did not take: $($applied.Trim())"
    }
    note = if ($running.Count -gt 0) { "$($running.Count) process(es) are already running from this file and are unaffected; use detain for those" } else { $null }
} | ConvertTo-Json -Compress -Depth 6)

exit $(if ($denied) { 0 } else { 1 })
