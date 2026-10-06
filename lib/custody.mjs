import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { appendToActivity, activityDir } from './activity.mjs'
import { CORE_ROOT, readJsonLoose, run, sleep } from './platform.mjs'
import { redactCommandLine } from './commandline.mjs'
import { policyPath } from './policy.mjs'

/**
 * Custody: freeze a suspected process, make the freeze impossible to forget, and never quarantine.
 *
 * Extracted from core.mjs, where these twenty-odd functions were spread from line 1434 to 2834 and
 * the last of them sat under a "C: red line" banner that had nothing to do with them. They are
 * ordered here by what they are for -- records, probes, rebuild, report, reconcile, timeline --
 * because the order they happened to be written in is not the order anyone reads them in.
 *
 * The line this layer will not cross, stated once: it freezes, reveals, records and asks. It does
 * not move, rename, rewrite or delete the target. A suspension is persistent and loud, because a
 * suspension nobody comes back for is worse than one that was never applied.
 */
const DETAIN_EVENTS = new Set(['suspended', 'released', 'release-failed', 'failed'])


const CUSTODY_EVENT_KINDS = new Set(['detain', 'custody-alert', 'custody-release-notice'])


const CUSTODY_ALERT_COOLDOWN_MS = 60 * 60 * 1000
const DEFAULT_STALE_MS = 60 * 60 * 1000


function tmpdirFallback() {
  // Kept local so this module does not have to import node:os just for one fallback path.
  return process.env.TEMP || process.env.TMP || '.'
}

function msBetween(a, b) {
  const ta = Date.parse(a ?? '')
  const tb = Date.parse(b ?? '')
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null
  return tb - ta
}

/** "2h 14m" -- a duration a person can read at a glance. */
export function humanDuration(ms) {
  if (ms === null || ms === undefined) return '?'
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/** The timestamps of release notices already written, keyed by pid. */
function noticesByPid(ctx) {
  const dir = activityDir(ctx)
  const seen = new Map()
  let files = []
  try {
    files = readdirSync(dir).filter((f) => /^activity-\d{4}-\d{2}-\d{2}\.ndjson$/.test(f))
  } catch {
    return seen
  }
  for (const f of files) {
    let text
    try {
      text = readFileSync(join(dir, f), 'utf8')
    } catch {
      continue
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      // Match the kind field rather than the substring: an unrelated event can carry this string
      // inside its hint text, and counting those was a real bug once already.
      if (!line.includes('"kind":"custody-release-notice"') &&
          !line.includes('"kind": "custody-release-notice"')) continue
      try {
        const e = JSON.parse(line.charCodeAt(0) === 0xfeff ? line.slice(1) : line)
        if (e.kind !== 'custody-release-notice') continue
        const pid = Number(e.pid)
        if (Number.isInteger(pid)) seen.set(pid, Math.max(seen.get(pid) ?? 0, Date.parse(e.t) || 0))
      } catch {
        /* a half-written tail line; the next read will have it */
      }
    }
  }
  return seen
}

/** Read the detain summary files. Newest first. */
export function readDetainRecords(ctx, readJsonLoose) {
  const dir = join(ctx.logDir ?? join(tmpdirFallback(), 'volcano-separator'), 'activity')
  let files = []
  try {
    files = readdirSync(dir).filter((f) => /^detain-\d+\.json$/.test(f))
  } catch {
    return []
  }
  const out = []
  for (const f of files) {
    const rec = readJsonLoose(join(dir, f))
    if (rec && typeof rec === 'object') out.push({ ...rec, recordFile: join(dir, f) })
  }
  return out
}

/**
 * Ask the live system about each pid: does it still exist, and are all of its threads
 * suspended?
 *
 * All-threads-suspended is the only reliable read-only signal available: NtSuspendProcess
 * leaves every thread in the Suspended wait state, and a running process always has at least
 * one thread that is not. Measured directly before relying on it -- a frozen process reports
 * "Wait, Suspended" for every thread, and resuming it restores the original wait reasons.
 */
export async function probeCustody(pids, { timeoutMs = 30000 } = {}) {
  const list = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))]
  if (!list.length) return {}

  const script = [
    `$ids = @(${list.join(',')})`,
    '$out = @()',
    'foreach ($id in $ids) {',
    '  $p = Get-Process -Id $id -ErrorAction SilentlyContinue',
    '  if (-not $p) { $out += @{ pid = $id; exists = $false }; continue }',
    '  $threads = @($p.Threads)',
    '  $susp = @($threads | Where-Object { $_.ThreadState -eq "Wait" -and $_.WaitReason -eq "Suspended" })',
    '  $out += @{ pid = $id; exists = $true; name = $p.ProcessName;',
    '            threads = $threads.Count; suspended = $susp.Count;',
    '            created = $p.StartTime.ToUniversalTime().ToString("o");',
    '            frozen = ($threads.Count -gt 0 -and $susp.Count -eq $threads.Count) }',
    '}',
    '$out | ConvertTo-Json -Compress -Depth 4',
  ].join('\n')

  const r = await run('powershell', ['-NoProfile', '-Command', script], { timeoutMs })
  if (!r.ok) return {}
  // PowerShell renders a single-element array as an object, so accept both shapes.
  let parsed
  try {
    parsed = JSON.parse((r.stdout || '').trim())
  } catch {
    return {}
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  const byPid = {}
  for (const row of rows) {
    if (row && typeof row.pid === 'number') byPid[row.pid] = row
  }
  return byPid
}

