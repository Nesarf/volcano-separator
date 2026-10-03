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
  /** env probe: a dry run slower than this many ms means the env is cold */
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

/**
 * Run a command and capture its output. Killed when timeoutMs elapses.
 * timeoutMs = 0 means **no watchdog** -- that is the defining difference of the warm stage.
 */
export function run(cmd, args, opts = {}) {
  const { timeoutMs = 0, env = process.env, cwd = undefined, logFile = null } = opts
  return new Promise((resolve) => {
    const started = Date.now()
    let child
    try {
      child = spawn(cmd, args, { env, cwd, windowsHide: true })
    } catch (e) {
      return resolve({ ok: false, code: null, signal: null, ms: 0, stdout: '', stderr: '', logFile, error: String(e?.message ?? e) })
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let timer = null

    // Stream to disk as it arrives, not just at the end. A start that takes four minutes must be
    // inspectable *during* those four minutes, otherwise the only thing an observer learns is
    // that they waited.
    const write = logFile
      ? (chunk) => {
          try {
            appendFileSync(logFile, chunk)
          } catch {
            /* logging must never break the run */
          }
        }
      : () => {}

    if (logFile) {
      try {
        mkdirSync(join(logFile, '..'), { recursive: true })
      } catch {
        /* ignore */
      }
      write(`$ ${cmd} ${args.join(' ')}\n# started ${new Date().toISOString()}\n\n`)
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        write(`\n# TIMEOUT after ${timeoutMs} ms -- killing\n`)
        try {
          child.kill()
        } catch {
          /* already gone */
        }
      }, timeoutMs)
    }
    child.stdout?.on('data', (d) => {
      stdout += d
      write(d)
    })
    child.stderr?.on('data', (d) => {
      stderr += d
      write(d)
    })
    child.on('error', (e) => {
      if (timer) clearTimeout(timer)
      write(`\n# spawn error: ${e?.message ?? e}\n`)
      resolve({ ok: false, code: null, signal: null, ms: Date.now() - started, stdout, stderr, logFile, error: String(e?.message ?? e) })
    })
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      const ms = Date.now() - started
      write(`\n# exited code=${code} signal=${signal} in ${ms} ms\n`)
      resolve({
        ok: code === 0 && !timedOut,
        code,
        signal,
        ms,
        stdout,
        stderr,
        logFile,
        timedOut,
        error: timedOut ? `timed out after ${timeoutMs} ms` : code === 0 ? null : `exit code ${code}`,
      })
    })
  })
}

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  if (!port) return { ok: false, listening: false, detail: `nothing listening on port ${ctx.port}` }
  let http = null
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 5000)
    const res = await fetch(`${ctx.url}/health`, { signal: ctl.signal }).catch(() => null)
    clearTimeout(t)
    if (res) http = res.status
  } catch {
    /* some builds have no /health; a live port is enough */
  }
  return { ok: true, listening: true, http, detail: `port ${ctx.port} is listening${http ? ` (/health -> ${http})` : ''}` }
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
  if (!ctx.uvx) return { ok: false, warm: false, detail: 'no uvx' }
  const args = [...uvFlags(ctx), '--with', ...ctx.withPackages, `hindsight-embed@${ctx.embedVersion}`, '--help']
  const r = await run(ctx.uvx, args, { timeoutMs: ctx.warmProbeMs, env: ctx.env })
  if (r.timedOut) {
    return { ok: true, warm: false, ms: r.ms, detail: `dry run did not return within ${ctx.warmProbeMs} ms -- the env is cold (downloading/building)` }
  }
  if (!r.ok) {
    return { ok: false, warm: false, ms: r.ms, detail: `dry run failed: ${r.error}`, stderr: r.stderr.slice(-800) }
  }
  return { ok: true, warm: true, ms: r.ms, detail: `env is warm (dry run ${r.ms} ms)` }
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
    log(`env is cold: ${probe.detail}`)
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
  return {
    ok: !after.ok,
    how: killed.killed.length ? 'port-owner' : 'none',
    killed: killed.killed,
    detail: !after.ok
      ? killed.killed.length
        ? `service stopped (the embed manager did not recognise it; collected the process tree by port owner: ${killed.killed.join(' -> ')})`
        : 'service stopped'
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
 * Find the port owner and walk up the parent chain, collecting the whole tree -- but only
 * uv/uvx/python/hindsight processes, never anything else.
 */
export async function killDaemonTree(ctx, { log = () => {} } = {}) {
  const pid = await findPortOwner(ctx.port)
  if (!pid) return { ok: true, killed: [], detail: 'no process on the port' }

  const ps = `
$allowed = @('python.exe','pythonw.exe','hindsight-api.exe','uv.exe','uvx.exe')
$chain = @()
$cur = ${pid}
for ($i = 0; $i -lt 6 -and $cur; $i++) {
  $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $cur) -EA SilentlyContinue
  if (-not $p) { break }
  if ($allowed -notcontains $p.Name) { break }
  $chain += [int]$p.ProcessId
  $cur = [int]$p.ParentProcessId
}
foreach ($procId in $chain) { Stop-Process -Id $procId -Force -EA SilentlyContinue }
$chain -join ','
`.trim()

  const r = await run('powershell', ['-NoProfile', '-Command', ps], { timeoutMs: 60000 })
  const killed = (r.stdout ?? '')
    .trim()
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
  for (const k of killed) log(`collected process ${k}`)
  await sleep(1200)
  return { ok: true, killed, detail: killed.length ? `collected the process tree: ${killed.join(' -> ')}` : 'no collectable processes' }
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

  // 1. uv toolchain -- the first link; if it is broken nothing downstream matters
  const uv = await probeUv(ctx)
  log(uv.ok ? `uv: ${uv.version ?? ''} ${uv.path}` : `uv FAILED: ${uv.detail}`)
  push({ step: 'uv', ...uv })
  if (!uv.ok) return { ok: false, healthy: false, failedAt: 'uv', steps }

  // 2. warm -- get the build out of the way **with no watchdog**
  const w = await warm(ctx, { force, log })
  push(w)
  if (!w.ok) {
    log(`warm-up FAILED: ${w.detail}`)
    return { ok: false, healthy: false, failedAt: 'warm', steps }
  }
  log(`warm-up: ${w.detail}`)

  // 3. serve -- the env is hot, so this is seconds
  const s = await serve(ctx, { log })
  push(s)
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
      push({ step: 'watch', ok: false, detail: `it came up and then died again (probe ${i + 1})` })
      return { ok: false, healthy: false, failedAt: 'watch', steps }
    }
    stable = true
  }
  push({ step: 'watch', ok: stable, detail: 'stable across 5 consecutive probes' })
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

