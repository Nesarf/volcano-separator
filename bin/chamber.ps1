# volcano-separator :: chamber
#
# A window this tool owns, showing everything observable about one process.
#
# What it is for, and what it is not
# ----------------------------------
# When a process will not show what it is doing, this puts it somewhere it is observed. The window
# belongs to this tool: the target cannot close it, cannot hide from it, and does not have to
# cooperate with it. **It cannot make a windowless process produce a window** -- this tool does not
# inject, so a process that never created one has nothing to reveal, and everything below is still
# true about it.
#
# Why reading the answer happens on the Node side
# -----------------------------------------------
# `procinfo.ps1` collects the live facts, and the activity record is read by `lib/chamber.mjs`, which
# writes one profile file per refresh. Rebuilding the history reader here would be a second
# implementation of something that already exists, and the two would drift. So this script renders
# what it is handed and collects the live half itself, because that half must be fresh.
#
# Style: pixel art, as a standing constraint for everything this project grows. **What that means here
# is honest and limited:** PowerShell 5.1's WinForms text is antialiased, so this is pixel-art
# *composition* -- a monospace grid, a small fixed palette, block characters instead of curves -- and
# not pixel *rendering*. A real pixel-art layer would have to draw glyphs itself. Saying otherwise
# would be the kind of claim this project removes.
param(
    [Parameter(Mandatory = $true)][int]$TargetPid,
    [string]$ProfileFile = '',
    [int]$FastMs = 1000,
    [int]$SlowMs = 15000,
    [switch]$TopMost,
    [switch]$Introspect,
    # Pixel glyphs for the panel body instead of system-rendered text. Off by default:
    # the readable view is the default and the pixel one is the deliberate choice.
    [switch]$Pixel,
    [ValidateRange(1, 6)][int]$PixelScale = 2,
    # Write the pixel panel to a PNG and exit, without opening a window. A graphical claim needs a
    # graphical check, and this project has no other way to look at a bitmap it produced.
    [string]$PixelPng = '',
    [int]$AutoCloseMs = 0
)

$ErrorActionPreference = 'Continue'

# The console encoding is forced to UTF-8 before anything is printed.
#
# This project has already paid for this lesson once, with an antivirus engine name that came back as
# replacement characters -- "a mojibake name is the wrong answer to 'who is watching'". The panel uses
# block and box characters, so under the default code page they arrive as `鈹€鈹€` and the reader cannot
# tell a rendering fault from a data fault.
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $OutputEncoding = [Console]::OutputEncoding
} catch { }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# The palette. Six colours, because a small fixed palette is what makes a pixel composition read as
# one -- and because a narrow palette is harder to make dishonest with.
$BG      = [System.Drawing.Color]::FromArgb(14, 16, 26)
$PANEL   = [System.Drawing.Color]::FromArgb(8, 10, 16)
$INK     = [System.Drawing.Color]::FromArgb(214, 222, 236)
$DIM     = [System.Drawing.Color]::FromArgb(120, 132, 158)
$ACCENT  = [System.Drawing.Color]::FromArgb(126, 226, 176)
$ALERT   = [System.Drawing.Color]::FromArgb(255, 138, 138)

