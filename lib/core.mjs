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


/**
 * Physical memory and CPU pressure, plus the largest processes.
 *
 * Lives beside the other probes because it depends on nothing but `run`. The thresholds
 * and the "may heavy work start?" verdict are a separate concern and live in
 * lib/resources.mjs, which builds on this.
 *
 * Command lines are collected on purpose: the embedded services run as generic
 * interpreter processes, so a name-only view cannot tell the memory daemon apart from an
 * unrelated python that happens to be large.
 */
export async function probeResources({ top = 6 } = {}) {
  const ps = [
    '$os = Get-CimInstance Win32_OperatingSystem',
    '$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average',
    `$p = Get-CimInstance Win32_Process | Sort-Object WorkingSetSize -Descending | Select-Object -First ${top}`,
    '@{ totalGB = [math]::Round($os.TotalVisibleMemorySize/1MB,2)',
    '   freeGB = [math]::Round($os.FreePhysicalMemory/1MB,2)',
    '   cpu = [int]$cpu',
    '   top = @($p | ForEach-Object { @{ pid = $_.ProcessId; name = $_.Name;',
    '     mb = [int]($_.WorkingSetSize/1MB); cmd = [string]$_.CommandLine } }) } | ConvertTo-Json -Depth 4 -Compress',
  ].join('; ')

  const r = await run('powershell', ['-NoProfile', '-Command', ps], { timeoutMs: 30000 })
  if (!r.ok) {
    return { ok: false, detail: r.error || 'resource probe failed', totalGB: null, freeGB: null, cpu: null, top: [] }
  }
  try {
    const j = JSON.parse(r.stdout.trim())
    const list = Array.isArray(j.top) ? j.top : j.top ? [j.top] : []
    return {
      ok: true,
      detail: `${j.freeGB} GB free of ${j.totalGB} GB, CPU ${j.cpu}%`,
      totalGB: Number(j.totalGB),
      freeGB: Number(j.freeGB),
      cpu: Number(j.cpu),
      top: list.map((p) => ({ pid: p.pid, name: p.name, mb: Number(p.mb), cmd: (p.cmd ?? '').trim() })),
    }
  } catch (e) {
    return { ok: false, detail: `could not parse resource probe: ${e?.message ?? e}`, totalGB: null, freeGB: null, cpu: null, top: [] }
  }
}

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
export function activityDir(ctx) {
  return join(ctx.logDir ?? join(tmpdir(), 'volcano-separator'), 'activity')
}

/**
 * Read back the activity record.
 *
 * Plain NDJSON on purpose: the timeline stays readable even when the daemon, the database and uv
 * are all down -- which is exactly when you most want to know what happened.
 */

