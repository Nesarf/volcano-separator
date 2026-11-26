/**
 * Quiesce and resume: stop the heartbeat, do the work, put it back.
 *
 * Why this exists
 * ---------------
 * The rule this project already carries is "stop the scheduled task before touching the host,
 * because `heal` restarts the daemon's descendants after the host is gone, and then nothing stays
 * killed". Following that rule today means typing two PowerShell commands in the right order and
 * remembering the second one at the end of an exhausting repair. A program can be handed a handle and
 * will carry it; a person reading a checklist at the end of a repair is the part that gets forgotten.
 *
 * What the handle buys
 * --------------------
 * `quiesce()` returns a handle and `resume()` demands it. The handle is what gives the pair an owner
 * and an order: without it two callers interleave, and the second resumes a suspension the first one
 * still depends on -- which reads as "the heartbeat came back on its own" and is the kind of ghost
 * this tool exists to stop chasing.
 *
 * What it will not do
 * -------------------
 * **It takes no task name.** The only task it can touch is the one passed at construction, which is
 * this service's heartbeat. A tool that disables an arbitrary scheduled task is a different tool with
 * a different argument and a different discussion, and folding it in here would make a narrow promise
 * ("the heartbeat, and nothing else") into a broad one by accident.
 *
 * **It does not guess what the state used to be.** `quiesce()` records it and `resume()` restores
 * *that*: a task the user had already disabled stays disabled. The other reading -- "resume means
 * enabled" -- would let a tool call quietly override a human decision, and the person who disabled it
 * would find it back on with no explanation.
 *
 * What it cannot do
 * -----------------
 * **It cannot survive its own process being force-killed.** Enabling a task needs a child process,
 * and a terminated process never gets to start one. The pending suspension is therefore written to
 * disk and reported on the next start rather than pretended away, and nothing here tries to release a
 * leftover automatically: the record says what the state was at the time, but the world may have moved
 * on since, and re-enabling on a guess is how a safety mechanism becomes the thing that turns the
 * safety mechanism on. A guard that only holds while nothing goes wrong is the pattern this project
 * removes; naming the boundary is the alternative.
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { powershellHost, run } from './platform.mjs'

/** Where a suspension that outlived its process is recorded. Outside the repository on purpose. */
export const STATE_FILE = join(homedir(), '.volcano-separator', 'quiesce.json')

/** A scheduled-task call is quick; this budget only bounds a wedged Windows. */
const PS_TIMEOUT_MS = 30_000

const NL = String.fromCharCode(10)

/**
 * A PowerShell single-quoted string literal. Doubling the quote is the whole of what PowerShell needs
 * inside single quotes, and a task name is the only value that reaches this.
 */
function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'"
}

async function defaultExec(script) {
  return run(powershellHost(), ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: PS_TIMEOUT_MS })
}

function firstLine(r) {
  const text = String(r?.stderr ?? r?.error ?? r?.stdout ?? '').trim()
  if (!text) return 'no detail'
  const line = text.split(/\r?\n/).filter(Boolean)[0]
  return line.length > 300 ? line.slice(0, 300) + '...' : line
}

/**
 * The task's state as Windows reports it: `ready`, `disabled`, `running`, `queued`, `missing` when the
 * task is not registered, or `unknown` with a reason when the query itself failed.
 *
 * `missing` and `unknown` are kept apart because they call for different answers: a missing task means
 * the thing being protected was never installed, while an unknown one means Windows did not tell us.
 * Reporting both as "not ready" would be the false signal this project keeps removing.
 */
export async function readTaskState(taskName, exec = defaultExec) {
  const script =
    `$t = Get-ScheduledTask -TaskName ${psQuote(taskName)} -ErrorAction SilentlyContinue; ` +
    `if ($null -eq $t) { 'MISSING' } else { $t.State.ToString() }`
  const r = await exec(script)
  const out = String(r?.stdout ?? '').trim()
  if (out === 'MISSING') return { state: 'missing' }
  if (!out) return { state: 'unknown', why: firstLine(r) }
  return { state: out.toLowerCase() }
}

/** The record left behind by a suspension whose process never returned. Read-only. */
export function readPending(statePath = STATE_FILE) {
  try {
    const rec = JSON.parse(readFileSync(statePath, 'utf8'))
    if (!rec || typeof rec.handle !== 'string' || typeof rec.taskName !== 'string') return null
    return rec
  } catch {
    return null
  }
}

/**
 * The gate. One suspension at a time, because two at once cannot be described honestly: the second
 * caller did not observe the state it is restoring.
 */
