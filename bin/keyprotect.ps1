# volcano-separator :: keyprotect -- DPAPI, and nothing else
#
# Why this file is this small
# ---------------------------
# PowerShell 5.1 runs on .NET Framework, which has no AesGcm -- so authenticated encryption has to
# happen in Node, which has it in node:crypto. DPAPI has no Node equivalent, so it has to happen here.
# Each side does the one thing only it can do, and neither reimplements the other's primitive.
#
# What DPAPI buys, stated precisely
# ---------------------------------
# It binds the key to this machine, so a key file copied elsewhere is useless, and it means the key is
# not sitting in plaintext next to the thing it protects. It does NOT stop anyone who can already run
# code as this user on this machine -- they can call DPAPI too. That is the same honest limit the
# isolation journal's signature carries, and it is written down rather than implied.
param(
    [Parameter(Mandatory = $true)][ValidateSet('protect', 'unprotect')][string]$Action,
    [Parameter(Mandatory = $true)][string]$In,
    [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = 'Stop'
$ENTROPY = [Text.Encoding]::UTF8.GetBytes('volcano-separator/key/v1')

try {
    Add-Type -AssemblyName System.Security -ErrorAction Stop

    if ($Action -eq 'protect') {
        # Input is base64 (the raw key). Output is base64 of the DPAPI blob.
        $raw = [Convert]::FromBase64String(((Get-Content -Raw -LiteralPath $In) -replace '\s', ''))
        $blob = [Security.Cryptography.ProtectedData]::Protect($raw, $ENTROPY, 'LocalMachine')
        [Convert]::ToBase64String($blob) | Set-Content -LiteralPath $Out -Encoding ASCII
        Write-Output (@{ ok = $true; action = 'protect'; bytes = $blob.Length } | ConvertTo-Json -Compress)
    } else {
        $blob = [Convert]::FromBase64String(((Get-Content -Raw -LiteralPath $In) -replace '\s', ''))
        $raw = [Security.Cryptography.ProtectedData]::Unprotect($blob, $ENTROPY, 'LocalMachine')
        [Convert]::ToBase64String($raw) | Set-Content -LiteralPath $Out -Encoding ASCII
        Write-Output (@{ ok = $true; action = 'unprotect'; bytes = $raw.Length } | ConvertTo-Json -Compress)
    }
} catch {
    # A failure here must never look like success: the caller refuses to encrypt when it cannot protect
    # the key, so this is the branch that decides whether anything happens at all.
    Write-Output (@{ ok = $false; action = $Action; detail = $_.Exception.Message } | ConvertTo-Json -Compress)
    exit 1
}