/**
 * Scan running processes for thread states, and report the ones fully suspended.
 *
 * Deliberately tolerant: most processes on a machine refuse to be opened, and that is normal
 * rather than an error worth surfacing. The scan reports what it could read and how much it could
 * not, because "nothing found" and "nothing could be read" are different answers.
 */
export async function scanSuspended({ timeoutMs = 60000 } = {}) {
  const script = [
    '$out = @()',
    '$denied = 0',
    'foreach ($p in Get-Process -ErrorAction SilentlyContinue) {',
    '  try {',
    '    $threads = @($p.Threads)',
    '    if ($threads.Count -eq 0) { continue }',
    '    $susp = @($threads | Where-Object { $_.ThreadState -eq "Wait" -and $_.WaitReason -eq "Suspended" })',
    '    if ($susp.Count -eq $threads.Count) {',
    '      $out += @{ pid = $p.Id; name = $p.ProcessName; threads = $threads.Count;',
    '                created = $p.StartTime.ToUniversalTime().ToString("o") }',
    '    }',
    '  } catch { $denied++ }',
    '}',
    '@{ denied = $denied; suspended = @($out) } | ConvertTo-Json -Compress -Depth 4',
  ].join('\n')

  const r = await run('powershell', ['-NoProfile', '-Command', script], { timeoutMs })
  if (!r.ok) {
    return { ok: false, reason: r.error || 'process scan failed', suspended: [], denied: null }
  }
  let parsed
  try {
    parsed = JSON.parse((r.stdout || '').trim())
  } catch (e) {
    return { ok: false, reason: `could not parse the scan: ${e?.message ?? e}`, suspended: [], denied: null }
  }
  const list = Array.isArray(parsed?.suspended) ? parsed.suspended : (parsed?.suspended ? [parsed.suspended] : [])
  return { ok: true, denied: Number(parsed?.denied ?? 0), suspended: list }
}

/**
 * Rebuild the per-pid custody state from the activity log.
 *
 * Last decisive event wins: `suspended` puts a pid under custody, `released` takes it out, and
 * anything that merely revealed windows does not change it.
 */
export function rebuildCustody(ctx) {
  const dir = activityDir(ctx)
  let files = []
  try {
    files = readdirSync(dir).filter((f) => /^activity-\d{4}-\d{2}-\d{2}\.ndjson$/.test(f)).sort()
  } catch {
    return { ok: false, reason: 'no activity record', pids: {} }
  }

  const perPid = new Map()
  let events = 0
  for (const f of files) {
    let text
    try {
      text = readFileSync(join(dir, f), 'utf8')
    } catch {
      continue
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || !line.includes('"detain"')) continue
      let e
      try {
        // Strip a BOM per line: it costs exactly one event per file otherwise, and the record
        // is the thing being trusted here, so losing a line silently is not acceptable.
        e = JSON.parse(line.charCodeAt(0) === 0xfeff ? line.slice(1) : line)
      } catch {
        continue
      }
      if (e.kind !== 'detain' || !DETAIN_EVENTS.has(e.action)) continue
      events++
      const pid = Number(e.pid)
      if (!Number.isInteger(pid)) continue
      // Only an event that ESTABLISHES custody may bring a record into existence.
      //
      // This used to be `perPid.get(pid) ?? { pid }` for every matching action, so a bare `released`
      // event created the very record that made the release look legitimate. Releasing a pid that
      // was never detained therefore wrote a record saying it had been, and the next release found
      // that record and proceeded -- an act authorising itself. Found while adding the identity
      // check, because the check kept passing for a pid nothing had ever detained.
      const existing = perPid.get(pid)
      const establishes = e.action === 'suspended' || e.action === 'failed'
      if (!existing && !establishes) continue
      const cur = existing ?? { pid }
      if (e.action === 'suspended') {
        cur.suspended = true
        cur.suspendedAt = e.t ?? null
        cur.created = e.created ?? cur.created
        cur.name = e.name ?? cur.name
        cur.why = e.why ?? cur.why
      } else if (e.action === 'released') {
        cur.suspended = false
        cur.releasedAt = e.t ?? null
        cur.releaseFailed = false
        cur.name = e.name ?? cur.name
      } else if (e.action === 'release-failed') {
        // A release that did not take is not a release. Keeping it as its own action is what lets
        // the ledger distinguish `running` from `still frozen after we tried`, which is the
        // difference between a working tool and one that reports its intentions.
        cur.releaseFailed = true
        cur.releaseFailedAt = e.t ?? null
        cur.name = e.name ?? cur.name
      } else if (e.action === 'failed') {
        cur.failed = true
        cur.failedAt = e.t ?? null
        cur.why = e.why ?? cur.why
      }
      perPid.set(pid, cur)
    }
  }
  const pids = {}
  for (const [pid, v] of perPid) pids[pid] = v
  return { ok: true, files: files.length, events, pids }
}

