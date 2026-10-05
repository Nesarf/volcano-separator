/**
 * volcano-separator · core
 *
 * Decouples the Hindsight memory service from a fragile chain:
 * "uvx builds an env on the spot" + "a host plugin spawns the daemon on demand" + "the daemon process".
 *
 * The evidence (host plugin log, 2026-09-26 -> 09-30): 12 start attempts, 7 of them ended in a
 * 180 s watchdog timeout, and every failure log shows "Downloaded botocore" /
 * "Built claude-agent-sdk==..." on the start path.
 * The essence is **a build racing a watchdog**. So the work is *staged* here, such that no
 * watchdog ever races a build:
 *
 *   warm  -- make the uv env complete. **No watchdog**: it may take minutes and runs to completion.
 *   serve -- start the daemon only when the env is hot. That is now seconds, so it can never time out.
 *   watch -- health probe and repair on demand. Near-zero cost when healthy, so an OS scheduler
 *            can call it every few minutes; no resident supervisor process is needed.
 *
 * Pure Node, zero third-party dependencies.
 */

import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { delimiter, join, resolve } from 'node:path'

// Lifted out so this file can shrink without anything above it changing. None of these
// three depend on the rest of the tool, which is what made them safe to move first.
import { CORE_ROOT, normalizePath, readJsonLoose, run, sleep, sleepSync } from './platform.mjs'
import { activityDir, activityTaskName, activityTaskState, appendToActivity, installActivityTask, probeActivityRecorder, readActivity, summarizeActivity, uninstallActivityTask } from './activity.mjs'
import { REDACTED, exeFromCmd, isSystemRoot, redactCommandLine } from './commandline.mjs'
import { ancestry, liveProcesses, readLogs, reveal } from './live.mjs'

// Public before the split, public after it.
export { ancestry, liveProcesses, readLogs, reveal } from './live.mjs'
import { recordRedline, redlineAreas, scanRedline } from './redline.mjs'

// Public before the split, public after it.
export { recordRedline, redlineAreas, scanRedline } from './redline.mjs'
import { daemonArgs, doctor, ensurePgService, findPluginLogs, findPortOwner, gateHeavyWork, guardCacheOp, heal, installService, killDaemonTree, newLogPath, probeDaemon, probeDaemonLog, probeDshHost, probeEnv, probePort, probePostgres, probeUv, restart, serve, serviceState, status, stop, taskScriptPath, uninstallService, uvFlags, warm } from './supervisor.mjs'

// Public before the split, public after it.
export { daemonArgs, doctor, ensurePgService, findPluginLogs, findPortOwner, gateHeavyWork, guardCacheOp, heal, installService, killDaemonTree, newLogPath, probeDaemon, probeDaemonLog, probeDshHost, probeEnv, probePort, probePostgres, probeUv, restart, serve, serviceState, status, stop, taskScriptPath, uninstallService, uvFlags, warm } from './supervisor.mjs'
import { probeResources } from './resources.mjs'
// Public before the split, public after it. The surface test caught this one missing: the
// import was added and the re-export was not, which is precisely the failure the surface test
// was written for -- a refactor drops an export and every other check still passes.
export { probeResources } from './resources.mjs'
import { analyzeSignals, decideSignals, recordDecisions, readStealth } from './signals.mjs'

// Public before the split, public after it.
export { analyzeSignals, decideSignals, recordDecisions, readStealth } from './signals.mjs'
import { custodyEvents, custodyOrphans, custodyReport, custodyState, custodyTimeline, custodyTimelineLive, detain, humanDuration, probeCustody, readDetainRecords, rebuildCustody, reconcileCustody, scanSuspended, staleCustody, unauthorizedReleases, unrecordedCustody } from './custody.mjs'

// Public before the split, public after it.
export { custodyEvents, custodyOrphans, custodyReport, custodyState, custodyTimeline, custodyTimelineLive, detain, humanDuration, probeCustody, readDetainRecords, rebuildCustody, reconcileCustody, scanSuspended, staleCustody, unauthorizedReleases, unrecordedCustody } from './custody.mjs'

// Public before the split, public after it.
export { REDACTED, redactCommandLine } from './commandline.mjs'

// Re-exported so existing importers of core.mjs keep working.
export { activityDir, activityTaskName, activityTaskState, appendToActivity, installActivityTask, probeActivityRecorder, readActivity, summarizeActivity, uninstallActivityTask } from './activity.mjs'
// Re-exported: `run` is the PowerShell bridge every layer above uses, and it was public.
export { run } from './platform.mjs'
import { POLICY_DEFAULTS, loadPolicy, policyAllows, policyPath, savePolicy } from './policy.mjs'

