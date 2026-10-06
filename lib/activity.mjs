import { existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { run, sleepSync } from './platform.mjs'
import { exeFromCmd } from './commandline.mjs'
import { loadPolicy, policyAllows } from './policy.mjs'

/**
 * Activity: the system-wide record, and the recorder that produces it.
 *
 * Extracted from core.mjs. This layer reads a log the OS-level recorder writes, and asks whether
 * that recorder is alive; it deliberately depends on nothing above it, because a transparency
 * tool that cannot read its own output has reproduced the problem it exists to remove -- and it
 * has to keep working when the service layer, the daemon and the database are all down, which is
 * exactly when you most want to know what happened.
 */
export function activityDir(ctx) {
  return join(ctx.logDir ?? join(tmpdir(), 'volcano-separator'), 'activity')
}

/**
 * Read back the activity record.
 *
 * Plain NDJSON on purpose: the timeline stays readable even when the daemon, the database and uv
 * are all down -- which is exactly when you most want to know what happened.
 */


export function readActivity(ctx, { limit = 40, kind = null, grep = null, files = 2 } = {}) {
  const dir = activityDir(ctx)
  let list = []
  try {
    list = readdirSync(dir)
      .filter((f) => f.endsWith('.ndjson'))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, files)
  } catch {
    return { dir, total: 0, events: [], recorderRunning: false }
  }

  const events = []
  const filesSeen = list.length
  let readFailures = 0
  for (const entry of list.reverse()) {
    // The recorder runs as SYSTEM and appends to this file continuously, so a read can collide
    // with a write and fail. Retrying is not optional: the previous code swallowed the failure
    // and returned an empty record, which reads exactly like "nothing happened".
    let text = null
    for (let attempt = 0; attempt < 5 && text === null; attempt++) {
      try {
        text = readFileSync(join(dir, entry.f), 'utf8')
      } catch {
        sleepSync(80 + attempt * 120)
      }
    }
    if (text === null) {
      readFailures++
      continue
    }
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim()
      if (!t) continue
      try {
        // Strip a BOM: it only ever appears on a file's first line, and there it silently
        // costs you exactly one event per rotation.
        const clean = t.charCodeAt(0) === 0xfeff ? t.slice(1) : t
        events.push(JSON.parse(clean))
      } catch {
        /* a half-written line at the tail of a live file -- skip it */
      }
    }
  }

  let filtered = events
  if (kind) filtered = filtered.filter((e) => e.kind === kind)
  if (grep) {
    let re = null
    try {
      re = new RegExp(grep, 'i')
    } catch {
      re = null
    }
    if (re) filtered = filtered.filter((e) => re.test(JSON.stringify(e)))
  }

  const last = events.filter((e) => e.kind === 'baseline').pop()
  // Three different situations, and conflating them is the bug this tool exists to fix:
  //   no files            -> the recorder is not installed
  //   files, unreadable   -> the recorder IS running but something holds the file (typically a
  //                          second instance); reporting this as "no recorder" turns a lock
  //                          into an invisibility
  //   files, readable     -> normal
  const readable = readFailures === 0
  return {
    dir,
    filesSeen,
    readFailures,
    readable,
    total: events.length,
    shown: Math.min(limit, filtered.length),
    events: filtered.slice(-limit),
    recorderRunning: filesSeen > 0,
    lastHeartbeat: last?.t ?? null,
  }
}

/**
 * The recorder's own account of what it managed to write.
 *
 * Why a *separate* file rather than rows in the record: the failures being counted are failures to
 * write rows, so a counter kept in the record would go quiet exactly when it had something to
 * report. The snapshot is written temp-then-rename, and it is rewritten every few seconds, so its
 * *staleness* is the one honest signal that the recorder is not running -- while the numbers are
 * the only way to tell "nothing happened" from "nothing was recorded".
 *
 * Absence is reported as absence. A recorder older than this file would otherwise read as healthy
 * and complete, which is the exact class of bug this whole layer is here to prevent.
 */
