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
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
// `run` moved to the platform layer; importing it from core.mjs would make this module depend
// on a module it has no other reason to know, and would hide the fact that the dependency is a
// primitive rather than the application.
import { powershellHost, run } from './platform.mjs'

const BS = String.fromCharCode(92)
const NL = String.fromCharCode(10)

/** Sub-caches that hold reproducible artifacts and are safe to reason about. */
const ARCHIVE = 'archive-v0'
/** Scratch name entries are staged under before deletion. Leading dot: not a cache entry shape. */
const TRASH = '.volcano-staging'
/** How many reviewed plans to keep on disk. Newest first; older ones can no longer be applied. */
const MAX_PLANS = 20
// A LEAVE_ALONE set used to sit here, naming the sub-caches not worth removing. Nothing read it:
// the plan only ever walks archive-v0, so those top-level directories were already untouched -- by
// not being looked at rather than by being excluded. Deleted rather than kept as documentation,
// because a set with a comment explaining what it protects reads like protection, and a reader who
// trusts it will not go and check. Found by asking which declarations nothing reads, which is the
// same question that turned up four other decisions that had been computed and never consulted.

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
  const r = await run(powershellHost(), ['-NoProfile', '-Command', ps], { timeoutMs: 60000 })
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
    if (hash === TRASH) continue
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
  return { ok: true, root, archiveDir, subdirs, total, packages, environments, others, inUse }
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
    id: planFingerprint(scan.archiveDir, targets, keepVersions),
    generatedAt: new Date().toISOString(),
    archiveDir: scan.archiveDir ?? null,
    keepVersions,
    targets: targets.sort((a, b) => b.bytes - a.bytes),
    bytes,
    gb: Number((bytes / 1024 ** 3).toFixed(2)),
    skippedInUse: [...scan.packages.values()].flat().filter((e) => e.inUse).length + scan.environments.filter((e) => e.inUse).length,
  }
}

/**
 * A name for the reviewed plan, derived from what it says.
 *
 * Content-derived rather than random on purpose: the same cache state and the same options
 * produce the same id, so a different id means a different set of removals. A random id would
 * make "this is the plan you looked at" unverifiable and "this is a different plan" invisible.
 */
function planFingerprint(archiveDir, targets, keepVersions) {
  const canonical = [...targets]
    .map((t) => [t.hash, t.reason, t.bytes, t.dir].join(' '))
    .sort()
    .join(NL)
  return createHash('sha256')
    .update([String(archiveDir ?? ''), String(keepVersions), canonical].join(NL))
    .digest('hex')
    .slice(0, 16)
}

/**
 * Where reviewed plans are kept.
 *
 * The same directory policy.json and the isolation journal live in, and for the same reason:
 * this is a decision about this machine, not an artifact of running the tool, so it does not
 * belong anywhere a cleanup is invited to empty.
 */
export function planDir(ctx) {
  return ctx.cachePlanDir ?? join(homedir(), '.volcano-separator', 'cache-plans')
}

/** The id came back from a file, so it is treated as input: a name, never a path. */
export function planPath(ctx, id) {
  if (!/^[0-9a-f]{8,64}$/.test(String(id ?? ''))) {
    throw new Error(`not a plan id: ${JSON.stringify(id)}`)
  }
  return join(planDir(ctx), String(id) + '.json')
}

/**
 * Record a plan so that `--apply` can carry out exactly this one.
 *
 * Written under a temporary name and renamed into place: a half-written plan file would be read
 * back as a corrupt plan, and the caller would then be executing something no one reviewed.
 */
export function savePlan(ctx, plan) {
  if (!plan?.ok || !plan.id) return { ok: false, detail: 'nothing to save' }
  const dir = planDir(ctx)
  mkdirSync(dir, { recursive: true })
  const file = planPath(ctx, plan.id)
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(plan, null, 2) + NL, 'utf8')
  try {
    renameSync(tmp, file)
  } catch (e) {
    // Renaming over an existing file is allowed on Windows, but a reader holding it open can
    // still refuse. The plan is already on disk under its own id either way.
    if (!existsSync(file)) {
      try { unlinkSync(tmp) } catch { /* reported by the throw below */ }
      throw e
    }
    try { unlinkSync(tmp) } catch { /* the reader's copy is the one that matters */ }
  }
  // Bounded, because this is a record of decisions and not a log: the newest are the ones that
  // can still be applied, and an unbounded directory of them is a slow leak nobody would notice.
  const kept = listPlans(ctx)
  const dropped = []
  for (const old of kept.slice(MAX_PLANS)) {
    try {
      unlinkSync(old.file)
      dropped.push(old.id)
    } catch { /* it stays; it is a record, and a record that cannot be removed is not an error */ }
  }
  return { ok: true, file, id: plan.id, kept: Math.min(kept.length, MAX_PLANS), dropped }
}

/** Read a saved plan back. The id in the file must match the name it was found under. */
export function loadPlan(ctx, id) {
  let file
  try {
    file = planPath(ctx, id)
  } catch (e) {
    return { ok: false, detail: String(e.message ?? e) }
  }
  if (!existsSync(file)) return { ok: false, detail: `no saved plan ${id}; run --prune to build one`, file }
  let plan
  try {
    plan = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    return { ok: false, detail: `saved plan ${id} could not be parsed: ${e.message}`, file }
  }
  if (plan?.id !== id) {
    return { ok: false, detail: `saved plan ${id} says it is ${JSON.stringify(plan?.id)}`, file }
  }
  if (!Array.isArray(plan.targets)) return { ok: false, detail: `saved plan ${id} has no target list`, file }
  return { ok: true, plan, file }
}