/** Synchronous sleep -- readActivity is sync, and a busy-wait would be worse than useless here. */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    /* if it is unavailable, skip the backoff rather than fail the read */
  }
}

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
  const filesSeen = list.length
  let readFailures = 0
  for (const entry of list.reverse()) {
    // The recorder runs as SYSTEM and appends to this file continuously, so a read can collide
    // with a write and fail. Retrying is not optional: the previous code swallowed the failure
    // and returned an empty record, which reads exactly like "nothing happened".
    let text = null
    for (let attempt = 0; attempt < 5 && text === null; attempt++) {
      try {
        text = readFileSync(join(dir, entry.f), 'utf8')
      } catch {
        sleepSync(80 + attempt * 120)
      }
    }
    if (text === null) {
      readFailures++
      continue
    }
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim()
      if (!t) continue
      try {
        // Strip a BOM: it only ever appears on a file's first line, and there it silently
        // costs you exactly one event per rotation.
        const clean = t.charCodeAt(0) === 0xfeff ? t.slice(1) : t
        events.push(JSON.parse(clean))
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
  // Three different situations, and conflating them is the bug this tool exists to fix:
  //   no files            -> the recorder is not installed
  //   files, unreadable   -> the recorder IS running but something holds the file (typically a
  //                          second instance); reporting this as "no recorder" turns a lock
  //                          into an invisibility
  //   files, readable     -> normal
  const readable = readFailures === 0
  return {
    dir,
    filesSeen,
    readFailures,
    readable,
    total: events.length,
    shown: Math.min(limit, filtered.length),
    events: filtered.slice(-limit),
    recorderRunning: filesSeen > 0,
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
    // The log directory is passed explicitly. The script's own default is $env:TEMP, and that
    // resolves differently for SYSTEM (the machine TEMP, C:\Windows\TEMP) than for the user --
    // so the recorder, which runs as SYSTEM, wrote to C: while every reader looked on E:.
    // That is not hypothetical: it is how this recorder came to write nothing at all.
    `sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""${watch}"" -LogDir ""${activityDir(ctx)}""", 0, False`,
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

/**
 * PowerShell's `Set-Content -Encoding UTF8` writes a BOM in Windows PowerShell 5.1, and
 * JSON.parse throws on a leading U+FEFF. That single byte cost a whole debugging round: the
 * file existed, the poll saw it 37 times out of 40, and every parse failed silently inside an
 * empty catch. Strip it here rather than trusting every writer to remember.
 */
function readJsonLoose(file) {
  const raw = readFileSync(file, 'utf8')
  const clean = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  return JSON.parse(clean)
}

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
  /**
   * The line this tool will not cross, and the reason it exists at all.
   *
   * Quarantine-on-detection is a defensible policy, but it is one policy among several, and
   * it fits builders of software badly: a heuristic that misjudges a build tool costs a
   * toolchain and an afternoon. This tool takes the other policy. It never moves, rewrites or
   * deletes the target -- it freezes, reveals, records, and asks. Allowing is the user's
   * decision, and it is recorded as policy rather than inferred.
   */
  neverQuarantine: true,
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
  const p = normalizePath(path)
  const n = String(name ?? '').toLowerCase()
  for (const entry of policy.allow ?? []) {
    const e = String(entry)
    if (e.startsWith('path:') && p && p.startsWith(normalizePath(e.slice(5)))) return e
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

// ────────────────────────────────────────────────────────────────────────────
// Custody: freeze a suspected process and make it impossible for it to hide
// ────────────────────────────────────────────────────────────────────────────

const CORE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Take a process into custody.
 *
 * The order is the design: freeze, then reveal, then display. A running process can always
 * destroy its own windows, so "it must not be able to close them" only becomes true once it
 * cannot execute at all. The custody window belongs to us, so it cannot close that either --
 * not because we defended it, but because it was never the target's to close.
 *
 * What this deliberately does NOT do: move, rename, rewrite or delete anything. The target
 * stays exactly where it is. Quarantining a file on suspicion is the behaviour that makes
 * security tooling unusable for developers and researchers, and it is the behaviour this
 * refuses to copy.
 *
 * Limits worth stating: this cannot give a window to a process that never created one (that
 * needs code injection, which this does not do), and suspension is not deletion -- the process
 * keeps its memory, handles and sockets, it simply cannot run.
 */
export async function detain(ctx, { pid, suspend = true, custody = true, topmost = true, release = false, reason = '' } = {}) {
  const script = join(CORE_ROOT, 'bin', 'detain.ps1')
  if (!existsSync(script)) return { ok: false, detail: `detain script missing: ${script}` }
  if (!Number.isFinite(Number(pid)) || Number(pid) <= 0) return { ok: false, detail: 'a target pid is required' }

  const target = Number(pid)
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-TargetPid', String(target)]
  if (release) args.push('-Release')
  if (!suspend) args.push('-NoSuspend')
  if (!custody) args.push('-NoCustody')
  if (topmost && custody && !release) args.push('-KeepOnTop')
  args.push('-PolicyFile', policyPath(ctx))
  if (reason) args.push('-Reason', reason)

  const summaryFile = join(activityDir(ctx), `detain-${target}.json`)

  // Releasing is short and synchronous: no window to wait on, so read the answer directly.
  if (release) {
    const r = await run(process.platform === 'win32' ? 'powershell.exe' : 'pwsh', args, { timeoutMs: 60000 })
    const out = (r.stdout ?? '').trim()
    const last = out.split(String.fromCharCode(10)).filter(Boolean).pop() || '{}'
    try {
      return { ok: r.ok, ...JSON.parse(last) }
    } catch {
      return { ok: r.ok, pid: target, detail: r.ok ? 'release ran' : (r.error ?? 'release failed'), raw: out.slice(-300) }
    }
  }

  try {
    rmSync(summaryFile, { force: true })
  } catch {
    /* ignore */
  }

  // Detached: the custody window stays open until a human decides, so this must not wait on it.
  // Hand it to the OS rather than holding it as our child.
  //
  // A detached child of this process still dies with this process on Windows (the harness runs
  // its tool calls inside a job object), which is exactly how the first version of this failed:
  // the script worked perfectly when run by hand and produced nothing through the CLI. Letting
  // Start-Process own it removes the parent from the question entirely.
  const quote = (a) => "'" + String(a).replace(/'/g, "''") + "'"
  const launcher =
    'Start-Process -FilePath ' + quote(process.platform === 'win32' ? 'powershell.exe' : 'pwsh') +
    ' -ArgumentList @(' + args.map(quote).join(',') + ') -WindowStyle Hidden'
  const launched = await run('powershell', ['-NoProfile', '-Command', launcher], { timeoutMs: 30000 })
  if (!launched.ok) {
    return { ok: false, pid: target, detail: `could not launch detain: ${launched.error ?? 'unknown'}`, stderr: (launched.stderr ?? '').slice(-300) }
  }

  // Poll, and record what each look actually saw. A bare "no summary" tells the next person
  // nothing; the observed sequence says whether the file never appeared, appeared late, or
  // appeared and then vanished -- three different bugs that read identically otherwise.
  const seen = []
  for (let i = 0; i < 40; i++) {
    await sleep(400)
    const hit = existsSync(summaryFile)
    seen.push({ t: (i + 1) * 400, hit, dir: existsSync(activityDir(ctx)) })
    if (hit) {
      try {
        return { ok: true, ...readJsonLoose(summaryFile), summaryFile }
      } catch {
        /* still being written */
      }
    }
  }
  return {
    ok: false,
    pid: target,
    detail: 'detain launched but produced no summary in 16 s',
    summaryFile,
    launcher,
    observed: seen,
    finalLook: existsSync(summaryFile),
    dirListing: (() => {
      try {
        return readdirSync(activityDir(ctx)).filter((f) => f.startsWith('detain-'))
      } catch {
        return null
      }
    })(),
  }
}

/** The custody summaries currently on disk, reconciled against the live system. */
export async function custodyState(ctx, { probe = true } = {}) {
  // Reads through readJsonLoose, not JSON.parse: these files are written by PowerShell with
  // -Encoding UTF8, which writes a BOM, and a bare JSON.parse throws on every one of them.
  // That is exactly how "detain produced no summary" happened while the freeze had worked.
  const dir = activityDir(ctx)
  let files = []
  try {
    files = readdirSync(dir).filter((x) => x.startsWith('detain-') && x.endsWith('.json'))
  } catch {
    return []
  }
  const records = []
  for (const f of files) {
    const rec = readJsonLoose(join(dir, f))
    if (rec && typeof rec === 'object') records.push({ file: join(dir, f), ...rec })
  }

  // A record is a claim about a moment. Whether it still holds is a question for the system,
  // and that is the whole point of this function: a suspension is persistent, so a freeze whose
  // operator forgot about it stays frozen with nothing on the machine saying so.
  if (!probe) return records
  const live = await probeCustody(records.map((r) => Number(r.pid)).filter(Number.isInteger))
  return records.map((rec) => {
    const pid = Number(rec.pid)
    const info = live[pid]
    let state = 'unverified'
    if (info && info.exists === false) state = 'exited'
    else if (info && info.exists) {
      if (info.frozen) state = rec.suspended === false ? 'frozen-unexpectedly' : 'frozen'
      else state = rec.suspended === false ? 'running' : 'resumed'
    }
    return { ...rec, state, threads: info?.threads ?? null,
             suspendedThreads: info?.suspended ?? null }
  })
}

/** The ones still frozen -- the processes a person needs to make a decision about. */
export async function custodyOrphans(ctx, opts = {}) {
  const all = await custodyState(ctx, opts)
  return all.filter((r) => r.state === 'frozen' || r.state === 'frozen-unexpectedly')
}

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

/** Roots where a program has no business living permanently. */
function ephemeralRoots(ctx) {
  const home = homedir()
  return [
    tmpdir(),
    join(home, 'AppData', 'Local', 'Temp'),
    join(home, 'Downloads'),
    join(home, 'Desktop'),
  ].map((p) => p.toLowerCase())
}

function isEphemeral(p, roots) {
  if (!p) return null
  const low = String(p).toLowerCase()
  for (const r of roots) if (low.startsWith(r)) return r
  // Anything sitting in a directory literally named temp/downloads/cache, wherever it is.
  const m = /[\/](temp|tmp|downloads?|cache)[\/]/i.exec(low)
  return m ? m[0] : null
}

/**
 * The executable from a captured command line, normalised, or null if we cannot be sure.
 *
 * Returning null matters more than it looks. The first version of the `binary-vanished` rule
 * used the raw first token and fired 48 times in an hour, almost all of it wrong:
 *   \??\C:\Windows\system32\conhost.exe   an NT-prefixed path that no filesystem call accepts
 *   ssh                                   a bare command name with no path at all
 *   a path the user had since renamed     a true statement about a file, and useless as a signal
 * A rule that cannot be checked must decline to fire.
 */
const BS = String.fromCharCode(92)
const NT_PREFIX = BS + BS + '?' + '?' + BS
const UNC_PREFIX = BS + BS
const ABS_PATH = new RegExp('^[a-zA-Z]:[' + BS + BS + '/]')

const SYS_ROOT = new RegExp('^[a-zA-Z]:[' + BS + BS + '/](windows|program files)', 'i')
function exeFromCmd(cmd) {
  if (!cmd) return null
  const s = String(cmd).trim()
  let tok
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1)
    if (end <= 0) return null
    tok = s.slice(1, end)
  } else {
    const sp = s.indexOf(' ')
    tok = sp === -1 ? s : s.slice(0, sp)
  }
  if (!tok) return null
  // Backslashes are built from their code point on purpose: this file has been through enough
  // escaping layers that a literal one does not reliably survive being written.
  if (tok.startsWith(NT_PREFIX)) tok = tok.slice(NT_PREFIX.length)
  if (!ABS_PATH.test(tok) && !tok.startsWith(UNC_PREFIX)) return null
  return tok
}


/**
 * Read the record and report what looks like stealth.
 *
 * Rules, and why each is defensible:
 *
 *   persist-from-ephemeral  Something was added to a persistence surface (Run key, Startup
 *                           folder, scheduled task) and it points into a temporary or download
 *                           directory. Legitimate software installs itself somewhere stable;
 *                           persistence from a scratch directory is the shape of a dropper.
 *
 *   exec-from-ephemeral     A process ran from such a directory. Common and often innocent --
 *                           installers, portable tools -- which is exactly why this is ranked
 *                           low and why the allowlist is consulted.
 *
 *   binary-vanished         A process ran and its executable is gone by the time we look. Some
 *                           installers clean up after themselves; self-deletion is also a
 *                           standard trick. Ranked high because it is rare.
 */
export function analyzeSignals(ctx, { sinceMinutes = 60, limit = 100 } = {}) {
  const a = readActivity(ctx, { limit: 200000, files: 3 })
  const policy = loadPolicy(ctx)
  const roots = ephemeralRoots(ctx)
  const cutoff = Date.now() - sinceMinutes * 60 * 1000

  const findings = []
  const add = (f) => {
    const allowHit = policyAllows(policy, { name: f.name, path: f.path })
    findings.push({ ...f, allowed: allowHit, policyMode: policy.mode })
  }

  const seenPid = new Set()

  for (const e of a.events) {
    const t = Date.parse(e.t ?? '')
    if (Number.isFinite(t) && t < cutoff) continue

    if (e.kind === 'persist' && e.action !== 'removed') {
      const where = isEphemeral(e.value, roots)
      if (where) {
        add({
          rule: 'persist-from-ephemeral',
          severity: 'high',
          name: e.name,
          path: e.value,
          subject: `${e.surface} -> ${e.name}`,
          why: `persistence was added under ${where}`,
          at: e.t,
        })
      }
    }

    if (e.kind === 'proc-start') {
      const pid = Number(e.pid)
      if (seenPid.has(pid)) continue
      seenPid.add(pid)

      const exe = exeFromCmd(e.cmd)
      const where = isEphemeral(exe, roots)
      if (where) {
        add({
          rule: 'exec-from-ephemeral',
          severity: 'low',
          pid,
          name: e.name,
          path: exe,
          subject: `${e.name} (pid ${pid})`,
          why: `ran from ${where}`,
          at: e.t,
        })
      }
            const systemRoot = exe && SYS_ROOT.test(exe)
      if (exe && !systemRoot && !existsSync(exe)) {
        add({
          rule: 'binary-vanished',
          severity: 'high',
          pid,
          name: e.name,
          path: exe,
          subject: `${e.name} (pid ${pid})`,
          why: 'the executable no longer exists at the path it ran from',
          at: e.t,
        })
      }
    }
  }

  // Newest first, and never let one noisy rule bury the rest.
  findings.sort((x, y) => String(y.at).localeCompare(String(x.at)))
  const byRule = {}
  for (const f of findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1

  return {
    ok: true,
    observed: a.total,
    window: `${sinceMinutes} min`,
    total: findings.length,
    byRule,
    allowed: findings.filter((f) => f.allowed).length,
    findings: findings.slice(0, limit),
    mode: policy.mode,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// L2 -- decisions: what each signal means, and what would be done about it
// ────────────────────────────────────────────────────────────────────────────
//
// Still no action. This layer answers "what should happen to this finding" and nothing else, so
// the judgements can be reviewed on real traffic before any of them are allowed to do anything.

/**
 * Normalise a path for comparison.
 *
 * Windows paths arrive with backslashes and the policy is written with forward slashes, so a
 * plain string prefix test never matched: `C:\Windows\System32\cmd.exe` was not recognised as
 * living under `path:c:/windows/`, and therefore **nothing** was ever covered by the allowlist.
 * Every finding looked unauthorised. Separators are folded here so the comparison is about the
 * path and not about which slash the writer happened to use.
 */
function normalizePath(p) {
  if (!p) return ''
  return String(p).split(String.fromCharCode(92)).join('/').toLowerCase()
}

/**
 * Apply policy to the signals and produce a verdict per finding, plus a roll-up.
 *
 *   allow  the allowlist already covers it -- no decision needed
 *   ask    serious enough to need a human, and not covered
 *   note   worth recording, not worth interrupting anyone over
 *
 * `wouldAct` is deliberately separate from `verdict`: it says what the configured mode *would*
 * have done, which is only meaningful once enforcement is switched on. In the default mode it is
 * always false, and that is the point of this layer.
 */
export function decideSignals(ctx, { sinceMinutes = 60 } = {}) {
  const s = analyzeSignals(ctx, { sinceMinutes, limit: 100000 })
  const policy = loadPolicy(ctx)

  const decisions = s.findings.map((f) => {
    const allowed = policyAllows(policy, { name: f.name, path: f.path })
    const verdict = allowed ? 'allow' : f.severity === 'high' ? 'ask' : 'note'
    const wouldAct = !allowed && verdict === 'ask' && policy.mode !== 'observe'
    // rawPath is kept for the dedupe key; `path` may have been normalised for matching.
    return { ...f, allowed, verdict, wouldAct, rawPath: f.path ?? '' }
  })

  const byVerdict = { allow: 0, ask: 0, note: 0 }
  for (const d of decisions) byVerdict[d.verdict]++

  return {
    ok: true,
    window: s.window,
    observed: s.observed,
    mode: policy.mode,
    total: decisions.length,
    byVerdict,
    byRule: s.byRule,
    decisions,
  }
}

/**
 * Write the decisions that need a human into the activity record as `stealth` events, so the
 * question survives the terminal it was printed in. `policy show` reads these back.
 */
export function recordDecisions(ctx, decisions) {
  const file = join(activityDir(ctx), `stealth-${new Date().toISOString().slice(0, 10)}.ndjson`)

  // Deduplicate against what is already recorded. The heartbeat runs every five minutes over a
  // window slightly wider than that, so without this the same finding is written again and again
  // and the log stops being a list of open questions.
  const already = new Set()
  try {
    for (const line of readFileSync(file, 'utf8').split(String.fromCharCode(10))) {
      const t = line.trim()
      if (!t) continue
      try {
        const e = JSON.parse(t)
        already.add(`${e.rule}|${e.subject}|${e.path ?? ''}`)
      } catch {
        /* skip a half-written line */
      }
    }
  } catch {
    /* no file yet */
  }

  let written = 0
  let skipped = 0
  for (const d of decisions) {
    if (d.verdict !== 'ask') continue
    const key = `${d.rule}|${d.subject}|${d.rawPath ?? ''}`
    if (already.has(key)) {
      skipped++
      continue
    }
    already.add(key)
    const line = JSON.stringify({
      t: d.at ?? new Date().toISOString(),
      kind: 'stealth',
      rule: d.rule,
      severity: d.severity,
      pid: d.pid ?? null,
      name: d.name ?? null,
      subject: d.subject,
      why: d.why,
      action: 'needs-decision',
      verdict: d.verdict,
      path: d.path ?? null,
      rawPath: d.rawPath ?? null,
    })
    try {
      appendFileSync(file, line + String.fromCharCode(10))
      written++
    } catch {
      /* never let bookkeeping break the report */
    }
  }
  return { ok: true, file, written, skipped }
}

/**
 * What actually ran, grouped.
 *
 * The record is complete and that turned out not to be enough. Hundreds of processes were
 * captured and nothing surfaced them: the signal rules only speak up about specific shapes
 * (persistence, ephemerality, self-deletion), and `ps` deliberately shows only this stack's own
 * processes. So a three-hour, 351-invocation, windowless workload ran and the tool had nothing
 * to say about it.
 *
 * Recording is not transparency. This answers "what has been running here", which is the
 * question a person actually asks.
 */
export function summarizeActivity(ctx, { sinceMinutes = 120, limit = 25, minRuns = 1 } = {}) {
  const a = readActivity(ctx, { limit: 400000, files: 3 })
  const policy = loadPolicy(ctx)
  const cutoff = Date.now() - sinceMinutes * 60 * 1000

  const groups = new Map()
  for (const e of a.events) {
    const t = Date.parse(e.t ?? '')
    if (Number.isFinite(t) && t < cutoff) continue
    if (e.kind !== 'proc-start') continue

    const name = String(e.name ?? '').toLowerCase()
    if (!name) continue
    let g = groups.get(name)
    if (!g) {
      g = { name, runs: 0, first: e.t, last: e.t, windows: 0, exe: null, pids: new Set(), user: e.user ?? null }
      groups.set(name, g)
    }
    g.runs++
    g.last = e.t
    g.pids.add(Number(e.pid))
    const exe = exeFromCmd(e.cmd)
    if (exe && !g.exe) g.exe = exe
  }

  // A window event means a title was sampled for it. Its absence means nothing: the recorder
  // only samples for a few seconds after start, so short-lived and late-titled programs never
  // produce one. The first version of this called the absence "headless" and flagged chrome.exe
  // as having no window. Named for what it is instead of what it was assumed to mean.
  for (const e of a.events) {
    if (e.kind !== 'window') continue
    const g = groups.get(String(e.name ?? '').toLowerCase())
    if (g) g.windows++
  }

  const rows = [...groups.values()]
    .filter((g) => g.runs >= minRuns)
    .map((g) => ({
      name: g.name,
      runs: g.runs,
      distinctPids: g.pids.size,
      first: g.first,
      last: g.last,
      windows: g.windows,
      noWindowObserved: g.windows === 0,
      exe: g.exe,
      allowed: policyAllows(policy, { name: g.name, path: g.exe }),
    }))
    .sort((x, y) => y.runs - x.runs)
    .slice(0, limit)

  return {
    ok: true,
    dir: a.dir,
    window: `${sinceMinutes} min`,
    observed: a.total,
    distinctPrograms: groups.size,
    noWindowObserved: rows.filter((r) => r.noWindowObserved).length,
    rows,
  }
}

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


/** Read the detain summary files. Newest first. */
export function readDetainRecords(ctx, readJsonLoose) {
  const dir = join(ctx.logDir ?? join(tmpdirFallback(), 'volcano-separator'), 'activity')
  let files = []
  try {
    files = readdirSync(dir).filter((f) => /^detain-\d+\.json$/.test(f))
  } catch {
    return []
  }
  const out = []
  for (const f of files) {
    const rec = readJsonLoose(join(dir, f))
    if (rec && typeof rec === 'object') out.push({ ...rec, recordFile: join(dir, f) })
  }
  return out
}

function tmpdirFallback() {
  // Kept local so this module does not have to import node:os just for one fallback path.
  return process.env.TEMP || process.env.TMP || '.'
}

/**
 * Ask the live system about each pid: does it still exist, and are all of its threads
 * suspended?
 *
 * All-threads-suspended is the only reliable read-only signal available: NtSuspendProcess
 * leaves every thread in the Suspended wait state, and a running process always has at least
 * one thread that is not. Measured directly before relying on it -- a frozen process reports
 * "Wait, Suspended" for every thread, and resuming it restores the original wait reasons.
 */
export async function probeCustody(pids, { timeoutMs = 30000 } = {}) {
  const list = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))]
  if (!list.length) return {}

  const script = [
    `$ids = @(${list.join(',')})`,
    '$out = @()',
    'foreach ($id in $ids) {',
    '  $p = Get-Process -Id $id -ErrorAction SilentlyContinue',
    '  if (-not $p) { $out += @{ pid = $id; exists = $false }; continue }',
    '  $threads = @($p.Threads)',
    '  $susp = @($threads | Where-Object { $_.ThreadState -eq "Wait" -and $_.WaitReason -eq "Suspended" })',
    '  $out += @{ pid = $id; exists = $true; name = $p.ProcessName;',
    '            threads = $threads.Count; suspended = $susp.Count;',
    '            created = $p.StartTime.ToUniversalTime().ToString("o");',
    '            frozen = ($threads.Count -gt 0 -and $susp.Count -eq $threads.Count) }',
    '}',
    '$out | ConvertTo-Json -Compress -Depth 4',
  ].join('\n')

  const r = await run('powershell', ['-NoProfile', '-Command', script], { timeoutMs })
  if (!r.ok) return {}
  // PowerShell renders a single-element array as an object, so accept both shapes.
  let parsed
  try {
    parsed = JSON.parse((r.stdout || '').trim())
  } catch {
    return {}
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  const byPid = {}
  for (const row of rows) {
    if (row && typeof row.pid === 'number') byPid[row.pid] = row
  }
  return byPid
}

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


const DETAIN_EVENTS = new Set(['suspended', 'released', 'failed'])

/**
 * Rebuild the per-pid custody state from the activity log.
 *
 * Last decisive event wins: `suspended` puts a pid under custody, `released` takes it out, and
 * anything that merely revealed windows does not change it.
 */
export function rebuildCustody(ctx) {
  const dir = activityDir(ctx)
  let files = []
  try {
    files = readdirSync(dir).filter((f) => /^activity-\d{4}-\d{2}-\d{2}\.ndjson$/.test(f)).sort()
  } catch {
    return { ok: false, reason: 'no activity record', pids: {} }
  }

  const perPid = new Map()
  let events = 0
  for (const f of files) {
    let text
    try {
      text = readFileSync(join(dir, f), 'utf8')
    } catch {
      continue
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || !line.includes('"detain"')) continue
      let e
      try {
        // Strip a BOM per line: it costs exactly one event per file otherwise, and the record
        // is the thing being trusted here, so losing a line silently is not acceptable.
        e = JSON.parse(line.charCodeAt(0) === 0xfeff ? line.slice(1) : line)
      } catch {
        continue
      }
      if (e.kind !== 'detain' || !DETAIN_EVENTS.has(e.action)) continue
      events++
      const pid = Number(e.pid)
      if (!Number.isInteger(pid)) continue
      const cur = perPid.get(pid) ?? { pid }
      if (e.action === 'suspended') {
        cur.suspended = true
        cur.suspendedAt = e.t ?? null
        cur.created = e.created ?? cur.created
        cur.name = e.name ?? cur.name
        cur.why = e.why ?? cur.why
      } else if (e.action === 'released') {
        cur.suspended = false
        cur.releasedAt = e.t ?? null
        cur.name = e.name ?? cur.name
      } else if (e.action === 'failed') {
        cur.failed = true
        cur.failedAt = e.t ?? null
        cur.why = e.why ?? cur.why
      }
      perPid.set(pid, cur)
    }
  }
  const pids = {}
  for (const [pid, v] of perPid) pids[pid] = v
  return { ok: true, files: files.length, events, pids }
}

/**
 * The answer to "is anything still frozen?", with each claim checked against the system.
 *
 * States, and the two that matter most:
 *   `frozen`   -- under custody now, and nothing released it. Somebody has to decide.
 *   `exited`   -- recorded as frozen but the process is gone; only history.
 *   `resumed`  -- recorded as frozen, released later, and running.
 *   `running`  -- a release was recorded but the process is still frozen, which means the
 *                 release did not take. That is a bug worth seeing rather than averaging away.
 */
export async function custodyReport(ctx, { probe = true, probeFn = null } = {}) {
  const rebuilt = rebuildCustody(ctx)
  const pids = Object.values(rebuilt.pids ?? {})
  if (!rebuilt.ok) return { ok: false, reason: rebuilt.reason, rows: [], frozen: [] }

  const live = !probe ? {} : await (probeFn ?? probeCustody)(pids.map((r) => r.pid))
  const rows = pids.map((rec) => {
    const info = live[rec.pid]
    // A pid is not an identity. If the process now holding this pid started at a different
    // moment than the one we froze, the record is about a process that no longer exists -- and
    // saying "released and running" would be a lie about a stranger.
    const reused = Boolean(rec.created && info?.created
                           && String(rec.created).slice(0, 16) !== String(info.created).slice(0, 16))
    let state
    if (!probe || !info || info.exists === undefined) state = 'unverified'
    else if (!info.exists) state = 'exited'
    else if (reused) state = 'pid-reused'
    else if (info.frozen) state = rec.suspended ? 'frozen' : 'frozen-after-release'
    else state = rec.suspended ? 'resumed-without-release' : 'running'
    return {
      pid: rec.pid,
      name: info?.name ?? rec.name ?? null,
      state,
      recorded: rec.suspended ? 'suspended' : (rec.failed ? 'failed' : 'released'),
      frozenAt: rec.suspendedAt ?? null,
      frozenForMs: rec.suspendedAt ? Date.now() - Date.parse(rec.suspendedAt) : null,
      created: rec.created ?? null,
      liveCreated: info?.created ?? null,
      releasedAt: rec.releasedAt ?? null,
      threads: info?.threads ?? null,
      suspendedThreads: info?.suspended ?? null,
      why: rec.why ?? '',
    }
  })
  rows.sort((a, b) => String(b.frozenAt ?? '').localeCompare(String(a.frozenAt ?? '')))
  return {
    ok: true,
    events: rebuilt.events,
    recordFiles: rebuilt.files,
    rows,
    frozen: rows.filter((r) => r.state === 'frozen'),
    needsAttention: rows.filter((r) => r.state === 'frozen' || r.state === 'frozen-after-release'
                                     || r.state === 'resumed-without-release'),
  }
}


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

const CUSTODY_ALERT_COOLDOWN_MS = 60 * 60 * 1000
const DEFAULT_STALE_MS = 60 * 60 * 1000

/** Custody records that are still frozen and have been for longer than `staleMs`. */
export async function staleCustody(ctx, { staleMs = DEFAULT_STALE_MS, probe = true,
                                          probeFn = null } = {}) {
  // probeFn is injectable so the alerting logic can be tested without freezing anything. The
  // default is the real thread-state probe; a test supplies a stub and asserts the outcome.
  const report = await custodyReport(ctx, probeFn ? { probe: true, probeFn } : { probe })
  if (!report.ok) return { staleMs, stale: [], report }
  const stale = report.rows.filter(
    (r) => (r.state === 'frozen' || r.state === 'frozen-after-release')
        && r.frozenForMs !== null && r.frozenForMs >= staleMs)
  return { staleMs, stale, report }
}

/**
 * Write one alert to the activity record if something has been frozen too long, and stay quiet
 * otherwise.
 *
 * Throttled per hour rather than per heartbeat: a stuck process is worth saying once an hour,
 * not every five minutes, and an alert that repeats until it is ignored protects nothing. The
 * throttle is read from the record itself, so there is no separate state to lose.
 */
export async function reconcileCustody(ctx, { staleMs = DEFAULT_STALE_MS, now = Date.now(),
                                             probeFn = null, scanFn = null } = {}) {
  // A release we did not perform is reported immediately, and not through the stale throttle:
  // it is an event rather than a condition, so it fires once per pid per freeze by construction
  // and waiting an hour to mention it would mean reporting it long after anyone could act.
  let released = []
  try {
    const un = await unauthorizedReleases(ctx, { probeFn })
    released = un.ok ? un.releases : []
  } catch {
    /* a release check that fails must not silence the other two */
  }

  const { stale } = await staleCustody(ctx, { staleMs, probeFn })
  const probeOpts = { probeFn, scanFn }
  const dir = activityDir(ctx)

  let lastAlert = 0
  try {
    const today = join(dir, 'activity-' + new Date(now).toISOString().slice(0, 10) + '.ndjson')
    const text = readFileSync(today, 'utf8')
    for (const rawLine of text.split(/\r?\n/)) {
      // Match the kind field, not the substring: an unrelated event carries the string
      // "custody-alert" inside its hint text (it tells the reader where to look), so a plain
      // includes() finds lines that are not alerts at all. The same mistake produced a false
      // "11 alerts" reading while the real count was zero.
      const line = rawLine.trim()
      if (!line.includes('"kind":"custody-alert"') && !line.includes('"kind": "custody-alert"')) continue
      try {
        const e = JSON.parse(line.charCodeAt(0) === 0xfeff ? line.slice(1) : line)
        if (e.kind === 'custody-alert') lastAlert = Math.max(lastAlert, Date.parse(e.t) || 0)
      } catch {
        /* a half-written line at the tail; the next read will have it */
      }
    }
  } catch {
    /* no record for today yet, so nothing was alerted */
  }

  // Frozen but never recorded is a different finding from recorded-and-forgotten, and it is the
  // one that was invisible: `detained` enumerates the record, so anything absent from it cannot
  // appear there. Walk the machine and subtract instead.
  let unrecorded = []
  try {
    const un = await unrecordedCustody(ctx, probeOpts)
    if (un.ok) unrecorded = un.unrecorded
  } catch {
    /* a scan failure must not silence the recorded-stale path */
  }

  if (released.length) {
    for (const r of released) {
      try {
        appendToActivity(ctx, {
          t: new Date(now).toISOString(),
          kind: 'custody-release-notice',
          action: 'released-by-something-else',
          pid: r.pid,
          name: r.name,
          frozenAt: r.frozenAt,
          detail: `pid ${r.pid} ${r.name ?? ''} was recorded as frozen and is running now, with no release through this tool`,
          hint: 'something unknown resumed it; nothing here did',
        })
      } catch {
        /* one failure must not stop the rest being reported */
      }
    }
  }

  if (!stale.length && !unrecorded.length) {
    return { alerted: false, released, stale: [], unrecorded: [],
             why: released.length
               ? `${released.length} release notice(s) written; nothing frozen past the threshold`
               : 'nothing frozen past the threshold' }
  }
  if (now - lastAlert < CUSTODY_ALERT_COOLDOWN_MS) {
    return { alerted: false, stale, unrecorded, why: 'already alerted within the last hour' }
  }

  const parts = []
  if (released.length) {
    parts.push('released by something else: ' + released.map(
      (r) => `pid ${r.pid} ${r.name ?? ''}`).join('; '))
  }
  if (stale.length) {
    parts.push('forgotten custody: ' + stale.map((r) => {
      const hours = (r.frozenForMs / 3600000).toFixed(1)
      return `pid ${r.pid} ${r.name ?? ''} frozen ${hours}h (since ${r.frozenAt ?? '?'})`
    }).join('; '))
  }
  if (unrecorded.length) {
    parts.push('frozen with no record: ' + unrecorded.map(
      (r) => `pid ${r.pid} ${r.name ?? ''} (${r.why})`).join('; '))
  }
  const line = parts.join(' | ')

  const event = {
    t: new Date(now).toISOString(),
    kind: 'custody-alert',
    action: 'stale',
    count: stale.length + unrecorded.length,
    pids: [...stale.map((r) => r.pid), ...unrecorded.map((r) => r.pid)],
    forgotten: stale.length,
    unrecorded: unrecorded.length,
    detail: line,
    hint: 'nothing was resumed automatically; run: volcano-separator detained',
  }
  try {
    appendToActivity(ctx, event)
  } catch (e) {
    return { alerted: false, stale, why: `could not write the alert: ${e?.message ?? e}` }
  }
  return { alerted: true, released, stale, unrecorded, detail: line }
}

/** Append one event to today's activity record, tolerating a concurrent writer. */
export function appendToActivity(ctx, event) {
  const dir = activityDir(ctx)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'activity-' + new Date().toISOString().slice(0, 10) + '.ndjson')
  // The recorder runs as SYSTEM and writes the same file. Append, retry a few times, and never
  // hold the handle: a collision is expected rather than exceptional.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      appendFileSync(file, JSON.stringify(event) + '\n', 'utf8')
      return true
    } catch {
      sleepSync(60 + attempt * 90)
    }
  }
  throw new Error('could not append to the activity record')
}


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
 * Scan running processes for thread states, and report the ones fully suspended.
 *
 * Deliberately tolerant: most processes on a machine refuse to be opened, and that is normal
 * rather than an error worth surfacing. The scan reports what it could read and how much it could
 * not, because "nothing found" and "nothing could be read" are different answers.
 */
