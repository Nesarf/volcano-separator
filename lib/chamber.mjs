import { existsSync, rmSync, writeFileSync } from 'node:fs'
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

  // A pid number is not an identity, and the record is full of events from earlier processes that
  // held the same number. Splitting them is the whole point: without this, "its history" means "the
  // history of this number", and a reader would take another process's activity for this one's.
  //
  // The split is possible because the live half knows when THIS process started. Events before that
  // instant belong to a predecessor, and they are kept -- not dropped, because "this pid number was
  // used before" is a real fact -- but counted and labelled apart.
  const startedAtMs = live.live?.startedAt ? Date.parse(live.live.startedAt) : NaN
  const allEvents = collectEvents(ctx, target, historyDays)
  const isMine = (e) => {
    if (!Number.isFinite(startedAtMs)) return null // unknown, so no claim either way
    const t = Date.parse(String(e.t ?? ''))
    return Number.isFinite(t) ? t >= startedAtMs : null
  }
  const mine = allEvents.filter((e) => isMine(e) === true)
  const earlier = allEvents.filter((e) => isMine(e) === false)
  const undated = allEvents.length - mine.length - earlier.length

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
      // `events` is this process's own, and only those. The predecessors are here too, separately,
      // because a caller that wants "what did this number ever do" and a caller that wants "what has
      // THIS process done" are asking different questions and only one of them is about a process.
      events: mine,
      eventCount: mine.length,
      earlierHolders: earlier,
      earlierHolderCount: earlier.length,
      undatedCount: undated,
      // Null when the start time is unknown, which is a fact rather than a zero.
      identityKnown: Number.isFinite(startedAtMs),
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

/**
 * Open the chamber window for one process.
 *
 * The profile is written to a file first, because the history half is rebuilt on this side -- it is
 * read out of the activity record with the same reader everything else uses, and reimplementing that
 * in PowerShell would be a second copy of it to keep correct. The window collects the live half
 * itself, because that half has to be fresh.
 *
 * **The launch has to be owned by `Start-Process`, and this project has already paid for that
 * lesson.** A detached child of this process still dies with it on Windows, because the harness runs
 * tool calls inside a job object -- `detain`'s window failed exactly that way once: perfect when run
 * by hand, nothing at all through the CLI. Handing it to `Start-Process` removes the parent from the
 * question.
 */
export async function openChamber(ctx, { pid, days = 3, profileFile = null, pixel = false } = {}) {
  const script = chamberScript()
  if (!existsSync(script)) return { ok: false, detail: `the chamber window script is missing: ${script}` }
  if (process.platform !== 'win32') return { ok: false, detail: 'the chamber window is Windows-only' }

  const target = Number(pid)
  if (!Number.isFinite(target) || target <= 0) return { ok: false, detail: 'a pid is required' }

  const profile = profileFile ?? join(tmpdir(), `vsep-chamber-profile-${process.pid}-${target}.json`)
  const p = await processProfile(ctx, target, { historyDays: days })
  try {
    writeFileSync(profile, JSON.stringify(p, null, 1), 'utf8')
  } catch (e) {
    return { ok: false, detail: `could not write the profile the window reads: ${e?.message ?? e}` }
  }

  const quote = (a) => "'" + String(a).replace(/'/g, "''") + "'"
  // `-Pixel` is passed through rather than decided here: the window is the thing that knows whether a
  // bitmap can be produced on this host, and the readable view is the default either way.
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-TargetPid', String(target), '-ProfileFile', profile]
  if (pixel) args.push('-Pixel')
  const launcher = 'Start-Process -FilePath ' + quote(powershellHost()) +
    ' -ArgumentList @(' + args.map(quote).join(',') + ')'
  const launched = await run(powershellHost(), ['-NoProfile', '-Command', launcher], { timeoutMs: 30000 })
  if (!launched.ok) {
    return { ok: false, detail: `could not open the chamber window: ${launched.error ?? 'unknown'}`, profile }
  }
  return {
    ok: true,
    pid: target,
    profile,
    detail: `pid ${target}; the window is read-only and stays open after the process exits, because its history does`,
  }
}

export function chamberAvailable() {
  return existsSync(chamberScript())
}
