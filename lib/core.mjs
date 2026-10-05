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

/** Where the plugin keeps its diagnostics: <tmpdir>/hindsight-<profile|harness>/plugin.log */
export function findPluginLogs(ctx) {
  const out = []
  for (const base of [tmpdir(), join(homedir(), 'AppData', 'Local', 'Temp')]) {
    let names = []
    try {
      names = readdirSync(base)
    } catch {
      continue
    }
    for (const n of names) {
      if (!n.startsWith('hindsight-')) continue
      const p = join(base, n, 'plugin.log')
      if (existsSync(p)) out.push(p)
    }
  }
  return out
}

// ────────────────────────────────────────────────────────────────────────────
// Process helpers
// ────────────────────────────────────────────────────────────────────────────


/** A fresh transcript path under ctx.logDir, pruning the oldest so the directory cannot grow forever. */
export function newLogPath(ctx, label) {
  const dir = ctx.logDir ?? join(tmpdir(), 'volcano-separator')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* ignore */
  }
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const old of files.slice(Math.max(1, ctx.keepLogs ?? 20) - 1)) {
      try {
        rmSync(join(dir, old.f), { force: true })
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return join(dir, `${stamp}-${label}.log`)
}

/**
 * Global flags for every `uv`/`uvx` invocation.
 * `--no-progress` because progress bars are noise once the output goes to a file, and `--color
 * never` so the transcript is readable in any viewer.
 */
export function uvFlags(ctx) {
  const n = Math.max(0, Math.min(3, Number(ctx.uvVerbosity ?? 0)))
  const flags = []
  if (n > 0) flags.push('-' + 'v'.repeat(n))
  flags.push('--no-progress', '--color', 'never')
  return flags
}

// ────────────────────────────────────────────────────────────────────────────
// Probes
// ────────────────────────────────────────────────────────────────────────────

/** Is the uv toolchain there? This is the first link of the chain, and the only real single point of failure. */
export async function probeUv(ctx) {
  if (!ctx.uvx) {
    return { ok: false, what: 'uvx', detail: 'uvx/uv not found on PATH -- the first link of the chain is broken' }
  }
  const r = await run(ctx.uvx, ['--version'], { timeoutMs: 20000 })
  return {
    ok: r.ok,
    what: 'uvx',
    path: ctx.uvx,
    version: (r.stdout + r.stderr).trim().split('\n')[0] || null,
    detail: r.ok ? 'ready' : `cannot run: ${r.error}`,
  }
}

/** Is the daemon listening? The cheapest possible probe: one TCP connection. */
export function probePort(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port })
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      try {
        sock.destroy()
      } catch {
        /* ignore */
      }
      resolve(ok)
    }
    sock.setTimeout(timeoutMs)
    sock.on('connect', () => finish(true))
    sock.on('timeout', () => finish(false))
    sock.on('error', () => finish(false))
  })
}

/** Service health: port plus an HTTP probe */
export async function probeDaemon(ctx) {
  const port = await probePort(ctx.port)
  if (!port) return { ok: false, listening: false, alive: false, http: null, detail: `nothing listening on port ${ctx.port}` }

  // Two different questions, and conflating them is how a dead service stays "healthy":
  //   /health       readiness -- gated on the database, 503 when the database is unreachable
  //   /health/live  liveness  -- the process answered, no database involved
  // The port being open answers neither. `ok` therefore follows readiness, and `alive` is kept
  // separately so a caller can tell "process up but not working" from "process gone".
  const get = async (path) => {
    try {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 5000)
      const res = await fetch(`${ctx.url}${path}`, { signal: ctl.signal }).catch(() => null)
      clearTimeout(t)
      return res ? res.status : null
    } catch {
      return null
    }
  }

  const http = await get('/health')
  const live = await get('/health/live')

  const alive = live === 200 || http === 200
  const ok = http === 200

  const detail = http === 200
    ? `port ${ctx.port} is listening and ready (/health -> 200)`
    : http === null
      ? `port ${ctx.port} is open but /health did not answer`
      : alive
        ? `NOT READY: /health -> ${http} while /health/live -> ${live} -- the process is up but its database is not usable`
        : `NOT HEALTHY: /health -> ${http}, /health/live -> ${live}`

  return { ok, listening: true, alive, http, live, detail }
}

/**
 * The daemon's own log, scanned for recent errors.
 *
 * Why this exists: a daemon can keep answering on its port while being unable to reach its
 * database. On the machine this was extracted from, a saturated disk made the daemon's Postgres
 * handshake time out 48 times -- the port stayed green throughout, so a port-only check reported
 * "healthy" while every write stalled. **Up is not the same as working.**
 *
 * Two windows, deliberately: `ok` reflects only the *fresh* window (is it failing right now?),
 * while the longer window is reported for context. An incident that has already recovered must
 * not keep the whole chain marked unhealthy, or the signal becomes noise.
 */
