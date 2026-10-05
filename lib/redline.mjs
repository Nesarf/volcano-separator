import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { activityDir, appendToActivity } from './activity.mjs'

/**
 * The C: red line: what is sitting in user-writable space on the system drive.
 *
 * Extracted from core.mjs, and worth separating for a reason that is not only size. This is a
 * workstation hygiene scan, not a malware scan: it measures and names things whose name says
 * cache / download / temp. Behaviour is signals.mjs, which is a different question, and having
 * both in one file invited reading this one as a security tool that it is not.
 *
 * It also does not block. Blocking a write needs a filter driver, and saying otherwise would be
 * the kind of false signal this tool exists to remove.
 */
/** The places a user can write to without elevation, and where the rule is most often broken. */
export function redlineAreas() {
  const home = homedir()
  return [
    { key: 'AppData\Local', dir: join(home, 'AppData', 'Local') },
    { key: 'AppData\Roaming', dir: join(home, 'AppData', 'Roaming') },
    { key: 'Downloads', dir: join(home, 'Downloads') },
    { key: 'Desktop', dir: join(home, 'Desktop') },
    { key: 'Documents', dir: join(home, 'Documents') },
    { key: 'Windows\Temp', dir: join(process.env.SystemRoot ?? 'C:\Windows', 'Temp') },
  ]
}

/** Names that mean "this is a cache/download/temp", used only to raise a flag, never to conclude. */
const REDLINE_HINTS = /(^|[^a-z])(cache|temp|tmp|downloads?|\.cache|npm-cache|pip|uv|gradle|nuget|hf|huggingface)([^a-z]|$)/i


/**
 * Measure what is sitting on C: under the user-writable roots.
 *
 * Walks sequentially and reports honestly when it stops early: a truncated total presented as a
 * total is the mistake the disk census made, and repeating it here would be careless. Reparse
 * points are not followed -- a junction is a link, not content, and its bytes are already
 * counted where they actually live.
 */
export async function scanRedline(ctx, { budgetMs = 45000, top = 20 } = {}) {
  const started = Date.now()
  const deadline = started + Math.max(3000, budgetMs)
  const areas = redlineAreas()
  const items = []
  const perArea = {}
  const limits = []
  let files = 0
  let bytes = 0
  let truncated = false

  for (const area of areas) {
    if (!existsSync(area.dir)) continue
    let areaBytes = 0
    let areaFiles = 0

    // Breadth-first from the area root so that one deep subtree cannot starve everything else --
    // exactly what happened to the temp bucket in the disk census.
    const queue = [{ dir: area.dir, depth: 0 }]
    const top1 = []
    while (queue.length) {
      if (Date.now() > deadline) {
        truncated = true
        if (!limits.includes('time')) limits.push('time')
        break
      }
      const { dir, depth } = queue.shift()
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const ent of entries) {
        const full = join(dir, ent.name)
        if (ent.isDirectory()) {
          if (depth < 40) queue.push({ dir: full, depth: depth + 1 })
        } else if (ent.isFile()) {
          files++
          areaFiles++
          let size = 0
          try {
            size = statSync(full).size
          } catch {
            /* skip */
          }
          bytes += size
          areaBytes += size
          top1.push({ path: full, size })
        }
      }
    }
    top1.sort((x, y) => y.size - x.size)
    perArea[area.key] = { bytes: areaBytes, files: areaFiles }
    for (const t of top1.slice(0, top)) items.push({ ...t, area: area.key })
    if (truncated) break
  }

  items.sort((x, y) => y.size - x.size)
  const flagged = items
    .filter((i) => REDLINE_HINTS.test(i.path))
    .slice(0, top)
    .map((i) => ({ ...i, why: 'name suggests a cache, download or temporary data under a user-writable root on C:' }))

  return {
    ok: true,
    areas: perArea,
    files,
    bytes,
    gb: Number((bytes / 1024 ** 3).toFixed(2)),
    truncated,
    limits,
    ms: Date.now() - started,
    top: items.slice(0, top),
    flagged,
    detail: truncated
      ? `walked ${files} files (${(bytes / 1024 ** 3).toFixed(2)} GB) before the ${Math.round(budgetMs / 1000)} s budget ran out -- the totals are a floor, not a total`
      : `walked ${files} files, ${(bytes / 1024 ** 3).toFixed(2)} GB`,
  }
}

/** Keep the red-line findings in the record, so they outlive the terminal that printed them. */
export function recordRedline(ctx, scan) {
  if (!scan?.flagged?.length) return { ok: true, written: 0 }
  const file = join(activityDir(ctx), `redline-${new Date().toISOString().slice(0, 10)}.ndjson`)
  const seen = new Set()
  try {
    for (const line of readFileSync(file, 'utf8').split(String.fromCharCode(10))) {
      const t = line.trim()
      if (!t) continue
      try {
        const e = JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t)
        seen.add(e.path)
      } catch {
        /* half-written line */
      }
    }
  } catch {
    /* first run */
  }
  let written = 0
  for (const f of scan.flagged) {
    if (seen.has(f.path)) continue
    try {
      appendFileSync(file, JSON.stringify({
        t: new Date().toISOString(),
        kind: 'redline',
        path: f.path,
        size: f.size,
        area: f.area,
        why: f.why,
        action: 'needs-decision',
      }) + String.fromCharCode(10))
      written++
    } catch {
      /* bookkeeping must not break the report */
    }
  }
  return { ok: true, file, written }
}
