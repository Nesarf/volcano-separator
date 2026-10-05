/**
 * uv cache hygiene.
 *
 * The cache grows in three ways, and they need different handling:
 *
 *   exact duplicates   the same package and version extracted under two hashes. Nothing needs
 *                      two copies; one is always removable.
 *   old versions       a newer version was pulled and the older one stayed. Keeping the newest
 *                      per package is enough for the cache to keep doing its job.
 *   stale environments uvx builds a full virtualenv per dependency set, and each one here is
 *                      over a gigabyte. An environment no running process is using is dead
 *                      weight -- the next run rebuilds it from the package cache.
 *
 * The one thing this must never do is remove something that is in use. A cache entry is
 * reproducible by definition: deleting it costs a re-download. Deleting the entry a running
 * daemon executes from is not a re-download, it is an outage -- so in-use detection is not a
 * nicety here, it is the whole safety argument.
 *
 * Zero dependencies, like the rest of this project.
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { run } from './core.mjs'

const BS = String.fromCharCode(92)

/** Sub-caches that hold reproducible artifacts and are safe to reason about. */
const ARCHIVE = 'archive-v0'
/** The resolved-index cache: removing it only forces metadata to be re-fetched. Not worth it. */
const LEAVE_ALONE = new Set(['simple-v24', 'interpreter-v4', 'environments-v2', 'git-v0', 'builds-v0'])

function dirSize(dir) {
  let total = 0
  let files = 0
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = join(d, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile()) {
        files++
        try {
          total += statSync(full).size
        } catch {
          /* a file that vanished mid-walk */
        }
      }
    }
  }
  return { total, files }
}

/**
 * Which cache entries a running process is executing from.
 *
 * This is checked by executable path rather than by asking uv, because uv's own in-use lock
 * only knows about uv's own operations -- it cannot see a daemon that is simply running.
 */
export async function entriesInUse(ctx) {
  const ps = [
    '$ErrorActionPreference = "SilentlyContinue"',
    'Get-CimInstance Win32_Process | ForEach-Object { $_.ExecutablePath } | Where-Object { $_ }',
  ].join('; ')
  const r = await run('powershell', ['-NoProfile', '-Command', ps], { timeoutMs: 60000 })
  const used = new Map()
  for (const line of (r.stdout ?? '').split(/\r?\n/)) {
    const p = line.trim()
    if (!p) continue
    const m = new RegExp(`${BS}${BS}archive-v0${BS}${BS}([^${BS}${BS}]+)`).exec(p)
    if (m) used.set(m[1], p)
  }
  return used
}

/** Read the cache and classify everything in it. Read-only. */
export async function scanUvCache(ctx) {
  const root = ctx.uvCacheReal ?? ctx.uvCacheDir
  if (!root || !existsSync(root)) {
    return { ok: false, detail: `uv cache not found at ${root ?? '(unset)'}`, root }
  }
  const archiveDir = join(root, ARCHIVE)
  if (!existsSync(archiveDir)) {
    return { ok: false, detail: `no ${ARCHIVE} in ${root}`, root }
  }

  const inUse = await entriesInUse(ctx)
  const subdirs = {}
  for (const sub of readdirSync(root)) {
    const p = join(root, sub)
    try {
      if (!statSync(p).isDirectory()) continue
    } catch {
      continue
    }
    const { total, files } = dirSize(p)
    subdirs[sub] = { bytes: total, files }
  }

  const packages = new Map()
  const environments = []
  const others = []

  for (const hash of readdirSync(archiveDir)) {
    const dir = join(archiveDir, hash)
    let top
    try {
      top = readdirSync(dir)
    } catch {
      continue
    }
    const { total } = dirSize(dir)
    const isVenv = top.includes('pyvenv.cfg') || top.includes('Lib')
    const dists = top.filter((n) => n.endsWith('.dist-info'))
    const entry = { hash, dir, bytes: total, inUse: inUse.has(hash), usedBy: inUse.get(hash) ?? null }

    if (dists.length) {
      for (const d of dists) {
        const m = /^(.+)-([^-]+)\.dist-info$/.exec(d)
        if (!m) continue
        const name = m[1].toLowerCase()
        if (!packages.has(name)) packages.set(name, [])
        packages.get(name).push({ ...entry, version: m[2] })
      }
    } else if (isVenv) {
      environments.push(entry)
    } else {
      others.push(entry)
    }
  }

  const total = Object.values(subdirs).reduce((s, v) => s + v.bytes, 0)
  return { ok: true, root, subdirs, total, packages, environments, others, inUse }
}

