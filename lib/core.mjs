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

/**
 * The processes that make up the stack, with their age.
 *
 * Age is the point: a `uvx` that has been alive for four minutes is either working hard or
 * wedged, and without the timestamp there is no way to tell those apart.
 */
export async function liveProcesses(ctx) {
  const ps = `
$names = @('uvx.exe','uv.exe','hindsight-api.exe','postgres.exe','wscript.exe','cmd.exe')
Get-CimInstance Win32_Process -Filter "Name='uvx.exe' or Name='uv.exe' or Name='hindsight-api.exe' or Name='postgres.exe'" |
  Select-Object ProcessId,ParentProcessId,Name,CreationDate,@{n='cmd';e={$_.CommandLine}} |
  Sort-Object CreationDate |
  ForEach-Object {
    $age = [math]::Round(((Get-Date) - $_.CreationDate).TotalSeconds, 1)
    "{0}|{1}|{2}|{3}|{4}" -f $_.ProcessId, $_.Name, $age, $_.ParentProcessId, ($_.cmd -replace "[\r\n]+",' ')
  }
`.trim()
  const r = await run('powershell', ['-NoProfile', '-Command', ps], { timeoutMs: 30000 })
  const rows = []
  for (const line of (r.stdout ?? '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || !t.includes('|')) continue
    const [pid, name, age, ppid, ...rest] = t.split('|')
    let cmd = rest.join('|')
    // Only keep processes that belong to this stack; a bare cmd.exe from anywhere else is noise.
    if (!/uvx|uv\.exe|hindsight|postgres|pg_ctl|daemon|embed/i.test(cmd)) continue
    if (cmd.length > 130) cmd = cmd.slice(0, 130) + '...'
    rows.push({ pid: Number(pid), name, ageSeconds: Number(age), parentPid: Number(ppid), cmd })
  }
  return rows
}

/** The newest transcripts plus the heartbeat trail. */
export function readLogs(ctx, { limit = 3, tailLines = 25 } = {}) {
  const dir = ctx.logDir
  const out = { dir, transcripts: [], heartbeat: null }
  let files = []
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs, size: statSync(join(dir, f)).size }))
      .sort((a, b) => b.t - a.t)
  } catch {
    return out
  }
  for (const entry of files.filter((f) => f.f !== 'heartbeat.log').slice(0, limit)) {
    let text = ''
    try {
      text = readFileSync(join(dir, entry.f), 'utf8')
    } catch {
      /* ignore */
    }
    const lines = text.split(/\r?\n/)
    out.transcripts.push({
      file: join(dir, entry.f),
      name: entry.f,
      size: entry.size,
      modified: new Date(entry.t).toISOString(),
      tail: lines.slice(-tailLines).join('\n'),
    })
  }
  const hb = join(dir, 'heartbeat.log')
  if (existsSync(hb)) {
    let text = ''
    try {
      text = readFileSync(hb, 'utf8')
    } catch {
      /* ignore */
    }
    const lines = text.trim().split(/\r?\n/)
    out.heartbeat = { file: hb, lines: lines.slice(-tailLines) }
  }
  return out
}

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

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Force hidden windows visible, and expose what a live process is actually doing.
 *
 * Honest limits, stated here so the caller does not over-trust it:
 *   * `show` reveals a window that EXISTS but is hidden. A process that never created a window
 *     cannot be given one without injecting code into it, which this tool does not do.
 *   * Everything else is read-only observation: command line, owner, modules, connections,
 *     windows. Nothing is written into the target process.
 */
export async function reveal(ctx, { mode = 'windows', pid = 0, filter = '', show = false, includeInvisible = false } = {}) {
  const script = join(PROJECT_ROOT, 'bin', 'reveal.ps1')
  if (!existsSync(script)) return { ok: false, detail: `reveal script missing: ${script}` }

  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Mode', mode]
  if (pid > 0) args.push('-TargetPid', String(pid))
  if (filter) args.push('-Filter', filter)
  if (show) args.push('-Show')
  if (includeInvisible) args.push('-IncludeInvisible')

  const r = await run('powershell', args, { timeoutMs: 90000 })
  const text = (r.stdout ?? '').trim()
  if (!text) return { ok: false, detail: r.error ?? 'no output', stderr: (r.stderr ?? '').slice(-500) }
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, detail: 'could not parse reveal output', raw: text.slice(-800) }
  }
  return { ok: true, mode, data, ms: r.ms }
}

/**
 * The inherited chain, with history.
 *
 * A parent that has already exited cannot be asked anything -- WMI only knows live processes.
 * The activity record can, because it captured the parent when it was alive. So the chain is
 * built from two sources: the live tree, then the record for whatever is no longer running.
 */
export function ancestry(ctx, pid, { maxDepth = 12 } = {}) {
  const a = readActivity(ctx, { limit: 100000, files: 5 })
  const byPid = new Map()
  for (const e of a.events) {
    if (e.kind !== 'proc-start') continue
    // Last write wins: a pid can be reused, and the newest start is the one that matters.
    byPid.set(Number(e.pid), e)
  }
  const chain = []
  let cur = Number(pid)
  const seen = new Set()
  for (let i = 0; i < maxDepth && cur && !seen.has(cur); i++) {
    seen.add(cur)
    const rec = byPid.get(cur)
    if (!rec) break
    chain.push({
      pid: rec.pid,
      ppid: rec.ppid,
      name: rec.name,
      // Records written before redaction existed still carry whatever the command line held, so
      // the value is redacted again on the way out. The write point is the real defence; this
      // covers the archive behind it.
      cmd: redactCommandLine(rec.cmd),
      user: rec.user,
      started: rec.t,
    })
    cur = Number(rec.ppid)
  }
  return { pid: Number(pid), depth: chain.length, chain, source: a.dir, recorded: byPid.size }
}

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

