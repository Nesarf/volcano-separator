# volcano-separator :: detain
#
# For a process you believe is hostile. Three things happen, in this order, and the order is
# what makes the third one true:
#
#   1. SUSPEND it. A running process can always destroy its own windows, so nothing below can
#      be guaranteed while it is running. Freezing it first is what converts "we asked it to
#      stay visible" into "it cannot do anything about it".
#   2. REVEAL every window it owns, forcing hidden ones visible.
#   3. Put a CUSTODY WINDOW of our own on screen, on top, showing what it is and what it is
#      doing. The target cannot close this one: it belongs to us, not to the target.
#
# Honest limits:
#   * A process that never created a window cannot be given one. We cannot conjure a window
#     inside it without injecting code into it, and this tool does not inject.
#   * Suspension is not deletion. The process still holds its memory, handles and connections;
#     it simply cannot execute. Release resumes it.
#   * Suspension can destabilise software that holds a shared resource. That is the point of
#     asking a human to decide, and it is why this is a deliberate command, not a default.
param(
    [Parameter(Mandatory = $true)][int]$TargetPid,
    [switch]$Release,
    [switch]$NoSuspend,
    [switch]$NoCustody,
    [switch]$KeepOnTop,
    [string]$PolicyFile = '',
    [string]$Reason = ''
)

$ErrorActionPreference = 'Continue'
if (-not $ActivityDir) { $ActivityDir = Join-Path $env:TEMP (Join-Path 'volcano-separator' 'activity') }
New-Item -ItemType Directory -Force -Path $ActivityDir | Out-Null

function Write-Activity {
    param([hashtable]$Fields)
    $Fields['t'] = (Get-Date).ToString('o')
    $line = ($Fields.GetEnumerator() | ForEach-Object {
        $v = if ($null -eq $_.Value) { '' } else { ([string]$_.Value) -replace '\\', '\\' -replace '"', '\"' -replace "`r?`n", ' ' }
        '"{0}":{1}' -f $_.Key, $(if ($_.Value -is [int] -or $_.Value -is [long]) { $_.Value } else { '"' + $v + '"' })
    }) -join ','
    # The recorder and this script both append to the same file. A collision is expected, not
    # exceptional, so retry rather than silently losing the record.
    $file = Join-Path $ActivityDir ('activity-' + (Get-Date).ToString('yyyy-MM-dd') + '.ndjson')
    for ($i = 0; $i -lt 8; $i++) {
        try {
            Add-Content -LiteralPath $file -Value ('{' + $line + '}') -Encoding UTF8 -ErrorAction Stop
            break
        } catch { Start-Sleep -Milliseconds (60 + 40 * $i) }
    }
}

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class Custody {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);

  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr h);
  [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr h);

  public const uint PROCESS_SUSPEND_RESUME = 0x0800;

  public static bool Suspend(int pid) {
    IntPtr h = OpenProcess(PROCESS_SUSPEND_RESUME, false, pid);
    if (h == IntPtr.Zero) return false;
    int r = NtSuspendProcess(h); CloseHandle(h); return r == 0;
  }
  public static bool Resume(int pid) {
    IntPtr h = OpenProcess(PROCESS_SUSPEND_RESUME, false, pid);
    if (h == IntPtr.Zero) return false;
    int r = NtResumeProcess(h); CloseHandle(h); return r == 0;
  }
  public static List<object[]> Windows(int pid) {
    var list = new List<object[]>();
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      uint wpid; GetWindowThreadProcessId(h, out wpid);
      if ((int)wpid != pid) return true;
      if (GetParent(h) != IntPtr.Zero) return true;
      var t = new StringBuilder(512); GetWindowTextW(h, t, 512);
      var c = new StringBuilder(256); GetClassNameW(h, c, 256);
      list.Add(new object[] { h.ToInt64(), t.ToString(), c.ToString(), IsWindowVisible(h) });
      return true;
    }, IntPtr.Zero);
    return list;
  }
  public static int Reveal(int pid) {
    int n = 0;
    foreach (var w in Windows(pid)) {
      long h = (long)w[0]; bool vis = (bool)w[3];
      if (!vis) { ShowWindow(new IntPtr(h), 5); n++; }
      SetWindowPos(new IntPtr(h), new IntPtr(-1), 0,0,0,0, 0x0001 | 0x0002 | 0x0040);
    }
    return n;
  }
}
'@ -ErrorAction SilentlyContinue

$target = Get-CimInstance Win32_Process -Filter ("ProcessId=$TargetPid") -ErrorAction SilentlyContinue
if (-not $target) {
    Write-Activity @{ kind = 'detain'; action = 'failed'; pid = $TargetPid; why = 'process not found' }
    Write-Output '{"ok":false,"detail":"process not found"}'
    exit 1
}
$name = [string]$target.Name
$cmd = [string]$target.CommandLine