export function recorderHealthFile(ctx) {
  return join(activityDir(ctx), 'recorder-health.json')
}

export function readRecorderHealth(ctx, { staleSeconds = 90 } = {}) {
  const file = recorderHealthFile(ctx)
  if (!existsSync(file)) {
    return { known: false, file, detail: 'no health snapshot -- this recorder does not publish one' }
  }
  let raw = null
  try {
    raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return { known: false, file, detail: 'the health snapshot exists but could not be read' }
  }
  const at = raw?.t ? Date.parse(raw.t) : NaN
  const ageSeconds = Number.isFinite(at) ? Math.round((Date.now() - at) / 1000) : null
  const fresh = Number.isFinite(at) && ageSeconds <= staleSeconds
  return {
    known: true,
    fresh,
    file,
    ageSeconds,
    pid: raw?.pid ?? null,
    startedAt: raw?.startedAt ?? null,
    uptimeSeconds: raw?.uptimeSeconds ?? null,
    passes: raw?.passes ?? null,
    iterations: raw?.iterations ?? null,
    subscribed: raw?.subscribed ?? null,
    subscribedStop: raw?.subscribedStop ?? null,
    lockTaken: raw?.lockTaken ?? null,
    lockNote: raw?.lockNote ?? '',
    eventsSeen: raw?.eventsSeen ?? null,
    eventsSelf: raw?.eventsSelf ?? null,
    eventsDuplicate: raw?.eventsDuplicate ?? null,
    eventsWritten: raw?.eventsWritten ?? null,
    eventsDropped: raw?.eventsDropped ?? null,
    handlerErrors: raw?.handlerErrors ?? null,
  }
}

/** Is the recorder alive right now? Its own events are the evidence. */
export async function probeActivityRecorder(ctx) {
  const a = readActivity(ctx, { limit: 1, files: 1 })
  const health = readRecorderHealth(ctx)

  if (!a.total) {
    return { ok: false, running: false, health, detail: `no activity record yet in ${a.dir}` }
  }
  const newest = a.events.at(-1)
  const ageMs = newest?.t ? Date.now() - Date.parse(newest.t) : Infinity
  const fresh = ageMs < 15 * 60 * 1000

  // A quiet machine and a broken recorder produce the same event age, and telling them apart is what
  // the counters are for. They are reported, never folded into `ok`: a dropped row is not the same
  // failure as a stopped recorder, and the two need different reactions.
  const lost = Number.isFinite(health.eventsDropped) ? health.eventsDropped : null
  const stuck = health.known && health.fresh === false
  const silentSubscription = health.known && health.subscribed === false

  return {
    // Two independent conditions, both required. "Recent events" alone was the old answer, and it
    // is the one a recorder cannot give honestly when what is failing is its writing.
    ok: fresh && (!health.known || (health.fresh && health.subscribed !== false)),
    running: fresh,
    dir: a.dir,
    events: a.total,
    newest: newest?.t ?? null,
    ageSeconds: Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : null,
    health,
    detail: [
      fresh
        ? `recording (${a.total} events, newest ${Math.round(ageMs / 1000)}s ago)`
        : Number.isFinite(ageMs)
          ? `stale: newest event is ${Math.round(ageMs / 60000)} min old`
          // A last line that is not valid JSON has no timestamp, and printing "Infinity min old" for
          // that is worse than saying nothing: it looks like a measurement. The usual cause is a
          // writer killed mid-line, which is a fact about the record worth naming.
          : 'the newest line in the record has no readable timestamp (a write that did not finish?)',
      health.known
        ? health.fresh
          ? // Not "wrote N of M seen": rows are also written outside the event stream (the recorder's
            // own start, the baseline), so that reads as a fraction greater than one. The dropped
            // count is the number that matters, and it is stated rather than derived.
            `${health.eventsWritten} row(s) written${lost ? `, ${lost} lost` : ', nothing lost'}`
          : `its health snapshot is ${health.ageSeconds}s old -- the recorder is not running`
        : 'no health snapshot to check its own writing against',
      silentSubscription ? 'it is not subscribed to the process trace' : null,
    ]
      .filter(Boolean)
      .join('; '),
  }
}