export function createGate({ taskName, logger = () => {}, exec = defaultExec, statePath = STATE_FILE } = {}) {
  if (!taskName || typeof taskName !== 'string') throw new Error('createGate needs the task name it may touch')
  let open = null

  function writePending(record) {
    try {
      mkdirSync(dirname(statePath), { recursive: true })
      writeFileSync(statePath, JSON.stringify(record, null, 2) + String.fromCharCode(10))
    } catch (e) {
      // Not fatal: the suspension itself worked, and refusing it here would leave the task disabled
      // with no record *and* an error the caller did not ask for. Say so and carry on.
      logger(`quiesce: could not record the pending suspension at ${statePath}: ${e?.message ?? e}`)
    }
  }

  function clearPending() {
    try {
      rmSync(statePath, { force: true })
    } catch {
      /* already gone */
    }
  }

  /**
   * Put the task back the way it was found. Returns the failure rather than throwing so a resume that
   * Windows refused can leave the suspension open -- a release that did not happen must not look like
   * one that did.
   */
  async function restore(record) {
    if (record.was === 'disabled') return { ok: true, changed: false }
    const r = await exec(`Enable-ScheduledTask -TaskName ${psQuote(record.taskName)} -ErrorAction Stop | Out-Null; 'done'`)
    if (!r?.ok) return { ok: false, why: `Enable-ScheduledTask failed: ${firstLine(r)}` }
    return { ok: true, changed: true }
  }

  async function quiesce() {
    if (open) {
      return { ok: false, why: 'already suspended by this server', handle: open.handle, since: open.since }
    }
    const before = await readTaskState(taskName, exec)
    if (before.state === 'missing') return { ok: false, why: `no scheduled task named ${taskName}` }
    if (before.state === 'unknown') return { ok: false, why: `could not read the state of ${taskName}: ${before.why}` }

    // The handle is generated before the change, so a crash between the disable and the record still
    // cannot produce a suspension with no identity attached to it. 32 bytes because this is the same
    // strength as the auth token and there is no reason for the two secrets this tool holds to differ
    // in a way nobody would remember.
    const handle = randomBytes(32).toString('hex')
    const record = { handle, taskName, was: before.state, since: new Date().toISOString(), pid: process.pid }

    // A task already disabled needs no disable call, and the record still says `was: 'disabled'` so the
    // resume leaves it alone. This is the case where "restore what you found" differs from "enable".
    if (before.state !== 'disabled') {
      const r = await exec(`Disable-ScheduledTask -TaskName ${psQuote(taskName)} -ErrorAction Stop | Out-Null; 'done'`)
      if (!r?.ok) return { ok: false, why: `Disable-ScheduledTask failed: ${firstLine(r)}` }
    }

    open = record
    writePending(record)
    logger(`quiesce: ${taskName} suspended (found ${before.state}); handle ${handle.slice(0, 8)}`)
    return { ok: true, handle, taskName, was: before.state, since: record.since, changed: before.state !== 'disabled' }
  }

  async function resume({ handle } = {}) {
    if (!open) return { ok: false, why: 'nothing is suspended by this server' }
    if (typeof handle !== 'string' || !handle) return { ok: false, why: 'resume needs the handle quiesce returned' }
    if (handle !== open.handle) return { ok: false, why: 'that handle does not own the current suspension' }
    const record = open
    const put = await restore(record)
    if (!put.ok) {
      // The suspension stays open and on disk: Windows refused, so the task is very likely still
      // disabled, and clearing either record would be the lie that makes the next start silent.
      return { ok: false, why: put.why, stillSuspended: true, handle: record.handle }
    }
    open = null
    clearPending()
    logger(`quiesce: ${record.taskName} resumed (found ${record.was})`)
    return { ok: true, taskName: record.taskName, restored: record.was, changed: put.changed }
  }

  /**
   * Give the suspension back without a handle, for a process on its way out. Used by the CLI shutdown
   * path, which is the one caller allowed to skip the handle: it is the owner, and it is leaving.
   */
  async function releaseAll(reason = 'shutting down') {
    if (!open) return { ok: true, released: false }
    const record = open
    const put = await restore(record)
    if (!put.ok) {
      logger(`quiesce: could NOT release ${record.taskName} on exit (${reason}): ${put.why}. The record at ${statePath} stays, and the task is probably still disabled.`)
      return { ok: false, released: false, why: put.why, taskName: record.taskName }
    }
    open = null
    clearPending()
    logger(`quiesce: released ${record.taskName} on exit (${reason})`)
    return { ok: true, released: true, changed: put.changed }
  }

  /**
   * What is open, for reporting. The handle is reduced to a prefix unless it is asked for by name:
   * a report is not a credential, but the pair cannot be driven across two requests without it, so
   * `withHandle` exists for the status binding rather than for a log line.
   */
  function pending({ withHandle = false } = {}) {
    if (!open) return null
    const rec = { taskName: open.taskName, was: open.was, since: open.since, pid: open.pid, handlePrefix: open.handle.slice(0, 8) }
    if (withHandle) rec.handle = open.handle
    return rec
  }

  /**
   * The record left by a process that did not return. Separate from `pending()` on purpose: one is
   * "this server is holding a suspension", the other is "somebody else was, and never gave it back".
   * Merging them would let the second read as the first, and the answer for the second is a person.
   */
  function leftover() {
    return readPending(statePath)
  }

  return { quiesce, resume, releaseAll, pending, leftover, taskName }
}