/** The custody summaries currently on disk, reconciled against the live system. */
export async function custodyState(ctx, { probe = true } = {}) {
  // Reads through readJsonLoose, not JSON.parse: these files are written by PowerShell with
  // -Encoding UTF8, which writes a BOM, and a bare JSON.parse throws on every one of them.
  // That is exactly how "detain produced no summary" happened while the freeze had worked.
  const dir = activityDir(ctx)
  let files = []
  try {
    files = readdirSync(dir).filter((x) => x.startsWith('detain-') && x.endsWith('.json'))
  } catch {
    return []
  }
  const records = []
  for (const f of files) {
    const rec = readJsonLoose(join(dir, f))
    if (rec && typeof rec === 'object') records.push({ file: join(dir, f), ...rec })
  }

  // A record is a claim about a moment. Whether it still holds is a question for the system,
  // and that is the whole point of this function: a suspension is persistent, so a freeze whose
  // operator forgot about it stays frozen with nothing on the machine saying so.
  if (!probe) return records
  const live = await probeCustody(records.map((r) => Number(r.pid)).filter(Number.isInteger))
  return records.map((rec) => {
    const pid = Number(rec.pid)
    const info = live[pid]
    let state = 'unverified'
    if (info && info.exists === false) state = 'exited'
    else if (info && info.exists) {
      if (info.frozen) state = rec.suspended === false ? 'frozen-unexpectedly' : 'frozen'
      else state = rec.suspended === false ? 'running' : 'resumed'
    }
    return { ...rec, state, threads: info?.threads ?? null,
             suspendedThreads: info?.suspended ?? null }
  })
}

/** The ones still frozen -- the processes a person needs to make a decision about. */
export async function custodyOrphans(ctx, opts = {}) {
  const all = await custodyState(ctx, opts)
  return all.filter((r) => r.state === 'frozen' || r.state === 'frozen-unexpectedly')
}

/**
 * The answer to "is anything still frozen?", with each claim checked against the system.
 *
 * States, and the two that matter most:
 *   `frozen`   -- under custody now, and nothing released it. Somebody has to decide.
 *   `exited`   -- recorded as frozen but the process is gone; only history.
 *   `resumed`  -- recorded as frozen, released later, and running.
 *   `running`  -- a release was recorded but the process is still frozen, which means the
 *                 release did not take. That is a bug worth seeing rather than averaging away.
 */
export async function custodyReport(ctx, { probe = true, probeFn = null } = {}) {
  const rebuilt = rebuildCustody(ctx)
  const pids = Object.values(rebuilt.pids ?? {})
  if (!rebuilt.ok) return { ok: false, reason: rebuilt.reason, rows: [], frozen: [] }

  const live = !probe ? {} : await (probeFn ?? probeCustody)(pids.map((r) => r.pid))
  const rows = pids.map((rec) => {
    const info = live[rec.pid]
    // A pid is not an identity. If the process now holding this pid started at a different
    // moment than the one we froze, the record is about a process that no longer exists -- and
    // saying "released and running" would be a lie about a stranger.
    const reused = Boolean(rec.created && info?.created
                           && String(rec.created).slice(0, 16) !== String(info.created).slice(0, 16))
    let state
    if (!probe || !info || info.exists === undefined) state = 'unverified'
    else if (!info.exists) state = 'exited'
    else if (reused) state = 'pid-reused'
    else if (info.frozen) state = rec.suspended ? 'frozen' : 'frozen-after-release'
    else state = rec.suspended ? 'resumed-without-release' : 'running'
    return {
      pid: rec.pid,
      name: info?.name ?? rec.name ?? null,
      state,
      recorded: rec.suspended ? 'suspended' : (rec.failed ? 'failed' : 'released'),
      frozenAt: rec.suspendedAt ?? null,
      frozenForMs: rec.suspendedAt ? Date.now() - Date.parse(rec.suspendedAt) : null,
      created: rec.created ?? null,
      liveCreated: info?.created ?? null,
      releasedAt: rec.releasedAt ?? null,
      threads: info?.threads ?? null,
      suspendedThreads: info?.suspended ?? null,
      why: rec.why ?? '',
    }
  })
  rows.sort((a, b) => String(b.frozenAt ?? '').localeCompare(String(a.frozenAt ?? '')))
  return {
    ok: true,
    events: rebuilt.events,
    recordFiles: rebuilt.files,
    rows,
    frozen: rows.filter((r) => r.state === 'frozen'),
    needsAttention: rows.filter((r) => r.state === 'frozen' || r.state === 'frozen-after-release'
                                     || r.state === 'resumed-without-release'),
  }
}

