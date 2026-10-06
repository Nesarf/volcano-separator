import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { connect } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { run, sleep } from './platform.mjs'
import { decideDefer, probeResources, waitForHeadroom } from './resources.mjs'
import { reconcileCustody } from './custody.mjs'
import { acquireLock, releaseLock } from './lock.mjs'
import { probeDatabaseQuery } from './database.mjs'
import { serviceArgs } from './service.mjs'

/**
 * The supervisor: keep the service reachable, and say what is wrong in layers.
 *
 * Extracted from core.mjs. This is the part the tool was built for, and the reason it is one file
 * is that its whole argument is a sequence: probe, then decide which layer is broken, then repair
 * only that layer, then verify. Split across files the sequence would be harder to follow than it
 * is to read.
 *
 * The property that makes it affordable to run often: heal costs about a second when healthy, so
 * the OS scheduler can do the watching and no process has to stay resident.
 */
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

/**
 * A transcript path for one step of one recovery.
 *
 * The stamp used to be truncated to the second, so two runs starting in the same second -- a manual
 * `heal` and the heartbeat, which is exactly the pair that collides -- wrote to one file and each
 * overwrote the other. The symptom is not a missing log but a log that mixes two recoveries, which is
 * worse: it reads as one confusing run instead of two clear ones.
 *
 * The `runId` is what makes a recovery reassemblable. `heal` generates one and hands it to every step
 * it takes, so the `warm` and `serve` transcripts of a single repair can be recognised as one repair
 * afterwards. Without it the only link between them is the wall clock, and the reason this tool keeps
 * transcripts at all is to answer "what happened during that repair" once it is over.
 */
// A counter, because the file does not exist yet when newLogPath returns.
//
// The first attempt at an overwrite guard checked the filesystem for a clash, which cannot work
// here: the function returns a PATH and the caller writes it later, so two calls in the same
// millisecond both see an empty directory and both return the same name. Across processes the pid
// separates them; within one process this does. Together those cover the whole space a collision
// can happen in, which is what makes a counter the right answer rather than more randomness.
let logCounter = 0