export async function scanSuspended({ timeoutMs = 60000 } = {}) {
  const script = [
    '$out = @()',
    '$denied = 0',
    'foreach ($p in Get-Process -ErrorAction SilentlyContinue) {',
    '  try {',
    '    $threads = @($p.Threads)',
    '    if ($threads.Count -eq 0) { continue }',
    '    $susp = @($threads | Where-Object { $_.ThreadState -eq "Wait" -and $_.WaitReason -eq "Suspended" })',
    '    if ($susp.Count -eq $threads.Count) {',
    '      $out += @{ pid = $p.Id; name = $p.ProcessName; threads = $threads.Count;',
    '                created = $p.StartTime.ToUniversalTime().ToString("o") }',
    '    }',
    '  } catch { $denied++ }',
    '}',
    '@{ denied = $denied; suspended = @($out) } | ConvertTo-Json -Compress -Depth 4',
  ].join('\n')

  const r = await run('powershell', ['-NoProfile', '-Command', script], { timeoutMs })
  if (!r.ok) {
    return { ok: false, reason: r.error || 'process scan failed', suspended: [], denied: null }
  }
  let parsed
  try {
    parsed = JSON.parse((r.stdout || '').trim())
  } catch (e) {
    return { ok: false, reason: `could not parse the scan: ${e?.message ?? e}`, suspended: [], denied: null }
  }
  const list = Array.isArray(parsed?.suspended) ? parsed.suspended : (parsed?.suspended ? [parsed.suspended] : [])
  return { ok: true, denied: Number(parsed?.denied ?? 0), suspended: list }
}

