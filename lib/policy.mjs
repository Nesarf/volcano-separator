import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

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
  /**
   * The line this tool will not cross, and the reason it exists at all.
   *
   * Quarantine-on-detection is a defensible policy, but it is one policy among several, and
   * it fits builders of software badly: a heuristic that misjudges a build tool costs a
   * toolchain and an afternoon. This tool takes the other policy. It never moves, rewrites or
   * deletes the target -- it freezes, reveals, records, and asks. Allowing is the user's
   * decision, and it is recorded as policy rather than inferred.
   */
  neverQuarantine: true,
  graceSeconds: 20,
}

export function loadPolicy(ctx) {
  const file = policyPath(ctx)
  let raw = {}
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      raw = {}
    }
  }
  return { file, ...POLICY_DEFAULTS, ...raw, allow: Array.isArray(raw.allow) ? raw.allow : POLICY_DEFAULTS.allow }
}

export function savePolicy(ctx, policy) {
  const file = policyPath(ctx)
  try {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify(policy, null, 2) + '\n', 'utf8')
    return { ok: true, file }
  } catch (e) {
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