export async function probeDaemonLog(ctx, { windowMinutes, freshMinutes } = {}) {
  const win = windowMinutes ?? ctx.logWindowMinutes ?? 30
  const freshWin = freshMinutes ?? ctx.logErrorWindowMinutes ?? 5
  if (!existsSync(ctx.profileLogFile)) {
    return { ok: true, available: false, fresh: 0, count: 0, errors: [], detail: 'no daemon log yet' }
  }

  // Tail only: these logs rotate at ~100 MB, and a full read would be both slow and pointless.
  let text = ''
  try {
    const size = statSync(ctx.profileLogFile).size
    const start = Math.max(0, size - 4 * 1024 * 1024)
    const fd = openSync(ctx.profileLogFile, 'r')
    try {
      const buf = Buffer.alloc(size - start)
      readSync(fd, buf, 0, buf.length, start)
      text = buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return { ok: true, available: false, fresh: 0, count: 0, errors: [], detail: 'daemon log unreadable' }
  }

  const now = Date.now()
  const cutoff = now - win * 60 * 1000
  const freshCutoff = now - freshWin * 60 * 1000
  const PATTERNS = [
    { kind: 'db-timeout', re: /^(TimeoutError|asyncpg|.*_create_ssl_connection|.*connect_utils)/ },
    { kind: 'refused', re: /(ConnectionRefused|ECONNREFUSED|connection refused)/i },
    { kind: 'error', re: /^(Error|Exception|Traceback)/ },
  ]

  const errors = []
  let lastTs = null
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/.exec(line)
    if (m) {
      lastTs = m[1]
      continue
    }
    const t = line.trim()
    if (!t) continue
    for (const p of PATTERNS) {
      if (p.re.test(t)) {
        const ms = lastTs ? Date.parse(lastTs.replace(' ', 'T')) : NaN
        if (Number.isFinite(ms) && ms >= cutoff) errors.push({ ts: lastTs, ms, kind: p.kind, line: t.slice(0, 160) })
        break
      }
    }
  }

  const fresh = errors.filter((e) => e.ms >= freshCutoff)
  const counts = errors.reduce((a, e) => ((a[e.kind] = (a[e.kind] ?? 0) + 1), a), {})
  const summary = Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(', ')
  const detail = fresh.length
    ? `${fresh.length} error line(s) in the last ${freshWin} min -- the service is up but failing`
    : errors.length
      ? `quiet for ${freshWin} min; ${errors.length} error line(s) earlier in the ${win} min window (recovered)`
      : `no errors in the last ${win} min`

  return {
    ok: fresh.length === 0,
    available: true,
    windowMinutes: win,
    freshMinutes: freshWin,
    fresh: fresh.length,
    count: errors.length,
    counts,
    errors: errors.slice(-20).map(({ ms, ...rest }) => rest),
    detail,
  }
}

/** Is Postgres reachable, and does the embedded instance exist on disk? */
export async function probePostgres(ctx) {
  const listening = await new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port: ctx.pgPort })
    let done = false
    const fin = (v) => {
      if (done) return
      done = true
      try {
        sock.destroy()
      } catch {
        /* ignore */
      }
      resolve(v)
    }
    sock.setTimeout(1500)
    sock.on('connect', () => fin(true))
    sock.on('timeout', () => fin(false))
    sock.on('error', () => fin(false))
  })

  const dataDir = join(homedir(), '.pg0', 'instances', `hindsight-embed-${ctx.profile}`, 'data')
  const hasData = existsSync(dataDir)
  return {
    ok: listening && hasData,
    listening,
    dataDir,
    hasData,
    port: ctx.pgPort,
    detail: !listening
      ? `nothing listening on 127.0.0.1:${ctx.pgPort}`
      : !hasData
        ? `listening on ${ctx.pgPort}, but no data dir at ${dataDir}`
        : `listening on ${ctx.pgPort}, data at ${dataDir}`,
  }
}

/**
 * Is a DeepSeek Harness host running?
 *
 * The memory service only matters while the thing that consumes it exists. Gating the heartbeat
 * on this is what makes "does not start at boot" actually true: without the gate, a 5-minute
 * heartbeat would simply start the daemon shortly after every boot -- which is exactly the
 * auto-start we are trying to avoid.
 *
 * Fails safe: if the check itself cannot run, report "running" so we heal rather than skip.
 */
