import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { run } from './platform.mjs'

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

/** Is the recorder alive right now? Its own events are the evidence. */
export async function probeActivityRecorder(ctx) {
  const a = readActivity(ctx, { limit: 1, files: 1 })
  if (!a.total) return { ok: false, running: false, detail: `no activity record yet in ${a.dir}` }
  const newest = a.events.at(-1)
  const ageMs = newest?.t ? Date.now() - Date.parse(newest.t) : Infinity
  const fresh = ageMs < 15 * 60 * 1000
  return {
    ok: fresh,
    running: fresh,
    dir: a.dir,
    events: a.total,
    newest: newest?.t ?? null,
    ageSeconds: Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : null,
    detail: fresh
      ? `recording (${a.total} events, newest ${Math.round(ageMs / 1000)}s ago)`
      : `stale: newest event is ${Math.round(ageMs / 60000)} min old`,
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
