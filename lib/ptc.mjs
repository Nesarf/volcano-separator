/**
 * Programmatic tool calls over HTTP: one request carries a program, the program calls the tool
 * surface, one structured result comes back.
 *
 * Why this exists next to the MCP server
 * --------------------------------------
 * `mcp.mjs` answers one tool per round trip. A repair that is really "check, then act, then check
 * again" costs three round trips and puts the sequencing in the caller's head. A program puts the
 * sequencing where it is testable:
 *
 *   const s = await tools.volcano_heal_status({})
 *   if (!s.ok) {
 *     const ps = await tools.volcano_ps({})
 *     return { heal: s, processes: ps }
 *   }
 *   return { heal: s }
 *
 * This is not a second implementation of anything. The bindings are generated from `TOOLS` and
 * dispatch through `call()` in `tools.mjs`, the same two things `mcp.mjs` uses. A tool fixed there
 * is fixed here, and a schema that changes there changes here.
 *
 * What this is NOT
 * ----------------
 * **`node:vm` is not a security boundary.** Node's own documentation says so. A context built here
 * keeps a program away from `require`, `process` and the module loader, and the binding list is
 * fixed -- but a determined program in a V8 context is not a sandbox, and this module does not
 * claim otherwise. The honest description is "a place to put sequencing", with file and process
 * authority still living in the tool implementations on the other side of the binding.
 *
 * Because of that, the write path stays out. `volcano_heal` is the one tool that changes the
 * machine from a distance, and it already has two callers with their own gates: the five-minute
 * heartbeat and an explicit MCP call. An anonymous HTTP endpoint would be a third gate that is
 * really a hole in the other two. It is excluded here by name, and the exclusion is asserted in the
 * binding list rather than left to a reader to notice.
 *
 * Returning text rather than fields
 * ---------------------------------
 * `call()` answers `{ ok, text }`, where text is prose written for a harness to show. Wrapping that
 * as-is keeps one return shape across both entry points. A program that needs fields should get
 * them from a structured dispatcher added to `tools.mjs`, not from parsing text here.
 */

import http from 'node:http'
import vm from 'node:vm'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TOOLS, call } from './tools.mjs'
import { extrasFunctions, extrasTools, loadExtras } from './extras.mjs'
import { loadPlugins, pluginsForPage } from './plugins.mjs'
import { createGate, quiesceFunctions, quiesceTools, readPending } from './quiesce.mjs'
import { loadPalette, renderPage } from './ui.mjs'

// One version, read from the one place that declares it. The placeholder is deliberately not a
// plausible number: a page that says "unknown" is honest about a broken install, while one that says
// 1.5.0 when package.json could not be read is repeating a value that may have moved.
let VERSION = 'unknown'
try {
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
  if (pkg?.version) VERSION = pkg.version
} catch {
  /* keep the placeholder */
}

/** Tools a program may call. Everything read-only; `volcano_heal` is the one deliberate omission. */
export const DENIED = Object.freeze(['volcano_heal'])

/** Bound the work one request can create, so a loop in a program cannot occupy the server. */
const LIMITS = Object.freeze({
  bodyBytes: 256 * 1024,
  programBytes: 64 * 1024,
  syncMs: 5_000,
  defaultBudgetMs: 30_000,
  maxBudgetMs: 120_000,
  maxLogLines: 500,
  maxLogChars: 64 * 1024,
  maxOutputChars: 256 * 1024,
})

const NL = String.fromCharCode(10)

/**
 * What the token defends against, stated so it is not read as more than it is
 * -------------------------------------------------------------------------
 * NOT "local security". Any process running as this user can read this file, read the environment,
 * and attach to this one. A secret cannot defend against a peer that already has equal authority, so
 * claiming it does would be exactly the false signal this project removes.
 *
 * What it does defend against is a page on another origin. Such a page can send `GET /` here -- that
 * is a simple request and needs no permission -- but without a CORS header it cannot read the
 * response, so the token inlined into this page never reaches it. It also cannot send
 * `POST /ptc/run` at all: a JSON content type and a custom header together make the request
 * preflighted, and this server answers no preflight and never attaches `Access-Control-*`.
 *
 * So the *shape* requirement is the load-bearing defence and the token is the second lock. Both are
 * checked. Dropping either one turns this into decoration: without the shape check a page can post
 * `text/plain` from a form, and without the token anything that guesses the port can run a program.
 */