// ────────────────────────────────────────────────────────────────────────────
// The activity recorder as a service-level citizen: installed by default
// ────────────────────────────────────────────────────────────────────────────

export function activityTaskName(ctx) {
  return `${ctx.taskName}-Activity`
}

/**
 * Register the system-wide activity recorder.
 *
 * Two deliberate choices:
 *   * **AtStartup, as SYSTEM.** The recorder has to be watching *before* anything worth
 *     recording starts -- before logon, before the agent host, before the daemon loads. A
 *     logon-triggered user task would already be blind to the boot sequence.
 *   * **wscript, not cmd.** Same reason as the heartbeat: a console-subsystem launcher under
 *     Windows Terminal flashes a window every time it runs.
 */
export async function installActivityTask(ctx, { projectDir, dryRun = false } = {}) {
  if (process.platform !== 'win32') return { ok: false, detail: 'Windows only' }
  const watch = join(projectDir, 'bin', 'activity-watch.ps1')
  if (!existsSync(watch)) return { ok: false, detail: `watcher not found: ${watch}` }

  const name = activityTaskName(ctx)
  const vbs = join(projectDir, 'bin', 'activity-task.vbs')
  const script = [
    "' volcano-separator :: launch the activity recorder with no window.",
    'Set sh = CreateObject("WScript.Shell")',
    // The log directory is passed explicitly. The script's own default is $env:TEMP, and that
    // resolves differently for SYSTEM (the machine TEMP, C:\Windows\TEMP) than for the user --
    // so the recorder, which runs as SYSTEM, wrote to C: while every reader looked on E:.
    // That is not hypothetical: it is how this recorder came to write nothing at all.
    `sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""${watch}"" -LogDir ""${activityDir(ctx)}""", 0, False`,
    '',
  ].join('\r\n')

  const ps = `
$ErrorActionPreference = 'Stop'
$action    = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '//B //Nologo "${vbs}"'
$atStartup = New-ScheduledTaskTrigger -AtStartup
$atLogon   = New-ScheduledTaskTrigger -AtLogOn
# SYSTEM + ServiceAccount: starts at boot, needs no interactive session, allocates no window,
# and can see every process and every registry hive.
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName '${name}' -Action $action -Trigger @($atStartup, $atLogon) -Settings $settings -Principal $principal -Force | Out-Null
'registered'
`.trim()

  if (dryRun) return { ok: true, dryRun: true, script, vbs, detail: `(dry-run) would register ${name} at boot as SYSTEM` }

  const { writeFileSync } = await import('node:fs')
  writeFileSync(vbs, script, 'utf8')
  const r = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { timeoutMs: 120000 })
  const good = r.ok && /registered/.test(r.stdout)
  return {
    ok: good,
    vbs,
    detail: good ? `registered ${name} (at boot, as SYSTEM, windowless)` : `registration failed: ${r.error ?? 'unknown'}`,
    tail: (r.stdout + r.stderr).trim().slice(-800),
  }
}

export async function uninstallActivityTask(ctx) {
  if (process.platform !== 'win32') return { ok: false, detail: 'Windows only' }
  const name = activityTaskName(ctx)
  const r = await run('powershell', ['-NoProfile', '-Command', `Unregister-ScheduledTask -TaskName '${name}' -Confirm:$false -ErrorAction SilentlyContinue; 'done'`], { timeoutMs: 60000 })
  return { ok: r.ok, detail: r.ok ? `removed ${name}` : `removal failed: ${r.error}` }
}