export function newLogPath(ctx, label, { runId = null } = {}) {
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

  // Milliseconds kept, and the pid appended: two processes can still share a millisecond, and a name
  // that cannot collide is worth more than one that is merely unlikely to.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const parts = [stamp, label]
  if (runId) parts.push(runId)
  parts.push(String(process.pid))

  logCounter += 1

  let file = join(dir, `${parts.join('-')}-${logCounter}.log`)
  // Belt and braces for a name that somehow still exists -- a reused pid, a restart into the same
  // millisecond -- so a transcript is never written over one somebody might be reading. The counter
  // above is what actually prevents the collision; this only covers the residue.
  for (let n = 2; existsSync(file) && n < 100; n++) {
    file = join(dir, `${parts.join('-')}-${logCounter}-${n}.log`)
  }
  return file
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

export function taskScriptPath(ctx, projectDir) {
  return join(projectDir, 'bin', 'guard-task.vbs')
}

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

/** Is Postgres reachable, and does the embedded instance exist on disk? */
/**
 * Where the database's data is, and which deployment that implies. Filesystem only, so it is free
 * to call from a probe.
 *
 * This used to be a hardcoded `~/.pg0/instances/hindsight-embed-<profile>/data` inside a probe that
 * also reported whether the database was reachable -- which quietly asserted that the embedded
 * layout is the only one. The service that starts the database and the directory the data lives in
 * are answers to two different questions: how it is deployed, and how its process is managed. A
 * machine with a database somewhere else was told its data directory was missing.
 *
 *   embedded  a pg0 instance under ~/.pg0, which is where the embed manager puts one
 *   declared  the caller said where it is (ctx.pgDataDir)
 *   unknown   neither, and the expected embedded layout is not there either
 */
export function pgDataLocation(ctx) {
  const embeddedDir = join(homedir(), '.pg0', 'instances', `hindsight-embed-${ctx.profile}`, 'data')
  if (ctx.pgDataDir) {
    return { dataDir: resolve(ctx.pgDataDir), deployment: 'declared', exists: existsSync(resolve(ctx.pgDataDir)), why: 'ctx.pgDataDir' }
  }
  const exists = existsSync(embeddedDir)
  return {
    dataDir: embeddedDir,
    deployment: exists ? 'embedded' : 'unknown',
    exists,
    why: exists ? `~/.pg0/instances/hindsight-embed-${ctx.profile}` : 'expected embedded layout, and it is not there',
  }
}
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

  const loc = pgDataLocation(ctx)

  // A socket that accepts connections is not a database that works. `5432 LISTEN` plus a data
  // directory plus a failed SQL handshake is a state that exists -- recovery mode, a full connection
  // table, a revoked role, a wrong password -- and all of them are invisible to a socket probe. The
  // daemon then comes up answering 503, which reads as a daemon fault and is not one.
  //
  // Only asked when the cheap checks already passed: there is nothing to learn about a database
  // whose port is closed, and a failing probe should name the layer that failed rather than the last
  // one it tried.
  const query = listening && loc.exists ? await probeDatabaseQuery(ctx, { timeoutMs: 15000 }) : null

  const howFar = !listening ? 'socket' : !loc.exists ? 'data-dir' : query?.checked ? 'query' : 'socket'
  return {
    ok: Boolean(listening && loc.exists && query?.ok),
    listening,
    dataDir: loc.dataDir,
    hasData: loc.exists,
    deployment: loc.deployment,
    port: ctx.pgPort,
    // How far the answer got, so a failure names the layer instead of reporting one word for four
    // different situations.
    reached: howFar,
    queryable: query ? query.ok : null,
    detail: !listening
      ? `nothing listening on 127.0.0.1:${ctx.pgPort} (${loc.deployment}: ${loc.why})`
      : !loc.exists
        ? `listening on ${ctx.pgPort}, but no data dir at ${loc.dataDir} (${loc.deployment})`
        : query && !query.ok
          ? `listening on ${ctx.pgPort} with data at ${loc.dataDir}, but it could not be queried: ${query.detail}`
          : query && query.checked
            ? `listening on ${ctx.pgPort}, ${loc.deployment} data at ${loc.dataDir}, and it answered a query`
            : `listening on ${ctx.pgPort}, ${loc.deployment} data at ${loc.dataDir} (not queried: ${query ? query.detail : 'not attempted'})`,
  }
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
  // Built from the service descriptor, which is the one place the module name lives. Four copies
  // of this line used to exist; they agreed, and nothing made them.
  const probeArgs = serviceArgs(ctx.serviceDescriptor, ctx, { uvArgs: uvFlags(ctx), offline: true })
  if (!probeArgs.ok) return { ok: false, undetermined: true, detail: probeArgs.detail }
  const args = [...probeArgs.args, '--help']
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

export function daemonArgs(ctx, sub) {
  const built = serviceArgs(ctx.serviceDescriptor, ctx, { uvArgs: uvFlags(ctx), sub })
  // A refused build is returned as an empty list, which the caller's own error handling reports.
  // Guessing a module name would be worse than not starting anything.
  return built.ok ? built.args : []
}

/**
 * Make sure the database is actually running before anything tries to use it.
 *
 * Sequencing, not decoration. A daemon started against a database that is down comes up and
 * answers 503 -- which looks like a daemon fault and is not one. This machine learned that the
 * hard way: the daemon ran for twenty minutes reporting an unusable database while every
 * process-level check called it healthy.
 *
 * Two questions, answered separately, because conflating them is how "no service named
 * hindsight-pg" came to mean "the database is not managed here" -- which is true only if nothing
 * else is managing it. Deployment (where the data is) comes from pgDataLocation; management (who
 * starts the process) is what this function decides, and it now says which of the two it found
 * rather than reporting a skip that reads like a shrug.
 *
 *   windows-service  a service with the configured name exists and this starts it
 *   embed-manager    no such service, so the tool's own start path owns the database
 *   external         no such service and no embedded data either: something else is serving it
 */
export async function ensurePgService(ctx, { log = () => {} } = {}) {
  if (process.platform !== 'win32') return { ok: true, skipped: true, management: 'unsupported', detail: 'not Windows' }
  const name = ctx.pgService ?? 'hindsight-pg'
  const loc = pgDataLocation(ctx)

  const r = await run('powershell', ['-NoProfile', '-Command',
    `$s = Get-Service -Name '${name}' -ErrorAction SilentlyContinue; if ($s) { $s.Status.ToString() } else { 'absent' }`],
    { timeoutMs: 30000 })
  const state = (r.stdout ?? '').trim()

  if (!/^[A-Za-z]/.test(state) || state === 'absent') {
    // Not managed here is a conclusion, not a shrug, and which one it is depends on whether the
    // embedded data is present: the tool starts that itself.
    const management = loc.deployment === 'embedded' || loc.deployment === 'declared' ? 'embed-manager' : 'external'
    return {
      ok: true,
      skipped: true,
      management,
      deployment: loc.deployment,
      detail:
        management === 'embed-manager'
          ? `no '${name}' service; the ${loc.deployment} database is started by this tool when needed`
          : `no '${name}' service and no embedded data at ${loc.dataDir}; the database is served elsewhere`,
    }
  }
  if (state === 'Running') {
    return { ok: true, running: true, management: 'windows-service', deployment: loc.deployment, detail: `database service '${name}' is running (${loc.deployment} data at ${loc.dataDir})` }
  }

  log(`database service '${name}' is ${state}; starting it`)
  await run('powershell', ['-NoProfile', '-Command', `Start-Service -Name '${name}'`], { timeoutMs: 120000 })

  // Wait for it to accept connections rather than assuming Start-Service returning means ready.
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

export async function warm(ctx, { force = false, log = () => {}, runId = null } = {}) {
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

  const warmArgs = serviceArgs(ctx.serviceDescriptor, ctx, { uvArgs: uvFlags(ctx) })
  if (!warmArgs.ok) return { ok: false, detail: warmArgs.detail }
  const args = [...warmArgs.args, '--help']
  const logFile = newLogPath(ctx, 'warm', { runId })
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

export async function serve(ctx, { log = () => {}, runId = null } = {}) {
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
  const svcLog = newLogPath(ctx, 'serve', { runId })
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

export async function restart(ctx, opts = {}) {
  const s = await stop(ctx)
  if (s.ok) await sleep(1500)
  return serve(ctx, opts)
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

  // From here on this function mutates things, and nothing used to stop two of it running at once.
  // The heartbeat fires every five minutes and a manual heal or an MCP call can start at any moment:
  // measured over 514 heartbeats on this machine, 16 overlapped the previous one, and the worst ran
  // for thirty minutes while the next had already begun. Two concurrent recoveries can warm the same
  // environment twice and report two different conclusions about one machine.
  //
  // The lock is taken after the fast path rather than around the whole function, because the common
  // case is one probe that concludes 'healthy' and holding a lock for it would make the cheap
  // question expensive.
  // One identifier for the whole repair, so its steps can be recognised as one repair afterwards.
  // Short on purpose: it appears in file names, and its job is to be distinctive within a day, not
  // to be globally unique.
  const runId = randomBytes(4).toString('hex')
  log(`recovery run ${runId}`)
  push({ step: 'run', id: runId })

  const lock = acquireLock(ctx, 'recovery', { holder: `heal pid ${process.pid}` })
  if (!lock.ok) {
    const h = lock.holder ?? {}
    log(`another recovery is in progress (${h.holder ?? 'unknown'} pid ${h.pid ?? '?'}, ${Math.round((lock.ageMs ?? 0) / 1000)}s); standing down`)
    push({ step: 'lock', ok: false, busy: true, holder: h })
    // A skipped heartbeat must not look like a healthy one. That distinction is the whole reason
    // this tool exists, and the one place it is easiest to lose track of.
    return { ok: false, busy: true, skipped: true, reason: 'recovery-in-progress', holder: h, steps }
  }
  if (lock.takenOverFrom) log(`took over a stale recovery lock: ${JSON.stringify(lock.takenOverFrom)}`)
  push({ step: 'lock', ok: true, takenOverFrom: lock.takenOverFrom ?? null })

  try {

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
    const r = await restart(ctx, { log, runId })
    push({ step: 'restart', ok: r.ok, detail: r.detail ?? '' })
    return { ok: r.ok, healthy: r.ok, failedAt: r.ok ? undefined : 'restart', steps, ...r }
  }

  // 2. warm -- get the build out of the way **with no watchdog**
  const w = await warm(ctx, { force, log, runId })
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
  const s = await serve(ctx, { log, runId })
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
  } finally {
    releaseLock(ctx, 'recovery')
  }
}

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
    `             profile    ${ctx.profile} (${ctx.runtimeModule}@${ctx.embedVersion})`,
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
