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
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

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
  const ctx = {
    ...c,
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
  const { timeoutMs = 0, env = process.env, cwd = undefined } = opts
  return new Promise((resolve) => {
    const started = Date.now()
    let child
    try {
      child = spawn(cmd, args, { env, cwd, windowsHide: true })
    } catch (e) {
      return resolve({ ok: false, code: null, signal: null, ms: 0, stdout: '', stderr: '', error: String(e?.message ?? e) })
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let timer = null
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        try {
          child.kill()
        } catch {
          /* already gone */
        }
      }, timeoutMs)
    }
    child.stdout?.on('data', (d) => (stdout += d))
    child.stderr?.on('data', (d) => (stderr += d))
    child.on('error', (e) => {
      if (timer) clearTimeout(timer)
      resolve({ ok: false, code: null, signal: null, ms: Date.now() - started, stdout, stderr, error: String(e?.message ?? e) })
    })
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      resolve({
        ok: code === 0 && !timedOut,
        code,
        signal,
        ms: Date.now() - started,
        stdout,
        stderr,
        timedOut,
        error: timedOut ? `timed out after ${timeoutMs} ms` : code === 0 ? null : `exit code ${code}`,
      })
    })
  })
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
 * Is the env hot? Dry-run uvx once and see whether it is downloading/building right now.
 * Hot = returns in seconds; cold = stalls or takes minutes. The timeout here is only for
 * *probing*; once "cold" is decided, warm() completes the work with no watchdog at all.
 */
export async function probeEnv(ctx) {
  if (!ctx.uvx) return { ok: false, warm: false, detail: 'no uvx' }
  const args = ['--with', ...ctx.withPackages, `hindsight-embed@${ctx.embedVersion}`, '--help']
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

  const args = ['--with', ...ctx.withPackages, `hindsight-embed@${ctx.embedVersion}`, '--help']
  const r = await run(ctx.uvx, args, { timeoutMs: ctx.warmBudgetMs, env: ctx.env })
  const text = (r.stdout + r.stderr).trim()
  const installed = /Installed\s+(\d+)\s+packages?/i.exec(text)

  if (!r.ok) {
    return {
      ok: false,
      step: 'warm',
      ms: r.ms,
      detail: r.timedOut ? `warm-up exceeded its ${Math.round(ctx.warmBudgetMs / 1000)} s budget` : `warm-up failed: ${r.error}`,
      tail: text.slice(-1500),
    }
  }
  return {
    ok: true,
    step: 'warm',
    ms: r.ms,
    detail: installed ? `env ready; installed ${installed[1]} packages this time (${r.ms} ms)` : `env ready (${r.ms} ms)`,
    tail: text.slice(-500),
  }
}

// ────────────────────────────────────────────────────────────────────────────
// serve: start the service. **Only meaningful once the env is hot** -- which is exactly
// why it can never trip a timeout.
// ────────────────────────────────────────────────────────────────────────────

export function daemonArgs(ctx, sub) {
  const args = ['--with', ...ctx.withPackages, `hindsight-embed@${ctx.embedVersion}`, 'daemon', '--profile', ctx.profile, sub]
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
  const r = await run(ctx.uvx, daemonArgs(ctx, 'start'), { timeoutMs: ctx.serveBudgetMs, env: ctx.env })
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

export async function heal(ctx, { log = () => {}, force = false } = {}) {
  const steps = []
  const push = (s) => {
    steps.push(s)
    return s
  }

  // 0. Fast path: if healthy, return immediately. Cost = one TCP connection.
  const health0 = await probeDaemon(ctx)
  if (health0.ok && !force) {
    log(`service healthy (${health0.detail}); nothing to do`)
    return { ok: true, healthy: true, fastPath: true, steps: [push({ step: 'probe', ok: true, detail: health0.detail })] }
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
  return join(projectDir, 'bin', 'guard-task.cmd')
}

export async function installService(ctx, { projectDir, nodePath = process.execPath, dryRun = false } = {}) {
  if (process.platform !== 'win32') return { ok: false, detail: 'scheduled-task installation is Windows-only for now' }
  const cli = join(projectDir, 'bin', 'cli.mjs')
  if (!existsSync(cli)) return { ok: false, detail: `CLI not found: ${cli}` }

  const cmdPath = taskScriptPath(ctx, projectDir)
  const script = [
    '@echo off',
    'rem volcano-separator watch heartbeat: a single TCP probe when healthy, repair only when not.',
    `"${nodePath}" "${cli}" heal --quiet`,
    '',
  ].join('\r\n')

  const ps = `
$ErrorActionPreference = 'Stop'
$action  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c "${cmdPath}"'
# Indefinite repetition: do NOT pass -RepetitionDuration. [TimeSpan]::MaxValue serialises to
# P99999999DT23H59M59S and the Task Scheduler rejects it (0x80041318). Omitting Duration IS
# the indefinite case.
$repeat  = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes ${ctx.taskIntervalMinutes})
$logon   = New-ScheduledTaskTrigger -AtLogOn
$logon.Repetition = $repeat.Repetition
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName '${ctx.taskName}' -Action $action -Trigger @($logon, $repeat) -Settings $settings -Force | Out-Null
'registered'
`.trim()

  if (dryRun) {
    return { ok: true, dryRun: true, script, cmdPath, detail: `(dry-run) would register scheduled task ${ctx.taskName}, running every ${ctx.taskIntervalMinutes} minutes` }
  }

  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync(join(projectDir, 'bin'), { recursive: true })
  writeFileSync(cmdPath, script, 'utf8')

  const r = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { timeoutMs: 120000 })
  const text = (r.stdout + r.stderr).trim()
  const good = r.ok && /registered/.test(r.stdout)
  return {
    ok: good,
    cmdPath,
    ms: r.ms,
    detail: good
      ? `registered scheduled task ${ctx.taskName} (at logon + every ${ctx.taskIntervalMinutes} minutes)`
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