export async function probeDshHost(ctx) {
  const ps = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'deepseek-ai[\\\\/]dsh|dsh[\\\\/]lib[\\\\/]bin\\.js' } | Select-Object -First 1 -ExpandProperty ProcessId`
  const r = await run('powershell', ['-NoProfile', '-Command', ps], { timeoutMs: 20000 })
  if (!r.ok) {
    return { ok: false, running: true, detail: `could not check for a DSH host (${r.error}); assuming present` }
  }
  const pid = Number((r.stdout ?? '').trim())
  return Number.isFinite(pid) && pid > 0
    ? { ok: true, running: true, pid, detail: `DSH host is running (pid ${pid})` }
    : { ok: true, running: false, detail: 'no DSH host running' }
}

/**
 * Is the env hot? Dry-run uvx once and see whether it is downloading/building right now.
 * Hot = returns in seconds; cold = stalls or takes minutes. The timeout here is only for
 * *probing*; once "cold" is decided, warm() completes the work with no watchdog at all.
 */
export async function probeEnv(ctx) {
  if (!ctx.uvx) return { ok: false, warm: false, known: true, detail: 'no uvx' }

  // Warmth is a question about completeness, not about speed, and the probe now asks it that way.
  //
  // It used to run a plain `uvx ... --help` and call the environment warm if that returned inside
  // warmProbeMs (15 s). Two things were wrong with that. A warm environment on a loaded machine --
  // busy disk, busy CPU -- takes longer than 15 s and was reported cold, and every "cold" verdict
  // leads to a full warm-up: the measurement was producing the work it exists to avoid. Worse, on a
  // genuinely cold environment the probe itself began downloading and was then killed at the
  // timeout, leaving a half-populated cache and paying part of the cost on every single call.
  //
  // `--offline` fixes both by changing what is being asked. Resolving without the network either
  // succeeds, which proves the environment is complete locally, or fails immediately, which proves
  // it is not -- and it can never download, so the probe cannot leave a partial cache behind or
  // mask a cold environment by quietly filling it. Elapsed time is now reported as context and no
  // longer decides anything.
  const args = [...uvFlags(ctx), '--offline', '--with', ...ctx.withPackages, `hindsight-embed@${ctx.embedVersion}`, '--help']
  const r = await run(ctx.uvx, args, { timeoutMs: ctx.warmProbeMs, env: ctx.env })

  if (r.timedOut) {
    // Not an answer. Saying "cold" here would be guessing, and the guess costs a full warm-up --
    // so this is reported as undetermined and the caller decides what to do about that.
    return {
      ok: true,
      warm: false,
      known: false,
      ms: r.ms,
      detail: `could not determine within ${ctx.warmProbeMs} ms -- the environment may be warm on a busy machine, or genuinely cold`,
    }
  }
  if (!r.ok) {
    // Prefer the line that says what is wrong. The last non-empty line of a uv failure is often
    // the tail of a wrapped sentence -- "unsatisfiable." on its own tells a reader nothing.
    const lines = (r.stderr ?? '').split(String.fromCharCode(10)).map((s) => s.trim()).filter(Boolean)
    const why = (lines.find((l) => l.includes('╰─▶')) ?? lines.find((l) => l.startsWith('×')) ?? lines.slice(-1)[0] ?? r.error)
      .replace(/^[╰─▶×│└├\s]+/, '')
    return {
      ok: true,
      warm: false,
      known: true,
      ms: r.ms,
      detail: `env is cold: it cannot be resolved without the network (${String(why).slice(0, 160)})`,
      stderr: (r.stderr ?? '').slice(-800),
    }
  }
  return { ok: true, warm: true, known: true, ms: r.ms, detail: `env is warm (resolved offline in ${r.ms} ms)` }
}

// ────────────────────────────────────────────────────────────────────────────
// warm: bring the env up to date. **No watchdog** -- the biggest difference from the plugin.
// ────────────────────────────────────────────────────────────────────────────

export async function warm(ctx, { force = false, log = () => {} } = {}) {
  if (!ctx.uvx) return { ok: false, step: 'warm', detail: 'no uvx; cannot warm up' }

  if (!force) {
    const probe = await probeEnv(ctx)
    if (probe.warm) {
      log(`env is warm (${probe.ms} ms); skipping warm-up`)
      return { ok: true, step: 'warm', skipped: true, ms: probe.ms, detail: probe.detail }
    }
    // An undetermined probe is not a cold verdict and must not be reported as one. Warming still
    // goes ahead, because the asymmetry is what decides it: a warm-up on an already-warm environment
    // is a no-op, while a skipped warm-up on a cold one is an outage. But the reason is stated, so
    // nobody later reads a warm-up as evidence that the environment was cold.
    log(
      probe.known
        ? `env is cold: ${probe.detail}`
        : `probe could not tell: ${probe.detail} -- warming anyway, because a needless warm-up is a no-op and a skipped one is an outage`,
    )
    // The env is cold, so the uvx run below will actually download and build -- the expensive
    // case, and the one worth asking about first.
    const gate = await gateHeavyWork(ctx, { what: 'warming the uv env', log })
    if (!gate.ok) return { ok: false, deferred: true, step: 'warm', ...gate }
    if (gate.freeGB !== undefined) log(`headroom ok: ${gate.freeGB} GB free, CPU ${gate.cpu}%`)
    log(`warming up (budget ${Math.round(ctx.warmBudgetMs / 1000)} s, no watchdog)...`)
  }

  const args = [...uvFlags(ctx), '--with', ...ctx.withPackages, `hindsight-embed@${ctx.embedVersion}`, '--help']
  const logFile = newLogPath(ctx, 'warm')
  log(`uv transcript -> ${logFile}`)
  const r = await run(ctx.uvx, args, { timeoutMs: ctx.warmBudgetMs, env: ctx.env, logFile })
  const text = (r.stdout + r.stderr).trim()
  const installed = /Installed\s+(\d+)\s+packages?/i.exec(text)

  if (!r.ok) {
    return {
      ok: false,
      step: 'warm',
      ms: r.ms,
      logFile,
      detail: r.timedOut ? `warm-up exceeded its ${Math.round(ctx.warmBudgetMs / 1000)} s budget` : `warm-up failed: ${r.error}`,
      tail: text.slice(-1500),
    }
  }
  return {
    ok: true,
    step: 'warm',
    ms: r.ms,
    logFile,
    detail: installed ? `env ready; installed ${installed[1]} packages this time (${r.ms} ms)` : `env ready (${r.ms} ms)`,
    tail: text.slice(-500),
  }
}

// ────────────────────────────────────────────────────────────────────────────
// serve: start the service. **Only meaningful once the env is hot** -- which is exactly
// why it can never trip a timeout.
// ────────────────────────────────────────────────────────────────────────────

export function daemonArgs(ctx, sub) {
  const args = [...uvFlags(ctx), '--with', ...ctx.withPackages, `hindsight-embed@${ctx.embedVersion}`, 'daemon', '--profile', ctx.profile, sub]
  return args
}

export async function serve(ctx, { log = () => {} } = {}) {
  if (!ctx.uvx) return { ok: false, step: 'serve', detail: 'no uvx' }
  const health = await probeDaemon(ctx)
  if (health.ok) {
    log(`service already running (${health.detail}); skipping start`)
    return { ok: true, step: 'serve', skipped: true, detail: health.detail }
  }
  // Starting the daemon costs memory. Doing it into an already-tight machine is how you get a
  // daemon that comes up and is then killed, which reads afterwards like a crash.
  const svcGate = await gateHeavyWork(ctx, { what: 'starting the daemon', log })
  if (!svcGate.ok) return { ok: false, deferred: true, step: 'serve', ...svcGate }
  log(`starting the service: daemon --profile ${ctx.profile} start (budget ${Math.round(ctx.serveBudgetMs / 1000)} s)...`)
  const svcLog = newLogPath(ctx, 'serve')
  log(`uv transcript -> ${svcLog}`)
  const r = await run(ctx.uvx, daemonArgs(ctx, 'start'), { timeoutMs: ctx.serveBudgetMs, env: ctx.env, logFile: svcLog })
  const after = await probeDaemon(ctx)
  const text = (r.stdout + r.stderr).trim()
  if (!after.ok) {
    return {
      ok: false,
      step: 'serve',
      ms: r.ms,
      detail: r.timedOut ? `the service did not come up within ${Math.round(ctx.serveBudgetMs / 1000)} s` : `start command failed: ${r.error}`,
      tail: text.slice(-1500),
    }
  }
  return { ok: true, step: 'serve', ms: r.ms, detail: `service is up: ${after.detail}` }
}

export async function stop(ctx) {
  if (!ctx.uvx) return { ok: false, detail: 'no uvx' }

  // Official path first: the embed manager records its own PIDs and can stop the one it owns.
  const r = await run(ctx.uvx, daemonArgs(ctx, 'stop'), { timeoutMs: 120000, env: ctx.env })
  if (!(await probeDaemon(ctx)).ok) {
    return { ok: true, how: 'embed', ms: r.ms, detail: 'service stopped (via the embed manager)', tail: (r.stdout + r.stderr).trim().slice(-400) }
  }

  // The official path failed, which means the daemon on the port is **not the one it started**.
  // This is common: once the host plugin has spawned one itself, the embed manager says
  // "Could not find PID for port 9077" and refuses to act. The only way out is to find the
  // port owner and collect it.
  const killed = await killDaemonTree(ctx, { log: () => {} })
  const after = await probeDaemon(ctx)
  // A refusal is not the same as finding nothing, and collapsing them into "no collectable process
  // was found" hides the only sentence that would tell a person what to do next. The tightened
  // identity check made `stop` able to decline on purpose; that decline has to be legible.
  const refusal = killed.refused?.[0]
  return {
    ok: !after.ok,
    how: killed.killed.length ? 'port-owner' : refusal ? 'declined' : 'none',
    killed: killed.killed,
    refused: killed.refused ?? [],
    detail: !after.ok
      ? killed.killed.length
        ? `service stopped (the embed manager did not recognise it; collected the process tree by port owner: ${killed.killed.join(' -> ')})`
        : 'service stopped'
      : refusal
        ? `refused to stop pid ${refusal.pid} (${refusal.name}): ${refusal.why}${refusal.exe ? ` -- ${refusal.exe}` : ''}. It holds port ${ctx.port} but does not look like the daemon, so it was left alone.`
        : 'service is still running and no collectable process was found',
    tail: (r.stdout + r.stderr).trim().slice(-400),
  }
}

/** Find the process listening on a port */
export async function findPortOwner(port) {
  const r = await run(
    'powershell',
    ['-NoProfile', '-Command', `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -EA SilentlyContinue | Select-Object -First 1; if ($c) { [string]$c.OwningProcess }`],
    { timeoutMs: 30000 },
  )
  const n = Number((r.stdout ?? '').trim())
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Find the port owner and walk up the parent chain, collecting only processes that are provably
 * part of the daemon.
 *
 * Name alone is not identity. `@('python.exe','pythonw.exe','hindsight-api.exe','uv.exe','uvx.exe')`
 * matches any python.exe from anywhere, so a process that merely shares a name would be killed for
 * standing near the daemon -- and the anchor is only "something is listening on 9077", which is not
 * by itself proof of what it is.
 *
 * What the real chain looks like, measured rather than assumed:
 *
 *   5756  python.exe         E:\DaShaoHuo\uv-python\...\python.exe
 *                            " ...\hindsight-api.exe" --daemon --idle-timeout 0 --port 9077
 *   9772  python.exe         D:\...\archive-v0\q2neiV6RdAvGqiAL\Scripts\python.exe
 *   13608 hindsight-api.exe  D:\...\archive-v0\q2neiV6RdAvGqiAL\Scripts\hindsight-api.exe --daemon
 *   2516  uv.exe             E:\DaShaoHuo\uv\uv.exe tool uvx hindsight-api@0.9.2 --port 9077
 *   13816 uvx.exe            uvx hindsight-api@0.9.2 --daemon --port 9077
 *
 * Every member names either the daemon or the port in its command line, so that is the second
 * condition: the name must be one of ours AND the command line must say so. A process failing it
 * stops the walk and is reported with its path and the reason, rather than being killed for
 * resembling the target.
 *
 * Walking only upward is deliberate and stays: descendants of the daemon are not collected,
 * because there is no name list that would make that safe.
 */
export async function killDaemonTree(ctx, { log = () => {}, dryRun = false } = {}) {
  const pid = await findPortOwner(ctx.port)
  if (!pid) return { ok: true, killed: [], refused: [], detail: 'no process on the port' }

  const ps = `
