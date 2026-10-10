import { existsSync } from 'node:fs'

import { readActivity } from './activity.mjs'
import { exeFromCmd } from './commandline.mjs'
import { powershellHost, run } from './platform.mjs'
import { probeResources } from './resources.mjs'

/**
 * One process, by pid, whatever it is.
 *
 * **`liveProcesses` is not the right source here and using it would have been a silent narrowing.**
 * It queries four executable names -- `uvx.exe`, `uv.exe`, `hindsight-api.exe`, `postgres.exe` -- and
 * then filters the command lines to this stack, because its job is to describe *this tool's* chain.
 * Asking it about an arbitrary pid therefore returns nothing, and "nothing" would have read as "not
 * running", which is the exact class of wrong answer this project removes.
 *
 * This asks about the pid itself, so it can answer for any process. It returns null for a pid that is
 * not there and throws away nothing: the caller can tell "gone" from "could not look".
 */
async function oneProcess(ctx, pid) {
  const ps =
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" -ErrorAction SilentlyContinue; ` +
    `if (-not $p) { 'NONE' } else { ` +
    `$age = [math]::Round(((Get-Date) - $p.CreationDate).TotalSeconds, 1); ` +
    `"$($p.ProcessId)|$($p.ParentProcessId)|$($p.Name)|$age|" + ($p.CommandLine -replace "[
]+", ' ') }`
  const r = await run(powershellHost(), ['-NoProfile', '-Command', ps], { timeoutMs: 30000 })
  const out = String(r.stdout ?? '').trim()
  if (!out) return { found: null, detail: r.error ?? 'the process query returned nothing' }
  if (out === 'NONE') return { found: false, detail: 'no process with that pid' }
  const [p, ppid, name, age, ...rest] = out.split('|')
  return {
    found: true,
    process: { pid: Number(p), parentPid: Number(ppid), name, ageSeconds: Number(age), cmd: rest.join('|') },
  }
}

/**
 * Every process whose command line names a path.
 *
 * A full `Win32_Process` sweep, deliberately, because the question "is anything running from this file"
 * is a question about the whole machine. The narrow stack-scoped reader would answer it for this tool's
 * own chain and silently miss everything else -- and an undo that proceeds on that answer is the
 * failure mode this exists to prevent.
 *
 * A command line is not a handle table, so this finds processes that *name* the path. That limit is
 * stated in the answer rather than folded into it.
 */
async function processesNaming(ctx, pathFragment) {
  // The fragment is escaped for WQL: a single quote would end the string literal, and a backslash is
  // an escape character in LIKE, so both are handled before the query is built.
  const BS = String.fromCharCode(92)
  const esc = String(pathFragment).split("'").join("''").split(BS).join(BS + BS)
  const ps =
    `Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${esc}%'" -ErrorAction SilentlyContinue | ` +
    `Select-Object -First 40 | ForEach-Object { ` +
    `$age = [math]::Round(((Get-Date) - $_.CreationDate).TotalSeconds, 1); ` +
    `"$($_.ProcessId)|$($_.Name)|$age" }`
  const r = await run(powershellHost(), ['-NoProfile', '-Command', ps], { timeoutMs: 60000 })
  const rows = []
  for (const line of String(r.stdout ?? '').split(String.fromCharCode(10))) {
    const t = line.trim()
    if (!t || !t.includes('|')) continue
    const [pid, name, age] = t.split('|')
    rows.push({ pid: Number(pid), name, ageSeconds: Number(age) })
  }
  return { rows, detail: r.error ?? null }
}

/**
 * One identity per thing, so the surfaces can be correlated instead of consulted one at a time.
 *
 * **The idea is osquery's and only the idea.** Its contribution is not a 200 MB agent, it is that a
 * machine's state is more useful when its facts share identities: ask about a pid and get everything
 * known about that pid, rather than asking five subsystems five separate questions and doing the join
 * by hand in your head. Nothing here is a new dependency.
 *
 * **What is deliberately not done.** There is no query language and no single flat table. The surfaces
 * are of two kinds and merging them would be a lie: `activity` is a record of *events*, which have a
 * time and happened once, while `ps` and `redline` are *snapshots*, which are true at the moment they
 * are taken and say nothing about a minute ago. A tool whose whole purpose is to remove wrong-looking
 * answers should not flatten "happened at 14:02" into "is true".
 *
 * So an entity answers "everything known about this pid" or "everything known about this path", and
 * each answer says which surface it came from and whether it is an event or a snapshot.
 */

/** The identity keys a caller can ask about. Named rather than positional, so a call says what it means. */
export const ENTITY_KINDS = ['pid', 'path']

function normPath(p) {
  if (!p) return null
  let s = String(p).trim().replace(/^"|"$/g, '')
  // Backslashes are built from their code point: this repository has been through enough escaping
  // layers that a literal one does not reliably survive being written into a file.
  const BS = String.fromCharCode(92)
  s = s.split(BS).join('/')
  return s.replace(/\/+$/, '').toLowerCase()
}

/**
 * Everything known about one process, across every surface that knows anything about processes.
 *
 * `pid` is a number, not an identity -- the record is full of events from earlier processes that held
 * the same one. So the events are reported with their timestamps and the caller can see that, rather
 * than this function quietly pretending they all belong to the process alive now. That mistake was
 * already found once, in the chamber, where "63 events for this pid" resolved to one.
 */
