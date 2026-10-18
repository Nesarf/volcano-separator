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
    # **This table now comes from Ichiwatashi, per the family rule that the pixel layer is produced
    # once and embedded.** It was generated with `ichiwatashi font --format powershell`, so it is the
    # same table that repository ships. 88 glyphs against the 61 that were hand-written here: the
    # missing ones were lower case and an apostrophe.
    #
    # **Two glyphs render differently than before, and that is the cost of one source rather than a
    # defect:** `/` and `#` had a different design here. `Q` was written as 16 hex digits and
    # `New-VsPixelFont` read only the first 14, so its last two digits never had any effect -- the two
    # versions agree once that is taken into account.
    # **An ordinal hashtable, because PowerShell's `@{}` is case-insensitive.** The shared font has
    # `A` and `a` as different glyphs; a literal `@{ 'A' = ...; 'a' = ... }` is rejected with
    # "duplicate key" -- which is why this table had no lower case before. The comparer is the fix.
    $hex = [System.Collections.Hashtable]::new([System.StringComparer]::Ordinal)
    $hex[' '] = '00000000000000'
    $hex['!'] = '04040404040004'
    $hex['"'] = '0A0A0000000000'
    $hex['#'] = '15151F151F1515'
    $hex['%'] = '19120408091300'
    $hex['&'] = '0C12140A150A05'
    $hex[''''] = '04040000000000'
    $hex['('] = '02040808080402'
    $hex[')'] = '08040202020408'
    $hex['*'] = '000A041F040A00'
    $hex['+'] = '0004041F040400'
    $hex[','] = '00000000000408'
    $hex['-'] = '0000001F000000'
    $hex['.'] = '00000000000404'
    $hex['/'] = '01020408100100'
    $hex['0'] = '0E11131519110E'
    $hex['1'] = '040C040404040E'
    $hex['2'] = '0E11010204081F'
    $hex['3'] = '1F02040201110E'
    $hex['4'] = '02060A121F0202'
    $hex['5'] = '1F101E0101110E'
    $hex['6'] = '0608101E11110E'
    $hex['7'] = '1F010204080808'
    $hex['8'] = '0E11110E11110E'
    $hex['9'] = '0E11110F01020C'
    $hex[':'] = '00040400040400'
    $hex[';'] = '00040400040800'
    $hex['<'] = '02040810080402'
    $hex['='] = '00001F001F0000'
    $hex['>'] = '08040201020408'
    $hex['?'] = '0E110102040004'
    $hex['A'] = '0E11111F111111'
    $hex['B'] = '1E11111E11111E'
    $hex['C'] = '0E10101010100E'
    $hex['D'] = '1E11111111111E'
    $hex['E'] = '1F10101E10101F'
    $hex['F'] = '1F10101E101010'
    $hex['G'] = '0E10101711110F'
    $hex['H'] = '1111111F111111'
    $hex['I'] = '0E04040404040E'
    $hex['J'] = '0702020202120C'
    $hex['K'] = '11121418141211'
    $hex['L'] = '1010101010101F'
    $hex['M'] = '111B1515111111'
    $hex['N'] = '11191513111111'
    $hex['O'] = '0E11111111110E'
    $hex['P'] = '1E11111E101010'
    $hex['Q'] = '0E111111150E02'
    $hex['R'] = '1E11111E141211'
    $hex['S'] = '0F10100E01011E'
    $hex['T'] = '1F040404040404'
    $hex['U'] = '1111111111110E'
    $hex['V'] = '11111111110A04'
    $hex['W'] = '11111115151B11'
    $hex['X'] = '11110A040A1111'
    $hex['Y'] = '11110A04040404'
    $hex['Z'] = '1F02040810101F'
    $hex['['] = '0E08080808080E'
    $hex['\'] = '10080402010000'
    $hex[']'] = '0E02020202020E'
    $hex['_'] = '0000000000001F'
    $hex['a'] = '00000C14140D00'
    $hex['b'] = '0010101E111E00'
    $hex['c'] = '000E1010100E00'
    $hex['d'] = '0001010F110F00'
    $hex['e'] = '0000181C140C00'
    $hex['f'] = '0006081C080800'
    $hex['g'] = '000F110F01001E'
    $hex['h'] = '0010101E111100'
    $hex['i'] = '00100010101000'
    $hex['j'] = '0010001010001C'
    $hex['k'] = '00101214181400'
    $hex['l'] = '00180808080600'
    $hex['m'] = '00001A15151500'
    $hex['n'] = '00001E11111100'
    $hex['o'] = '00000E11110E00'
    $hex['p'] = '001E111E100010'
    $hex['q'] = '000F110F010001'
    $hex['r'] = '00001618101000'
    $hex['s'] = '00000F10011E00'
    $hex['t'] = '00081C08080600'
    $hex['u'] = '00001111110F00'
    $hex['v'] = '000011110A0400'
    $hex['w'] = '00001115150A00'
    $hex['x'] = '0000110A0A1100'
    $hex['y'] = '0011110A04000C'
    $hex['z'] = '00001E04081E00'
    $hex['|'] = '04040404040404'
    $font = [System.Collections.Hashtable]::new([System.StringComparer]::Ordinal)
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
            # **Case is preserved now, and that was a real dead end.** This line used to be
            # `.ToUpperInvariant()`, which was correct while the table held only capitals -- and it meant the
            # 26 lower-case glyphs added from the shared font would never have been drawn. Measured: the
            # table gained them and the renderer still collapsed every letter to upper case, so the data was
            # shared and then discarded at the one place it mattered. The fallback box below still catches
            # anything the table genuinely lacks.
            $glyphKey = $line.Substring($x, 1)
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