$allowed = @('python.exe','pythonw.exe','hindsight-api.exe','uv.exe','uvx.exe')
$port = '${ctx.port}'
$dry = ${dryRun ? '$true' : '$false'}
$killed = @()
$refused = @()
$cur = ${pid}
for ($i = 0; $i -lt 6 -and $cur; $i++) {
  $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $cur) -EA SilentlyContinue
  if (-not $p) { break }
  $name = [string]$p.Name
  $exe  = [string]$p.ExecutablePath
  $cmd  = [string]$p.CommandLine
  if ($allowed -notcontains $name) {
    $refused += [pscustomobject]@{ pid = [int]$p.ProcessId; name = $name; exe = $exe; why = "image name '$name' is not one of the daemon's" }
    break
  }
  if ($cmd -notmatch 'hindsight' -and $cmd -notmatch $port) {
    $refused += [pscustomobject]@{ pid = [int]$p.ProcessId; name = $name; exe = $exe; why = 'its command line names neither the daemon nor the port' }
    break
  }
  $killed += [int]$p.ProcessId
  $cur = [int]$p.ParentProcessId
}
if (-not ${'$'}dry) { foreach ($procId in $killed) { Stop-Process -Id $procId -Force -EA SilentlyContinue } }
@{ killed = $killed; refused = $refused } | ConvertTo-Json -Compress -Depth 5
`.trim()

  const r = await run('powershell', ['-NoProfile', '-Command', ps], { timeoutMs: 60000 })
  let parsed = null
  try {
    parsed = JSON.parse((r.stdout ?? '').trim())
  } catch {
    parsed = null
  }
  const killed = (parsed?.killed ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0)
  const refused = Array.isArray(parsed?.refused) ? parsed.refused : parsed?.refused ? [parsed.refused] : []

  for (const k of killed) log(`${dryRun ? 'would collect' : 'collected'} process ${k}`)
  for (const f of refused) log(`left alone: pid ${f.pid} ${f.name} -- ${f.why}`)
  // Nothing was stopped, so there is nothing to wait for.
  if (!dryRun) await sleep(1200)

  if (!killed.length && refused.length) {
    return {
      ok: false,
      killed,
      refused,
      detail: `refused to kill pid ${refused[0].pid} (${refused[0].name}): ${refused[0].why}${refused[0].exe ? ` -- ${refused[0].exe}` : ''}`,
    }
  }
  return {
    ok: true,
    killed,
    refused,
    detail: killed.length
      ? `${dryRun ? 'would collect' : 'collected'} the process tree: ${killed.join(' -> ')}`
      : 'no collectable processes',
  }
}

export async function restart(ctx, opts = {}) {
  const s = await stop(ctx)
  if (s.ok) await sleep(1500)
  return serve(ctx, opts)
}

// ────────────────────────────────────────────────────────────────────────────
// heal: intelligent repair. Closes the gaps in warm -> serve -> watch order and reports
// what it is doing at every step.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Make sure the database is actually running before anything tries to use it.
 *
 * Sequencing, not decoration. A daemon started against a database that is down comes up and
 * answers 503 -- which looks like a daemon fault and is not one. This machine learned that the
 * hard way: the daemon ran for twenty minutes reporting an unusable database while every
 * process-level check called it healthy.
 *
 * Only acts when a service with the configured name exists. Installations that keep the
 * database as an embedded child process are left alone.
 */
export async function ensurePgService(ctx, { log = () => {} } = {}) {
  if (process.platform !== 'win32') return { ok: true, skipped: true, detail: 'not Windows' }
  const name = ctx.pgService ?? 'hindsight-pg'

  const r = await run('powershell', ['-NoProfile', '-Command',
    `$s = Get-Service -Name '${name}' -ErrorAction SilentlyContinue; if ($s) { $s.Status.ToString() } else { 'absent' }`],
    { timeoutMs: 30000 })
  const state = (r.stdout ?? '').trim()

  if (!/^[A-Za-z]/.test(state) || state === 'absent') {
    return { ok: true, skipped: true, detail: `no '${name}' service; the database is not managed here` }
  }
  if (state === 'Running') return { ok: true, running: true, detail: `database service '${name}' is running` }

  log(`database service '${name}' is ${state}; starting it`)
  await run('powershell', ['-NoProfile', '-Command', `Start-Service -Name '${name}'`], { timeoutMs: 120000 })

  // Wait for it to accept connections rather than assuming Start-Service returning means ready.
  const pgReady = join(process.env.ProgramFiles ?? 'C:/Program Files', '..', '.pg0')
  for (let i = 0; i < 24; i++) {
    await sleep(2500)
    const up = await probePort(ctx.pgPort)
    const q = up ? await run('powershell', ['-NoProfile', '-Command',
      `$s = Get-Service -Name '${name}' -ErrorAction SilentlyContinue; if ($s) { $s.Status.ToString() } else { 'absent' }`],
      { timeoutMs: 20000 }) : null
    if (up && (q?.stdout ?? '').trim() === 'Running') {
      return { ok: true, running: true, started: true, detail: `database service '${name}' started and port ${ctx.pgPort} is listening` }
    }
  }
  return { ok: false, running: false, detail: `database service '${name}' did not become ready` }
}

export async function heal(ctx, { log = () => {}, force = false, requireDsh = false } = {}) {
  const steps = []
  const push = (s) => {
    steps.push(s)
    return s
  }

  // 0. Gate (heartbeat only): the memory service exists to serve a DSH host. When none is
  //    running, do nothing at all -- no probe, no uvx, no daemon start. That is what keeps the
  //    heartbeat from quietly becoming a boot auto-start.
  if (requireDsh) {
    const dsh = await probeDshHost(ctx)
    push({ step: 'dsh-gate', ...dsh })
    if (!dsh.running) {
      log(`${dsh.detail}; nothing to do`)
      return { ok: true, skipped: true, reason: 'no-dsh-host', steps }
    }
    log(dsh.detail)
  }

  // 1. Fast path: if healthy, return immediately. Cost = one TCP connection.
  const health0 = await probeDaemon(ctx)
  if (health0.ok && !force) {
    log(`service healthy (${health0.detail}); nothing to do`)
    return { ok: true, healthy: true, fastPath: true, steps: [...steps, push({ step: 'probe', ok: true, detail: health0.detail })] }
  }

  log(health0.ok ? 'service is running, but a forced redo was requested' : `service unavailable: ${health0.detail}`)
  push({ step: 'probe', ok: health0.ok, detail: health0.detail })

  // 1a. Headroom before starting a heavy service. A daemon started while the machine is
  //     already tight is the exact setup in which it gets killed moments later, and the
  //     symptom then reads as "the supervisor is broken" rather than "there was no room".
  //     Measure before and after so that failure leaves evidence instead of a mystery.
  const memBefore = await probeResources({ top: 3 })
  if (memBefore.ok) {
    log(`headroom: ${memBefore.detail}`)
    const big = memBefore.top?.[0]
    if (big && big.mb >= 800) {
      log(`note: largest process is ${big.name} #${big.pid} at ${big.mb} MB`)
    }
  } else {
    log(`headroom: unavailable (${memBefore.detail})`)
  }
  push({ step: 'headroom-before', ...memBefore })

  // 1. uv toolchain -- the first link; if it is broken nothing downstream matters
  const uv = await probeUv(ctx)
  log(uv.ok ? `uv: ${uv.version ?? ''} ${uv.path}` : `uv FAILED: ${uv.detail}`)
  push({ step: 'uv', ...uv })
  if (!uv.ok) return { ok: false, healthy: false, failedAt: 'uv', steps }

  // 2. data layer first. Starting the daemon against a database that is down only produces
  //    a 503 and looks like a daemon fault.
  const db = await ensurePgService(ctx, { log })
  push({ step: 'pg-service', ...db })
  if (!db.ok) {
    log(`database not usable: ${db.detail}`)
    return { ok: false, healthy: false, failedAt: 'pg-service', steps }
  }

  // Only now, with the database actually up, is a restart meaningful. Doing this before the
  // database step was a real bug: it restarted the daemon against a dead database, which then
  // came up reporting 503 and looked like a daemon fault.
  if (health0.alive && !health0.ok && !force) {
    log('process is up but not ready; restarting it instead of waiting')
    const r = await restart(ctx, { log })
    push({ step: 'restart', ok: r.ok, detail: r.detail ?? '' })
    return { ok: r.ok, healthy: r.ok, failedAt: r.ok ? undefined : 'restart', steps, ...r }
  }

  // 2. warm -- get the build out of the way **with no watchdog**
  const w = await warm(ctx, { force, log })
  push(w)
  if (w.deferred) {
    // Not a failure. The machine is busy; the work is postponed, and saying FAILED here would
    // teach anyone reading the heartbeat to ignore it.
    log(`warm-up deferred: ${w.detail}`)
    return { ok: true, healthy: false, deferred: true, deferredAt: 'warm', detail: w.detail, steps }
  }
  if (!w.ok) {
    log(`warm-up FAILED: ${w.detail}`)
    return { ok: false, healthy: false, failedAt: 'warm', steps }
  }
  log(`warm-up: ${w.detail}`)

  // 3. serve -- the env is hot, so this is seconds
  const s = await serve(ctx, { log })
  push(s)
  if (s.deferred) {
    log(`start deferred: ${s.detail}`)
    return { ok: true, healthy: false, deferred: true, deferredAt: 'serve', detail: s.detail, steps }
  }
  if (!s.ok) {
    log(`start FAILED: ${s.detail}`)
    return { ok: false, healthy: false, failedAt: 'serve', steps }
  }
  log(`service: ${s.detail}`)

  // 4. watch -- confirm it is stable, not merely up for a moment
  let stable = false
  for (let i = 0; i < 5; i++) {
    await sleep(1500)
    const h = await probeDaemon(ctx)
    if (!h.ok) {
      // "It came up and then died" has two very different causes: a broken service, or a
      // machine with no room for it. Record the memory state at the moment of death, and
      // the largest consumer then, so the next reader can tell them apart.
      const mem = await probeResources({ top: 3 })
      const largest = mem.ok && mem.top?.length ? `${mem.top[0].name} #${mem.top[0].pid} at ${mem.top[0].mb} MB` : 'unknown'
      const note = mem.ok ? `${mem.detail}; largest: ${largest}` : `resource state unavailable (${mem.detail})`
      push({ step: 'watch', ok: false, detail: `it came up and then died again (probe ${i + 1})`, memory: mem })
      log(`it came up and then died again -- ${note}`)
      if (mem.ok && mem.freeGB < 3.5) {
        log('pressure is the likely cause: the machine was already tight when it died')
      }
      return { ok: false, healthy: false, failedAt: 'watch', steps }
    }
    stable = true
  }
  const memAfter = await probeResources({ top: 3 })
  if (memAfter.ok && memBefore.ok) {
    const used = Math.round((memBefore.freeGB - memAfter.freeGB) * 100) / 100
    log(`headroom after: ${memAfter.detail} (the service accounts for about ${used} GB)`)
  }
  push({ step: 'watch', ok: stable, detail: 'stable across 5 consecutive probes' })
  push({ step: 'headroom-after', ...memAfter })
  log('watch: stable across 5 consecutive probes')
  return { ok: true, healthy: true, steps }
}