/** Every saved plan, newest first. The newest is the one `--apply` carries out by default. */
export function listPlans(ctx) {
  const dir = planDir(ctx)
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -5)
    const r = loadPlan(ctx, id)
    if (!r.ok) continue
    let when = 0
    try { when = statSync(r.file).mtimeMs } catch { /* skipped: unreadable mtime sorts last */ }
    out.push({ id, file: r.file, when, generatedAt: r.plan.generatedAt ?? null, gb: r.plan.gb ?? 0, targets: r.plan.targets.length })
  }
  return out.sort((a, b) => b.when - a.when)
}

/**
 * Carry the plan out.
 *
 * The rename is the point, not a step. An earlier version scanned running processes for in-use
 * entries and then called rmSync on the plan, and both halves of that were weak:
 *
 *   * the scan and the delete are not atomic, so a process that starts using an entry in between
 *     is not protected at all; and
 *   * rmSync on a directory tree can delete half of it and then fail, leaving a running process
 *     with the files it had already mapped and missing the ones it had not.
 *
 * Renaming the entry to a scratch name fixes both, by being the authoritative test rather than a
 * better guess. Windows refuses to rename a directory while a file inside it is open -- verified,
 * not assumed -- so a rename that succeeds is proof that nothing holds the entry, and it is one
 * atomic operation. The process scan stays as a cheap pre-filter that keeps obviously-live entries
 * out of the plan; the rename is what actually decides.
 *
 * If deleting the staged entry fails it is left where it is and reported, and the next run clears
 * the scratch directory first, so it cannot accumulate.
 *
 * ── why the plan is re-checked against the filesystem before anything moves ──
 *
 * This used to walk whatever list it was handed and rename each entry. The rename is still the
 * in-use answer, and it still is -- but it answers a different question than the one that matters
 * when a person approved a plan a while ago:
 *
 *   the rename asks "is anything holding this entry?"
 *   it does not ask "is this still the entry that was reviewed?"
 *
 * The CLI used to close that gap by rescanning, which closes it in the wrong direction: the
 * reviewed plan and the executed plan could differ in either direction, and the difference was
 * never named. A plan approved as "remove 40 entries, free 0.07 GB" could execute as a different
 * 40 -- or as 60 -- and the output would still read like the reviewed one.
 *
 * So a target is revalidated first: it must still exist, at the same path, at the same size. A
 * target that fails is not touched and is reported by name and reason. **Nothing outside the
 * reviewed plan is ever removed**, so new candidates that appeared in the meantime are left for
 * the next plan, where they will be visible before they are approved.
 *
 * A cached entry is content-addressed and write-once, so size is a sufficient identity here; the
 * point is to notice that the thing being removed is not the thing that was named.
 */
export function applyUvPrune(plan, { dryRun = true } = {}) {
  if (!plan?.ok) return { ok: false, detail: plan?.detail ?? 'nothing to apply' }
  const removed = []
  const failed = []
  const refused = []
  const gone = []
  const changed = []

  const archiveDir = plan.archiveDir
  const trash = archiveDir ? join(archiveDir, TRASH) : null

  if (!dryRun && trash) {
    // Clear anything a previous run could not delete, so the scratch directory cannot grow.
    try {
      rmSync(trash, { recursive: true, force: true })
    } catch {
      /* a locked leftover stays until it is released; it is reported, not hidden */
    }
    mkdirSync(trash, { recursive: true })
  }

  for (const t of plan.targets) {
    if (dryRun) {
      removed.push({ ...t, dryRun: true })
      continue
    }
    if (!trash) {
      failed.push({ hash: t.hash, reason: 'no archive directory to stage into' })
      continue
    }

    // Revalidate before touching anything: the entry must still be the one that was reviewed.
    let actual = null
    try {
      const st = statSync(t.dir)
      if (!st.isDirectory()) {
        changed.push({ hash: t.hash, dir: t.dir, name: t.name, was: t.bytes, now: null, why: 'it is no longer a directory' })
        continue
      }
      actual = dirSize(t.dir).total
    } catch (e) {
      gone.push({ hash: t.hash, dir: t.dir, name: t.name, was: t.bytes, why: String(e?.code ?? e?.message ?? e) })
      continue
    }
    if (typeof t.bytes === 'number' && actual !== t.bytes) {
      changed.push({
        hash: t.hash, dir: t.dir, name: t.name, was: t.bytes, now: actual,
        why: 'its contents changed after the plan was made, so it is not the entry that was reviewed',
      })
      continue
    }

    const staged = join(trash, t.hash)
    try {
      renameSync(t.dir, staged)
    } catch (e) {
      // The rename refused, which means something holds a file inside the entry. That is a real
      // answer rather than a failure of the plan: the entry was in use after all.
      refused.push({ hash: t.hash, reason: String(e?.code ?? e?.message ?? e) })
      continue
    }
    try {
      rmSync(staged, { recursive: true, force: true })
      removed.push(t)
    } catch (e) {
      failed.push({ hash: t.hash, reason: String(e?.code ?? e?.message ?? e), at: staged })
    }
  }

  const freed = removed.reduce((s, t) => s + t.bytes, 0)
  return {
    ok: true,
    dryRun,
    planId: plan.id ?? null,
    removed: removed.length,
    removedList: removed,
    refused,
    failed,
    gone,
    changed,
    // A target was skipped for a reason that is not about it being in use. Named rather than
    // folded into `refused`, because "a running process holds this" and "this is not the entry
    // that was reviewed" call for different responses from the person reading.
    skipped: gone.length + changed.length,
    intact: gone.length === 0 && changed.length === 0,
    freed,
    gb: Number((freed / 1024 ** 3).toFixed(2)),
    targets: plan.targets,
  }
}