# ------------------------------------------------------------------ release
if ($Release) {
    # The mechanical result decides what is recorded, and it did not before.
    #
    # This used to call Resume, discard the answer, write `action = 'released'` unconditionally, and
    # `exit 0` -- so a release that failed was recorded as a release that happened. That is the one
    # thing this tool is built not to do: a record may not assert something the system did not do.
    # `running` in the custody report means exactly "a release was recorded but the process is still
    # frozen", and the two ways to produce that state were a genuine bug and this line.
    $ok = [Custody]::Resume($TargetPid)
    $action = if ($ok) { 'released' } else { 'release-failed' }

    # Recorded either way, because a failed attempt is itself something a person needs to see. What
    # changes is the claim, not whether there is a record.
    Write-Activity @{ kind = 'detain'; action = $action; pid = $TargetPid; name = $name; requested = $true; succeeded = [bool]$ok }

    $rel = @{
        ok             = [bool]$ok
        action         = $action
        requested      = $true
        succeeded      = [bool]$ok
        pid            = $TargetPid
        name           = $name
    }
    if (-not $ok) {
        $rel.detail = 'NtResumeProcess did not report success, so this pid may still be frozen'
        $rel.note = 'the record says release-failed rather than released, because the record must not claim what did not happen'
    }
    try { $rel | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $ActivityDir ("detain-$TargetPid.json")) -Encoding UTF8 } catch { }
    Write-Output ($rel | ConvertTo-Json -Compress)
    exit $(if ($ok) { 0 } else { 1 })
}

# ------------------------------------------------------------------ 1. suspend
$suspended = $false
if (-not $NoSuspend) {
    $suspended = [Custody]::Suspend($TargetPid)
}
Write-Activity @{
    kind = 'detain'; action = $(if ($suspended) { 'suspended' } else { 'observed' })
    pid = $TargetPid; name = $name; cmd = $cmd
    why = 'flagged for custody; frozen so its own windows cannot be withdrawn'
    # Creation time travels with the event so a later reader can tell this process apart from a
    # different one that inherited the same pid. A pid is not an identity: a record for a frozen
    # pid read as "released and running" while the process then on the machine was not the one
    # that had been frozen.
    created = $target.CreationDate.ToUniversalTime().ToString('o')
}

# ------------------------------------------------------------------ 2. reveal
$before = [Custody]::Windows($TargetPid)
$revealed = [Custody]::Reveal($TargetPid)
Write-Activity @{ kind = 'detain'; action = 'revealed'; pid = $TargetPid; windows = $before.Count; forced = $revealed }

$summary = [pscustomobject]@{
    ok = $true; pid = $TargetPid; name = $name
    suspended = $suspended
    windows = $before.Count
    forcedVisible = $revealed
    custody = (-not $NoCustody)
}

# Write the record FIRST. The custody window needs WinForms, and anything that fails there
# would otherwise take the summary down with it -- which is exactly how "detain produced no
# summary" happened while the freeze itself had worked perfectly.
try { $summary | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $ActivityDir ("detain-$TargetPid.json")) -Encoding UTF8 } catch { }