// ────────────────────────────────────────────────────────────────────────────
// doctor: count historical start failures from the plugin log -- "why did it used to die"
// ────────────────────────────────────────────────────────────────────────────

export async function doctor(ctx) {
  const logs = findPluginLogs(ctx)
  const report = { logs, attempts: 0, failed: 0, succeeded: 0, events: [], plugins: [] }

  for (const p of logs) {
    let text = ''
    try {
      text = readFileSync(p, 'utf8')
    } catch {
      continue
    }
    const lines = text.split(/\r?\n/)
    for (const line of lines) {
      const ts = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)/.exec(line)?.[1] ?? null
      if (/starting daemon for profile/.test(line)) {
        report.attempts++
        report.events.push({ ts, kind: 'start', log: p })
      } else if (/Daemon Failed \(Timeout\)/.test(line)) {
        report.failed++
        report.events.push({ ts, kind: 'timeout', log: p })
      } else if (/Daemon started successfully/.test(line)) {
        report.succeeded++
        report.events.push({ ts, kind: 'success', log: p })
      }
    }
  }
  report.events.sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
  report.verdict =
    report.attempts === 0
      ? 'no start attempts found in the logs'
      : `${report.attempts} start attempts, ${report.failed} failed on timeout, ${report.succeeded} succeeded` +
        (report.failed > 0 ? ' -- the failures are a build racing a watchdog' : '')
  return report
}

