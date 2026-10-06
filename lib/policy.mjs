import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { normalizePath } from './platform.mjs'

/**
 * Policy: which stealth is permitted, and what to do about the rest.
 *
 * Extracted from core.mjs unchanged. The decisions here are the ones a person makes about their
 * own machine, and keeping them in their own file means the allowlist can be read without
 * scrolling past the code that consults it.
 *
 * The policy file lives next to the user's other config, not in the temp-backed log dir: it is a
 * decision, not an artifact, and it must survive a cache clean.
 */
export function policyPath(ctx) {
  const base = ctx.policyFile ? resolve(ctx.policyFile) : join(homedir(), '.volcano-separator')
  return base.endsWith('.json') ? base : join(base, 'policy.json')
}

export const POLICY_DEFAULTS = {
  /**
   * observe -- record the finding and change nothing. The default, on purpose: plenty of
   *            legitimate software hides a window (tray apps, splash screens, installers), so
   *            enforcing before you have an allowlist would do more damage than the threat.
   * suspend -- freeze the process so it cannot proceed, and wait for a human.
   * reject  -- terminate it. This is the "refuse" mode; it is opt-in and it is destructive.
   */
  mode: 'observe',
  /** Never touch these, whatever they do. Entries are `name:<exe>` or `path:<prefix>`. */
  allow: [
    // Forward slashes on purpose: these are compared as lowercased string prefixes, never
    // handed to the filesystem, and it keeps the table readable instead of doubled-escaped.
    'path:c:/windows/',
    'path:c:/program files/',
    'path:c:/program files (x86)/',
    'path:d:/dashaohuo/',
    'path:e:/dashaohuo/',
    'path:e:/npm-global/',
    'path:e:/volcano-separator/',
    'name:system',
    'name:svchost.exe',
    'name:csrss.exe',
    'name:winlogon.exe',
    'name:services.exe',
    'name:lsass.exe',
    'name:dwm.exe',
    'name:explorer.exe',
    'name:msmpeng.exe',
  ],
  /** A window hidden for less than this long is not treated as stealth (splash screens). */
  graceSeconds: 20,
}

export function loadPolicy(ctx) {
  const file = policyPath(ctx)
  let raw = {}
  // Absent and unreadable are different states and were reported the same way.
  //
  // `catch { raw = {} }` turned a corrupt policy into the default policy, silently. The defaults are
  // the safe direction -- observe, empty allowlist -- so nothing dangerous followed from it, and that
  // is exactly why it went unnoticed: a corrupted file produced a working tool with a policy nobody
  // chose. The rule this project keeps invoking is that unknown is not zero; here it was unknown
  // being read as "the user has no preferences", which reads as consent.
  let integrity = existsSync(file) ? 'ok' : 'absent'
  let parseError = null
  if (integrity === 'ok') {
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        integrity = 'invalid'
        parseError = `a policy must be a JSON object, and this is ${Array.isArray(raw) ? 'an array' : typeof raw}`
        raw = {}
      }
    } catch (e) {
      integrity = 'invalid'
      parseError = String(e?.message ?? e)
      raw = {}
    }
  }
  return {
    file,
    ...POLICY_DEFAULTS,
    ...raw,
    allow: Array.isArray(raw.allow) ? raw.allow : POLICY_DEFAULTS.allow,
    // After the spread, so a policy file cannot claim its own integrity.
    integrity,
    parseError,
    // One word for callers that want to report rather than inspect.
    verified: integrity !== 'invalid',
  }
}

export function savePolicy(ctx, policy) {
  const file = policyPath(ctx)
  const tmp = `${file}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    // Written beside and moved over, never written in place.
    //
    // A policy written directly is a policy that can be half-written when the power goes or the
    // process dies, and a half-written policy is exactly the corrupt state loadPolicy now reports.
    // The rename is atomic within a directory, so a reader sees either the old file or the new one.
    writeFileSync(tmp, JSON.stringify(policy, null, 2) + '\n', 'utf8')
    renameSync(tmp, file)
    return { ok: true, file }
  } catch (e) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* the failure to clean up is not the failure to report */
    }
    return { ok: false, file, detail: String(e?.message ?? e) }
  }
}

/** Does this process match an allow entry? Matching is deliberately simple and auditable. */
export function policyAllows(policy, { name, path }) {
  const p = normalizePath(path)
  const n = String(name ?? '').toLowerCase()
  for (const entry of policy.allow ?? []) {
    const e = String(entry)
    if (e.startsWith('path:') && p && p.startsWith(normalizePath(e.slice(5)))) return e
    if (e.startsWith('name:') && n === e.slice(5).toLowerCase()) return e
  }
  return null
}
