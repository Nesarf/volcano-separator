# volcano-separator :: a 5x7 bitmap font, and a renderer that paints it
#
# Why this exists
# ---------------
# PowerShell 5.1's WinForms text is antialiased. There is no way to ask a TextBox for pixel glyphs, and
# no pixel font is installed on this machine (checked: zero matches among 425 families). So the pixel
# style this project requires cannot be had from system text rendering at all.
#
# This ships its own glyphs instead. Each glyph is 5x7, one hex digit per row, bit 4 as the leftmost
# pixel. It is drawn with `SetPixel` at an integer scale, which is the *only* way to get real pixel
# rendering out of GDI+: every drawing primitive it offers will smooth, and SetPixel cannot.
#
# What it covers, honestly: the characters a panel of numbers and Latin words needs, plus a fallback
# box for anything else. It does not know every Unicode character, so anything outside this set is
# shown as a filled block -- visible as a gap, rather than a wrong glyph that renders as something
# plausible. That is the same rule the rest of this tool follows: an unexplained blank is better than a
# confident lie.
#
# Cost: 5x7 at scale 3 is 15x21 pixels per character, so a 100-column panel needs a 1500 px wide bitmap
# and about 1.5 s to paint. It is repainted only when the text changes, not on every tick.

function New-VsPixelFont {
    $hex = @{
        'A' = '0E11111F111111'; 'B' = '1E11111E11111E'; 'C' = '0E10101010100E'; 'D' = '1E11111111111E'
        'E' = '1F10101E10101F'; 'F' = '1F10101E101010'; 'G' = '0E10101711110F'; 'H' = '1111111F111111'
        'I' = '0E04040404040E'; 'J' = '0702020202120C'; 'K' = '11121418141211'; 'L' = '1010101010101F'
        'M' = '111B1515111111'; 'N' = '11191513111111'; 'O' = '0E11111111110E'; 'P' = '1E11111E101010'
        'Q' = '0E111111150E0201'; 'R' = '1E11111E141211'; 'S' = '0F10100E01011E'
        'T' = '1F040404040404'; 'U' = '1111111111110E'; 'V' = '11111111110A04'; 'W' = '11111115151B11'
        'X' = '11110A040A1111'; 'Y' = '11110A04040404'; 'Z' = '1F02040810101F'
        '0' = '0E11131519110E'; '1' = '040C040404040E'; '2' = '0E11010204081F'; '3' = '1F02040201110E'
        '4' = '02060A121F0202'; '5' = '1F101E0101110E'; '6' = '0608101E11110E'; '7' = '1F010204080808'
        '8' = '0E11110E11110E'; '9' = '0E11110F01020C'
        ' ' = '00000000000000'; '.' = '00000000000404'; ',' = '00000000000408'
        ':' = '00040400040400'; ';' = '00040400040800'; '-' = '0000001F000000'
        '_' = '0000000000001F'; '/' = '01020408102000'; '\' = '1008040201' + '0000'
        '(' = '02040808080402'; ')' = '08040202020408'; '[' = '0E08080808080E'; ']' = '0E02020202020E'
        '<' = '02040810080402'; '>' = '08040201020408'; '=' = '00001F001F0000'
        '+' = '0004041F040400'; '*' = '000A041F040A00'; '#' = '0A1F0A0A1F0A00'
        '!' = '04040404040004'; '?' = '0E110102040004'; '%' = '19120408091' + '300'
        "'" = '04040400000000'; '"' = '0A0A0000000000'; '|' = '04040404040404'
        '&' = '0C12140A150A05'
    }
    $font = @{}
    foreach ($k in $hex.Keys) {
        $h = $hex[$k]
        $rows = New-Object 'int[]' 7
        for ($r = 0; $r -lt 7; $r++) {
            $rows[$r] = [Convert]::ToInt32($h.Substring($r * 2, 2), 16)
        }
        $font[$k] = $rows
    }
    return $font
}