// ────────────────────────────────────────────────────────────────────────────
// status: whole-chain check
// ────────────────────────────────────────────────────────────────────────────

export async function status(ctx, { deep = false } = {}) {
  // `deep` decides exactly one probe, and it is the one that is not read-only.
  //
  // Measuring warmth means running `uvx --with pg0-embedded hindsight-embed@<v> --help`, and uvx
  // builds an ephemeral environment in order to run anything at all. So a status call against a
  // cache with no matching environment CREATES one -- and this is the command people run most,
  // by hand and by agents, on the understanding that looking changes nothing. It was also feeding
  // itself: those generated environments are the ~5 GB of idle uvx environments that
  // `cache --prune` exists to remove.
  //
  // Everything else here is a TCP connect, an HTTP request, a file read or a scheduler query.
  // The warmth line is the only thing that costs a write, so it is the only thing behind a flag.
  const [uv, daemon, env, pg, log] = await Promise.all([
    probeUv(ctx),
    probeDaemon(ctx),
    deep ? probeEnv(ctx) : Promise.resolve(null),
    probePostgres(ctx),
    probeDaemonLog(ctx),
  ])

  const out = {
    config: {
      profile: ctx.profile,
      embedVersion: ctx.embedVersion,
      port: ctx.port,
      pgPort: ctx.pgPort,
      url: ctx.url,
      uvx: ctx.uvx,
      uvCacheDir: ctx.uvCacheDir,
      uvCacheReal: ctx.uvCacheReal,
      uvCacheRedirected: ctx.uvCacheRedirected,
      hindsightHome: ctx.hindsightHome,
      profileEnvFile: ctx.profileEnvFile,
      profileLogFile: ctx.profileLogFile,
    },
    uv,
    daemon,
    // null when the uvx probe was skipped, so a caller can tell "not measured" from "cold"
    // rather than reading a default as a measurement.
    env,
    envMeasured: env !== null,
    database: { path: pg.dataDir, exists: pg.hasData, listening: pg.listening },
    postgres: pg,
    log,
    // A green port is not enough: the daemon also has to be able to reach its database, and its
    // own log has to be quiet. Otherwise "healthy" hides a service that cannot do any work.
    ok: uv.ok && daemon.ok && pg.ok && log.ok,
  }

  const dot = (b) => (b ? 'ok  ' : 'FAIL')
  const warn = (b) => (b ? 'ok  ' : 'WARN')
  const lines = [
    `Volcano Separator -- whole-chain check`,
    ``,
    `  env layer  uv   [${dot(uv.ok)}] ${uv.ok ? `${uv.version ?? ''} (${uv.path})` : uv.detail}`,
    `             cache      ${ctx.uvCacheReal ?? '(not set)'}${ctx.uvCacheRedirected ? `  <- ${ctx.uvCacheDir} is a junction pointing at it` : ''}`,
    `             warmth     ${
      env === null
        ? '[ -- ] not measured -- `status --deep` runs a uvx dry run, and uvx writes to the cache'
        : `[${env.warm ? 'hot ' : 'cold'}] ${env.detail}`
    }`,
    `  service    daemon [${dot(daemon.ok)}] ${daemon.detail}`,
    `             profile    ${ctx.profile} (hindsight-embed@${ctx.embedVersion})`,
    `  data       pg     [${dot(pg.ok)}] ${pg.detail}`,
    `             errors     [${warn(log.ok)}] ${log.detail}`,
    ``,
    `  service log : ${ctx.profileLogFile}`,
    `  plugin log  : ${findPluginLogs(ctx).join(' , ') || '(none)'}`,
  ]
  if (!log.ok && log.errors?.length) {
    lines.push('', `  most recent daemon-log errors:`)
    for (const e of log.errors.slice(-5)) lines.push(`    ${e.ts}  ${e.kind}  ${e.line}`)
    lines.push(
      '',
      `  If these are db-timeout / connection errors, the daemon is up but cannot reach Postgres.`,
      `  A saturated disk is enough to cause it (the connection handshake has a tight timeout),`,
      `  so check for a background walk, delete or indexer before blaming the network.`,
    )
  }
  return { ...out, text: lines.join('\n') }
}