/** The two bindings, in the shape `buildBindings` expects: one object in, lossless JSON out. */
export function quiesceFunctions(gate) {
  return {
    volcano_quiesce: async (args) => {
      if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
        throw new TypeError('volcano_quiesce takes one object argument')
      }
      const r = await gate.quiesce()
      return {
        ...r,
        text: r.ok
          ? `${r.taskName} suspended (found ${r.was}). Keep this handle and pass it to volcano_resume; an unreleased suspension is released when this server stops, and reported if the stop was not clean.`
          : `not suspended: ${r.why}`,
      }
    },
    volcano_resume: async (args) => {
      if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
        throw new TypeError('volcano_resume takes one object argument')
      }
      const handle = typeof args?.handle === 'string' ? args.handle : undefined
      const r = await gate.resume({ handle })
      return {
        ...r,
        text: r.ok
          ? `${r.taskName} restored to ${r.restored}${r.changed ? ' (enabled by this call)' : ' (it was already disabled, so it was left that way)'}`
          : `not resumed: ${r.why}${r.stillSuspended ? ' -- the suspension is still open and on disk' : ''}`,
      }
    },
    /**
     * The read-only half, and the reason the pair can be driven across two requests at all: a program
     * that suspends has to end, so the handle it received dies with the response unless something can
     * hand it back later. This is that something.
     *
     * It returns the handle in full, which is the same judgement the auth token makes: a secret is not
     * a border between processes that already run as this user, and withholding it here would not make
     * anything safer -- it would only make the pairing impossible to complete. What it is worth is that
     * the handle names *which* suspension, so a resume after a restart cannot resume somebody else's.
     *
     * `live` and `leftover` are kept apart because they call for different answers. One is "this
     * server is holding it, resume it here". The other is "a process that is gone was holding it, and
     * the answer is a person".
     */
    volcano_quiesce_status: async (args) => {
      if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
        throw new TypeError('volcano_quiesce_status takes one object argument')
      }
      const live = gate.pending({ withHandle: true })
      const left = live ? null : gate.leftover()
      const lines = []
      if (live) {
        lines.push(`${live.taskName} is suspended by this server (found ${live.was} at ${live.since})`)
        lines.push('the handle below is what volcano_resume needs; this process is the one holding it')
      } else if (left) {
        lines.push(`a suspension of ${left.taskName} from ${left.since} (pid ${left.pid}) was never released`)
        lines.push('this server is NOT holding it and will not release it on a guess -- read the task state and enable it by hand if that is right')
      } else {
        lines.push('nothing is suspended; the heartbeat is as it was')
      }
      return { ok: true, suspended: Boolean(live), live, leftover: left, text: lines.join(NL) }
    },
  }
}

/** Descriptors for the discovery endpoint, in the same shape `TOOLS` entries use. */
export function quiesceTools() {
  return [
    {
      name: 'volcano_quiesce',
      description:
        'Suspend this service\'s heartbeat (the scheduled task) so a repair of the host can actually stop it, and return a handle. The heartbeat is what restarts the daemon\'s descendants after the host goes away, so killing the host while it runs produces a process that comes back. Changes machine state: the task is disabled until volcano_resume is called with this handle, or until this server stops. Takes no task name -- it can only ever touch its own heartbeat.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'volcano_resume',
      description:
        'End a suspension started by volcano_quiesce, restoring the state that was found rather than simply enabling: a task that was already disabled before the call stays disabled. Requires the handle, so two callers cannot interleave their suspensions. If Windows refuses, the suspension stays open and on disk rather than being reported as released.',
      inputSchema: {
        type: 'object',
        properties: { handle: { type: 'string', description: 'The handle volcano_quiesce returned, in full.' } },
        required: ['handle'],
        additionalProperties: false,
      },
    },
    {
      name: 'volcano_quiesce_status',
      description:
        'Whether the heartbeat is suspended, and which suspension it is. Read-only, and the reason a pairing can span two requests at all: a program that suspends has to end, so the handle has to be readable afterwards. Reports a live suspension -- this server is holding it, resume it here -- separately from a leftover one, which a process that is gone was holding and which needs a person rather than a guess.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ]
}