// Re-exported so every existing importer of core.mjs keeps working: the split must not move the
// public surface, only the file the code lives in.
export { POLICY_DEFAULTS, loadPolicy, policyAllows, policyPath, savePolicy } from './policy.mjs'

// ────────────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────────────

export const DEFAULTS = {
  /** hindsight profile name (drives the .env / .log / database instance names) */
  profile: 'coding-agent',
  /** port the daemon listens on */
  port: 9077,
  /** extra uv packages used for both warm-up and start (the plugin's own command line carries this) */
  withPackages: ['pg0-embedded'],
  /**
   * Safety timeout for the offline env probe. NOT the warm/cold test: that is whether the
   * environment resolves with the network off. If this expires the probe reports undetermined
   * rather than guessing, because a wrong "cold" costs a full warm-up.
   */
  warmProbeMs: 15000,
  /** env budget: how long warm-up may run (this is the "no watchdog" stretch, so be generous) */
  warmBudgetMs: 15 * 60 * 1000,
  /** serve budget: how long to wait for the service (seconds once the env is hot) */
  serveBudgetMs: 5 * 60 * 1000,
  /** Postgres port the daemon talks to (the embedded pg0 instance) */
  pgPort: 5432,
  /** how far back a daemon-log error still counts as "recent" (context window) */
  logWindowMinutes: 30,
  /** errors inside this window mean the service is failing *now* -- this drives health */
  logErrorWindowMinutes: 5,
  /**
   * How much `uv` should say about what it is doing: 0 = off, 1 = `-v`, 2 = `-vv`, 3 = `-vvv`.
   *
   * At 0 a slow start is a mystery: you can see *that* uv took four minutes, never *what* it
   * spent them on. At 1 the transcript names every resolve / download / build step, which is the
   * difference between "it hung" and "it was compiling claude-agent-sdk again".
   */
  uvVerbosity: 1,
  /** Where the full uv transcript is written. null -> <tmpdir>/volcano-separator. */
  logDir: null,
  /** Keep at most this many transcript files (oldest pruned). */
  keepLogs: 20,
  /** Consult the resource layer before heavy work (see gateHeavyWork). */
  resourceGate: true,
  /** How long a gated step will wait for headroom before giving up and deferring. */
  gateWaitMs: 60000,
  /** scheduled task name */
  taskName: 'Volcano-Separator',
  /** scheduled task repetition interval in minutes -- this is the watch heartbeat */
  taskIntervalMinutes: 5,
}

function firstExisting(paths) {
  for (const p of paths) if (p && existsSync(p)) return p
  return null
}

/** Find an executable on PATH (Windows also tries .exe/.cmd; extensionless works in git-bash) */
function which(bin, env = process.env) {
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat', '.ps1'] : ['']
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const p = join(dir, bin + ext)
      try {
        if (statSync(p).isFile()) return p
      } catch {
        /* not there */
      }
    }
  }
  return null
}

// ────────────────────────────────────────────────────────────────────────────
// Context: resolve every path once; every other function only reads this object
// ────────────────────────────────────────────────────────────────────────────

export function resolveContext(cfg = {}) {
  const c = { ...DEFAULTS, ...cfg }
  const home = homedir()
  const hindsightHome = join(home, '.hindsight')

  // The plugin's own config: embedVersion / serverMode / bankId
  let pluginCfg = {}
  const cfgFile = join(hindsightHome, 'coding-agent.json')
  if (existsSync(cfgFile)) {
    try {
      pluginCfg = JSON.parse(readFileSync(cfgFile, 'utf8'))
    } catch {
      /* unreadable config: behave as if absent */
    }
  }
  const embedVersion = c.embedVersion ?? pluginCfg.embedVersion ?? null

  const uvx = c.uvxPath ?? which('uvx') ?? which('uv')
  const uv = c.uvPath ?? which('uv')
  const uvCacheDir =
    c.uvCacheDir ?? process.env.UV_CACHE_DIR ?? firstExisting([join(home, '.cache', 'uv')]) ?? null

  // The cache dir may be a junction (on the machine this came from, the old path on one drive
  // was pointed at an SSD). Report the real target, otherwise the status panel shows a path that
  // looks like it is still on the slow disk.
  let uvCacheReal = uvCacheDir
  let uvCacheRedirected = false
  if (uvCacheDir && existsSync(uvCacheDir)) {
    try {
      const real = realpathSync.native(uvCacheDir)
      if (real.toLowerCase() !== uvCacheDir.toLowerCase()) {
        uvCacheReal = real
        uvCacheRedirected = true
      }
    } catch {
      /* cannot resolve: keep the original path */
    }
  }

  const profileDir = join(hindsightHome, 'profiles')
  const logDir = c.logDir ? resolve(c.logDir) : join(tmpdir(), 'volcano-separator')
  const ctx = {
    ...c,
    logDir,
    embedVersion,
    pluginCfg,
    configFile: cfgFile,
    hindsightHome,
    profileDir,
    profileEnvFile: join(profileDir, `${c.profile}.env`),
    profileLogFile: join(profileDir, `${c.profile}.log`),
    profileLockFile: join(profileDir, `${c.profile}.lock`),
    daemonLogFile: join(hindsightHome, 'daemon.log'),
    uvx,
    uv,
    uvCacheDir,
    uvCacheReal,
    uvCacheRedirected,
    url: `http://127.0.0.1:${c.port}`,
    env: {
      ...process.env,
      ...(uvCacheDir ? { UV_CACHE_DIR: uvCacheDir } : {}),
    },
  }
  return ctx
}

