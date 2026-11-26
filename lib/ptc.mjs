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
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TOOLS, call } from './tools.mjs'
import { extrasFunctions, extrasTools, loadExtras } from './extras.mjs'
import { loadPlugins, pluginsForPage } from './plugins.mjs'
import { converse, LLM_DEFAULTS, llmFunctions, llmTools } from './llm.mjs'
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
const TOKEN_HEADER = 'x-vos-token'
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
 * Where a value stops being JSON, when `isLosslessJson` says it does not.
 *
 * The boolean is enough to refuse; it is not enough to fix. Reporting only "not lossless JSON" makes a
 * caller hunt through a returned object for the one field that cannot cross, and both times this happened
 * here the field existed on only one branch — `kind` on failure, `usage` on success. A path turns that
 * hunt into a one-line fix, and the message says what to do about it rather than only that it is wrong.
 */
export function whyNotLossless(value, path = 'value', seen = new Set()) {
  if (value === null) return null
  const t = typeof value
  if (t === 'boolean' || t === 'string') return null
  if (t === 'number') return Number.isFinite(value) ? null : `${path} is ${value}, which JSON cannot carry`
  if (t === 'undefined') return `${path} is undefined — a field present on only some branches has to be null or left out`
  if (t !== 'object') return `${path} is a ${t}, which JSON cannot carry`
  if (seen.has(value)) return `${path} is a cycle`
  seen.add(value)
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value)
  for (const [key, v] of entries) {
    const found = whyNotLossless(v, Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`, seen)
    if (found) {
      seen.delete(value)
      return found
    }
  }
  seen.delete(value)
  return null
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
    const where = whyNotLossless(value)
    return { logs, error: failure('invalid-output', `the completion value is not lossless JSON: ${where ?? 'no offending field found'}`) }
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

/**
 * `limit` is a parameter because a conversation body is legitimately larger than a program: a page that
 * has been talking for a while sends its whole history on every turn. One number for both would either
 * cap conversations at a few turns or allow a program nobody can explain.
 */
function readBody(req, limit = LIMITS.bodyBytes) {
  return new Promise((done) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
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
 * What this machine is, told to the model before it answers.
 *
 * Without it the agent has twenty-four tools and no idea which one answers which question: it does not
 * know that 9077 is the daemon and 3080 is the host, that a scheduled task restarts the chain after the
 * host goes away, or that `volcano_quiesce` really does stop the watchdog. A model in that position
 * guesses, and a guess with a tool attached is a command.
 *
 * Two halves, and the second one matters more. The first states facts, read from the running server
 * rather than hardcoded, so a different port or a missing extras file changes what it says. The second
 * states the rules around the write bindings -- because `volcano_quiesce` is not a query, and an agent
 * that suspends a heartbeat and forgets to give it back leaves this machine unwatched.
 */
function machineBrief({ port, taskName, tools, extras }) {
  const lines = [
    'You are talking through the web surface of volcano-separator (vos), on a Windows machine. These are',
    'the facts of this running server, not assumptions:',
    `- This surface is http://127.0.0.1:${port}. You are speaking through it.`,
    '- Ports: the Hindsight daemon defaults to 9077, the DSH host to 3080. To learn who is actually',
    '  listening, call volcano_entity({ kind: "port", id: "<port>" }) -- do not guess.',
    '- Events and snapshots are different sources: volcano_activity records things that happened (with',
    '  timestamps), volcano_ps and volcano_redline are true only at the moment they ran.',
  ]
  if (taskName) {
    lines.push(
      `- The scheduled task ${taskName} runs a health check every few minutes. After the host is stopped it`,
      '  restarts the daemon chain, which is why stopping the host while it runs produces a process that',
      '  comes back. That is the only reason volcano_quiesce exists.',
    )
  }
  lines.push(`- You can call ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}.`)
  lines.push(
    extras.length
      ? `- ${extras.length} of them belong to other projects (torikago, nanodesu) and start a python process when called.`
      : '- No external bindings are loaded, so nothing here reaches another project.',
  )
  lines.push(
    '',
    'Rules for the tools that change things. Breaking any of these is a wrong answer, not a style choice:',
    '1. volcano_quiesce really disables the scheduled task. Say what you are about to stop and why BEFORE',
    '   calling it, never after.',
    '2. After suspending, you must call volcano_resume in the same conversation, with the handle you got',
    '   back. An unreleased suspension keeps the machine unwatched until this server exits.',
    '3. To find out whether something is suspended, call volcano_quiesce_status. Never use quiesce itself',
    '   as a probe.',
    '4. vos_ask spends money and sends text off this machine. Do not call it in a loop.',
    '5. Prefer one call that answers the question over several that circle it.',
    '',
    'Repairing the host is a two-part job with a human step in the middle, and you cannot do that middle part:',
    'you have no tool that stops the host, on purpose, because that action cuts the session somebody is',
    'working in. So when somebody asks you to repair it:',
    '1. Look first: volcano_entity({ kind: "port", id: "3080" }) for the host, volcano_status for the chain.',
    '2. Say what you are about to suspend and why, then volcano_quiesce. Keep the handle.',
    '3. Ask the person to stop the host themselves -- closing the terminal that launched it, or killing the',
    '   pid that is LISTENING on 3080 and its whole tree -- and to come back when it is done.',
    '4. When they come back, volcano_resume with the same handle, then volcano_status to check, then report',
    '   what changed. If they do not come back, remind them once: the suspension is still open.',
    '5. If you are unsure whether they have stopped it, ask. Never assume, and never skip giving the handle back.',
    '',
    'Answer concretely: a command, a path, or one sentence. If the tools cannot tell you, say so instead',
    'of filling the gap with something that sounds right.',
  )
  return lines.join('\n')
}