// ────────────────────────────────────────────────────────────────────────────
// Guardrail: while the daemon is alive, keep uv from touching its own cache
// ────────────────────────────────────────────────────────────────────────────

/**
 * Check whether a uv cache operation is safe right now.
 * Background: the daemon's code lives inside the uv cache, so `cache clean/prune` collides with
 * the running daemon, and `--force` deletes the running daemon's own files out from under it.
 */
export async function guardCacheOp(ctx, op) {
  const mutating = /^(clean|prune)$/.test(String(op))
  if (!mutating) return { safe: true, detail: `${op} does not modify the cache` }
  const d = await probeDaemon(ctx)
  if (!d.ok) return { safe: true, detail: `the daemon is not running; ${op} is safe` }
  return {
    safe: false,
    detail:
      `the daemon is running (${d.detail}) and its code lives in ${ctx.uvCacheReal ?? ctx.uvCacheDir} -- ` +
      `uv cache ${op} will be blocked by its in-use lock, and --force would delete the running daemon's own files.`,
    remedy: `Safe order: volcano-separator stop -> uv cache ${op} -> volcano-separator heal`,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Service integration: hand watch to the OS scheduler; no extra resident process
// ────────────────────────────────────────────────────────────────────────────

export function taskScriptPath(ctx, projectDir) {
  return join(projectDir, 'bin', 'guard-task.vbs')
}

export async function installService(ctx, { projectDir, nodePath = process.execPath, dryRun = false } = {}) {
  if (process.platform !== 'win32') return { ok: false, detail: 'scheduled-task installation is Windows-only for now' }
  const cli = join(projectDir, 'bin', 'cli.mjs')
  if (!existsSync(cli)) return { ok: false, detail: `CLI not found: ${cli}` }

  const scriptPath = taskScriptPath(ctx, projectDir)

  // Why a .vbs and not a .cmd: this machine's default terminal is Windows Terminal, so any
  // process that allocates a console gets a visible window. `cmd.exe /c ...` as a scheduled
  // action with an interactive logon type therefore flashes a console **every run**. wscript.exe
  // is a GUI-subsystem host -- it allocates no console of its own, and `Run(..., 0, ...)` asks
  // for a hidden window on the child. This is the same pattern the machine's existing
  // logon launcher uses, for the same reason.
  const script = [
    "' volcano-separator watch heartbeat.",
    "' Runs the CLI with no window. Launched by the scheduled task; see lib/core.mjs installService().",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run """${nodePath}"" ""${cli}"" heal --quiet --require-dsh --signals --redline --custody", 0, False`,
    '',
  ].join('\r\n')

  const ps = `
$ErrorActionPreference = 'Stop'
$action  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '//B //Nologo "${scriptPath}"'
# Deliberately NO logon trigger: this task must never be what starts the daemon at boot. It runs
# on a plain repetition, and the --require-dsh gate means it does nothing while no DSH host exists.
#
# Indefinite repetition: do NOT pass -RepetitionDuration. [TimeSpan]::MaxValue serialises to
# P99999999DT23H59M59S and the Task Scheduler rejects it (0x80041318). Omitting Duration IS
# the indefinite case.
$repeat   = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes ${ctx.taskIntervalMinutes})
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName '${ctx.taskName}' -Action $action -Trigger $repeat -Settings $settings -Force | Out-Null
'registered'
`.trim()

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      script,
      scriptPath,
      detail: `(dry-run) would register scheduled task ${ctx.taskName}: no logon trigger, every ${ctx.taskIntervalMinutes} minutes, windowless via wscript`,
    }
  }

  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync(join(projectDir, 'bin'), { recursive: true })
  writeFileSync(scriptPath, script, 'utf8')

  const r = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { timeoutMs: 120000 })
  const text = (r.stdout + r.stderr).trim()
  const good = r.ok && /registered/.test(r.stdout)
  return {
    ok: good,
    scriptPath,
    ms: r.ms,
    detail: good
      ? `registered scheduled task ${ctx.taskName} (every ${ctx.taskIntervalMinutes} minutes, no logon trigger, windowless)`
      : `registration failed: ${r.error ?? 'unknown'}`,
    tail: text.slice(-1200),
  }
}

export async function uninstallService(ctx) {
  if (process.platform !== 'win32') return { ok: false, detail: 'Windows only' }
  const r = await run('powershell', ['-NoProfile', '-Command', `Unregister-ScheduledTask -TaskName '${ctx.taskName}' -Confirm:$false -ErrorAction SilentlyContinue; 'done'`], { timeoutMs: 60000 })
  return { ok: r.ok, detail: r.ok ? `removed scheduled task ${ctx.taskName}` : `removal failed: ${r.error}`, tail: (r.stdout + r.stderr).trim().slice(-400) }
}

export async function serviceState(ctx) {
  const r = await run('powershell', ['-NoProfile', '-Command', `$t = Get-ScheduledTask -TaskName '${ctx.taskName}' -ErrorAction SilentlyContinue; if ($t) { $i = Get-ScheduledTaskInfo -TaskName '${ctx.taskName}'; 'state=' + $t.State; 'last=' + $i.LastRunTime; 'result=' + $i.LastTaskResult; 'next=' + $i.NextRunTime } else { 'state=absent' }`], { timeoutMs: 60000 })
  const text = (r.stdout + r.stderr).trim()
  if (/state=absent/.test(text)) return { installed: false, text }
  const g = (k) => new RegExp(`${k}=(.+)`).exec(text)?.[1]?.trim() ?? null
  return { installed: true, state: g('state'), lastRun: g('last'), lastResult: g('result'), nextRun: g('next'), text }
}

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

/**
 * Ask whether there is room to do something expensive, and say so plainly.
 *
 * Why this lives here and not only in lib/resources.mjs: the batch jobs already call the defer
 * command before each unit of work, which protects *them*. Nothing protected the daemon from
 * being started into a machine that was already out of memory -- and a daemon that is started
 * and then OOM-killed is worse than one that was never started, because the restart looks like
 * a crash.
 *
 * The distinction that matters to callers is deferral versus failure. "Not now" is not an error;
 * it is a decision, and reporting it as a failure would train anyone reading the heartbeat to
 * ignore it.
 *
 * resources.mjs already imports this module, so the import is dynamic: a static one would be a
 * cycle.
 */
export async function gateHeavyWork(ctx, { what = 'heavy work', log = () => {}, waitMs } = {}) {
  if (ctx.resourceGate === false) return { ok: true, skipped: true, detail: 'resource gate disabled' }

  let res
  try {
    res = await import('./resources.mjs')
  } catch (e) {
    return { ok: true, skipped: true, detail: `resource probe unavailable (${e?.message ?? e}); proceeding` }
  }

  const budget = Number.isFinite(waitMs) ? waitMs : Number(ctx.gateWaitMs ?? 60000)
  const started = Date.now()
  let decision = null

  for (;;) {
    const probe = await probeResources({ top: 3 })
    decision = res.decideDefer(probe, {})
    if (!decision.defer) break
    if (Date.now() - started + 15000 > budget) break
    log(`holding off on ${what}: ${decision.reason}`)
    await sleep(15000)
  }

  if (decision.defer) {
    return {
      ok: false,
      deferred: true,
      detail: `no headroom for ${what}: ${decision.reason}`,
      freeGB: decision.freeGB,
      cpu: decision.cpu,
      held: decision.held ?? [],
      waitedMs: Date.now() - started,
    }
  }
  return { ok: true, deferred: false, detail: decision.reason, freeGB: decision.freeGB, cpu: decision.cpu, waitedMs: Date.now() - started }
}

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