// ────────────────────────────────────────────────────────────────────────────
// Process helpers
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// Probes
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// warm: bring the env up to date. **No watchdog** -- the biggest difference from the plugin.
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// serve: start the service. **Only meaningful once the env is hot** -- which is exactly
// why it can never trip a timeout.
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// heal: intelligent repair. Closes the gaps in warm -> serve -> watch order and reports
// what it is doing at every step.
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// doctor: count historical start failures from the plugin log -- "why did it used to die"
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// status: whole-chain check
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// Guardrail: while the daemon is alive, keep uv from touching its own cache
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// Service integration: hand watch to the OS scheduler; no extra resident process
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// Live view: what is running right now, and what did the last runs do
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// Activity: the system-wide record
// ────────────────────────────────────────────────────────────────────────────

/** Where the activity recorder writes (plain NDJSON, one event per line). */

// ────────────────────────────────────────────────────────────────────────────
// Policy: which stealth is permitted, and what to do about the rest
// ────────────────────────────────────────────────────────────────────────────

/**
 * The policy lives next to the user's other config, not in the temp-backed log dir: it is a
 * decision, not an artifact, and it must survive a cache clean.
 */

// ────────────────────────────────────────────────────────────────────────────
// Reveal: force hidden things into the open
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// Custody: freeze a suspected process and make it impossible for it to hide
// ────────────────────────────────────────────────────────────────────────────

// CORE_ROOT now lives in the platform layer, so there is one definition of it.

// ────────────────────────────────────────────────────────────────────────────
// L1 -- signals: what looks like it does not want to be seen
// ────────────────────────────────────────────────────────────────────────────
//
// This layer only *notices*. It does not suspend, refuse or remove anything, and that is a
// deliberate staging decision rather than an unfinished one: a detector has to be shown to be
// accurate before its findings are allowed to cause an action. Rules that cry wolf get switched
// off, and then they protect nothing.
//
// Every rule here is written to be defensible from the record alone, and every finding carries
// the evidence that produced it plus whether the allowlist already covers it. A finding you
// cannot check is a finding you cannot trust.

// ────────────────────────────────────────────────────────────────────────────
// L2 -- decisions: what each signal means, and what would be done about it
// ────────────────────────────────────────────────────────────────────────────
//
// Still no action. This layer answers "what should happen to this finding" and nothing else, so
// the judgements can be reviewed on real traffic before any of them are allowed to do anything.

// ────────────────────────────────────────────────────────────────────────────
// Resource gate: heavy work yields instead of racing the daemon
// ────────────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────────────
// C: red line -- the disk policy, enforced by a check instead of by memory
// ────────────────────────────────────────────────────────────────────────────
//
// The rule on this machine is that large files, downloads, caches and temp data do not go on C:.
// It was written in a document and enforced by whoever remembered it, which is not enforcement.
// Two real violations were found only by accident, while looking at something else: a uv tool
// environment under AppData\Roaming\uv\tools, and a shim in .local\bin. Both had been there a
// while.
//
// This does not block. Blocking a write needs a filter driver, and pretending otherwise would
// be the same overclaim as calling a port-open check "health". It measures, names what looks
// wrong, and records it.