/** Custody records that are still frozen and have been for longer than `staleMs`. */
export async function staleCustody(ctx, { staleMs = DEFAULT_STALE_MS, probe = true,
                                          probeFn = null } = {}) {
  // probeFn is injectable so the alerting logic can be tested without freezing anything. The
  // default is the real thread-state probe; a test supplies a stub and asserts the outcome.
  const report = await custodyReport(ctx, probeFn ? { probe: true, probeFn } : { probe })
  if (!report.ok) return { staleMs, stale: [], report }
  const stale = report.rows.filter(
    (r) => (r.state === 'frozen' || r.state === 'frozen-after-release')
        && r.frozenForMs !== null && r.frozenForMs >= staleMs)
  return { staleMs, stale, report }
}

/**
 * Write one alert to the activity record if something has been frozen too long, and stay quiet
 * otherwise.
 *
 * Throttled per hour rather than per heartbeat: a stuck process is worth saying once an hour,
 * not every five minutes, and an alert that repeats until it is ignored protects nothing. The
 * throttle is read from the record itself, so there is no separate state to lose.
 */
export async function reconcileCustody(ctx, { staleMs = DEFAULT_STALE_MS, now = Date.now(),
                                             probeFn = null, scanFn = null } = {}) {
  // A release we did not perform is reported immediately, and not through the stale throttle:
  // it is an event rather than a condition, so it fires once per pid per freeze by construction
  // and waiting an hour to mention it would mean reporting it long after anyone could act.
  let released = []
  try {
    const un = await unauthorizedReleases(ctx, { probeFn })
    released = un.ok ? un.releases : []
  } catch {
    /* a release check that fails must not silence the other two */
  }

  const { stale } = await staleCustody(ctx, { staleMs, probeFn })
  const probeOpts = { probeFn, scanFn }
  const dir = activityDir(ctx)

  let lastAlert = 0
  try {
    const today = join(dir, 'activity-' + new Date(now).toISOString().slice(0, 10) + '.ndjson')
    const text = readFileSync(today, 'utf8')
    for (const rawLine of text.split(/\r?\n/)) {
      // Match the kind field, not the substring: an unrelated event carries the string
      // "custody-alert" inside its hint text (it tells the reader where to look), so a plain
      // includes() finds lines that are not alerts at all. The same mistake produced a false
      // "11 alerts" reading while the real count was zero.
      const line = rawLine.trim()
      if (!line.includes('"kind":"custody-alert"') && !line.includes('"kind": "custody-alert"')) continue
      try {
        const e = JSON.parse(line.charCodeAt(0) === 0xfeff ? line.slice(1) : line)
        if (e.kind === 'custody-alert') lastAlert = Math.max(lastAlert, Date.parse(e.t) || 0)
      } catch {
        /* a half-written line at the tail; the next read will have it */
      }
    }
  } catch {
    /* no record for today yet, so nothing was alerted */
  }

  // Frozen but never recorded is a different finding from recorded-and-forgotten, and it is the
  // one that was invisible: `detained` enumerates the record, so anything absent from it cannot
  // appear there. Walk the machine and subtract instead.
  let unrecorded = []
  try {
    const un = await unrecordedCustody(ctx, probeOpts)
    if (un.ok) unrecorded = un.unrecorded
  } catch {
    /* a scan failure must not silence the recorded-stale path */
  }

  if (released.length) {
    for (const r of released) {
      try {
        appendToActivity(ctx, {
          t: new Date(now).toISOString(),
          kind: 'custody-release-notice',
          action: 'released-by-something-else',
          pid: r.pid,
          name: r.name,
          frozenAt: r.frozenAt,
          detail: `pid ${r.pid} ${r.name ?? ''} was recorded as frozen and is running now, with no release through this tool`,
          hint: 'something unknown resumed it; nothing here did',
        })
      } catch {
        /* one failure must not stop the rest being reported */
      }
    }
  }

  if (!stale.length && !unrecorded.length) {
    return { alerted: false, released, stale: [], unrecorded: [],
             why: released.length
               ? `${released.length} release notice(s) written; nothing frozen past the threshold`
               : 'nothing frozen past the threshold' }
  }
  if (now - lastAlert < CUSTODY_ALERT_COOLDOWN_MS) {
    return { alerted: false, stale, unrecorded, why: 'already alerted within the last hour' }
  }

  const parts = []
  if (released.length) {
    parts.push('released by something else: ' + released.map(
      (r) => `pid ${r.pid} ${r.name ?? ''}`).join('; '))
  }
  if (stale.length) {
    parts.push('forgotten custody: ' + stale.map((r) => {
      const hours = (r.frozenForMs / 3600000).toFixed(1)
      return `pid ${r.pid} ${r.name ?? ''} frozen ${hours}h (since ${r.frozenAt ?? '?'})`
    }).join('; '))
  }
  if (unrecorded.length) {
    parts.push('frozen with no record: ' + unrecorded.map(
      (r) => `pid ${r.pid} ${r.name ?? ''} (${r.why})`).join('; '))
  }
  const line = parts.join(' | ')

  const event = {
    t: new Date(now).toISOString(),
    kind: 'custody-alert',
    action: 'stale',
    count: stale.length + unrecorded.length,
    pids: [...stale.map((r) => r.pid), ...unrecorded.map((r) => r.pid)],
    forgotten: stale.length,
    unrecorded: unrecorded.length,
    detail: line,
    hint: 'nothing was resumed automatically; run: volcano-separator detained',
  }
  try {
    appendToActivity(ctx, event)
  } catch (e) {
    return { alerted: false, stale, why: `could not write the alert: ${e?.message ?? e}` }
  }
  return { alerted: true, released, stale, unrecorded, detail: line }
}