export async function status(ctx) {
  const [uv, daemon, env, pg, log] = await Promise.all([
    probeUv(ctx),
    probeDaemon(ctx),
    probeEnv(ctx),
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
    env,
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
    `             warmth     [${env.warm ? 'hot ' : 'cold'}] ${env.detail}`,
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
    `sh.Run """${nodePath}"" ""${cli}"" heal --quiet --require-dsh", 0, False`,
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
  for (const entry of list.reverse()) {
    let text = ''
    try {
      text = readFileSync(join(dir, entry.f), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim()
      if (!t) continue
      try {
        events.push(JSON.parse(t))
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
  return {
    dir,
    total: events.length,
    shown: Math.min(limit, filtered.length),
    events: filtered.slice(-limit),
    recorderRunning: events.length > 0,
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
    `sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""${watch}""", 0, False`,
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

// ────────────────────────────────────────────────────────────────────────────
// Policy: which stealth is permitted, and what to do about the rest
// ────────────────────────────────────────────────────────────────────────────

/**
 * The policy lives next to the user's other config, not in the temp-backed log dir: it is a
 * decision, not an artifact, and it must survive a cache clean.
 */
export function policyPath(ctx) {
  const base = ctx.policyFile ? resolve(ctx.policyFile) : join(homedir(), '.volcano-separator')
  return base.endsWith('.json') ? base : join(base, 'policy.json')
}

export const POLICY_DEFAULTS = {
  /**
   * observe -- record the finding and change nothing. The default, on purpose: plenty of
   *            legitimate software hides a window (tray apps, splash screens, installers), so
   *            enforcing before you have an allowlist would do more damage than the threat.
   * suspend -- freeze the process so it cannot proceed, and wait for a human.
   * reject  -- terminate it. This is the "refuse" mode; it is opt-in and it is destructive.
   */
  mode: 'observe',
  /** Never touch these, whatever they do. Entries are `name:<exe>` or `path:<prefix>`. */
  allow: [
    // Forward slashes on purpose: these are compared as lowercased string prefixes, never
    // handed to the filesystem, and it keeps the table readable instead of doubled-escaped.
    'path:c:/windows/',
    'path:c:/program files/',
    'path:c:/program files (x86)/',
    'path:d:/dashaohuo/',
    'path:e:/dashaohuo/',
    'path:e:/npm-global/',
    'path:e:/volcano-separator/',
    'name:system',
    'name:svchost.exe',
    'name:csrss.exe',
    'name:winlogon.exe',
    'name:services.exe',
    'name:lsass.exe',
    'name:dwm.exe',
    'name:explorer.exe',
    'name:msmpeng.exe',
  ],
  /** A window hidden for less than this long is not treated as stealth (splash screens). */
  graceSeconds: 20,
}

export function loadPolicy(ctx) {
  const file = policyPath(ctx)
  let raw = {}
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      raw = {}
    }
  }
  return { file, ...POLICY_DEFAULTS, ...raw, allow: Array.isArray(raw.allow) ? raw.allow : POLICY_DEFAULTS.allow }
}

export function savePolicy(ctx, policy) {
  const file = policyPath(ctx)
  try {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify(policy, null, 2) + '\n', 'utf8')
    return { ok: true, file }
  } catch (e) {
    return { ok: false, file, detail: String(e?.message ?? e) }
  }
}

/** Does this process match an allow entry? Matching is deliberately simple and auditable. */
export function policyAllows(policy, { name, path }) {
  const p = (path ?? '').toLowerCase()
  const n = (name ?? '').toLowerCase()
  for (const entry of policy.allow ?? []) {
    const e = String(entry)
    if (e.startsWith('path:') && p && p.startsWith(e.slice(5).toLowerCase())) return e
    if (e.startsWith('name:') && n === e.slice(5).toLowerCase()) return e
  }
  return null
}

/** Stealth findings recorded by the recorder, newest last. */
export function readStealth(ctx, { limit = 50 } = {}) {
  const a = readActivity(ctx, { limit: 100000, files: 3 })
  const events = a.events.filter((e) => e.kind === 'stealth')
  return { dir: a.dir, total: events.length, events: events.slice(-limit) }
}


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
      cmd: rec.cmd,
      user: rec.user,
      started: rec.t,
    })
    cur = Number(rec.ppid)
  }
  return { pid: Number(pid), depth: chain.length, chain, source: a.dir, recorded: byPid.size }
}