/**
 * What is under custody right now?
 *
 * `detain` writes a summary next to the activity record when it freezes a process, but nothing
 * read those files, so the question "which processes did we freeze, and are they still frozen?"
 * had no answer. That matters because a suspension is *persistent*: NtSuspendProcess leaves the
 * target frozen until something resumes it, so a detain whose operator forgot about it stays
 * frozen indefinitely and nothing on the machine would say so.
 *
 * So this reads the records and, more importantly, checks each claim against the live system
 * rather than trusting the file. A record is a claim; only the probe is evidence. That is the
 * same rule the rest of this project follows -- verify with the artefact, not with a note about
 * the artefact.
 */

/**
 * Reconcile the records against the live system.
 *
 * Six states, because collapsing them would hide the two that matter: `frozen-orphan` (a
 * process still frozen that nobody released) and `exited` (a record whose process is gone, so
 * the record is only history).
 */

/**
 * Custody, rebuilt from the record that actually survives.
 *
 * The first version of this read the `detain-<pid>.json` summary files. On a real machine those
 * files were **all gone** -- only the append-only activity log still had the evidence -- so a
 * query built on them would have answered "nothing is under custody" while five command shells
 * had been frozen that day. A state file that can vanish is not a state file.
 *
 * The activity log is append-only and by design survives, and it already carries the sequence
 * that matters: `suspended` and `released` events per pid. So the log is the source of truth and
 * a summary file, when present, only adds detail.
 *
 * And a claim in the log is still only a claim: whether a process is frozen *now* is a question
 * for the system. Each reconstructed record is therefore checked against the live thread state,
 * which is what turns "we froze it at 17:43" into "it is frozen now" or "it exited".
 */

/**
 * Custody that nobody came back for.
 *
 * A suspension is persistent, so a freeze whose operator forgot about it stays frozen forever
 * with nothing on the machine saying so. The `detained` command answers the question, but only
 * if somebody thinks to ask it -- and the failure mode is precisely that nobody thinks to.
 *
 * So the heartbeat reconciles and the record speaks up. Two properties this deliberately does
 * NOT have:
 *
 *   * It never resumes anything. Releasing a process somebody deliberately froze is a decision
 *     about their machine, and this tool reports rather than decides. The alert names the exact
 *     command to run instead.
 *   * It does not depend on the service. The activity recorder's contract is that visibility is
 *     not a function of service health, and an alerting path that went quiet whenever the daemon
 *     was down would break exactly that contract.
 */

/**
 * Custody we did not create.
 *
 * Everything up to now reconciled the freezes *this tool* performed: the log says suspended, and
 * the probe says whether that still holds. That covers one half of the problem and misses a
 * different one entirely -- a process that is frozen right now with **no record of anybody
 * freezing it**. Those are not the same situation and must not be averaged together:
 *
 *   recorded + still frozen   -> our custody, waiting on a decision
 *   recorded + running        -> somebody released it; a release path was bypassed
 *   NOT recorded + frozen     -> somebody or something else froze it, and nothing here knows why
 *
 * The third is the interesting one precisely because it is invisible: `detained` enumerates the
 * record, so anything absent from the record cannot appear in it. Answering it needs the
 * opposite direction -- walk the machine, then subtract.
 *
 * Read-only, and it resumes nothing. An unrecorded freeze might be a debugger, a backup tool, a
 * hung driver, or something that should worry the operator; that is their call, not ours.
 */

/**
 * Custody that somebody else ended.
 *
 * The reconciliation so far watches two things: a freeze nobody came back for, and a freeze that
 * nothing recorded. There is a third, and it is the most informative of the three -- a process
 * this tool froze that is **running again**, with no release through our own path. Something else
 * resumed it: an operator, another tool, or whatever else has hands on the machine.
 *
 * That is an event rather than a state. A process resumed once should be said once, not once per
 * heartbeat, and if the same pid is detained again and released again that is a second event
 * worth reporting. So the record is checked for a release notice that is newer than the freeze it
 * followed, and only then is a new one written.
 */

/**
 * The life of a custody decision, from freeze to whatever ended it.
 *
 * The events are all in the record already -- suspended, revealed, released, failed, and the two
 * notice kinds -- but they are scattered through an append-only log alongside fifty thousand
 * unrelated process events. Reconstructing what happened to one pid means grepping for a number
 * and reading timestamps, which is exactly the kind of work a tool should do instead of asking a
 * person to.
 *
 * So this groups the custody events into lifecycles: one per freeze. A pid can have several,
 * because a process released and detained again is a second decision rather than a continuation
 * of the first, and collapsing them would hide that.
 *
 * Read-only. It reads the record and reports; it does not probe, resume or clean anything, so it
 * is a truthful account of what was recorded even on a machine where the processes are long gone.
 */