const TOKEN_HEADER = 'x-vsep-token'
const DEFAULT_TOKEN_FILE = join(homedir(), '.volcano-separator', 'ptc.token')

/**
 * The token from a file, or a fresh one written there. A file rather than an environment variable
 * because there are two callers that are not the same process -- the page, and whatever script the
 * user writes -- and a file is something both can be handed. Nothing prints the value: `ptcInfo`
 * carries the path, and a path is what a caller needs.
 */
function resolveToken(tokenPath) {
  const where = tokenPath || DEFAULT_TOKEN_FILE
  try {
    const existing = readFileSync(where, 'utf8').trim()
    if (existing.length >= 32) return { token: existing, path: where, created: false }
  } catch {
    /* not written yet -- fall through and make one */
  }
  const token = randomBytes(32).toString('hex')
  mkdirSync(dirname(where), { recursive: true })
  writeFileSync(where, token + NL, { mode: 0o600 })
  return { token, path: where, created: true }
}

/**
 * Compare without leaking where they diverge. An unequal length is answered `false` before the call
 * rather than after it, because `timingSafeEqual` throws on different lengths -- which would turn a
 * guessable header into a 500 and tell the caller their guess was the wrong shape.
 */
function tokenMatches(given, expected) {
  const a = Buffer.from(String(given ?? ''), 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * The failure taxonomy is orthogonal on purpose: a budget expiry is not an exception, an abort is
 * not a timeout, and a program that produced the wrong kind of value failed differently from one
 * that threw. Reporting them as one kind would make a caller guess which.
 */
export const FAILURE_KINDS = Object.freeze([
  'exception',
  'timeout',
  'abort',
  'worker-exit',
  'invalid-output',
  'output-limit',
])

function failure(kind, message) {
  if (!FAILURE_KINDS.includes(kind)) throw new Error(`not a failure kind: ${kind}`)
  return { kind, message }
}

/**
 * Lossless JSON, as PTC means it: the value survives a round trip through JSON. `undefined`,
 * functions, symbols, bigints and non-finite numbers do not, and `JSON.stringify` turns the first
 * four into silence rather than an error -- so they are rejected here, where the caller can be told.
 */
export function isLosslessJson(value, seen = new Set()) {
  if (value === null) return true
  const t = typeof value
  if (t === 'boolean' || t === 'string') return true
  if (t === 'number') return Number.isFinite(value)
  if (t !== 'object') return false // undefined, function, symbol, bigint
  if (seen.has(value)) return false // cycle
  seen.add(value)
  const ok = Array.isArray(value)
    ? value.every((v) => isLosslessJson(v, seen))
    : Object.values(value).every((v) => isLosslessJson(v, seen))
  seen.delete(value)
  return ok
}

/**
 * The bindings a program sees, as PTC defines them: a namespace global holding async callables that
 * take one argument object and resolve to lossless JSON.
 *
 * Each wrapper is generated, not written out, for the same reason the split exists: a hand-written
 * copy per tool is a copy that drifts.
 */
export function buildBindings({ extras = [], gated = {} } = {}) {
  const functions = Object.create(null)
  for (const tool of TOOLS) {
    if (DENIED.includes(tool.name)) continue
    const name = tool.name
    functions[name] = async (args) => {
      if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
        throw new TypeError(`${name} takes one object argument`)
      }
      let a = args ?? {}
      // `deep` warms the uv env through uvx, which writes to the cache. The MCP surface leaves that
      // behind a flag the caller has to choose; a program gets the cheap answer unless it says so,
      // and saying so through this endpoint would be the one path that writes from a read-only list.
      if (name === 'volcano_status' && 'deep' in a) a = { ...a, deep: a.deep === true }
      const r = await call(name, a)
      return { ok: r.ok === true, text: String(r.text ?? '') }
    }
  }
  // The gated bindings sit between the built-ins and the external commands, and they are the only
  // ones that change the machine. Their names come from the code that started this server rather than
  // from a data file: suspending the heartbeat is a decision, and a decision is not something a JSON
  // file should be able to add to a running process.
  for (const [name, fn] of Object.entries(gated)) {
    if (name in functions) throw new Error(`a gated binding is named "${name}", which a built-in tool already is`)
    functions[name] = fn
  }
  // External commands share this one namespace, so a collision is a configuration mistake that has to
  // be refused out loud. Silently shadowing a built-in tool would be the worst of both: the built-in
  // disappears from a program's view and the file looks like it worked.
  for (const [name, fn] of Object.entries(extrasFunctions(extras))) {
    if (name in functions) throw new Error(`an external binding is named "${name}", which a built-in tool already is`)
    functions[name] = fn
  }
  return [{ global: 'tools', functions }]
}

/** The tools a program can reach, for the discovery endpoint: the built-ins, the gated ones, any extras. */
export function exposedTools({ extras = [], gatedTools = [] } = {}) {
  const builtin = TOOLS.filter((t) => !DENIED.includes(t.name)).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }))
  const seen = new Set(builtin.map((t) => t.name))
  for (const t of gatedTools) {
    if (seen.has(t.name)) throw new Error(`a gated binding is named "${t.name}", which a built-in tool already is`)
    seen.add(t.name)
  }
  const external = extrasTools(extras).filter((t) => {
    if (seen.has(t.name)) throw new Error(`an external binding is named "${t.name}", which a built-in tool already is`)
    seen.add(t.name)
    return true
  })
  return [...builtin, ...gatedTools, ...external]
}