# ------------------------------------------------------------------ 3. custody window
if (-not $NoCustody) {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    $form = New-Object System.Windows.Forms.Form
    $form.Text = "VOLCANO SEPARATOR :: CUSTODY  --  $name (pid $TargetPid)"
    $form.Width = 900; $form.Height = 560
    $form.StartPosition = 'CenterScreen'
    $form.BackColor = [System.Drawing.Color]::FromArgb(16, 18, 28)
    $form.ForeColor = [System.Drawing.Color]::FromArgb(220, 225, 240)
    $form.Font = New-Object System.Drawing.Font('Consolas', 9.5)
    if ($KeepOnTop) { $form.TopMost = $true }

    $head = New-Object System.Windows.Forms.Label
    $head.Dock = 'Top'; $head.Height = 132
    $head.ForeColor = [System.Drawing.Color]::FromArgb(255, 140, 140)
    $stateLine = if ($suspended) { 'SUSPENDED: frozen, so it cannot close, hide or change anything.' } else { 'RUNNING: only observed; it can still close its own windows.' }
    $reasonLine = if ($Reason) { $Reason } else { 'flagged for custody by policy' }
    $head.Text = @"
DETAINED -- under custody. It cannot withdraw its own windows.
  $name   pid $TargetPid
  $stateLine

WHY IT WAS FLAGGED
  $reasonLine

Change to the registry are not proof of harm: keygens, patchers, licence tools and the work of
developers and security researchers all do this legitimately. Nothing has been moved, altered
or deleted -- this tool never quarantines. Read the evidence above and decide.
"@
    $form.Controls.Add($head)

    $box = New-Object System.Windows.Forms.TextBox
    $box.Multiline = $true; $box.ReadOnly = $true; $box.ScrollBars = 'Vertical'
    $box.Dock = 'Fill'
    $box.BackColor = [System.Drawing.Color]::FromArgb(8, 10, 16)
    $box.ForeColor = [System.Drawing.Color]::FromArgb(150, 220, 180)
    $form.Controls.Add($box)
    $box.BringToFront()

    $buttons = New-Object System.Windows.Forms.Panel
    $buttons.Dock = 'Bottom'; $buttons.Height = 40

    # Never name a local after a parameter in PowerShell: `$release` IS the -Release switch,
    # and assigning a Button to it fails at runtime with a metadata-conversion error. This
    # script has already been bitten by $PID and by that; the suffix is deliberate.
    $allowBtn = New-Object System.Windows.Forms.Button
    $allowBtn.Text = 'ALLOW  (this is fine -- never flag it again)'
    $allowBtn.Dock = 'Left'; $allowBtn.Width = 360
    $allowBtn.BackColor = [System.Drawing.Color]::FromArgb(28, 70, 44)
    $allowBtn.ForeColor = [System.Drawing.Color]::White
    $buttons.Controls.Add($allowBtn)

    $releaseBtn = New-Object System.Windows.Forms.Button
    $releaseBtn.Text = 'RELEASE  (resume it, decide later)'
    $releaseBtn.Dock = 'Fill'
    $releaseBtn.BackColor = [System.Drawing.Color]::FromArgb(60, 30, 30)
    $releaseBtn.ForeColor = [System.Drawing.Color]::White
    $buttons.Controls.Add($releaseBtn)

    $form.Controls.Add($buttons)

    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 1000
    $timer.Add_Tick({
        # Keep its windows visible for as long as we hold it. While suspended this is belt and
        # braces; if it was never suspended it is the only thing doing the work.
        $null = [Custody]::Reveal($TargetPid)
        $p = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
        $lines = @()
        $lines += "--- live ---"
        $lines += "alive        : $([bool]$p)"
        if ($p) {
            $lines += "threads      : $($p.Threads.Count)"
            $lines += "handles      : $($p.HandleCount)"
            $lines += "working set  : $([math]::Round($p.WorkingSet64/1MB,1)) MB"
            $lines += "total CPU    : $([math]::Round($p.CPU,1)) s"
        }
        $lines += ""
        $lines += "--- its windows ---"
        foreach ($w in [Custody]::Windows($TargetPid)) {
            $lines += ("  [{0}] {1}  '{2}'" -f $(if ($w[3]) { 'visible' } else { 'HIDDEN ' }), [string]$w[2], [string]$w[1])
        }
        $lines += ""
        $lines += "--- network ---"
        $conns = Get-NetTCPConnection -OwningProcess $TargetPid -ErrorAction SilentlyContinue
        if ($conns) { foreach ($c in $conns) { $lines += "  $($c.State) $($c.LocalAddress):$($c.LocalPort) -> $($c.RemoteAddress):$($c.RemotePort)" } }
        else { $lines += "  (none)" }
        $lines += ""
        $lines += "--- modules (first 25) ---"
        if ($p) { foreach ($m in ($p.Modules | Select-Object -First 25)) { $lines += "  " + $m.FileName } }

        $box.Text = ($lines -join "`r`n")
    })
    $timer.Start()

    $allowBtn.Add_Click({
        # The user's decision becomes policy. Entries are name:/path: prefixes, the same shape
        # the CLI writes, so the file stays one thing rather than two kinds of record.
        $entry = ''
        if ($target.ExecutablePath) { $entry = 'path:' + ([string]$target.ExecutablePath).ToLower() }
        elseif ($name) { $entry = 'name:' + $name.ToLower() }
        $written = $false
        if ($PolicyFile -and $entry) {
            try {
                $pol = if (Test-Path $PolicyFile) { Get-Content -LiteralPath $PolicyFile -Raw | ConvertFrom-Json } else { [pscustomobject]@{ mode = 'observe'; allow = @() } }
                $cur = @()
                if ($pol.allow) { $cur = @($pol.allow) }
                if ($cur -notcontains $entry) { $cur += $entry }
                $pol.allow = $cur
                $pol | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $PolicyFile -Encoding UTF8
                $written = $true
            } catch { }
        }
        Write-Activity @{ kind = 'detain'; action = 'allowed-by-user'; pid = $TargetPid; name = $name; entry = $entry; policyWritten = $written }
        $null = [Custody]::Resume($TargetPid)
        $timer.Stop()
        $form.Close()
    })

    $releaseBtn.Add_Click({
        $null = [Custody]::Resume($TargetPid)
        Write-Activity @{ kind = 'detain'; action = 'released-by-user'; pid = $TargetPid; name = $name }
        $timer.Stop()
        $form.Close()
    })

    try { $summary | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $ActivityDir ("detain-$TargetPid.json")) -Encoding UTF8 } catch { }
    Write-Output ($summary | ConvertTo-Json -Compress)
    [void]$form.ShowDialog()
} else {
    try { $summary | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $ActivityDir ("detain-$TargetPid.json")) -Encoding UTF8 } catch { }
    Write-Output ($summary | ConvertTo-Json -Compress)
}