/**
 * Suspended processes that the activity record does not account for.
 *
 * `probeFn`/`scanFn` are injectable so this can be tested without freezing anything and without
 * depending on what happens to be running on the machine at the time.
 */
export async function unrecordedCustody(ctx, { scanFn = null, now = Date.now() } = {}) {
  const rebuilt = rebuildCustody(ctx)
  const known = rebuilt.ok ? rebuilt.pids : {}

  const scan = scanFn ? await scanFn() : await scanSuspended()
  if (!scan.ok) return { ok: false, reason: scan.reason, unrecorded: [], denied: scan.denied }

  const unrecorded = []
  for (const p of scan.suspended) {
    const pid = Number(p.pid)
    const rec = known[pid]
    if (!rec) {
      unrecorded.push({ pid, name: p.name ?? null, threads: p.threads ?? null,
                        created: p.created ?? null, why: 'no record of a detain for this pid' })
      continue
    }
    // A pid is not an identity: a frozen process whose creation time differs from the recorded
    // one is a different process wearing a recycled number.
    if (rec.created && p.created && String(rec.created).slice(0, 16) !== String(p.created).slice(0, 16)) {
      unrecorded.push({ pid, name: p.name ?? null, threads: p.threads ?? null,
                        created: p.created ?? null,
                        why: 'pid was recorded, but this is a different process than the recorded one' })
    }
  }
  return { ok: true, denied: scan.denied, unrecorded, scannedAt: new Date(now).toISOString() }
}

/**
 * Recorded as under custody, but running now.
 *
 * `probeFn` is injectable for the same reason as elsewhere: the decision should be testable
 * without freezing anything real.
 */
export async function unauthorizedReleases(ctx, { probeFn = null, now = Date.now() } = {}) {
  const report = await custodyReport(ctx, probeFn ? { probe: true, probeFn } : { probe: true })
  if (!report.ok) return { ok: false, reason: report.reason, releases: [] }

  const candidates = report.rows.filter((r) => r.state === 'resumed-without-release')
  if (!candidates.length) return { ok: true, releases: [], now }

  const alreadyNoticed = noticesByPid(ctx)
  const releases = []
  for (const r of candidates) {
    const noticedAt = alreadyNoticed.get(r.pid) ?? 0
    const frozenAt = Date.parse(r.frozenAt ?? '') || 0
    // Only a notice that came after the freeze it relates to counts. A re-detained pid whose
    // release was already reported is a fresh event and should be reported again.
    if (noticedAt >= frozenAt) continue
    releases.push({
      pid: r.pid,
      name: r.name ?? null,
      frozenAt: r.frozenAt ?? null,
      why: 'recorded as frozen, but the process is running and no release was recorded',
    })
  }
  return { ok: true, releases, now }
}