/**
 * Where a tool call made by a conversation is recorded.
 *
 * The page keeps the step list beside each reply, but that lives in one browser's storage: it disappears
 * with the browser, and it is not where somebody looks after a heartbeat was stopped and the question is
 * who stopped it. The server's own log has one line per round with a count and no arguments, which is not
 * enough to answer that either.
 *
 * So each call is appended here -- the tool, its arguments, how large the result was, which round. Not the
 * conversation: that is the caller's, and copying it into a file this tool owns would be a different
 * promise than "I record what I did to this machine".
 */
const CHAT_AUDIT_ROTATE_BYTES = 2 * 1024 * 1024

function chatAuditFile(ctx = {}) {
  return ctx.chatAuditFile ?? join(homedir(), '.volcano-separator', 'chat-tools.ndjson')
}

/** A prompt is the one argument that can carry somebody's text, so only its size is written. */
function redactArgs(tool, args) {
  if (tool === 'vos_ask' && args && typeof args.prompt === 'string') {
    return { ...args, prompt: `<${args.prompt.length} chars>` }
  }
  return args ?? null
}

function recordToolStep(file, step) {
  if (!file) return
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify(step) + NL)
  } catch {
    // A record that cannot be written must not stop the call it describes: the machine was already asked to
    // do the thing, and failing here would turn a logging problem into a failed conversation.
  }
}

/** One rotation at start-up, not per write. Checking on every call would stat the file more often than it
 *  reads it, and the alternative to a rotation is a file that grows until somebody notices. */
function rotateChatAudit(ctx = {}, logger = () => {}) {
  const file = chatAuditFile(ctx)
  try {
    if (statSync(file).size < CHAT_AUDIT_ROTATE_BYTES) return
    renameSync(file, file + '.1')
    logger(`chat audit: rotated ${file} at ${CHAT_AUDIT_ROTATE_BYTES} bytes`)
  } catch {
    /* not there yet, or could not rename -- either way nothing to do */
  }
}

/** Bounds for the tool loop. Each one answers a way this goes wrong, and all of them exist because the
 *  alternative is a request that never comes back. */
const CHAT_LIMITS = Object.freeze({
  maxRounds: 6,
  maxToolCallsPerRound: 4,
  maxToolResultChars: 4000,
  budgetMs: 120_000,
})