# Painted with SetPixel. Returns a bitmap; the caller owns it and must dispose the previous one.
#
# HOW TO CHECK THIS. Do not judge the output from a scaled-down preview -- that was tried twice in this
# session and misread both times, and the second time cost several rounds of hunting a font bug that
# did not exist. Print the bitmap as text instead, which is a character set nobody has to interpret:
#
#     $b = New-VsPixelPanel -Lines @('LIVE','AB') -Font $f -Scale 1 -Cols 6 -Bg $black -Fg $white
#     for ($y=0; $y -lt $b.Height; $y++) { $l=''
#       for ($x=0; $x -lt $b.Width; $x++) { $l += $(if ($b.GetPixel($x,$y).R -gt 100) {'#'} else {'.'}) }
#       $l }
#
# And count the fallbacks rather than eyeballing them: one temporary `misses=` counter settled in a
# single run what two rounds of guessing had not.
function New-VsPixelPanel {
    param(
        [string[]]$Lines = @(),
        [hashtable]$Font,
        [int]$Scale = 3,
        [ValidateRange(1, 400)][int]$Cols = 100,
        [int]$MaxCols = 118,
        [int]$MaxRows = 46,
        [System.Drawing.Color]$Bg,
        [System.Drawing.Color]$Fg
    )

    # One colour per glyph is not worth the bookkeeping, but the block used for an unknown character is
    # deliberately the same foreground: it reads as a hole in the text, not as a letter.
    # Every glyph is 5x7, fixed. A proportional font would need per-glyph widths, and a panel of
    # numbers and Latin words does not need one.
    $cw = 6 * $Scale   # 5 wide plus one column of spacing
    $ch = 8 * $Scale   # 7 tall plus one row
    # The column count is given, not measured.
    #
    # Two attempts derived it from the longest line and both produced wrong widths, because the value
    # depended on how the caller spelled its input: a single string arrives as one item, not as an
    # array of one, so `@('A')` measured a width of one and made a two-column panel. A panel whose
    # columns change with the caller's spelling changes width on every refresh.
    #
    # A number the caller passes cannot do that, and a display of numbers and labels has no need for
    # proportional widths.
    # A stray `[int]$Cols = 0` sat here, left by an earlier edit: in PowerShell that is a TYPED
    # VARIABLE DECLARATION inside the function body, not a comment, and it silently overwrote the
    # parameter with zero. Every bitmap came out one column wide while the glyphs themselves drew
    # perfectly -- which is why the failure looked like a font bug for two rounds.
    $cols = $Cols
    if ($cols -lt 1) { $cols = 1 }
    $rows = [math]::Min($MaxRows, @($Lines).Count)
    if ($rows -lt 1) { $rows = 1 }

    $bmp = New-Object System.Drawing.Bitmap (($cols * $cw) + $Scale), (($rows * $ch) + $Scale)
    # Every pixel is written explicitly, so there is nothing left for the graphics layer to interpolate.
    for ($y = 0; $y -lt $rows; $y++) {
        $line = if ($y -lt @($Lines).Count) { [string]@($Lines)[$y] } else { '' }
        if ($line.Length -gt $cols) { $line = $line.Substring(0, $cols) }
        elseif ($line.Length -lt $cols) { $line = $line.PadRight($cols) }
        for ($x = 0; $x -lt $line.Length; $x++) {
            $glyphKey = $line.Substring($x, 1).ToUpperInvariant()
            $glyph = $Font[$glyphKey]
            if (-not $glyph) { $glyph = @(31, 17, 17, 17, 17, 17, 31) }   # an outlined box: visibly not a letter
            for ($r = 0; $r -lt 7; $r++) {
                $bits = $glyph[$r]
                for ($c = 0; $c -lt 5; $c++) {
                    # Bit 4 is the leftmost pixel. The mask is built with [math]::Pow rather than
                    # `1 -shl (4 - $c)`, which is NOT a shift: PowerShell's `-shl` composes its right
                    # operand by string concatenation in this position, so every column tested the same
                    # two bits and every glyph came out as vertical bars. The render was visibly wrong,
                    # which is the only reason it was caught -- a subtler mistake here would have drawn
                    # plausible-looking letters that were not the ones intended.
                    $mask = [int][math]::Pow(2, 4 - $c)
                    $on = ($bits -band $mask) -ne 0
                    $col = if ($on) { $Fg } else { $Bg }
                    for ($sy = 0; $sy -lt $Scale; $sy++) {
                        for ($sx = 0; $sx -lt $Scale; $sx++) {
                            $bmp.SetPixel(($x * $cw) + ($c * $Scale) + $sx, ($y * $ch) + ($r * $Scale) + $sy, $col)
                        }
                    }
                }
            }
        }
    }
    return $bmp
}
