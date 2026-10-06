import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { CORE_ROOT, powershellHost, readJsonLoose, run } from './platform.mjs'
import { custodyTimeline } from './custody.mjs'
import { redactCommandLine } from './commandline.mjs'
import { readActivity } from './activity.mjs'

/**
 * The chamber: everything this tool can honestly say about one process, in one place.
 *
 * What this is not
 * ----------------
 * It is not a way to make a process show itself. This tool does not inject, and that is the invariant
 * `detain` already states: **a process that never created a window cannot be made to produce one.**
 * "Extracting visualisation" from such a process yields nothing, and a version that claimed to would
 * be the same class of false signal this project exists to remove.
 *
 * So the honest capability is *put it where it is observed*: the window belongs to this tool, the
 * target cannot close it or hide from it, and the target does not have to cooperate with it.
 *
 * What the profile carries, and where each half comes from
 * -------------------------------------------------------
 *   live      threads, handles, working set, CPU, its own windows *including hidden ones*, TCP
 *             connections, and the modules it has loaded -- read now, so it changes as the process
 *             does. This is what "activity" means for a process, as opposed to what it feels like.
 *   history   every event this pid has emitted, its inherited chain, and what has already been done
 *             to it -- rebuilt from the append-only record, so it survives the process being gone.
 *
 * The second half is the one that makes the uncooperative case honest rather than empty. A windowless
 * daemon has nothing to reveal and still has a great deal that is true about it, and most of that is
 * already on disk by the time anyone asks.
 */

/**
 * Live facts about one process, or a refusal that says whether it is gone.
 *
 * Two transports were tried and one failed: an inline `-Command` script returned JSON that could not be
 * parsed, because a running process has hundreds of loaded modules and dozens of connections and the
 * pipeline truncated it. That looked like a probe bug and was a transport limit. The script is
 * `bin/procinfo.ps1` now and its answer arrives through a file, which is this project's convention for
 * anything carrying paths, quotes or bulk.
 */
export async function probeProcess(ctx, pid, { tier = 'all' } = {}) {
  const target = Number(pid)
  if (!Number.isFinite(target) || target <= 0) return { ok: false, detail: 'a pid is required' }
  const script = join(CORE_ROOT, 'bin', 'procinfo.ps1')
  if (!existsSync(script)) return { ok: false, pid: target, detail: `process probe script missing: ${script}` }

  // The tier is part of the file name, so two tiers asked for at once cannot overwrite each other's
  // answer. Cheap to do, and the alternative is a race that shows up as a field from the wrong tier.
  const outFile = join(tmpdir(), `vsep-procinfo-${process.pid}-${target}-${tier}.json`)
  rmSync(outFile, { force: true })

  const r = await run(powershellHost(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-TargetPid', String(target), '-Tier', tier, '-OutFile', outFile], { timeoutMs: 90000 })

  let data = null
  try {
    data = readJsonLoose(outFile)
  } catch {
    data = null
  } finally {
    rmSync(outFile, { force: true })
  }
  if (!data) {
    return { ok: false, pid: target, tier, detail: r.error ?? `the process probe wrote no readable answer (exit ${r.code ?? '?'})` }
  }
  data.path = redactCommandLine(String(data.path ?? ''))
  // An absent process is a fact, not a failure: a caller asking about a pid that is gone has an
  // answer, and reporting it as an error would make "it exited" look like "the probe broke".
  return { ok: true, pid: target, exists: Boolean(data.exists), live: data }
}

/**
 * One process, live and historical, as one object.
 *
 * The two halves are deliberately not merged into a single list. A live fact is true now and will be
 * different in a second; a historical fact happened and cannot change. Flattening them would make the
 * combined view look uniform and mean two different things in one column.
 */
export async function processProfile(ctx, pid, { historyDays = 3 } = {}) {
  const target = Number(pid)
  const live = await probeProcess(ctx, target)
  const t = custodyTimeline(ctx, { days: historyDays })
  const lifecycles = (t.lifecycles ?? []).filter((l) => Number(l.pid) === target)

  // Every event this pid ever produced, from the record: the half that survives the process.
  const events = collectEvents(ctx, target, historyDays)

  return {
    ok: live.ok,
    pid: target,
    // Whether a process has a window is a fact. Whether it "cooperates" would be a judgement, and
    // nothing here can make one -- so the profile reports the fact and lets the reader judge.
    hasWindow: live.live?.hasWindow ?? null,
    live: live.live ?? null,
    liveDetail: live.detail ?? null,
    history: {
      days: historyDays,
      lifecycles,
      events,
      eventCount: events.length,
      everDetained: lifecycles.length > 0,
    },
  }
}

/**
 * The events the record holds for one pid.
 *
 * Read from the same append-only file everything else reads. The filter is on the pid field, so an
 * event that does not carry one -- a baseline, a watcher start -- is not attributed to any process,
 * which is the correct answer rather than a near miss.
 */
export function collectEvents(ctx, pid, days = 3) {
  const a = readActivity(ctx, { limit: 500000, files: Math.max(2, days) })
  return (a.events ?? []).filter((e) => Number(e.pid) === Number(pid))
}

/** Is the chamber's own window host present? */
export function chamberScript() {
  return join(CORE_ROOT, 'bin', 'chamber.ps1')
}

export function chamberAvailable() {
  return existsSync(chamberScript())
}
