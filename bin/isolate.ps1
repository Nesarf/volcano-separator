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

# ── journal authenticity ─────────────────────────────────────────────────────
#
# Why this exists
# ---------------
# `restore` reads a journal and runs `icacls /restore` with the ACL file the journal names. If a
# journal can be forged, then "restore the original ACL" is itself a privilege-escalation primitive:
# plant a file, wait for someone to restore it, and the tool applies whatever DACL the planted file
# contains.
#
# So a journal is only acted on if this tool wrote it. Each one carries an HMAC over its
# security-relevant fields, keyed by a random key that DPAPI protects for this machine.
#
# What this actually stops, stated honestly
# -----------------------------------------
# It raises the bar from "write a JSON file into a directory" to "run code as this user on this
# machine". It does NOT stop an attacker who can already do the second thing -- they can call DPAPI
# too. What it does stop is the cheap versions: a journal copied from elsewhere, a hand-written one,
# a backup file swapped for another, a plausible-looking edit.
#
# Which is why the escape hatch matters more than the lock: **a journal that fails verification makes
# the TOOL refuse, not the undo impossible.** The restore command is printed on every result and uses
# icacls, so a person who trusts their own eyes more than our key can still undo by hand.

$JOURNAL_ENTROPY = [Text.Encoding]::UTF8.GetBytes('volcano-separator/journal/v1')

function Get-JournalKey {
    param([string]$Dir)
    $keyFile = Join-Path $Dir 'journal.key'
    try {
        Add-Type -AssemblyName System.Security -ErrorAction Stop
        if (Test-Path $keyFile) {
            $blob = [Convert]::FromBase64String(((Get-Content -Raw -LiteralPath $keyFile).Trim()))
            $raw = [Security.Cryptography.ProtectedData]::Unprotect($blob, $JOURNAL_ENTROPY, 'LocalMachine')
            return @{ ok = $true; key = $raw; file = $keyFile; created = $false }
        }
        $raw = New-Object byte[] 32
        [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($raw)
        $blob = [Security.Cryptography.ProtectedData]::Protect($raw, $JOURNAL_ENTROPY, 'LocalMachine')
        if (-not (Test-Path $Dir)) { New-Item -ItemType Directory -Force -Path $Dir | Out-Null }
        [Convert]::ToBase64String($blob) | Set-Content -LiteralPath $keyFile -Encoding ASCII
        return @{ ok = $true; key = $raw; file = $keyFile; created = $true }
    } catch {
        return @{ ok = $false; detail = "could not obtain the journal key: $($_.Exception.Message)"; file = $keyFile }
    }
}

# A canonical string, built by hand rather than by serialising a hashtable: ConvertTo-Json does not
# promise key order, and an HMAC over a value whose order can change is an HMAC that fails at random.
function Get-JournalMac {
    param([byte[]]$Key, [string]$Canonical)
    $h = [Security.Cryptography.HMACSHA256]::new($Key)
    return [Convert]::ToBase64String($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($Canonical)))
}

function Get-JournalCanonical {
    param([string]$Id, [string]$Path, [string]$BackupFile, [string]$BackupSha, [string]$DenySpec)
    $sep = [string][char]10
    return @('v1', $Id, $Path, $BackupFile, $BackupSha, $DenySpec) -join $sep
}

# The backup's hash, computed without Get-FileHash.
#
# `Get-FileHash` lives in Microsoft.PowerShell.Utility and its presence cannot be assumed: measured on
# this machine `Get-Command Get-FileHash` returns nothing. That single fact produced a journal written
# with `backupSha256: null` next to a valid signature, and then a restore that refused with a message
# blaming the signature. Both call sites now use the framework hasher, which does not depend on which
# cmdlets happen to be loaded.
function Get-FileSha256 {
    param([string]$LiteralPath)
    $stream = $null
    try {
        $stream = [System.IO.File]::OpenRead($LiteralPath)
        $sha = [System.Security.Cryptography.SHA256]::Create()
        $bytes = $sha.ComputeHash($stream)
        return ([System.BitConverter]::ToString($bytes) -replace '-', '')
    } catch {
        return $null
    } finally {
        if ($stream) { $stream.Dispose() }
    }
}

