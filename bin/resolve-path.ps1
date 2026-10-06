# volcano-separator :: resolve -- the real identity of a path, not its spelling
#
# Why this exists
# ---------------
# The never-list refuses to touch anything inside %SystemRoot%. It compared the path as written, using
# [System.IO.Path]::GetFullPath, which is purely lexical: it normalises `..` and slashes and resolves
# nothing else. On a machine with junctions that is not the same question as "where does this file
# actually live".
#
# Demonstrated on this machine:
#
#   mklink /J E:\scratch\innocent-link C:\Windows\System32
#   GetFullPath E:\scratch\innocent-link\kernel32.dll
#     -> E:\scratch\innocent-link\kernel32.dll
#     -> does not start with C:\Windows, so NOT refused
#     -> and icacls would have applied the deny to the real System32 file
#
# A junction is not exotic. Any user can create one without elevation, package managers create them,
# and this machine already has several. The whole point of a never-list is that it holds when the
# caller insists, and it did not hold when the caller spelled the path differently.
#
# What this does not do
# ---------------------
# It resolves the path. It does not decide anything -- the caller still compares the answer against
# whatever list it cares about, and still refuses on both the written path and this one. Resolving is
# the part that needs a handle; deciding is the part that needs a policy.
param(
    [Parameter(Mandatory = $true)][string]$Path
)

$ErrorActionPreference = 'Continue'

if (-not ('VsepPathResolve' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class VsepPathResolve {
    const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;   // needed to open a directory
    const uint FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, FILE_SHARE_DELETE = 4;
    const uint OPEN_EXISTING = 3;
    const uint VOLUME_NAME_DOS = 0;

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint len, uint flags);

    public static string Resolve(string path) {
        // Open with no access rights at all: this asks where the file is, not to read it, so it works
        // on a file the caller could not open for reading.
        using (var h = CreateFileW(path, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                                   IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero)) {
            if (h.IsInvalid) return null;
            var sb = new StringBuilder(1024);
            uint n = GetFinalPathNameByHandleW(h, sb, (uint)sb.Capacity, VOLUME_NAME_DOS);
            if (n == 0) return null;
            var s = sb.ToString();
            // The API returns \\?\C:\... ; strip the prefix so the answer is comparable to a normal path.
            if (s.StartsWith(@"\\?\UNC\")) s = @"\\" + s.Substring(8);
            else if (s.StartsWith(@"\\?\")) s = s.Substring(4);
            return s;
        }
    }
}
'@ -ErrorAction Stop
}

$out = @{ ok = $false; path = $Path; resolved = $null; why = $null }
try {
    $r = [VsepPathResolve]::Resolve($Path)
    if ($r) {
        $out.ok = $true
        $out.resolved = $r
        # `different` is the fact the caller needs: the written path and the real one disagree, which
        # means at least one of them is a spelling of something else.
        $out.different = -not ($r.TrimEnd('\') -ieq ([System.IO.Path]::GetFullPath($Path)).TrimEnd('\'))
    } else {
        $out.why = 'could not open a handle to the path, so its real identity is unknown'
    }
} catch {
    $out.why = $_.Exception.Message
}
Write-Output ($out | ConvertTo-Json -Compress)