function clampBudget(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return LIMITS.defaultBudgetMs
  return Math.min(LIMITS.maxBudgetMs, Math.max(1, Math.round(n)))
}

/**
 * Run one program against the tool bindings.
 *
 * The program body is what a caller writes: statements, `await`, and a `return`. It is wrapped in an
 * async function so `return` means what a reader expects; a REPL-shaped program with a trailing
 * expression is not accepted here, because two accepted shapes need two rules and this can wait.
 *
 * `timeout` and `abort` are reported as themselves, and the program is not claimed to have stopped:
 * a Promise cannot be cancelled from outside, so the deadline ends the *waiting*, which is the only
 * thing this function actually controls.
 */
export async function runProgram({ program, timeoutMs, signal, bindings, args } = {}) {
  const logs = []
  const pushLog = (line) => {
    if (logs.length >= LIMITS.maxLogLines) return
    logs.push(String(line).slice(0, 2000))
  }

  if (typeof program !== 'string' || !program.trim()) {
    return { logs, error: failure('exception', 'program must be a non-empty string') }
  }
  if (Buffer.byteLength(program, 'utf8') > LIMITS.programBytes) {
    return { logs, error: failure('output-limit', `program exceeds ${LIMITS.programBytes} bytes`) }
  }
  if (signal?.aborted) return { logs, error: failure('abort', 'aborted before the program started') }

  const namespaces = bindings ?? buildBindings()
  const sandbox = { console: null }
  for (const ns of namespaces) sandbox[ns.global] = ns.functions
  // `args` is how a plugin takes an argument at all. A program is a string, so it has no signature to
  // declare one; without this the only way to vary what it does is to edit it. Frozen because a program
  // that could reassign its own inputs would make "what was this called with" a question with no answer
  // after the fact, and the value is only ever what the caller put in the request body.
  sandbox.args = Object.freeze(args !== null && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {})
  const boundConsole = Object.create(null)
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    boundConsole[level] = (...parts) => pushLog(parts.map((p) => (typeof p === 'string' ? p : safeStr(p))).join(' '))
  }
  sandbox.console = boundConsole

  const context = vm.createContext(sandbox, { name: 'volcano-ptc' })
  const budget = clampBudget(timeoutMs)

  let script
  try {
    script = new vm.Script(`(async () => {${NL}${program}${NL}})()`, { filename: 'volcano-ptc-program.js' })
  } catch (e) {
    return { logs, error: failure('exception', `program did not parse: ${e?.message ?? e}`) }
  }

  let pending
  try {
    pending = script.runInContext(context, { timeout: LIMITS.syncMs, breakOnSigint: false })
  } catch (e) {
    const timedOut = /timed out/i.test(String(e?.message ?? ''))
    return { logs, error: failure(timedOut ? 'timeout' : 'exception', `${e?.name ?? 'Error'}: ${e?.message ?? e}`) }
  }

  let timer
  let onAbort
  const deadline = new Promise((done) => {
    timer = setTimeout(() => done({ __deadline: 'timeout' }), budget)
    if (signal) {
      onAbort = () => done({ __deadline: 'abort' })
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })

  let outcome
  try {
    outcome = await Promise.race([Promise.resolve(pending).then((value) => ({ value })), deadline])
  } catch (e) {
    const kind = signal?.aborted ? 'abort' : 'exception'
    return { logs, error: failure(kind, `${e?.name ?? 'Error'}: ${e?.message ?? e}`) }
  } finally {
    clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }

  if (outcome?.__deadline) {
    return { logs, error: failure(outcome.__deadline, `the program did not settle within ${budget} ms`) }
  }

  const value = outcome?.value
  // "No value" and "a value that cannot cross the boundary" are different outcomes, and the first
  // one is legitimate: a program that logs and returns nothing ran to completion. `undefined` fails
  // `isLosslessJson` by design -- as a *value* it is not JSON -- so it is separated here rather than
  // being reported as a wrong-shaped result. The first version of this function missed that and
  // called every value-less program an invalid output; the probe caught it.
  if (value === undefined) return { logs }
  if (!isLosslessJson(value)) {
    return { logs, error: failure('invalid-output', 'the completion value is not lossless JSON') }
  }

  const logChars = logs.reduce((n, l) => n + l.length, 0)
  if (logChars > LIMITS.maxLogChars) {
    return { logs: [], error: failure('output-limit', `logs exceed ${LIMITS.maxLogChars} characters`) }
  }
  const valueChars = JSON.stringify(value).length
  if (valueChars > LIMITS.maxOutputChars) {
    return { logs: [], error: failure('output-limit', `the value exceeds ${LIMITS.maxOutputChars} characters`) }
  }

  return { logs, value }
}