/**
 * Suspended processes that the activity record does not account for.
 *
 * `probeFn`/`scanFn` are injectable so this can be tested without freezing anything and without
 * depending on what happens to be running on the machine at the time.
 */
export async function unrecordedCustody(ctx, { scanFn = null, now = Date.now() } = {}) {
  const rebuilt = rebuildCustody(ctx)
  const known = rebuilt.ok ? rebuilt.pids : {}

  const scan = scanFn ? await scanFn() : await scanSuspended()
  if (!scan.ok) return { ok: false, reason: scan.reason, unrecorded: [], denied: scan.denied }

  const unrecorded = []
  for (const p of scan.suspended) {
    const pid = Number(p.pid)
    const rec = known[pid]
    if (!rec) {
      unrecorded.push({ pid, name: p.name ?? null, threads: p.threads ?? null,
                        created: p.created ?? null, why: 'no record of a detain for this pid' })
      continue
    }
    // A pid is not an identity: a frozen process whose creation time differs from the recorded
    // one is a different process wearing a recycled number.
    if (rec.created && p.created && String(rec.created).slice(0, 16) !== String(p.created).slice(0, 16)) {
      unrecorded.push({ pid, name: p.name ?? null, threads: p.threads ?? null,
                        created: p.created ?? null,
                        why: 'pid was recorded, but this is a different process than the recorded one' })
    }
  }
  return { ok: true, denied: scan.denied, unrecorded, scannedAt: new Date(now).toISOString() }
}


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
 * Recorded as under custody, but running now.
 *
 * `probeFn` is injectable for the same reason as elsewhere: the decision should be testable
 * without freezing anything real.
 */
