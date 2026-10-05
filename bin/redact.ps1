# volcano-separator :: command-line redaction
#
# Why this exists
# ---------------
# The activity recorder stores each process's full command line in a long-lived NDJSON log, and
# the signals rules and custody timeline read it back. That is what makes the record useful: a
# command line is often the only thing that distinguishes an expected process from an unexpected
# one.
#
# But a command line is also where secrets travel. `app.exe --token abc123`, `mysql -phunter2`,
# `AWS_SECRET_ACCESS_KEY=...`, `curl -H "Authorization: Bearer ..."` -- all of them land in the
# log verbatim, and the log is append-only and read by several views. A tool built to make the
# machine legible must not become the place credentials are quietly archived.
#
# Where it runs, and why there
# ----------------------------
# Redaction happens at the WRITE point, in the recorder, before the line reaches disk. Redacting
# only when displaying would leave the secret in the file forever and merely hide it from the
# default view -- which is worse than not redacting at all, because it looks safe.
#
# The rules are deliberately narrow
# ---------------------------------
# Only values that follow an explicit secret-bearing flag, an assignment to a secret-looking
# name, an Authorization/Bearer header, or URL credentials. Long random-looking strings are NOT
# redacted: hashes, GUIDs, build ids and base64 in ordinary arguments are common, and a rule that
# guesses would either drown the log in placeholders or teach people to ignore them.
#
# The executable token is never touched -- `exeFromCmd` in lib/core.mjs parses it out of this
# same string to decide which process ran, and the signals rules depend on it.

Set-StrictMode -Off

# Kept as one list so the two implementations (this one and redactCommandLine in lib/core.mjs)
# can be checked against the same fixture. If you add a name here, add it there too -- the smoke
# suite feeds identical input to both and fails if they disagree.
$script:SecretFlagNames = @(
    'token', 'password', 'passwd', 'pwd', 'secret', 'passphrase',
    'apikey', 'api-key', 'api_key',
    'auth', 'authorization', 'credential', 'credentials',
    'accesskey', 'access-key', 'access_key',
    'privatekey', 'private-key', 'private_key',
    'clientsecret', 'client-secret', 'client_secret',
    'bearer', 'sessionkey', 'session-key', 'session_key'
)

$script:RedactedPlaceholder = '<redacted>'

function Protect-CommandLine {
    [CmdletBinding()]
    param([AllowNull()][string]$CommandLine)

    if ([string]::IsNullOrEmpty($CommandLine)) { return $CommandLine }

    $s = $CommandLine
    $ph = $script:RedactedPlaceholder
    $names = ($script:SecretFlagNames | ForEach-Object { [regex]::Escape($_) }) -join '|'

    # 1. --flag=VALUE and --flag VALUE, where the flag names a secret.
    #    The value may be quoted; the quote is kept so the shape of the command stays readable.
    $s = [regex]::Replace($s, "(?i)(--?(?:$names))(\s*=\s*| +)(""[^""]*""|'[^']*'|\S+)", {
        param($m)
        $v = $m.Groups[3].Value
        $q = if ($v.Length -ge 2 -and ($v[0] -eq '"' -or $v[0] -eq "'")) { $v[0] } else { '' }
        $m.Groups[1].Value + $m.Groups[2].Value + $q + $ph + $q
    })

    # 2. NAME=VALUE where NAME looks like a secret. Covers environment-style prefixes such as
    #    AWS_SECRET_ACCESS_KEY=, GITHUB_TOKEN=, DB_PASSWORD=.
    $s = [regex]::Replace($s, "(?i)\b([A-Za-z_][A-Za-z0-9_-]*(?:TOKEN|PASSWORD|PASSWD|SECRET|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)[A-Za-z0-9_-]*)=(\S+)", {
        param($m)
        $m.Groups[1].Value + '=' + $ph
    })

    # 3. Authorization headers and bare Bearer tokens.
    #
    #    Three separate bugs were found here by running it, not by reading it. Reading it looked
    #    right twice.
    #      * matching `authorization:` alone consumed the word "Bearer" and left the token in the
    #        clear -- `Authorization: <redacted> eyJhbGciOi.J9`, which looks redacted and is not.
    #      * a greedy \S+ ate the closing quote of the enclosing argument, swallowing the
    #        separator between the header and the next argument.
    #      * `Authorization: Basic <base64>` stopped at the space after the scheme word and left
    #        the credentials exposed, because the value there is two tokens, not one.
    #
    #    So: an optional scheme word, then a value that ends at a quote or whitespace. The quote
    #    belongs to the enclosing argument (`-H "Authorization: ..."`) and must come back
    #    untouched -- which is why the value class excludes it rather than the replacement
    #    re-adding it.
    $s = [regex]::Replace($s, "(?i)(authorization\s*:\s*)(?:[A-Za-z][A-Za-z0-9-]*\s+)?[^""\s']*", { param($m) $m.Groups[1].Value + $ph })
    $s = [regex]::Replace($s, "(?i)\b(bearer\s+)([A-Za-z0-9._~+/-]+=*)", { param($m) $m.Groups[1].Value + $ph })

    # 4. Credentials embedded in a URL: scheme://user:password@host
    $s = [regex]::Replace($s, "([a-zA-Z][a-zA-Z0-9+.-]*://[^:/\s@]+:)([^@/\s]+)(@)", { param($m) $m.Groups[1].Value + $ph + $m.Groups[3].Value })

    # 5. mysql-style -pSECRET, concatenated only. `-p 5432` is a port and must survive, so the
    #    space-separated form is deliberately left alone, and an all-digit value is left alone.
    $s = [regex]::Replace($s, "(?i)(\s-p)([A-Za-z_][A-Za-z0-9_!@#%^&*.-]{2,})", { param($m) $m.Groups[1].Value + $ph })

    return $s
}