# The 5x7 glyphs. Loaded by dot-sourcing rather than duplicated: one font, one place to fix it.
$pixelFont = $null
if ($Pixel) {
    $fontPath = Join-Path $PSScriptRoot 'pixelfont.ps1'
    if (-not (Test-Path $fontPath)) {
        Write-Error "the pixel font is missing: $fontPath"
        exit 2
    }
    . $fontPath
    $pixelFont = New-VsPixelFont
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "VOLCANO SEPARATOR :: CHAMBER  --  pid $TargetPid"
$form.Width = 940; $form.Height = 640
$form.StartPosition = 'CenterScreen'
$form.BackColor = $BG
$form.ForeColor = $INK
$form.Font = New-Object System.Drawing.Font('Consolas', 9.5)
if ($TopMost) { $form.TopMost = $true }

# The banner. It states what this window can and cannot do before it shows anything else, because a
# reader who does not know that will misread the panel below it.
$head = New-Object System.Windows.Forms.Label
$head.Dock = 'Top'; $head.Height = 74
$head.BackColor = $BG
$head.ForeColor = $ACCENT
$head.Text = @"
  WATCHING -- this window is ours. It cannot be closed or hidden by the target.
  It does not inject, so a process with no window has nothing to reveal; the facts below are read,
  not extracted. Nothing has been moved, altered or deleted.

"@
$form.Controls.Add($head)

$box = New-Object System.Windows.Forms.TextBox
$box.Multiline = $true; $box.ReadOnly = $true; $box.ScrollBars = 'Vertical'
$box.Dock = 'Fill'
$box.BackColor = $PANEL
$box.ForeColor = $INK
$box.Font = New-Object System.Drawing.Font('Consolas', 9.5)
$box.Visible = -not $Pixel
$form.Controls.Add($box)
$box.BringToFront()

# The pixel panel.
#
# A second view of the same text, drawn from this project's own 5x7 glyphs instead of handed to
# Windows. The difference is not cosmetic: `SetPixel` at an integer scale is the only way to get real
# pixel output out of GDI+ -- every drawing primitive it offers smooths, and a TextBox will not give
# pixel glyphs no matter how it is configured. Measured: this machine has no pixel font installed at
# all, zero matches among 425 families.
#
# It is a mode rather than a replacement, and the default is the readable one. Pixel glyphs at scale 2
# are legible but slow to paint, and `-Pixel` says so rather than pretending the choice is free.
$pixelBox = New-Object System.Windows.Forms.PictureBox
$pixelBox.Dock = 'Fill'
$pixelBox.BackColor = $PANEL
$pixelBox.SizeMode = 'AutoSize'
$pixelBox.Visible = [bool]$Pixel
$form.Controls.Add($pixelBox)
$pixelBox.BringToFront()

$foot = New-Object System.Windows.Forms.Label
$foot.Dock = 'Bottom'; $foot.Height = 26
$foot.BackColor = $BG
$foot.ForeColor = $DIM
$foot.Text = "  read-only view. To let it go:  volcano-separator release $TargetPid"
$form.Controls.Add($foot)

# Two timers, because the facts differ by three orders of magnitude in cost and a single timer would
# either refresh the cheap half far too slowly or the expensive half far too often. Measured:
# Get-Process 71 ms against Get-NetTCPConnection 1277 ms.
$script:live = $null
$script:slow = $null
$script:profile = $null
$script:lastSlow = [datetime]::MinValue
$script:ticks = 0
$script:lastPainted = $null
$script:gone = $false

$procinfo = Join-Path $PSScriptRoot 'procinfo.ps1'
$tmpBase = Join-Path ([System.IO.Path]::GetTempPath()) ("vsep-chamber-" + $PID)

function Read-Tier {
    param([string]$Tier, [string]$File)
    if (-not (Test-Path $procinfo)) { return $null }
    Remove-Item -LiteralPath $File -Force -ErrorAction SilentlyContinue
    # Run it in this process rather than spawning another PowerShell per tick: a spawn costs more than
    # the collection does, and this window refreshes every second.
    $null = & $procinfo -TargetPid $TargetPid -Tier $Tier -OutFile $File
    if (-not (Test-Path $File)) { return $null }
    try { return (Get-Content -LiteralPath $File -Raw | ConvertFrom-Json) } catch { return $null }
}

function Bar {
    # A block character rather than a drawn bar: this is a text grid, and a bar made of cells is both
    # cheaper and more honest about being approximate.
    param([double]$Value, [double]$Max, [int]$Width = 32)
    if ($Max -le 0) { return ('-' * $Width) }
    $n = [int][math]::Round(($Value / $Max) * $Width)
    if ($n -lt 0) { $n = 0 }
    if ($n -gt $Width) { $n = $Width }
    # '#' and '.' rather than the block-drawing characters. The pixel font covers ASCII, so a bar
    # built from U+2588 would render as a row of boxes -- a bar that says "unknown" instead of "how
    # much". The system-text view loses a little polish for it and gains a glyph set the pixel view
    # can actually draw.
    return ('#' * $n) + ('.' * ($Width - $n))
}

function Render {
    $lines = New-Object System.Collections.ArrayList

    $fast = $script:live
    if (-not $fast) {
        [void]$lines.Add('  the process probe returned nothing this tick')
        return ($lines -join "`r`n")
    }

    if (-not $fast.exists) {
        [void]$lines.Add('  !! the process is GONE -- it exited while this window was open')
        [void]$lines.Add('')
        [void]$lines.Add('  What it did while it ran is in the history below, which survives it.')
    }

    [void]$lines.Add('  -- LIVE  (this tick) ' + ('-' * 46))
    [void]$lines.Add(("  {0,-14} {1}" -f 'name', [string]$fast.name))
    [void]$lines.Add(("  {0,-14} {1}" -f 'pid', [string]$fast.pid))
    if ($null -ne $fast.threads) { [void]$lines.Add(("  {0,-14} {1}" -f 'threads', [string]$fast.threads)) }
    if ($null -ne $fast.handles) { [void]$lines.Add(("  {0,-14} {1}" -f 'handles', [string]$fast.handles)) }
    if ($null -ne $fast.workingSetMB) {
        # The ceiling is 512 MB, not the machine's memory: a bar pinned to a scale nothing reaches reads as
        # empty and therefore says nothing. Block sizing is also finer, so a few MB is visible.
        [void]$lines.Add(("  {0,-14} {1,8} MB  {2}" -f 'working set', [string]$fast.workingSetMB, (Bar ([double]$fast.workingSetMB) 512)))
    }
    if ($null -ne $fast.cpuSeconds) { [void]$lines.Add(("  {0,-14} {1,8} s" -f 'cpu', [string]$fast.cpuSeconds)) }
    if ($fast.startedAt) { [void]$lines.Add(("  {0,-14} {1}" -f 'started', [string]$fast.startedAt)) }
    if ($fast.path) { [void]$lines.Add(("  {0,-14} {1}" -f 'path', [string]$fast.path)) }
    [void]$lines.Add('')

    # Whether it has a window is a fact, and it is the fact that decides what this window is worth.
    $w = $fast.windows
    if ($null -eq $w) {
        [void]$lines.Add('  -- WINDOWS  (part of the slow tier; not read on this tick)')
    } else {
        $vis = @($w | Where-Object { $_.visible })
        [void]$lines.Add('  -- WINDOWS  ' + ("({0} owned, {1} visible, {2} hidden)" -f @($w).Count, $vis.Count, (@($w).Count - $vis.Count)))
        if (@($w).Count -eq 0) {
            [void]$lines.Add('     none. This process has no window to reveal, and this tool does not inject,')
            [void]$lines.Add('     so it cannot be given one. Everything above is still true about it.')
        }
        foreach ($x in $w) {
            $tag = if ($x.visible) { 'visible' } else { 'HIDDEN ' }
            [void]$lines.Add(("     [{0}] {1}  '{2}'" -f $tag, [string]$x.class, [string]$x.title))
        }
    }
    [void]$lines.Add('')

    if ($null -ne $fast.modules) {
        [void]$lines.Add(("  -- MODULES ({0}) " -f @($fast.modules).Count) + ('-' * 40))
        foreach ($m in (@($fast.modules) | Select-Object -First 8)) { [void]$lines.Add('     ' + [string]$m) }
        if (@($fast.modules).Count -gt 8) { [void]$lines.Add(("     ... and {0} more" -f (@($fast.modules).Count - 8))) }
    } else {
        [void]$lines.Add('  -- MODULES  (slow tier; not read on this tick)')
    }
    [void]$lines.Add('')

    if ($null -ne $fast.connections) {
        [void]$lines.Add(("  -- CONNECTIONS ({0}) " -f @($fast.connections).Count) + ('-' * 36))
        if (@($fast.connections).Count -eq 0) { [void]$lines.Add('     none') }
        foreach ($c in @($fast.connections)) { [void]$lines.Add(("     {0,-12} {1} -> {2}" -f [string]$c.state, [string]$c.local, [string]$c.remote)) }
    } elseif ($fast.connectionsError) {
        # A failed query is not an empty one, and the difference is the whole reason this branch exists.
        [void]$lines.Add('  -- CONNECTIONS: could not be read, so this is NOT "none"')
        [void]$lines.Add('     ' + [string]$fast.connectionsError)
    } else {
        [void]$lines.Add('  -- CONNECTIONS  (slow tier; not read on this tick)')
    }
    [void]$lines.Add('')

    # -- history: the half that survives the process --
    [void]$lines.Add('  -- HISTORY  (from the activity record, which outlives the process) ' + ('-' * 8))
    if ($script:profile -and $script:profile.history) {
        $h = $script:profile.history
        [void]$lines.Add(("     {0} event(s) from THIS process over {1} day(s)" -f $h.eventCount, $h.days))
        # A pid number is reused, and the record cannot tell. Events before this process started belong
        # to a predecessor, and showing them as this process's activity would be a wrong answer that
        # looks like a right one -- the failure this whole tool exists to remove.
        if ($h.earlierHolderCount -gt 0) {
            [void]$lines.Add(("     (+{0} for this pid NUMBER before this process started -- a different process)" -f $h.earlierHolderCount))
        }
        if ($h.everDetained) {
            [void]$lines.Add(("     under custody {0} time(s)" -f @($h.lifecycles).Count))
            foreach ($l in @($h.lifecycles)) {
                [void]$lines.Add(("       frozen {0} -> {1}" -f [string]$l.frozenAt, $(if ($l.endedAt) { [string]$l.endedAt } else { 'never released' })))
            }
        } else {
            [void]$lines.Add('     never detained by this tool')
        }
        foreach ($e in (@($h.events) | Select-Object -Last 12)) {
            $when = ([string]$e.t).Replace('T', ' ')
            if ($when.Length -gt 19) { $when = $when.Substring(0, 19) }
            # `??` is PowerShell 7 syntax and this runs on 5.1. The syntax check caught it immediately,
            # which is what it is for: a file full of 7-only syntax would otherwise fail at the one
            # moment someone opened the window and needed it.
            $detail = ''
            foreach ($field in 'cmd', 'title', 'name', 'action') {
                $v = $e.$field
                if ($null -ne $v -and [string]$v -ne '') { $detail = [string]$v; break }
            }
            [void]$lines.Add(("     {0}  {1,-10} {2}" -f $when, [string]$e.kind, $detail))
        }
        if ($h.eventCount -gt 12) { [void]$lines.Add(("     ... {0} earlier" -f ($h.eventCount - 12))) }
    } else {
        [void]$lines.Add('     (no profile file handed to this window)')
    }

    [void]$lines.Add('')
    [void]$lines.Add(("  tick {0}   slow facts refreshed {1}s ago" -f $script:ticks, [int]((Get-Date) - $script:lastSlow).TotalSeconds))

    return ($lines -join "`r`n")
}

function Refresh {
    param([switch]$Slow)
    New-Item -ItemType Directory -Force -Path $tmpBase | Out-Null
    $script:ticks++

    $script:live = Read-Tier -Tier 'fast' -File (Join-Path $tmpBase 'fast.json')
    if ($Slow) {
        $script:slow = Read-Tier -Tier 'slow' -File (Join-Path $tmpBase 'slow.json')
        $script:lastSlow = Get-Date
        # Merge: the slow tier's own answer wins for the fields it collected, the fast tier's for the
        # rest. Merging rather than replacing is why both tiers carry every key.
        if ($script:slow) {
            foreach ($p in $script:slow.PSObject.Properties) {
                if ($null -ne $p.Value) { $script:live | Add-Member -NotePropertyName $p.Name -NotePropertyValue $p.Value -Force }
            }
        }
        if ($ProfileFile -and (Test-Path $ProfileFile)) {
            try { $script:profile = Get-Content -LiteralPath $ProfileFile -Raw | ConvertFrom-Json } catch { }
        }
    }

    if ($script:live -and -not $script:live.exists) { $script:gone = $true }
    $text = Render
    $box.Text = $text
    $box.SelectionStart = 0
    $box.SelectionLength = 0

    if ($Pixel -and $pixelFont) {
        # Repainted only when the text changed, not on every tick. Painting 46 rows x 118 columns at
        # scale 2 is about 1.5 s of SetPixel calls, which is longer than the fast tier's refresh
        # interval -- so doing it on every tick would make the window lag its own subject.
        if ($text -ne $script:lastPainted) {
            $script:lastPainted = $text
            $old = $pixelBox.Image
            $pixelBox.Image = New-VsPixelPanel -Lines ($text -split "`r?`n") -Font $pixelFont `
                -Scale $PixelScale -Cols 118 -MaxRows 46 -Bg $PANEL -Fg $INK
            if ($old) { $old.Dispose() }
        }
    }
    return $script:gone
}

$fastTimer = New-Object System.Windows.Forms.Timer
$fastTimer.Interval = [math]::Max(200, $FastMs)
$fastTimer.Add_Tick({
    # The window stays up after the process exits, because the history is still worth reading and
    # closing it would take that away from the reader. What changes is that nothing more will happen:
    # the panel says so rather than leaving an unchanging view looking live.
    $null = Refresh
})

$slowTimer = New-Object System.Windows.Forms.Timer
$slowTimer.Interval = [math]::Max(1000, $SlowMs)
$slowTimer.Add_Tick({ $null = Refresh -Slow })

$form.Add_Shown({
    $null = Refresh -Slow
    $fastTimer.Start()
    $slowTimer.Start()
})

if ($AutoCloseMs -gt 0) {
    $closeTimer = New-Object System.Windows.Forms.Timer
    $closeTimer.Interval = $AutoCloseMs
    $closeTimer.Add_Tick({ $closeTimer.Stop(); $form.Close() })
    $form.Add_Shown({ $closeTimer.Start() })
}

$form.Add_FormClosed({
    $fastTimer.Stop(); $slowTimer.Stop()
    Remove-Item -LiteralPath $tmpBase -Recurse -Force -ErrorAction SilentlyContinue
})

# `-Introspect` builds everything, renders two frames and prints the panel instead of showing it.
#
# A GUI that can only be checked by looking at it is a GUI nobody checks. This project has no way to
# see a window from a script, so the render path is made callable: if the panel can be produced and
# printed, the window's contents are verified even though its pixels are not.
if ($PixelPng) {
    if (-not $Pixel) { Write-Error '-PixelPng needs -Pixel: there is no bitmap otherwise'; exit 2 }
    $null = Refresh -Slow
    Start-Sleep -Milliseconds 1500
    $null = Refresh -Slow
    Add-Type -AssemblyName System.Drawing
    $bmp = New-VsPixelPanel -Lines ((Render) -split "`r?`n") -Font $pixelFont `
        -Scale $PixelScale -Cols 118 -MaxRows 46 -Bg $PANEL -Fg $INK
    $bmp.Save($PixelPng, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output ("bitmap {0}x{1} -> {2}" -f $bmp.Width, $bmp.Height, $PixelPng)
    $bmp.Dispose()
    Remove-Item -LiteralPath $tmpBase -Recurse -Force -ErrorAction SilentlyContinue
    exit 0
}

if ($Introspect) {
    Write-Output ("  [view: " + $(if ($Pixel) { "pixel glyphs, scale $PixelScale" } else { "system text" }) + "]")
    $null = Refresh -Slow
    Start-Sleep -Milliseconds 1200
    $null = Refresh -Slow
    Write-Output $box.Text
    Remove-Item -LiteralPath $tmpBase -Recurse -Force -ErrorAction SilentlyContinue
    exit 0
}

[void]$form.ShowDialog()