function safeStr(v) {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function json(res, code, body) {
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

function htmlPage(res, code, body) {
  res.writeHead(code, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((done) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > LIMITS.bodyBytes) {
        done({ tooLarge: true })
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => done({ text: Buffer.concat(chunks).toString('utf8') }))
    req.on('error', () => done({ text: '' }))
  })
}

/**
 * The HTTP surface. Loopback only: this endpoint can call every read-only tool on the machine, and
 * "reachable from the network" is not a feature anybody asked for.
 *
 * Two routes, no more. A discovery endpoint so a client can learn the binding names and their
 * schemas without reading source, and one run endpoint so it can send a program.
 */
export function createPtcServer({ webPort, host = '127.0.0.1', logger = () => {}, extrasPath = null, tokenPath = null, allowQuiesce = false, taskName = null, pluginsDir = null } = {}) {
  if (!Number.isInteger(webPort) || webPort <= 0) throw new Error('createPtcServer needs a port')

  const auth = resolveToken(tokenPath)
  logger(auth.created ? `auth: token created at ${auth.path}` : `auth: token read from ${auth.path}`)

  // External commands are read once, at start-up, and never per request. A file edited mid-run should
  // not change what an already-running server will execute, and a load problem has to be visible at
  // the moment somebody started it rather than at the moment a program called it. A name collision
  // throws here, which is also the moment to find out.
  let extras = []
  if (extrasPath) {
    const loaded = loadExtras(extrasPath)
    extras = loaded.bindings
    for (const problem of loaded.problems) logger(`extras: ${problem}`)
    if (extras.length) logger(`extras: ${extras.length} external binding(s) from ${extrasPath}`)
  }
  // The gate exists only when the switch is on. Absent is the default, and it is not a second code
  // path downstream: the bindings simply are not in the map, so a program cannot call what was never
  // generated and the discovery endpoint cannot list it either.
  let gate = null
  let gatedFns = {}
  let gatedToolList = []
  if (allowQuiesce) {
    if (!taskName) throw new Error('allowQuiesce needs the task name it may touch')
    gate = createGate({ taskName, logger })
    gatedFns = quiesceFunctions(gate)
    gatedToolList = quiesceTools()
    // A record left by a process killed mid-repair is reported here and not released. The record says
    // what the state was, but the world has had time to move since then, and re-enabling on a guess is
    // how a safety mechanism becomes the thing that switches the safety mechanism on.
    const leftover = readPending()
    if (leftover) {
      logger(`quiesce: a suspension of ${leftover.taskName} from ${leftover.since} (pid ${leftover.pid}) was never released`)
      logger('quiesce: it is NOT released automatically -- read the task state and enable it by hand if that is right')
    }
  }

  // Plugins are read once, at start-up, for the same reason extras are: a file edited mid-run must not
  // change what an already-running server offers, and a broken plugin has to be visible at the moment
  // somebody started the server rather than at the moment they clicked it.
  let plugins = []
  if (pluginsDir) {
    const loaded = loadPlugins(pluginsDir)
    plugins = loaded.plugins
    for (const problem of loaded.problems) logger(`plugins: ${problem}`)
    if (plugins.length) logger(`plugins: ${plugins.length} plugin(s) from ${pluginsDir}`)
  }

  const bindings = buildBindings({ extras, gated: gatedFns })
  const tools = exposedTools({ extras, gatedTools: gatedToolList })

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/'

    // No preflight, and no `Access-Control-*` header on any response in this function. This is the
    // half of the guard the token cannot perform: a page on another origin may send a *simple*
    // request, so the defence is making the request that matters non-simple and then declining to
    // answer the question that would let it through regardless.
    if (req.method === 'OPTIONS') {
      res.writeHead(405, { allow: 'GET, POST' })
      res.end()
      return
    }

    if (req.method === 'GET' && (url === '/ptc/plugins' || url === '/ptc/plugins/')) {
      // The programs are included rather than referenced by id. This endpoint is the page's own source
      // of truth for what it lists, and a page that had to come back for each program would be a page
      // that renders a list of names it cannot run when one request fails.
      const names = tools.map((t) => t.name)
      return json(res, 200, { namespace: 'plugins', port: webPort, available: names, plugins: pluginsForPage(plugins, names) })
    }
    if (req.method === 'GET' && (url === '/ptc/bindings' || url === '/ptc/bindings/')) {
      return json(res, 200, { namespace: 'tools', port: webPort, denied: DENIED, tools })
    }
    if (req.method === 'POST' && url === '/ptc/run') {
      // Shape first, then identity. The content type is the part that forces a browser to preflight,
      // so a 415 closes the entire simple-request path a page would otherwise have; the token is
      // checked second because a request of the wrong shape is not a candidate whether or not it
      // carries a credential, and answering "wrong token" first would invite guessing at the shape.
      const ctype = String(req.headers['content-type'] ?? '').toLowerCase()
      if (!ctype.startsWith('application/json')) {
        return json(res, 415, { error: failure('exception', 'POST /ptc/run needs content-type: application/json') })
      }
      if (!tokenMatches(req.headers[TOKEN_HEADER], auth.token)) {
        return json(res, 401, { error: failure('exception', `missing or wrong ${TOKEN_HEADER}: the path is in GET /ptc`) })
      }
      const body = await readBody(req)
      if (body.tooLarge) return json(res, 413, { error: failure('output-limit', 'request body too large') })
      let payload
      try {
        payload = JSON.parse(body.text || '{}')
      } catch (e) {
        return json(res, 400, { error: failure('exception', `body is not JSON: ${e?.message ?? e}`) })
      }
      // Checked here rather than in `runProgram`, because this is the boundary where the value came
      // from a request body: a caller that sent a string where an object belongs gets a 400 that names
      // the field, instead of a program that silently receives nothing.
      if (payload.args !== undefined && (payload.args === null || typeof payload.args !== 'object' || Array.isArray(payload.args))) {
        return json(res, 400, { error: failure('exception', 'args must be a plain object of program inputs') })
      }
      const started = Date.now()
      const result = await runProgram({ program: payload.program, timeoutMs: payload.timeoutMs, bindings, args: payload.args })
      logger(`ptc run ${Date.now() - started}ms ok=${result.error ? 'no' : 'yes'}`)
      return json(res, result.error?.kind === 'exception' ? 400 : 200, result)
    }
    if (req.method === 'GET' && url === '/') {
      // The page reads its palette from bin/panel.json at request time, so the window and the page
      // cannot disagree about what this tool looks like.
      // The token is inlined into this document on purpose, and it is not a leak: a page on another
      // origin can send the request that fetches this HTML, but without a CORS header it cannot read
      // the response, so the value stays inside the browser tab that opened this page. The page still
      // has to send the custom header, which is the check that binds the two facts together.
      return htmlPage(res, 200, renderPage({
        port: webPort,
        tools,
        denied: DENIED,
        palette: loadPalette(),
        version: VERSION,
        token: auth.token,
        plugins: pluginsForPage(plugins, tools.map((t) => t.name)),
        // Read at render time from the live gate, so the strip cannot claim "running" while this very
        // server is holding the task disabled. `null` when the capability is off, which says nothing
        // rather than saying "running".
        heartbeat: gate ? Boolean(gate.pending()) : null,
      }))
    }
    if (req.method === 'GET' && url === '/ptc') {
      return json(res, 200, {
        service: 'volcano-separator',
        surface: 'ptc',
        page: '/',
        routes: ['GET /', 'GET /ptc/bindings', 'GET /ptc/plugins', 'POST /ptc/run'],
        bindings: tools.length,
        extras: extras.length,
        plugins: plugins.length,
        // The path, never the value. This endpoint is readable without a credential on purpose -- it
        // is how a caller learns what it may call -- so putting the secret here would hand it to the
        // only audience the secret is supposed to exclude. The path is listed because a caller that
        // cannot find the file needs to know where to look.
        auth: {
          header: TOKEN_HEADER,
          required: 'POST /ptc/run',
          tokenFile: auth.path,
          why: 'not local security: this defends against a page on another origin, which cannot read a cross-origin response and cannot send a preflighted request',
        },
        note: 'node:vm is not a security boundary; bindings are read-only and volcano_heal is excluded',
      })
    }
    return json(res, 404, { error: failure('exception', `no route for ${req.method} ${url}`) })
  })
  server.on('clientError', (_e, socket) => socket.destroy())
  // Reported here so a caller does not have to read the extras file a second time to describe what is
  // running -- two loads could disagree, and a number the endpoint contradicts is worse than none.
  server.ptcInfo = {
    tools: tools.length,
    extras: extras.length,
    denied: DENIED.length,
    bindings: Object.keys(bindings[0]?.functions ?? {}).length,
    /** The path, not the value. A caller that needs to run a program has to know where to read it. */
    tokenPath: auth.path,
    /** Whether the two write bindings are present, so an operator can see the switch took effect. */
    quiesce: Boolean(gate),
    plugins: plugins.length,
  }

  /**
   * The shutdown hook, called by the CLI on its way out. A function rather than an `exit` listener
   * installed here on purpose: `process.on('exit')` cannot await a child process, and enabling a
   * scheduled task needs one, so a listener there would look like a guarantee and deliver nothing.
   */
  server.releaseQuiesce = (reason) => (gate ? gate.releaseAll(reason) : Promise.resolve({ ok: true, released: false }))
  server.quiescePending = () => (gate ? gate.pending() : null)
  return server
}

/** Start listening, resolving with the bound address. Rejects rather than falling back to another port. */
export function listen(server, { webPort, host = '127.0.0.1' } = {}) {
  return new Promise((done, reject) => {
    const onError = (e) => {
      server.removeListener('listening', onListening)
      reject(e)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      done(server.address())
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(webPort, host)
  })
}
