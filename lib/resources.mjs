/**
 * Resource layer for Volcano Separator.
 *
 * Why this exists
 * ---------------
 * The uv / daemon / hindsight layers keep the memory service reachable, but they say
 * nothing about whether the machine can *afford* an unrelated heavy job right now.
 * A real incident on this host: a batch decompiler whose worker peaks at ~1.8 GB ran
 * while the daemon held ~1.25 GB, and the daemon was killed. Observed twice.
 *
 * So this layer answers one question before heavy work starts:
 *     "is there enough headroom, or should the caller wait?"
 * and one question afterwards:
 *     "if the daemon is gone, was it pressure rather than a bug?"
 *
 * Design rules
 * ------------
 * - It never kills anything. It reports and refuses; the caller decides.
 * - Thresholds are explicit, in GB, and can be overridden per call.
 * - A busy CPU counts as pressure too: the failure mode is "everything slows to a
 *   crawl and a watchdog gives up", not only "allocation fails".
 * - Cheap to run: one PowerShell query for memory + CPU, one for the top consumers.
 */

import os from 'node:os'
import { probeResources as probeRaw } from './core.mjs'

/** Default headroom, in GB, that must stay free before heavy work may start. */
export const DEFAULT_FLOOR_GB = {
  // Free physical memory that must remain available.
  free: 3.5,
  // Above this total CPU load, treat the machine as busy even if memory is free.
  cpu: 85,
}

/** Processes that are protected: pressure must never be resolved by stopping these. */
export const PROTECTED = [
  // The daemon runs as `python ... hindsight_api ... --port 9077`; the hyphenated form comes
  // from the package name and the underscore form from the module, so both must match.
  { match: /hindsight[-_]api/i, why: 'memory daemon (port 9077)' },
  { match: /postgres/i, why: 'embedded database (port 5432)' },
  { match: /volcano-separator/i, why: 'this watchdog' },
]

/**
 * Query memory, CPU and the largest processes.
 *
 * Returns GB for readability, matching how the thresholds are written. On a host
 * without PowerShell (or on any failure) `ok` is false and the caller should treat
 * the state as unknown rather than as free.
 */
// The raw probe lives in core.mjs, next to the other probes. This layer adds the policy:
// thresholds, the protected set and the go/defer verdict.
export { probeResources } from './core.mjs'

/** Which of the protected processes are currently among the top consumers. */
export function protectedAmong(res, protectedList = PROTECTED) {
  const hits = []
  for (const p of res.top ?? []) {
    // Match the image name first, then the command line: that is the only way to spot the
    // embedded service, which runs as a generic interpreter process.
    const haystacks = [p.name ?? '', p.cmd ?? '']
    for (const rule of protectedList) {
      if (haystacks.some((h) => rule.match.test(h))) {
        hits.push({ ...p, why: rule.why })
        break
      }
    }
  }
  return hits
}

/**
 * Decide whether heavy work may start.
 *
 * `free` and `cpu` may be overridden, which is how a specific job declares its own
 * appetite (a 2 GB tool needs a different floor than a 200 MB one).
 */
export function decideDefer(res, { free = DEFAULT_FLOOR_GB.free, cpu = DEFAULT_FLOOR_GB.cpu } = {}) {
  if (!res.ok) {
    return { defer: true, reason: 'resource state unknown', free, cpu, worst: null }
  }
  const worst = (res.top ?? [])[0] ?? null
  if (res.freeGB < free) {
    return {
      defer: true,
      reason: `free memory ${res.freeGB} GB is below the floor of ${free} GB`,
      free,
      cpu,
      freeGB: res.freeGB,
      worst,
      held: protectedAmong(res),
    }
  }
  if (res.cpu >= cpu) {
    return {
      defer: true,
      reason: `CPU load ${res.cpu}% is at or above the ${cpu}% ceiling`,
      free,
      cpu,
      freeGB: res.freeGB,
      worst,
      held: protectedAmong(res),
    }
  }
  return {
    defer: false,
    reason: `headroom ok: ${res.freeGB} GB free, CPU ${res.cpu}%`,
    free,
    cpu,
    freeGB: res.freeGB,
    worst,
    held: protectedAmong(res),
  }
}

/**
 * Wait until heavy work is allowed, or until `maxWaitMs` elapses.
 *
 * This is the piece the batch jobs call before each unit of work, so that a long run
 * yields to the daemon instead of racing it. Returns the final decision.
 */
export async function waitForHeadroom(opts = {}) {
  const { free = DEFAULT_FLOOR_GB.free, cpu = DEFAULT_FLOOR_GB.cpu, pollMs = 20000,
          maxWaitMs = 15 * 60 * 1000, log = () => {}, probe = probeRaw } = opts
  const started = Date.now()
  let decision
  for (;;) {
    const res = await probe({})
    decision = decideDefer(res, { free, cpu })
    if (!decision.defer) return decision
    log(`waiting: ${decision.reason}`)
    if (Date.now() - started + pollMs > maxWaitMs) {
      return { ...decision, timedOut: true, waitedMs: Date.now() - started }
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

/** One-line summary for the status view. */
export function summarizeResources(res, decision = null) {
  if (!res.ok) return `unavailable (${res.error})`
  const held = protectedAmong(res)
  const parts = [`${res.freeGB} GB free of ${res.totalGB} GB`, `CPU ${res.cpu}%`]
  if (res.top?.length) parts.push(`largest: ${res.top[0].name} ${res.top[0].mb} MB`)
  if (held.length) parts.push(`protected in top: ${held.map((h) => h.name).join(', ')}`)
  if (decision) parts.push(decision.defer ? `DEFER (${decision.reason})` : 'headroom ok')
  return parts.join(' | ')
}
