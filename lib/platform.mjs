import { readFileSync } from 'node:fs'

/**
 * The bottom layer: pure helpers that everything above needs and that depend on nothing here.
 *
 * These three lived in core.mjs, where every module reaching for them meant the file could only
 * ever grow. They have no dependency on the rest of the tool -- a path string, a JSON file read
 * that tolerates a BOM, and a timer -- which is what makes them safe to lift out first: nothing
 * that imports them can be surprised, because nothing about them changed.
 */

/**
 * Normalise a path for comparison.
 *
 * Windows paths arrive with backslashes and the policy is written with forward slashes, so a
 * plain string prefix test never matched: `C:\Windows\System32\cmd.exe` was not recognised as
 * living under `path:c:/windows/`, and therefore **nothing** was ever covered by the allowlist.
 * Every finding looked unauthorised. Separators are folded here so the comparison is about the
 * path and not about which slash the writer happened to use.
 */
export function normalizePath(p) {
  if (!p) return ''
  return String(p).split(String.fromCharCode(92)).join('/').toLowerCase()
}

/**
 * Read JSON, tolerating the byte Windows PowerShell puts in front of it.
 *
 * `Set-Content -Encoding UTF8` writes a BOM in Windows PowerShell 5.1, and JSON.parse throws on a
 * leading U+FEFF. That single byte cost a whole debugging round: the file existed, the poll saw it
 * 37 times out of 40, and every parse failed silently inside an empty catch. Strip it here rather
 * than trusting every writer to remember.
 */
export function readJsonLoose(file) {
  const raw = readFileSync(file, 'utf8')
  const clean = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  return JSON.parse(clean)
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