/**
 * Take a process into custody.
 *
 * The order is the design: freeze, then reveal, then display. A running process can always
 * destroy its own windows, so "it must not be able to close them" only becomes true once it
 * cannot execute at all. The custody window belongs to us, so it cannot close that either --
 * not because we defended it, but because it was never the target's to close.
 *
 * What this deliberately does NOT do: move, rename, rewrite or delete anything. The target
 * stays exactly where it is. Quarantining a file on suspicion is the behaviour that makes
 * security tooling unusable for developers and researchers, and it is the behaviour this
 * refuses to copy.
 *
 * Limits worth stating: this cannot give a window to a process that never created one (that
 * needs code injection, which this does not do), and suspension is not deletion -- the process
 * keeps its memory, handles and sockets, it simply cannot run.
 */
export async function detain(ctx, { pid, suspend = true, custody = true, topmost = true, release = false, reason = '' } = {}) {
  const script = join(CORE_ROOT, 'bin', 'detain.ps1')
  if (!existsSync(script)) return { ok: false, detail: `detain script missing: ${script}` }
  if (!Number.isFinite(Number(pid)) || Number(pid) <= 0) return { ok: false, detail: 'a target pid is required' }

  const target = Number(pid)
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-TargetPid', String(target)]
  if (release) args.push('-Release')
  if (!suspend) args.push('-NoSuspend')
  if (!custody) args.push('-NoCustody')
  if (topmost && custody && !release) args.push('-KeepOnTop')
  // The activity directory is passed explicitly, not left to the script's default. The default is
  // %TEMP%olcano-separatorctivity, which is the SAME path the Node side derives only when logDir
  // is unset -- so with any logDir override the summary was written to one directory and looked for
  // in another, and the freeze that had worked perfectly read as "detain produced no summary".
  args.push('-ActivityDir', activityDir(ctx))
  args.push('-PolicyFile', policyPath(ctx))
  if (reason) args.push('-Reason', reason)

  const summaryFile = join(activityDir(ctx), `detain-${target}.json`)

  // Releasing is short and synchronous: no window to wait on, so read the answer directly.
  if (release) {
    // Before anything is resumed, answer the question this file already knows how to answer: is the
    // process holding this pid the one we froze?
    //
    // The comparison has existed in custodyReport since the ledger was written, and this path never
    // consulted it -- so the tool could correctly report `pid-reused` on one screen and resume a
    // stranger on the next. A fact computed and not read by the decision that needs it is the failure
    // this project keeps finding, and here it is a confused deputy: Windows recycles a pid, someone
    // releases the old number, and an unrelated process is unfrozen.
    //
    // It reuses custodyReport rather than re-deriving the comparison, because a second copy of an
    // identity check is a second thing to keep correct.
    const report = await custodyReport(ctx, { probe: true })
    const rec = report.rows?.find((r) => r.pid === target)

    if (rec?.state === 'pid-reused') {
      return {
        ok: false,
        refused: true,
        pid: target,
        detail: `refused to release: pid ${target} is now a different process than the one that was frozen`,
        recorded: `frozen at ${rec.frozenAt ?? 'an unrecorded time'}`,
        liveCreated: rec.liveCreated,
        note: 'Nothing was resumed. A pid is not an identity, and resuming it would unfreeze whatever Windows gave that number to.',
      }
    }
    if (rec?.state === 'exited') {
      return {
        ok: false,
        refused: true,
        pid: target,
        detail: `refused to release: no process with pid ${target} exists`,
        note: 'Nothing was resumed, because there was nothing to resume.',
      }
    }
    if (!rec) {
      // No record means no identity to check, which is the same shape of act as the two refusals
      // above -- resuming whatever holds this number. `isolate` refuses without a target and
      // `decrypt` refuses a journal it did not write; this is the third instance of the same rule.
      //
      // The cost is real and worth stating: a process this tool froze whose record was lost cannot be
      // released through here. The record is rebuilt from the append-only activity log, so it is lost
      // only if that log was pruned -- and `detained` and `timeline` both read the same source, so the
      // operator can confirm before reaching for another tool.
      // The reason is then narrowed. "No record" alone would also be said about a pid that does
      // not exist, and a refusal that gives the wrong reason is barely better than no check -- the
      // same standard the isolate and decrypt refusals are held to.
      const live = await probeCustody([target])
      const info = live[target]
      const gone = Boolean(info && info.exists === false)
      return {
        ok: false,
        refused: true,
        pid: target,
        detail: gone
          ? `refused to release: no process with pid ${target} exists`
          : `refused to release: no record of a detain for pid ${target}, so this tool cannot check whether that number still belongs to the process it froze`,
        note: gone
          ? 'Nothing was resumed, because there was nothing to resume.'
          : 'Nothing was resumed. If you froze it and the record is gone, `volcano-separator detained` reads the same source and will say so.',
      }
    }

    const r = await run(process.platform === 'win32' ? 'powershell.exe' : 'pwsh', args, { timeoutMs: 60000 })
    const out = (r.stdout ?? '').trim()
    const last = out.split(String.fromCharCode(10)).filter(Boolean).pop() || '{}'
    try {
      const parsed = JSON.parse(last)
      // The mechanical answer decides what gets claimed. detain.ps1 wrote `released` whether or not
      // Resume succeeded; the script reports the real result now, and this makes the caller's `ok`
      // agree with it rather than with the process exit code.
      return { ok: parsed.ok === true, ...parsed, checked: rec ? rec.state : 'no record' }
    } catch {
      return { ok: false, pid: target, detail: r.error ?? 'release produced no result', raw: out.slice(-300) }
    }
  }

  try {
    rmSync(summaryFile, { force: true })
  } catch {
    /* ignore */
  }

  // Detached: the custody window stays open until a human decides, so this must not wait on it.
  // Hand it to the OS rather than holding it as our child.
  //
  // A detached child of this process still dies with this process on Windows (the harness runs
  // its tool calls inside a job object), which is exactly how the first version of this failed:
  // the script worked perfectly when run by hand and produced nothing through the CLI. Letting
  // Start-Process own it removes the parent from the question entirely.
  const quote = (a) => "'" + String(a).replace(/'/g, "''") + "'"
  const launcher =
    'Start-Process -FilePath ' + quote(process.platform === 'win32' ? 'powershell.exe' : 'pwsh') +
    ' -ArgumentList @(' + args.map(quote).join(',') + ') -WindowStyle Hidden'
  const launched = await run('powershell', ['-NoProfile', '-Command', launcher], { timeoutMs: 30000 })
  if (!launched.ok) {
    return { ok: false, pid: target, detail: `could not launch detain: ${launched.error ?? 'unknown'}`, stderr: (launched.stderr ?? '').slice(-300) }
  }

  // Poll, and record what each look actually saw. A bare "no summary" tells the next person
  // nothing; the observed sequence says whether the file never appeared, appeared late, or
  // appeared and then vanished -- three different bugs that read identically otherwise.
  const seen = []
  for (let i = 0; i < 40; i++) {
    await sleep(400)
    const hit = existsSync(summaryFile)
    seen.push({ t: (i + 1) * 400, hit, dir: existsSync(activityDir(ctx)) })
    if (hit) {
      try {
        return { ok: true, ...readJsonLoose(summaryFile), summaryFile }
      } catch {
        /* still being written */
      }
    }
  }
  return {
    ok: false,
    pid: target,
    detail: 'detain launched but produced no summary in 16 s',
    summaryFile,
    launcher,
    observed: seen,
    finalLook: existsSync(summaryFile),
    dirListing: (() => {
      try {
        return readdirSync(activityDir(ctx)).filter((f) => f.startsWith('detain-'))
      } catch {
        return null
      }
    })(),
  }
}

/** Every custody-related event in the record, oldest first. */
export function custodyEvents(ctx, { sinceDays = null, now = Date.now() } = {}) {
  const dir = activityDir(ctx)
  let files = []
  try {
    files = readdirSync(dir).filter((f) => /^activity-\d{4}-\d{2}-\d{2}\.ndjson$/.test(f)).sort()
  } catch {
    return { ok: false, reason: 'no activity record', events: [] }
  }
  if (sinceDays !== null) {
    const cutoff = new Date(now - sinceDays * 86400000).toISOString().slice(0, 10)
    files = files.filter((f) => f.slice('activity-'.length, -'.ndjson'.length) >= cutoff)
  }

  const events = []
  for (const f of files) {
    let text
    try {
      text = readFileSync(join(dir, f), 'utf8')
    } catch {
      continue
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      // Cheap pre-filter, but the kind field decides: an unrelated event can carry these strings
      // inside its hint text, and trusting a substring produced a real false reading once.
      if (!line.includes('"detain"') && !line.includes('"custody-alert"') &&
          !line.includes('"custody-release-notice"')) continue
      let e
      try {
        e = JSON.parse(line.charCodeAt(0) === 0xfeff ? line.slice(1) : line)
      } catch {
        continue
      }
      if (!CUSTODY_EVENT_KINDS.has(e.kind)) continue
      events.push(e)
    }
  }
  events.sort((a, b) => String(a.t ?? '').localeCompare(String(b.t ?? '')))
  return { ok: true, files: files.length, events }
}

/**
 * Group the events into one lifecycle per freeze, with the notices that fired while it was live.
 *
 * A notice is attached to the freeze it followed rather than listed separately: "we warned about
 * this freeze three times" only means something next to the freeze it was about.
 */
export function custodyTimeline(ctx, opts = {}) {
  const { ok, reason, files, events } = custodyEvents(ctx, opts)
  if (!ok) return { ok: false, reason, lifecycles: [] }

  const lifecycles = []
  let current = null
  const systemNotices = []

  for (const e of events) {
    if (e.kind === 'detain') {
      const pid = Number(e.pid)
      if (e.action === 'suspended') {
        current = {
          pid,
          name: e.name ?? null,
          command: redactCommandLine(e.cmd) ?? null,
          why: e.why ?? null,
          created: e.created ?? null,
          frozenAt: e.t ?? null,
          entries: [{ at: e.t, what: 'frozen', detail: e.why ?? '' }],
          notices: [],
          endedAt: null,
          outcome: null,
          durationMs: null,
        }
        lifecycles.push(current)
        continue
      }
      if (!Number.isInteger(pid)) continue
      // Attach to the most recent lifecycle for this pid that has not ended.
      const target = [...lifecycles].reverse().find((l) => l.pid === pid && !l.endedAt)
      if (e.action === 'released') {
        if (target) {
          target.endedAt = e.t ?? null
          target.outcome = 'released'
          target.entries.push({ at: e.t, what: 'released', detail: 'through this tool' })
          target.durationMs = msBetween(target.frozenAt, target.endedAt)
          current = null
        } else {
          systemNotices.push({ at: e.t, what: 'released',
                               detail: `pid ${pid} released with no recorded freeze` })
        }
        continue
      }
      if (e.action === 'failed') {
        systemNotices.push({ at: e.t, what: 'detain failed',
                             detail: `pid ${pid}: ${e.why ?? 'no reason recorded'}` })
        continue
      }
      if (e.action === 'revealed' && target) {
        target.entries.push({
          at: e.t, what: 'windows revealed',
          detail: `${e.windows ?? '?'} window(s), ${e.forced ?? 0} forced visible`,
        })
      }
      continue
    }

    // Notices: attach to the live lifecycle for that pid, or record them as system-level.
    const pid = Number(e.pid)
    const target = [...lifecycles].reverse().find((l) => l.pid === pid && !l.endedAt)
    const entry = {
      at: e.t,
      what: e.kind === 'custody-alert' ? 'alert: stale custody'
          : 'alert: released by something else',
      detail: e.detail ?? '',
    }
    if (target) target.notices.push(entry)
    else systemNotices.push(entry)
  }

  // Anything still open is not "unfinished" -- it is a freeze that never ended, which is the
  // state worth noticing, so the outcome says that rather than leaving it blank.
  for (const l of lifecycles) {
    if (!l.endedAt) {
      l.outcome = 'never released'
      l.durationMs = msBetween(l.frozenAt, new Date().toISOString())
    }
  }

  const byOutcome = {}
  for (const l of lifecycles) byOutcome[l.outcome] = (byOutcome[l.outcome] ?? 0) + 1

  return {
    ok: true,
    files,
    events: events.length,
    lifecycles,
    systemNotices,
    byOutcome,
    open: lifecycles.filter((l) => !l.endedAt),
  }
}

/**
 * A timeline with the live system folded in.
 *
 * A decision recorded as "never released" reads as an outstanding problem, but if the process no
 * longer exists there is nothing to release and the record is simply history. That distinction is
 * the difference between a to-do and an archive entry, so each open decision carries what the
 * system says about it now -- and whether the process is still frozen, running, or gone.
 */
export async function custodyTimelineLive(ctx, opts = {}) {
  const t = custodyTimeline(ctx, opts)
  if (!t.ok) return t
  const open = t.open
  if (!open.length) return { ...t, checked: true }

  const probeFn = opts.probeFn ?? null
  const live = await (probeFn ?? probeCustody)(open.map((l) => l.pid))
  const lifecycles = t.lifecycles.map((l) => {
    if (l.endedAt) return l
    const info = live[l.pid]
    let liveState = 'unknown'
    if (info && info.exists === false) liveState = 'process gone'
    else if (info && info.exists) liveState = info.frozen ? 'still frozen' : 'running'
    return { ...l, liveState, liveThreads: info?.threads ?? null,
             liveSuspended: info?.suspended ?? null }
  })
  return { ...t, lifecycles, checked: true,
           open: lifecycles.filter((l) => !l.endedAt) }
}