export async function activityTaskState(ctx) {
  if (process.platform !== 'win32') return { installed: false }
  const name = activityTaskName(ctx)
  const r = await run('powershell', ['-NoProfile', '-Command', `$t = Get-ScheduledTask -TaskName '${name}' -ErrorAction SilentlyContinue; if ($t) { $i = Get-ScheduledTaskInfo -TaskName '${name}'; 'state=' + $t.State; 'last=' + $i.LastRunTime; 'result=' + $i.LastTaskResult } else { 'state=absent' }`], { timeoutMs: 60000 })
  const text = (r.stdout + r.stderr).trim()
  if (/state=absent/.test(text)) return { installed: false, text }
  const g = (k) => new RegExp(`${k}=(.+)`).exec(text)?.[1]?.trim() ?? null
  return { installed: true, state: g('state'), lastRun: g('last'), lastResult: g('result'), text }
}

/**
 * What actually ran, grouped.
 *
 * The record is complete and that turned out not to be enough. Hundreds of processes were
 * captured and nothing surfaced them: the signal rules only speak up about specific shapes
 * (persistence, ephemerality, self-deletion), and `ps` deliberately shows only this stack's own
 * processes. So a three-hour, 351-invocation, windowless workload ran and the tool had nothing
 * to say about it.
 *
 * Recording is not transparency. This answers "what has been running here", which is the
 * question a person actually asks.
 */
export function summarizeActivity(ctx, { sinceMinutes = 120, limit = 25, minRuns = 1 } = {}) {
  const a = readActivity(ctx, { limit: 400000, files: 3 })
  const policy = loadPolicy(ctx)
  const cutoff = Date.now() - sinceMinutes * 60 * 1000

  const groups = new Map()
  for (const e of a.events) {
    const t = Date.parse(e.t ?? '')
    if (Number.isFinite(t) && t < cutoff) continue
    if (e.kind !== 'proc-start') continue

    const name = String(e.name ?? '').toLowerCase()
    if (!name) continue
    let g = groups.get(name)
    if (!g) {
      g = { name, runs: 0, first: e.t, last: e.t, windows: 0, exe: null, pids: new Set(), user: e.user ?? null }
      groups.set(name, g)
    }
    g.runs++
    g.last = e.t
    g.pids.add(Number(e.pid))
    const exe = exeFromCmd(e.cmd)
    if (exe && !g.exe) g.exe = exe
  }

  // A window event means a title was sampled for it. Its absence means nothing: the recorder
  // only samples for a few seconds after start, so short-lived and late-titled programs never
  // produce one. The first version of this called the absence "headless" and flagged chrome.exe
  // as having no window. Named for what it is instead of what it was assumed to mean.
  for (const e of a.events) {
    if (e.kind !== 'window') continue
    const g = groups.get(String(e.name ?? '').toLowerCase())
    if (g) g.windows++
  }

  const rows = [...groups.values()]
    .filter((g) => g.runs >= minRuns)
    .map((g) => ({
      name: g.name,
      runs: g.runs,
      distinctPids: g.pids.size,
      first: g.first,
      last: g.last,
      windows: g.windows,
      noWindowObserved: g.windows === 0,
      exe: g.exe,
      allowed: policyAllows(policy, { name: g.name, path: g.exe }),
    }))
    .sort((x, y) => y.runs - x.runs)
    .slice(0, limit)

  return {
    ok: true,
    dir: a.dir,
    window: `${sinceMinutes} min`,
    observed: a.total,
    distinctPrograms: groups.size,
    noWindowObserved: rows.filter((r) => r.noWindowObserved).length,
    rows,
  }
}

/** Append one event to today's activity record, tolerating a concurrent writer. */
export function appendToActivity(ctx, event) {
  const dir = activityDir(ctx)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'activity-' + new Date().toISOString().slice(0, 10) + '.ndjson')
  // The recorder runs as SYSTEM and writes the same file. Append, retry a few times, and never
  // hold the handle: a collision is expected rather than exceptional.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      appendFileSync(file, JSON.stringify(event) + '\n', 'utf8')
      return true
    } catch {
      sleepSync(60 + attempt * 90)
    }
  }
  throw new Error('could not append to the activity record')
}