export async function unauthorizedReleases(ctx, { probeFn = null, now = Date.now() } = {}) {
  const report = await custodyReport(ctx, probeFn ? { probe: true, probeFn } : { probe: true })
  if (!report.ok) return { ok: false, reason: report.reason, releases: [] }

  const candidates = report.rows.filter((r) => r.state === 'resumed-without-release')
  if (!candidates.length) return { ok: true, releases: [], now }

  const alreadyNoticed = noticesByPid(ctx)
  const releases = []
  for (const r of candidates) {
    const noticedAt = alreadyNoticed.get(r.pid) ?? 0
    const frozenAt = Date.parse(r.frozenAt ?? '') || 0
    // Only a notice that came after the freeze it relates to counts. A re-detained pid whose
    // release was already reported is a fresh event and should be reported again.
    if (noticedAt >= frozenAt) continue
    releases.push({
      pid: r.pid,
      name: r.name ?? null,
      frozenAt: r.frozenAt ?? null,
      why: 'recorded as frozen, but the process is running and no release was recorded',
    })
  }
  return { ok: true, releases, now }
}

/** The timestamps of release notices already written, keyed by pid. */
function noticesByPid(ctx) {
  const dir = activityDir(ctx)
  const seen = new Map()
  let files = []
  try {
    files = readdirSync(dir).filter((f) => /^activity-\d{4}-\d{2}-\d{2}\.ndjson$/.test(f))
  } catch {
    return seen
  }
  for (const f of files) {
    let text
    try {
      text = readFileSync(join(dir, f), 'utf8')
    } catch {
      continue
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      // Match the kind field rather than the substring: an unrelated event can carry this string
      // inside its hint text, and counting those was a real bug once already.
      if (!line.includes('"kind":"custody-release-notice"') &&
          !line.includes('"kind": "custody-release-notice"')) continue
      try {
        const e = JSON.parse(line.charCodeAt(0) === 0xfeff ? line.slice(1) : line)
        if (e.kind !== 'custody-release-notice') continue
        const pid = Number(e.pid)
        if (Number.isInteger(pid)) seen.set(pid, Math.max(seen.get(pid) ?? 0, Date.parse(e.t) || 0))
      } catch {
        /* a half-written tail line; the next read will have it */
      }
    }
  }
  return seen
}


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