/**
 * A conversation that can use the tools.
 *
 * The loop lives here rather than in `llm.mjs`, because running a tool is this module's job: the bindings
 * are already here, and the alternative is passing callbacks down into a module that should only know how
 * to talk to a model.
 *
 * `maxRounds` stops a model that keeps asking for tools instead of answering. `maxToolCallsPerRound` stops
 * one turn from fanning out into a dozen processes. `budgetMs` stops the whole thing from outliving the
 * person waiting. A result over the cap is truncated **and says so in the text the model reads** — a
 * silently cut result is a wrong answer delivered confidently, which is the failure this project keeps
 * removing.
 */
async function runChatLoop({ messages, tools, bindings, system, logger = () => {}, budgetMs = CHAT_LIMITS.budgetMs, auditFile = null }) {
  const started = Date.now()
  const transcript = [...messages]
  const steps = []
  let usage = null
  let requested = null
  let model = null
  let askedBy = null

  for (let round = 1; round <= CHAT_LIMITS.maxRounds; round++) {
    if (Date.now() - started > budgetMs) {
      return { ok: false, kind: 'timeout', why: `the conversation passed ${budgetMs} ms after ${round - 1} round(s)`, transcript, steps, ms: Date.now() - started }
    }

    const said = await converse({}, { messages: transcript, tools, system, timeoutMs: Math.max(5000, budgetMs - (Date.now() - started)) })
    if (usage === null && said.usage) usage = said.usage
    if (!said.ok) return { ...said, transcript, steps, ms: Date.now() - started }
    requested = said.requested ?? requested
    model = said.model ?? model
    askedBy = said.askedBy ?? askedBy

    if (!said.toolCalls.length) {
      transcript.push({ role: 'assistant', content: said.text })
      return { ok: true, text: said.text, transcript, steps, rounds: round, requested, model, usage, askedBy, ms: Date.now() - started }
    }

    // The assistant turn has to be recorded before the results are, and with the same call ids: a provider
    // refuses a tool message that answers a call it cannot find.
    transcript.push({ role: 'assistant', content: said.text || '', tool_calls: said.toolCalls })

    const runnable = said.toolCalls.slice(0, CHAT_LIMITS.maxToolCallsPerRound)
    const dropped = said.toolCalls.slice(CHAT_LIMITS.maxToolCallsPerRound)

    for (const call of runnable) {
      const name = String(call?.function?.name ?? '')
      let args = null
      try {
        args = JSON.parse(call?.function?.arguments || '{}')
      } catch {
        args = null
      }
      let result
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        result = `not run: the arguments were not a JSON object: ${String(call?.function?.arguments ?? '').slice(0, 200)}`
      } else if (typeof bindings[name] !== 'function') {
        result = `not run: there is no tool named ${JSON.stringify(name)} on this server`
      } else {
        try {
          const r = await bindings[name](args)
          result = typeof r === 'object' && r !== null ? JSON.stringify(r) : String(r)
        } catch (e) {
          result = `the tool threw: ${e?.message ?? e}`
        }
      }
      const full = String(result)
      const content = full.length > CHAT_LIMITS.maxToolResultChars
        ? full.slice(0, CHAT_LIMITS.maxToolResultChars) + `\n[truncated: the result was ${full.length} characters]`
        : full
      const step = {
        at: new Date().toISOString(),
        round,
        tool: name,
        args: redactArgs(name, args),
        chars: full.length,
        truncated: full.length > CHAT_LIMITS.maxToolResultChars,
        refused: /^not run:|^the tool threw/.test(full),
      }
      steps.push(step)
      recordToolStep(auditFile, step)
      transcript.push({ role: 'tool', tool_call_id: String(call?.id ?? ''), content })
    }

    for (const call of dropped) {
      transcript.push({
        role: 'tool',
        tool_call_id: String(call?.id ?? ''),
        content: `not run: this turn asked for more than ${CHAT_LIMITS.maxToolCallsPerRound} tool calls, so the extras were dropped`,
      })
    }

    logger(`ptc chat round ${round}: ${runnable.length} tool call(s)${dropped.length ? ', ' + dropped.length + ' dropped' : ''}`)
  }

  return { ok: false, kind: 'too-many-rounds', why: `the model asked for tools ${CHAT_LIMITS.maxRounds} times without answering`, transcript, steps, ms: Date.now() - started }
}