function Test-Journal {
    param([string]$Dir, [object]$Spec)
    $key = Get-JournalKey -Dir $Dir
    if (-not $key.ok) { return @{ ok = $false; why = $key.detail } }
    if (-not $Spec.hmac -or -not $Spec.backupSha256) {
        # Naming the field matters. This message said "no signature" for both cases, and the journal
        # that triggered it had a perfectly good signature with a null backup hash -- so the wording
        # pointed at the signature while the hash was the one that was absent.
        $missing = @()
        if (-not $Spec.hmac) { $missing += 'signature' }
        if (-not $Spec.backupSha256) { $missing += 'backup hash' }
        return @{ ok = $false; why = 'this journal is missing its ' + ($missing -join ' and ') + ', so this tool cannot vouch for it' }
    }
    $canon = Get-JournalCanonical -Id ([string]$Spec.id) -Path ([string]$Spec.path) -BackupFile ([string]$Spec.backupFile) -BackupSha ([string]$Spec.backupSha256) -DenySpec ([string]$Spec.denySpec)
    $expect = Get-JournalMac -Key $key.key -Canonical $canon
    if ($expect -ne [string]$Spec.hmac) {
        return @{ ok = $false; why = 'the journal has been changed since this tool wrote it, or was not written by it' }
    }
    $backup = [string]$Spec.backupFile
    if (-not (Test-Path $backup)) { return @{ ok = $false; why = "the ACL backup is missing: $backup" } }
    $actual = Get-FileSha256 -LiteralPath $backup
    if (-not $actual) {
        return @{ ok = $false; why = 'the ACL backup exists but could not be hashed, so there is nothing to compare it with' }
    }
    if ($actual -ne ([string]$Spec.backupSha256).ToUpperInvariant()) {
        return @{ ok = $false; why = 'the ACL backup does not match the hash this tool recorded for it' }
    }
    return @{ ok = $true; keyFile = $key.file; keyCreated = $key.created }
}

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

    # Every compare below is done twice: once against the path as written and once against the path
    # the filesystem says it really is.
    #
    # GetFullPath is lexical -- it normalises `..` and slashes and resolves nothing else -- so on a
    # machine with junctions it does not answer "where does this file live". Demonstrated here:
    #
    #   mklink /J E:\scratch\innocent-link C:\Windows\System32
    #   GetFullPath E:\scratch\innocent-link\kernel32.dll
    #     -> E:\scratch\innocent-link\kernel32.dll, which is not under C:\Windows, so NOT refused,
    #     -> and icacls would then have applied the deny to the real System32 file.
    #
    # Junctions need no elevation to create and this machine already has several, so this is not an
    # exotic case. A never-list that holds only when the caller spells the path the expected way is
    # not a never-list.
    $real = $null
    try {
        $rr = & (Join-Path $PSScriptRoot 'resolve-path.ps1') -Path $full | ConvertFrom-Json
        if ($rr.ok) { $real = [string]$rr.resolved }
    } catch { }
    $targets = @($low)
    $realLow = $null
    if ($real) {
        $realLow = ([System.IO.Path]::GetFullPath($real)).ToLowerInvariant()
        if ($realLow -ne $low) { $targets += $realLow }
    }
    $under = { param($prefix) $p2 = ([System.IO.Path]::GetFullPath($prefix)).ToLowerInvariant(); foreach ($t in $targets) { if ($t.StartsWith($p2)) { return $true } }; return $false }

    $win = $env:SystemRoot
    if ($win -and (& $under $win)) {
        if (-not $IncludeSystemRoot) {
            return "it is inside %SystemRoot% ($win); pass -IncludeSystemRoot to mean it"
        }
    }
    $installer = Join-Path $env:ProgramData 'Package Cache'
    if ($installer -and (& $under $installer)) { return 'it is inside the installer package cache' }

    # Nothing may act on the undo path itself. A mechanism that can disable its own reversal is not
    # reversible, and this is the one rule that has to hold even when the caller insists.
    if ($JournalDir -and (& $under $JournalDir)) {
        return 'it is the undo journal itself'
    }
    $self = [System.IO.Path]::GetFullPath($PSScriptRoot)
    if (& $under $self) { return 'it is this tool' }

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

    $dir = [System.IO.Path]::GetDirectoryName([string]$spec.path)
    $backup = [string]$spec.backupFile

    # Verified before anything is applied. A journal this tool did not write is not acted on -- see
    # the note above Test-Journal. Refusing here does NOT make the undo impossible: the escape hatch
    # is printed either way, and it is icacls, which does not need us.
    $verdict = Test-Journal -Dir $JournalDir -Spec $spec
    if (-not $verdict.ok) {
        $byHand = [string]$spec.restoreCommand
        if (-not $byHand) { $byHand = "icacls `"$dir`" /restore `"$backup`"" }
        Write-Activity @{ kind = 'isolate'; action = 'refused-restore'; path = [string]$spec.path; id = [string]$spec.id; why = $verdict.why }
        Write-Output (@{
            ok = $false
            refused = $true
            path = [string]$spec.path
            detail = "refused to restore: $($verdict.why)"
            restoreCommand = $byHand
            note = 'nothing was changed. If you trust this journal, that command undoes it without this tool.'
        } | ConvertTo-Json -Compress)
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
# Signed before it is written. The backup's hash goes into the signed payload too: signing only the
# journal would leave the ACL file itself swappable, which is the same attack one step over.
# Hashed and checked BEFORE the key is fetched, so that a failure here leaves nothing half-done.
$backupSha = Get-FileSha256 -LiteralPath $backup
if (-not $backupSha) {
    # This used to proceed: the journal was written with a null hash and the ACL was denied anyway,
    # leaving an act that the restore guard would later refuse to undo. Refusing later is the safe
    # direction and still the wrong place -- an act that cannot be undone must not be performed, which
    # is what this file's own comment says about the journal two paragraphs above.
    Write-Output (@{ ok = $false; path = $resolved; detail = "could not hash the ACL backup, so nothing was changed: the journal would not be verifiable" } | ConvertTo-Json -Compress)
    exit 1
}

$key = Get-JournalKey -Dir $JournalDir
if (-not $key.ok) {
    Write-Output (@{ ok = $false; path = $resolved; detail = "$($key.detail); nothing was changed, because a journal this tool cannot vouch for is one it must not act on later" } | ConvertTo-Json -Compress)
    exit 1
}
$canon = Get-JournalCanonical -Id $id -Path $resolved -BackupFile $backup -BackupSha $backupSha -DenySpec $DENY_SPEC
$mac = Get-JournalMac -Key $key.key -Canonical $canon

$entry = @{
    id = $id
    kind = 'isolate'
    path = $resolved
    at = (Get-Date).ToUniversalTime().ToString('o')
    backupFile = $backup
    backupSha256 = $backupSha
    hmac = $mac
    keyFile = $key.file
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