const CUSTODY_EVENT_KINDS = new Set(['detain', 'custody-alert', 'custody-release-notice'])

/** Every custody-related event in the record, oldest first. */
export function custodyEvents(ctx, { sinceDays = null, now = Date.now() } = {}) {
  const dir = activityDir(ctx)
  let files = []
  try {
    files = readdirSync(dir).filter((f) => /^activity-\d{4}-\d{2}-\d{2}\.ndjson$/.test(f)).sort()
  } catch {
    return { ok: false, reason: 'no activity record', events: [] }
  }
  if (sinceDays !== null) {
    const cutoff = new Date(now - sinceDays * 86400000).toISOString().slice(0, 10)
    files = files.filter((f) => f.slice('activity-'.length, -'.ndjson'.length) >= cutoff)
  }

  const events = []
  for (const f of files) {
    let text
    try {
      text = readFileSync(join(dir, f), 'utf8')
    } catch {
      continue
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      // Cheap pre-filter, but the kind field decides: an unrelated event can carry these strings
      // inside its hint text, and trusting a substring produced a real false reading once.
      if (!line.includes('"detain"') && !line.includes('"custody-alert"') &&
          !line.includes('"custody-release-notice"')) continue
      let e
      try {
        e = JSON.parse(line.charCodeAt(0) === 0xfeff ? line.slice(1) : line)
      } catch {
        continue
      }
      if (!CUSTODY_EVENT_KINDS.has(e.kind)) continue
      events.push(e)
    }
  }
  events.sort((a, b) => String(a.t ?? '').localeCompare(String(b.t ?? '')))
  return { ok: true, files: files.length, events }
}