/**
 * Work out what can go, and keep the newest of everything that stays.
 *
 * Nothing in-use is ever a candidate. `keepVersions` is how many versions of each package to
 * retain, newest first; 1 means the cache still serves the current build without a re-download.
 */
export function planUvPrune(scan, { keepVersions = 1, pruneEnvironments = true } = {}) {
  if (!scan?.ok) return { ok: false, detail: scan?.detail ?? 'nothing to plan' }
  const targets = []
  let bytes = 0

  // Exact duplicates first: same name and version, more than one hash. Keep the newest.
  for (const [name, versions] of scan.packages) {
    const byVersion = new Map()
    for (const v of versions) {
      if (!byVersion.has(v.version)) byVersion.set(v.version, [])
      byVersion.get(v.version).push(v)
    }
    for (const [version, copies] of byVersion) {
      if (copies.length < 2) continue
      const sorted = [...copies].sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))
      for (const c of sorted.slice(1)) {
        if (c.inUse) continue
        targets.push({ ...c, name, version, reason: 'duplicate', why: `${name} ${version} is cached more than once` })
        bytes += c.bytes
      }
    }
  }

  // Old versions: keep the newest N per package.
  for (const [name, versions] of scan.packages) {
    const unique = new Map()
    for (const v of versions) if (!unique.has(v.version)) unique.set(v.version, v)
    const sorted = [...unique.values()].sort((a, b) =>
      b.version.localeCompare(a.version, undefined, { numeric: true }),
    )
    for (const old of sorted.slice(keepVersions)) {
      if (old.inUse) continue
      if (targets.some((t) => t.hash === old.hash)) continue
      targets.push({ ...old, name, reason: 'old-version', why: `${name} ${old.version} is older than ${sorted[0].version}` })
      bytes += old.bytes
    }
  }

  // Stale environments.
  if (pruneEnvironments) {
    for (const env of scan.environments) {
      if (env.inUse) continue
      targets.push({ ...env, name: '(uvx environment)', reason: 'stale-environment', why: 'no running process is using this environment' })
      bytes += env.bytes
    }
  }

  return {
    ok: true,
    keepVersions,
    targets: targets.sort((a, b) => b.bytes - a.bytes),
    bytes,
    gb: Number((bytes / 1024 ** 3).toFixed(2)),
    skippedInUse: [...scan.packages.values()].flat().filter((e) => e.inUse).length + scan.environments.filter((e) => e.inUse).length,
  }
}

/**
 * Carry the plan out.
 *
 * `removeOldFiles` is deliberately not used here: it walks a tree for files older than N days,
 * while these targets are whole directories whose identity is already known. Using it would
 * mean re-discovering what the scan just found, and would delete by age rather than by decision.
 */
export function applyUvPrune(plan, { dryRun = true } = {}) {
  if (!plan?.ok) return { ok: false, detail: plan?.detail ?? 'nothing to apply' }
  const removed = []
  const failed = []
  for (const t of plan.targets) {
    if (dryRun) {
      removed.push({ ...t, dryRun: true })
      continue
    }
    try {
      rmSync(t.dir, { recursive: true, force: true })
      removed.push(t)
    } catch (e) {
      // A locked entry is one that something is using, whatever the process scan said.
      failed.push({ hash: t.hash, reason: String(e?.message ?? e) })
    }
  }
  const freed = removed.reduce((s, t) => s + t.bytes, 0)
  return {
    ok: true,
    dryRun,
    removed: removed.length,
    failed,
    freed,
    gb: Number((freed / 1024 ** 3).toFixed(2)),
    targets: removed,
  }
}
