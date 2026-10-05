# Read the live ACL state for a list of paths, in one process.
#
# Why this exists: `isolated` reported what the journals said, and the journals record what was done
# at the time -- not what is true now. A file unlocked by hand, or by another tool, or by an
# administrator restoring an ACL, still read as `applied`. That contradicts the rule the module states
# in its own comment: the ACL is the authority, not our record of it.
#
# Paths arrive through a file rather than as command-line arguments: they contain backslashes and
# spaces, and every attempt to pass them through three layers of quoting has cost this project time.
param(
    [Parameter(Mandatory = $true)][string]$PathList
)

$ErrorActionPreference = 'Continue'
$results = @()
foreach ($p in (Get-Content -LiteralPath $PathList)) {
    $t = $p.Trim()
    if (-not $t) { continue }
    if (-not (Test-Path -LiteralPath $t)) {
        $results += [pscustomobject]@{ path = $t; exists = $false; denied = $false }
        continue
    }
    $out = & icacls "$t" 2>&1 | Out-String
    $results += [pscustomobject]@{ path = $t; exists = $true; denied = [bool]($out -match 'DENY') }
}
Write-Output ($results | ConvertTo-Json -Compress -Depth 4)