/**
 * Group the events into one lifecycle per freeze, with the notices that fired while it was live.
 *
 * A notice is attached to the freeze it followed rather than listed separately: "we warned about
 * this freeze three times" only means something next to the freeze it was about.
 */
export function custodyTimeline(ctx, opts = {}) {
  const { ok, reason, files, events } = custodyEvents(ctx, opts)
  if (!ok) return { ok: false, reason, lifecycles: [] }

  const lifecycles = []
  let current = null
  const systemNotices = []

  for (const e of events) {
    if (e.kind === 'detain') {
      const pid = Number(e.pid)
      if (e.action === 'suspended') {
        current = {
          pid,
          name: e.name ?? null,
          command: e.cmd ?? null,
          why: e.why ?? null,
          created: e.created ?? null,
          frozenAt: e.t ?? null,
          entries: [{ at: e.t, what: 'frozen', detail: e.why ?? '' }],
          notices: [],
          endedAt: null,
          outcome: null,
          durationMs: null,
        }
        lifecycles.push(current)
        continue
      }
      if (!Number.isInteger(pid)) continue
      // Attach to the most recent lifecycle for this pid that has not ended.
      const target = [...lifecycles].reverse().find((l) => l.pid === pid && !l.endedAt)
      if (e.action === 'released') {
        if (target) {
          target.endedAt = e.t ?? null
          target.outcome = 'released'
          target.entries.push({ at: e.t, what: 'released', detail: 'through this tool' })
          target.durationMs = msBetween(target.frozenAt, target.endedAt)
          current = null
        } else {
          systemNotices.push({ at: e.t, what: 'released',
                               detail: `pid ${pid} released with no recorded freeze` })
        }
        continue
      }
      if (e.action === 'failed') {
        systemNotices.push({ at: e.t, what: 'detain failed',
                             detail: `pid ${pid}: ${e.why ?? 'no reason recorded'}` })
        continue
      }
      if (e.action === 'revealed' && target) {
        target.entries.push({
          at: e.t, what: 'windows revealed',
          detail: `${e.windows ?? '?'} window(s), ${e.forced ?? 0} forced visible`,
        })
      }
      continue
    }

    // Notices: attach to the live lifecycle for that pid, or record them as system-level.
    const pid = Number(e.pid)
    const target = [...lifecycles].reverse().find((l) => l.pid === pid && !l.endedAt)
    const entry = {
      at: e.t,
      what: e.kind === 'custody-alert' ? 'alert: stale custody'
          : 'alert: released by something else',
      detail: e.detail ?? '',
    }
    if (target) target.notices.push(entry)
    else systemNotices.push(entry)
  }

  // Anything still open is not "unfinished" -- it is a freeze that never ended, which is the
  // state worth noticing, so the outcome says that rather than leaving it blank.
  for (const l of lifecycles) {
    if (!l.endedAt) {
      l.outcome = 'never released'
      l.durationMs = msBetween(l.frozenAt, new Date().toISOString())
    }
  }

  const byOutcome = {}
  for (const l of lifecycles) byOutcome[l.outcome] = (byOutcome[l.outcome] ?? 0) + 1

  return {
    ok: true,
    files,
    events: events.length,
    lifecycles,
    systemNotices,
    byOutcome,
    open: lifecycles.filter((l) => !l.endedAt),
  }
}