/**
 * The HTTP surface. Loopback only: this endpoint can call every read-only tool on the machine, and
 * "reachable from the network" is not a feature anybody asked for.
 *
 * Two routes, no more. A discovery endpoint so a client can learn the binding names and their
 * schemas without reading source, and one run endpoint so it can send a program.
 */
export function createPtcServer({ webPort, host = '127.0.0.1', logger = () => {}, extrasPath = null, tokenPath = null, allowQuiesce = false, allowLlm = false, taskName = null, pluginsDir = null, chatAuditFile: auditOverride = null } = {}) {
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

  // The model call is a separate switch rather than part of the quiesce one: suspending a scheduled task
  // and spending money on a network request are different decisions, and somebody who wants one should not
  // have to accept the other to get it.
  if (allowLlm) {
    Object.assign(gatedFns, llmFunctions())
    gatedToolList = [...gatedToolList, ...llmTools()]
  }

  // Where a conversation's tool calls are recorded. Overridable so a test never appends to the real file.
  const auditFile = auditOverride ?? chatAuditFile({})
  rotateChatAudit({ chatAuditFile: auditFile }, logger)

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

    // A conversation is not a program, so it does not go through the program runner: the messages would
    // have to be encoded as JavaScript and parsed back for nothing, and every turn would pay the cost of
    // building a vm context to call one function. Same credential, same switch, a different body.
    if (req.method === 'POST' && url === '/ptc/chat') {
      if (!allowLlm) {
        return json(res, 404, { error: failure('exception', '/ptc/chat is not enabled here -- start the server with --allow-llm') })
      }
      const chatCtype = String(req.headers['content-type'] ?? '').toLowerCase()
      if (!chatCtype.startsWith('application/json')) {
        return json(res, 415, { error: failure('exception', 'POST /ptc/chat needs content-type: application/json') })
      }
      if (!tokenMatches(req.headers[TOKEN_HEADER], auth.token)) {
        return json(res, 401, { error: failure('exception', `missing or wrong ${TOKEN_HEADER}: the path is in GET /ptc`) })
      }
      const raw = await readBody(req, LIMITS.bodyBytes * 4)
      if (raw.tooLarge) return json(res, 413, { error: failure('output-limit', 'the conversation body is too large') })
      let payload
      try {
        payload = JSON.parse(raw.text || '{}')
      } catch (e) {
        return json(res, 400, { error: failure('exception', `body is not JSON: ${e?.message ?? e}`) })
      }
      // The tools the model is offered are the bindings this server actually exposes, so a switch that is off
      // is a tool the model cannot see. There is no second list to keep in step with the first.
      const specs = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }))
      // The model is told what this machine is and what the write tools do before it sees a single message.
      // Everything in the brief comes from this running server, so a different port or an empty extras file
      // changes what it says rather than leaving a stale fact in a prompt.
      const brief = machineBrief({ port: webPort, taskName: gate ? taskName : null, tools, extras })
      const said = await runChatLoop({
        messages: payload.messages,
        tools: specs,
        bindings: bindings[0]?.functions ?? {},
        system: `${LLM_DEFAULTS.system}${NL}${NL}${brief}`,
        logger,
        auditFile,
      })
      logger(`ptc chat ${said.ok ? 'ok' : said.kind} ${said.ms ?? 0}ms`)
      return json(res, said.ok ? 200 : 400, said)
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
        /** Whether the conversation window may talk. Its own switch, and the page says so when it is off. */
        llm: allowLlm,
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
    /** Whether a program may spend money on a model call. Its own switch, and off by default. */
    llm: allowLlm,
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
