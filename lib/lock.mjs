import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

import { readJsonLoose } from './platform.mjs'

/**
 * A named lock, for work that must not overlap with itself.
 *
 * Why this exists
 * ---------------
 * `heal` was written as if only one of it ran at a time, and nothing enforced that. The heartbeat
 * runs every five minutes; a manual `heal`, a `restart`, or an MCP call can start at any moment.
 * Measured over 514 heartbeats on this machine, 16 of them overlapped with the previous one -- about
 * three percent -- and the worst ran for thirty minutes while the next had already begun. Two
 * concurrent recoveries can warm the same environment twice, start a service one of them is about to
 * stop, and report two different conclusions about the same machine.
 *
 * The risk is not hypothetical, which is the only reason it is worth the code.
 *
 * What the lock does not do
 * -------------------------
 * It does not make the holder's work correct, and it is not a mutual-exclusion primitive for other
 * processes to build on -- it is a file, and a file can be ignored. What it buys is that the tool
 * stops doing two recoveries at once *when it is the one starting them*, which is the case it
 * controls.
 *
 * Staleness is deliberately generous. A holder that died leaves a file behind, and a lock that can
 * never be acquired again is worse than no lock: the heartbeat would stop repairing anything and
 * report that it could not get a turn.
 */

const DEFAULT_STALE_MS = 45 * 60 * 1000

export function lockDir(ctx = {}) {
  return ctx.lockDir ?? join(homedir(), '.volcano-separator', 'locks')
}

export function lockFile(ctx, name) {
  return join(lockDir(ctx), `${name}.lock`)
}

export function readLock(ctx, name) {
  const file = lockFile(ctx, name)
  if (!existsSync(file)) return null
  // readJsonLoose tolerates the BOM and nothing else -- it throws on malformed JSON, which is not
  // what its name suggests. Caught here rather than assumed away: a lock file we cannot read is not
  // evidence that anyone holds it.
  let held = null
  try {
    held = readJsonLoose(file)
  } catch {
    return { file, unreadable: true }
  }
  return held && typeof held === 'object' && !Array.isArray(held) ? { ...held, file } : { file, unreadable: true }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    // Signal 0 asks whether the process exists without touching it. On Windows Node implements this
    // as an existence check.
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === 'EPERM'
  }
}

/**
 * Try to take the lock. Returns `{ ok: true }` when acquired, `{ ok: false, busy: true, holder }`
 * when someone else holds it, and never throws -- a caller deciding whether to proceed needs an
 * answer, not an exception.
 */
export function acquireLock(ctx, name, { holder = 'unknown', staleMs = DEFAULT_STALE_MS, now = Date.now() } = {}) {
  const file = lockFile(ctx, name)
  const existing = readLock(ctx, name)

  if (existing && !existing.unreadable) {
    const age = now - Date.parse(existing.at ?? 0)
    const alive = pidAlive(existing.pid)
    // Stale when the holder is gone, or when it has been held far longer than any recovery should
    // take. Both are reported rather than silently overridden, because "I took it from a dead
    // process" is a fact the log should carry.
    const stale = !alive || !Number.isFinite(age) || age > staleMs
    if (!stale) {
      return { ok: false, busy: true, holder: existing, file, ageMs: age }
    }
    existing.takenOverFrom = { pid: existing.pid, holder: existing.holder, alive, ageMs: age }
  } else if (existing?.unreadable) {
    // A lock file we cannot read is not evidence that someone holds it, and refusing forever
    // because of a truncated write is the failure mode this whole module is trying to avoid.
    existing.takenOverFrom = { unreadable: true }
  }

  try {
    mkdirSync(dirname(file), { recursive: true })
    const me = { pid: process.pid, holder, at: new Date(now).toISOString() }
    if (existing?.takenOverFrom) me.takenOverFrom = existing.takenOverFrom
    writeFileSync(file, JSON.stringify(me, null, 2))
    return { ok: true, file, holder: me, takenOverFrom: me.takenOverFrom ?? null }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e), file }
  }
}

export function releaseLock(ctx, name) {
  const file = lockFile(ctx, name)
  const held = readLock(ctx, name)
  // Only the holder releases it. A process that took over from a stale lock must not have its own
  // lock deleted by the process it took over from, which is the one way this simple scheme can go
  // wrong in a way that matters.
  if (held && !held.unreadable && held.pid !== process.pid) {
    return { ok: false, file, reason: `held by pid ${held.pid}, not by ${process.pid}` }
  }
  try {
    rmSync(file, { force: true })
    return { ok: true, file }
  } catch (e) {
    return { ok: false, file, detail: String(e?.message ?? e) }
  }
}

/** Run `fn` while holding the lock, releasing it however `fn` ends. */
export async function withLock(ctx, name, fn, { holder = 'unknown', staleMs = DEFAULT_STALE_MS } = {}) {
  const got = acquireLock(ctx, name, { holder, staleMs })
  if (!got.ok) return { ok: false, busy: true, lock: got }
  try {
    const result = await fn()
    return { ...(result ?? {}), lock: { acquired: true, takenOverFrom: got.takenOverFrom ?? null } }
  } finally {
    releaseLock(ctx, name)
  }
}