export async function entityByPid(ctx, pid, { historyDays = 3 } = {}) {
  const target = Number(pid)
  if (!Number.isFinite(target) || target <= 0) return { ok: false, detail: 'a pid is required' }

  const snapshot = []
  const events = []
  const unknown = []

  // Snapshot: is it running now, and from what.
  let running = null
  try {
    const one = await oneProcess(ctx, target)
    if (one.found === true) running = one.process
    else if (one.found !== false) unknown.push({ surface: 'ps', why: one.detail })
  } catch (e) {
    unknown.push({ surface: 'ps', why: `the process could not be looked up: ${e?.message ?? e}` })
  }
  if (running) {
    snapshot.push({ surface: 'ps', what: 'running now', value: running })
  } else if (!unknown.some((u) => u.surface === 'ps')) {
    snapshot.push({ surface: 'ps', what: 'running now', value: null })
  }

  // Snapshot: how much of the machine it is using, and whether it is among the largest.
  try {
    const res = await probeResources({ top: 25 })
    const inTop = (res.top ?? []).find((p) => Number(p.pid) === target)
    if (inTop) snapshot.push({ surface: 'resources', what: 'among the largest processes', value: inTop })
  } catch (e) {
    unknown.push({ surface: 'resources', why: `resource state could not be read: ${e?.message ?? e}` })
  }

  // Events: what the record says about this pid number. Timestamps are kept, because a pid is reused.
  try {
    const a = readActivity(ctx, { limit: 500000, files: 60 })
    const mine = (a.events ?? []).filter((e) => Number(e.pid) === target)
    for (const e of mine) {
      events.push({ surface: 'activity', t: e.t, kind: e.kind, action: e.action ?? null, detail: e.detail ?? e.cmd ?? null })
    }
    if (a.unreadableLines) unknown.push({ surface: 'activity', why: `${a.unreadableLines} line(s) of the record were unreadable, so these events are a floor` })
  } catch (e) {
    unknown.push({ surface: 'activity', why: `the record could not be read: ${e?.message ?? e}` })
  }

  // The executable path, which is the join key to everything file-shaped.
  const exe = running?.cmd ? exeFromCmd(running.cmd) : null

  return {
    ok: true,
    kind: 'pid',
    id: target,
    snapshot,
    events,
    // The identity, stated as a fact rather than implied. `pid` alone is not one.
    identity: {
      path: exe,
      pathExists: exe ? existsSync(exe) : null,
      note: exe
        ? 'this is the executable the process is running from, and the key that files can be found by'
        : 'the executable path could not be parsed from the command line, so this pid cannot be joined to any file',
    },
    // What this cannot answer, said here rather than left for a reader to assume.
    cannot: [
      'which files the process has open -- that needs handle enumeration this tool does not do',
      'whether the process is harmful, which is a question about behaviour over time and not about state',
    ],
    unknown,
  }
}

/**
 * Everything known about one path, across every surface that knows anything about files.
 *
 * **The question this exists for is the one an undo needs.** `vault` moves a file and `isolate` denies
 * access to one; both are safe only if nothing is running from it. Neither could previously ask, so the
 * answer was "probably nothing" -- and a tool whose whole purpose is to remove that kind of answer
 * should not rest on one.
 *
 * What it reports about users is derived from command lines in the process snapshot, so it names the
 * processes whose *command line mentions this path*. That is a real measurement and a partial one, and
 * the difference is stated in the answer rather than folded into it: a process holding the file open
 * without naming it in its command line is not found this way.
 */
export async function entityByPath(ctx, path, { historyDays = 3 } = {}) {
  if (!path) return { ok: false, detail: 'a path is required' }
  const wanted = normPath(path)
  const snapshot = []
  const events = []
  const unknown = []

  snapshot.push({ surface: 'filesystem', what: 'the path itself', value: { exists: existsSync(path) } })

  // Who is running from it, or naming it. From the process snapshot.
  let users = []
  try {
    const found = await processesNaming(ctx, path)
    users = found.rows
    if (found.detail) unknown.push({ surface: 'ps', why: found.detail })
  } catch (e) {
    unknown.push({ surface: 'ps', why: `processes could not be searched: ${e?.message ?? e}` })
  }
  snapshot.push({ surface: 'ps', what: 'processes whose command line names this path', value: users })

  // What the record says happened to it.
  try {
    const a = readActivity(ctx, { limit: 500000, files: Math.max(2, historyDays + 2) })
    for (const e of a.events ?? []) {
      const fields = [e.path, e.value, e.detail, e.cmd].filter(Boolean).map(normPath)
      if (fields.some((f) => f && f.includes(wanted))) {
        events.push({ surface: 'activity', t: e.t, kind: e.kind, action: e.action ?? null, detail: e.detail ?? e.path ?? null })
      }
    }
  } catch (e) {
    unknown.push({ surface: 'activity', why: `the record could not be read: ${e?.message ?? e}` })
  }

  return {
    ok: true,
    kind: 'path',
    id: String(path),
    snapshot,
    events,
    identity: { normPath: wanted },
    // The headline for an undo decision, derived rather than asked of the caller.
    inUse: users.length > 0,
    inUseWhy: users.length
      ? `named by ${users.length} running process(es): ${users.slice(0, 3).map((u) => `${u.name} #${u.pid}`).join(', ')}`
      : 'no running process names this path in its command line',
    cannot: [
      'whether a process holds the file open without naming it -- command lines are not handle tables',
      'whether the path is a directory with something running from inside it, which needs a walk',
    ],
    unknown,
  }
}

/** Dispatch by kind, so a caller with a string does not have to branch. */
export async function entity(ctx, kind, id, opts = {}) {
  if (kind === 'pid') return entityByPid(ctx, id, opts)
  if (kind === 'path') return entityByPath(ctx, id, opts)
  return { ok: false, detail: `no entity kind '${kind}' (have: ${ENTITY_KINDS.join(', ')})` }
}