/**
 * A timeline with the live system folded in.
 *
 * A decision recorded as "never released" reads as an outstanding problem, but if the process no
 * longer exists there is nothing to release and the record is simply history. That distinction is
 * the difference between a to-do and an archive entry, so each open decision carries what the
 * system says about it now -- and whether the process is still frozen, running, or gone.
 */
export async function custodyTimelineLive(ctx, opts = {}) {
  const t = custodyTimeline(ctx, opts)
  if (!t.ok) return t
  const open = t.open
  if (!open.length) return { ...t, checked: true }

  const probeFn = opts.probeFn ?? null
  const live = await (probeFn ?? probeCustody)(open.map((l) => l.pid))
  const lifecycles = t.lifecycles.map((l) => {
    if (l.endedAt) return l
    const info = live[l.pid]
    let liveState = 'unknown'
    if (info && info.exists === false) liveState = 'process gone'
    else if (info && info.exists) liveState = info.frozen ? 'still frozen' : 'running'
    return { ...l, liveState, liveThreads: info?.threads ?? null,
             liveSuspended: info?.suspended ?? null }
  })
  return { ...t, lifecycles, checked: true,
           open: lifecycles.filter((l) => !l.endedAt) }
}

function msBetween(a, b) {
  const ta = Date.parse(a ?? '')
  const tb = Date.parse(b ?? '')
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null
  return tb - ta
}

/** "2h 14m" -- a duration a person can read at a glance. */
export function humanDuration(ms) {
  if (ms === null || ms === undefined) return '?'
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}