/** The places a user can write to without elevation, and where the rule is most often broken. */
export function redlineAreas() {
  const home = homedir()
  return [
    { key: 'AppData\Local', dir: join(home, 'AppData', 'Local') },
    { key: 'AppData\Roaming', dir: join(home, 'AppData', 'Roaming') },
    { key: 'Downloads', dir: join(home, 'Downloads') },
    { key: 'Desktop', dir: join(home, 'Desktop') },
    { key: 'Documents', dir: join(home, 'Documents') },
    { key: 'Windows\Temp', dir: join(process.env.SystemRoot ?? 'C:\Windows', 'Temp') },
  ]
}

/** Names that mean "this is a cache/download/temp", used only to raise a flag, never to conclude. */
const REDLINE_HINTS = /(^|[^a-z])(cache|temp|tmp|downloads?|\.cache|npm-cache|pip|uv|gradle|nuget|hf|huggingface)([^a-z]|$)/i

/**
 * Measure what is sitting on C: under the user-writable roots.
 *
 * Walks sequentially and reports honestly when it stops early: a truncated total presented as a
 * total is the mistake the disk census made, and repeating it here would be careless. Reparse
 * points are not followed -- a junction is a link, not content, and its bytes are already
 * counted where they actually live.
 */
export async function scanRedline(ctx, { budgetMs = 45000, top = 20 } = {}) {
  const started = Date.now()
  const deadline = started + Math.max(3000, budgetMs)
  const areas = redlineAreas()
  const items = []
  const perArea = {}
  const limits = []
  let files = 0
  let bytes = 0
  let truncated = false

  for (const area of areas) {
    if (!existsSync(area.dir)) continue
    let areaBytes = 0
    let areaFiles = 0

    // Breadth-first from the area root so that one deep subtree cannot starve everything else --
    // exactly what happened to the temp bucket in the disk census.
    const queue = [{ dir: area.dir, depth: 0 }]
    const top1 = []
    while (queue.length) {
      if (Date.now() > deadline) {
        truncated = true
        if (!limits.includes('time')) limits.push('time')
        break
      }
      const { dir, depth } = queue.shift()
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const ent of entries) {
        const full = join(dir, ent.name)
        if (ent.isDirectory()) {
          if (depth < 40) queue.push({ dir: full, depth: depth + 1 })
        } else if (ent.isFile()) {
          files++
          areaFiles++
          let size = 0
          try {
            size = statSync(full).size
          } catch {
            /* skip */
          }
          bytes += size
          areaBytes += size
          top1.push({ path: full, size })
        }
      }
    }
    top1.sort((x, y) => y.size - x.size)
    perArea[area.key] = { bytes: areaBytes, files: areaFiles }
    for (const t of top1.slice(0, top)) items.push({ ...t, area: area.key })
    if (truncated) break
  }

  items.sort((x, y) => y.size - x.size)
  const flagged = items
    .filter((i) => REDLINE_HINTS.test(i.path))
    .slice(0, top)
    .map((i) => ({ ...i, why: 'name suggests a cache, download or temporary data under a user-writable root on C:' }))

  return {
    ok: true,
    areas: perArea,
    files,
    bytes,
    gb: Number((bytes / 1024 ** 3).toFixed(2)),
    truncated,
    limits,
    ms: Date.now() - started,
    top: items.slice(0, top),
    flagged,
    detail: truncated
      ? `walked ${files} files (${(bytes / 1024 ** 3).toFixed(2)} GB) before the ${Math.round(budgetMs / 1000)} s budget ran out -- the totals are a floor, not a total`
      : `walked ${files} files, ${(bytes / 1024 ** 3).toFixed(2)} GB`,
  }
}

/** Keep the red-line findings in the record, so they outlive the terminal that printed them. */
export function recordRedline(ctx, scan) {
  if (!scan?.flagged?.length) return { ok: true, written: 0 }
  const file = join(activityDir(ctx), `redline-${new Date().toISOString().slice(0, 10)}.ndjson`)
  const seen = new Set()
  try {
    for (const line of readFileSync(file, 'utf8').split(String.fromCharCode(10))) {
      const t = line.trim()
      if (!t) continue
      try {
        const e = JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t)
        seen.add(e.path)
      } catch {
        /* half-written line */
      }
    }
  } catch {
    /* first run */
  }
  let written = 0
  for (const f of scan.flagged) {
    if (seen.has(f.path)) continue
    try {
      appendFileSync(file, JSON.stringify({
        t: new Date().toISOString(),
        kind: 'redline',
        path: f.path,
        size: f.size,
        area: f.area,
        why: f.why,
        action: 'needs-decision',
      }) + String.fromCharCode(10))
      written++
    } catch {
      /* bookkeeping must not break the report */
    }
  }
  return { ok: true, file, written }
}

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

