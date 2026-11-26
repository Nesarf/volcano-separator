/**
 * One LLM call, for the parts of this tool that are better answered by a model than by a rule.
 *
 * Why the endpoint is a value and not a constant
 * ----------------------------------------------
 * This repository's own TODO has said since 2026-10-06 that it "must not be built for one LLM only", and
 * that rule was written about the thing this tool supervises. It applies here for a plainer reason: every
 * provider that speaks the OpenAI chat shape is the same request, so hard-coding one host would be a
 * choice nobody could see and nobody could change. DeepSeek is the default because it is what this
 * machine already pays for, not because it is the only shape.
 *
 * The key is never printed, never logged, never returned in an error, and never written in the clear
 * --------------------------------------------------------------------------------------------------
 * `saveKey` protects it with the same DPAPI script the vault uses (`bin/keyprotect.ps1`), under the same
 * "only this Windows user can read it" rule. A key in a config file next to the tool would travel with
 * every backup of that directory; a key in an environment variable is visible to every child process.
 * Neither is what "the setting is done" should mean.
 *
 * What this module does not do
 * ----------------------------
 * It does not decide anything. It sends a prompt and returns text or a classified failure. Choosing when
 * to ask, and what to do with the answer, belongs to whatever called it -- and every caller has to opt in
 * (`--allow-llm` on the ptc surface), because this is the one part of this tool that spends money and
 * sends data off the machine.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { CORE_ROOT, powershellHost, run } from './platform.mjs'

const NL = String.fromCharCode(10)

export const LLM_DEFAULTS = Object.freeze({
  endpoint: 'https://api.deepseek.com/v1/chat/completions',
  model: 'deepseek-chat',
  /** Relative to the state directory. DPAPI-protected, never plain. */
  keyFile: 'llm.key',
  /** Checked in order when no protected key has been saved. Names only -- nothing is read from disk. */
  keyEnv: ['VOS_LLM_API_KEY', 'DEEPSEEK_API_KEY'],
  timeoutMs: 60_000,
  maxTokens: 800,
  /** A prompt longer than this is refused rather than truncated: a silently cut question gets a wrong answer. */
  maxPromptChars: 24_000,
  /**
   * The same ceiling for a whole conversation. Larger because a conversation is meant to carry context --
   * but still a ceiling, because the alternative is a request that grows until the provider refuses it and
   * the error arrives in somebody's chat window after they have typed six turns.
   */
  maxChatChars: 60_000,
  /**
   * The default voice. It exists so that an answer shaped like a paragraph of advice does not arrive as a
   * paragraph of marketing -- and it says what this tool is, because a model that does not know the
   * machine it is talking about invents one.
   */
  system:
    'You are helping with volcano-separator, a small Windows tool that supervises a uv + Hindsight daemon ' +
    'chain and a DSH host. Answer in the language the question is asked in. Be concrete and short; prefer ' +
    'a command, a path, or a sentence over a list of options. If something cannot be determined from what ' +
    'you were given, say so instead of guessing.',
})

/** The directory the rest of this tool keeps its state in. Not under the log directory, which is pruned. */
export function llmKeyFile(ctx = {}) {
  return ctx.llmKeyFile ?? join(ctx.stateDir ?? join(homedir(), '.volcano-separator'), LLM_DEFAULTS.keyFile)
}

export function resolveLlm(ctx = {}) {
  const cfg = { ...LLM_DEFAULTS, ...(ctx.llm ?? {}) }
  const endpoint = String(ctx.llmEndpoint ?? cfg.endpoint).trim()
  const model = String(ctx.llmModel ?? cfg.model).trim()
  return {
    endpoint,
    model,
    keyEnv: Array.isArray(ctx.llmKeyEnv) ? ctx.llmKeyEnv : cfg.keyEnv,
    timeoutMs: Number(ctx.llmTimeoutMs) > 0 ? Number(ctx.llmTimeoutMs) : cfg.timeoutMs,
    maxTokens: Number(ctx.llmMaxTokens) > 0 ? Number(ctx.llmMaxTokens) : cfg.maxTokens,
    maxPromptChars: cfg.maxPromptChars,
    maxChatChars: cfg.maxChatChars,
    system: ctx.llmSystem ?? cfg.system,
  }
}

/**
 * The script speaks one JSON line on stdout for both outcomes, and exits non-zero on refusal. Reading only
 * the exit code loses the reason DPAPI gave, which is the only part that makes a failure actionable --
 * that is where "protect failed: no detail" came from the first time this ran.
 */
function lastJson(stdout) {
  const line = String(stdout ?? '').split(NL).filter(Boolean).pop() ?? '{}'
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

/**
 * Reads the protected file through DPAPI. A missing file is an answer, not an error.
 *
 * Both directions are base64: the script decodes its input with `FromBase64String` and writes its output
 * with `-Encoding ASCII`, so anything that is not base64 fails inside PowerShell with a message about the
 * input rather than about the key.
 */
async function readProtected(file) {
  const script = join(CORE_ROOT, 'bin', 'keyprotect.ps1')
  const plain = file + '.plain.tmp'
  const r = await run(powershellHost(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', 'unprotect', '-In', file, '-Out', plain], { timeoutMs: 60_000 })
  try {
    const said = lastJson(r.stdout)
    if (!r.ok || said?.ok === false) return { ok: false, detail: said?.detail ?? `unprotect exited ${r.code ?? '?'}` }
    const b64 = readFileSync(plain, 'utf8').replace(/\s/g, '')
    return { ok: true, value: Buffer.from(b64, 'base64').toString('utf8') }
  } catch (e) {
    return { ok: false, detail: `could not read the unprotected copy: ${e?.message ?? e}` }
  } finally {
    rmSync(plain, { force: true })
  }
}

/**
 * The key and where it came from. The source is reported because "it works on this machine and not that
 * one" is answered by knowing whether the file or the environment supplied it -- and the value itself is
 * never part of the answer.
 */
export async function loadKey(ctx = {}) {
  if (typeof ctx.llmKey === 'string' && ctx.llmKey.trim()) return { ok: true, key: ctx.llmKey.trim(), source: 'caller' }

  const file = llmKeyFile(ctx)
  // Skipped when the file is not there: starting PowerShell to be told a path does not exist costs a
  // second and reports nothing the filesystem had not already said.
  let protectedRead = { ok: false, detail: 'no saved key' }
  if (existsSync(file)) protectedRead = await readProtected(file)
  if (protectedRead.ok && protectedRead.value) return { ok: true, key: protectedRead.value, source: 'file:' + file }

  for (const name of resolveLlm(ctx).keyEnv) {
    const value = process.env[name]
    if (value && value.trim()) return { ok: true, key: value.trim(), source: 'env:' + name }
  }

  return {
    ok: false,
    source: null,
    detail:
      `no API key: ${file} does not exist or cannot be read` +
      (protectedRead.ok ? '' : ` (${protectedRead.detail})`) +
      ` and none of ${resolveLlm(ctx).keyEnv.join(', ')} is set`,
  }
}

/**
 * Save a key for this Windows user. Refuses a value that cannot be a key rather than storing it and
 * letting the first request fail -- a saved value that is wrong is worse than no value, because it looks
 * like the setting is done.
 */
export async function saveKey(ctx = {}, rawKey) {
  const key = String(rawKey ?? '').trim()
  if (key.length < 20) return { ok: false, detail: 'that is too short to be an API key' }
  if (/[\s]/.test(key)) return { ok: false, detail: 'a key with whitespace in it is usually a copy-paste accident' }

  const file = llmKeyFile(ctx)
  const script = join(CORE_ROOT, 'bin', 'keyprotect.ps1')
  const plain = file + '.plain.tmp'
  try {
    mkdirSync(dirname(file), { recursive: true })
    // Base64, because that is what the script decodes. A plain key here fails inside PowerShell with a
    // message about the input, which reads like a bug in this module rather than in the value it was given.
    writeFileSync(plain, Buffer.from(key, 'utf8').toString('base64') + NL, { mode: 0o600 })
    const r = await run(powershellHost(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', 'protect', '-In', plain, '-Out', file], { timeoutMs: 60_000 })
    const said = lastJson(r.stdout)
    if (!r.ok || said?.ok === false) return { ok: false, detail: said?.detail ?? `protect exited ${r.code ?? '?'}` }
    return { ok: true, path: file }
  } catch (e) {
    return { ok: false, detail: String(e?.message ?? e) }
  } finally {
    // The plaintext is removed whatever happened: a failed protect must not leave the key lying in a
    // temporary file next to the protected one.
    rmSync(plain, { force: true })
  }
}

export function forgetKey(ctx = {}) {
  const file = llmKeyFile(ctx)
  try {
    rmSync(file, { force: true })
    return { ok: true, path: file }
  } catch (e) {
    return { ok: false, detail: String(e?.message ?? e) }
  }
}

/**
 * One question, one answer.
 *
 * The failure kinds are separate for the same reason the program runner's are: a timeout is not a network
 * failure, an HTTP error is not a malformed answer, and a caller that cannot tell them apart cannot decide
 * whether to retry. Nothing in any message includes the key.
 */
async function send(ctx, { messages, system, model, maxTokens, timeoutMs, tools }) {
  const cfg = resolveLlm(ctx)
  const loaded = await loadKey(ctx)
  if (!loaded.ok) return { ok: false, kind: 'no-key', why: loaded.detail }

  const body = {
    model: model ? String(model) : cfg.model,
    messages: [{ role: 'system', content: String(system ?? cfg.system) }, ...messages],
    max_tokens: Number(maxTokens) > 0 ? Number(maxTokens) : cfg.maxTokens,
    stream: false,
  }
  // Passed through as the provider's own function schema, which is the same JSON Schema this tool already
  // publishes for its bindings -- so there is no second description of a tool for the two to drift apart.
  if (Array.isArray(tools) && tools.length) body.tools = tools

  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : cfg.timeoutMs
  const started = Date.now()
  let response
  try {
    response = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + loaded.key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(budget),
    })
  } catch (e) {
    const aborted = e?.name === 'TimeoutError' || /abort/i.test(String(e?.name ?? ''))
    return {
      ok: false,
      kind: aborted ? 'timeout' : 'network',
      why: aborted ? `no answer within ${budget} ms` : `the request did not complete: ${e?.message ?? e}`,
      ms: Date.now() - started,
    }
  }

  const text = await response.text()
  if (!response.ok) {
    // The provider's own message is the useful part, and it never contains the key -- it is the request
    // that was refused, not echoed.
    return {
      ok: false,
      kind: 'http',
      status: response.status,
      why: `HTTP ${response.status}: ${text.slice(0, 500)}`,
      ms: Date.now() - started,
    }
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, kind: 'bad-response', why: `the answer was not JSON: ${text.slice(0, 200)}`, ms: Date.now() - started }
  }

  const choice = parsed?.choices?.[0]
  const answer = choice?.message?.content
  const toolCalls = Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : []
  // No text is legitimate when the model asked for a tool instead: that is the whole shape of a function
  // call, and calling it a malformed reply would make a tool loop impossible to start.
  if (typeof answer !== 'string' && !toolCalls.length) {
    return {
      ok: false,
      kind: 'bad-response',
      why: `no choices[0].message.content and no tool calls in the answer: ${JSON.stringify(parsed).slice(0, 300)}`,
      ms: Date.now() - started,
    }
  }

  return {
    ok: true,
    text: typeof answer === 'string' ? answer : '',
    /** Empty for a plain answer. Present when the model wants something run before it can reply. */
    toolCalls,
    finish: choice?.finish_reason ?? null,
    /** What was asked for, and what answered. A provider may map one to the other, and reporting only the
     *  second makes a configured model look like it was ignored. */
    requested: body.model,
    model: parsed?.model ?? body.model,
    usage: parsed?.usage ?? null,
    ms: Date.now() - started,
    askedBy: loaded.source.startsWith('env:') ? loaded.source : 'the saved key',
  }
}

/**
 * One question, one answer. Kept because most callers do not have a conversation, and its checks run before
 * a credential is looked for -- an empty prompt should not cost a DPAPI round trip.
 */
export async function ask(ctx = {}, { prompt, system, model, maxTokens, timeoutMs } = {}) {
  const cfg = resolveLlm(ctx)
  const question = String(prompt ?? '').trim()
  if (!question) return { ok: false, kind: 'empty-prompt', why: 'nothing to ask' }
  if (question.length > cfg.maxPromptChars) {
    return { ok: false, kind: 'prompt-too-long', why: `the prompt is ${question.length} characters; the limit is ${cfg.maxPromptChars}` }
  }
  return send(ctx, { messages: [{ role: 'user', content: question }], system, model, maxTokens, timeoutMs })
}

/**
 * A conversation.
 *
 * The history arrives from the caller on every turn, because this module keeps no state of its own: the
 * window stores it in the browser, so a restart of this server does not end a conversation, a reload does
 * not lose it, and two tabs do not fight over one list. The alternative -- a session map on the server --
 * would have made a personal conversation into a global that has to be expired, named and cleaned up.
 *
 * Roles are narrowed to user and assistant on purpose. A caller that wants to inject a second system
 * message is asking for a different feature, and quietly accepting one here would let a page rewrite the
 * voice this tool talks in without saying so.
 */
export async function chat(ctx = {}, { messages, system, model, maxTokens, timeoutMs, tools } = {}) {
  const cfg = resolveLlm(ctx)
  const list = Array.isArray(messages) ? messages : []
  if (!list.length) return { ok: false, kind: 'empty-conversation', why: 'no messages to send' }

  const cleaned = []
  for (const m of list) {
    const role = m?.role === 'user' ? 'user' : m?.role === 'assistant' ? 'assistant' : null
    if (!role) return { ok: false, kind: 'bad-message', why: `a message role has to be user or assistant, not ${JSON.stringify(m?.role)}` }
    const content = typeof m?.content === 'string' ? m.content.trim() : ''
    if (!content) return { ok: false, kind: 'bad-message', why: 'a message has empty content' }
    cleaned.push({ role, content })
  }

  const total = cleaned.reduce((n, m) => n + m.content.length, 0)
  if (total > cfg.maxChatChars) {
    return { ok: false, kind: 'conversation-too-long', why: `the conversation is ${total} characters; the limit is ${cfg.maxChatChars}` }
  }

  return send(ctx, { messages: cleaned, system, model, maxTokens, timeoutMs, tools })
}

/**
 * One raw turn, for a caller running a tool loop.
 *
 * `chat` narrows roles to user and assistant on purpose; a loop needs the other two as well -- an
 * `assistant` turn carrying `tool_calls`, and a `tool` turn carrying the result with the id it answers.
 * Rather than loosening `chat` for everybody, this entry point accepts exactly those four roles and
 * checks the one thing a provider will refuse outright: a tool message without a `tool_call_id`.
 *
 * It is still not a hole. The same credential, the same length ceiling, the same classified failures.
 */
export async function converse(ctx = {}, { messages, system, model, maxTokens, timeoutMs, tools } = {}) {
  const cfg = resolveLlm(ctx)
  const list = Array.isArray(messages) ? messages : []
  if (!list.length) return { ok: false, kind: 'empty-conversation', why: 'no messages to send' }

  let total = 0
  for (const m of list) {
    const role = m?.role
    if (role !== 'user' && role !== 'assistant' && role !== 'tool') {
      return { ok: false, kind: 'bad-message', why: `a message role has to be user, assistant or tool, not ${JSON.stringify(role)}` }
    }
    const content = typeof m?.content === 'string' ? m.content : ''
    if (role === 'tool' && typeof m?.tool_call_id !== 'string') {
      return { ok: false, kind: 'bad-message', why: 'a tool message has to carry the tool_call_id it answers' }
    }
    if (role === 'tool' && !content.trim()) return { ok: false, kind: 'bad-message', why: 'a tool message has empty content' }
    if (role === 'user' && !content.trim()) return { ok: false, kind: 'bad-message', why: 'a user message has empty content' }
    total += content.length
  }
  if (total > cfg.maxChatChars) {
    return { ok: false, kind: 'conversation-too-long', why: `the conversation is ${total} characters; the limit is ${cfg.maxChatChars}` }
  }

  // Rebuilt rather than passed through: a caller that keeps extra fields on its own messages -- this page
  // stores which tools were used beside each reply -- would otherwise send them to the provider, and a
  // provider that rejects unknown fields turns a display detail into a failed request.
  const clean = list.map((m) => {
    const out = { role: m.role, content: typeof m.content === 'string' ? m.content : '' }
    if (m.role === 'tool') out.tool_call_id = m.tool_call_id
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) out.tool_calls = m.tool_calls
    return out
  })
  return send(ctx, { messages: clean, system, model, maxTokens, timeoutMs, tools })
}

/** What `vos llm status` reports. Deliberately describes the credential without carrying it. */
export async function status(ctx = {}) {
  const cfg = resolveLlm(ctx)
  const loaded = await loadKey(ctx)
  return {
    endpoint: cfg.endpoint,
    model: cfg.model,
    keyFile: llmKeyFile(ctx),
    hasKey: loaded.ok,
    source: loaded.source,
    detail: loaded.ok ? null : loaded.detail,
    timeoutMs: cfg.timeoutMs,
    maxTokens: cfg.maxTokens,
  }
}

/**
 * The binding, in the shape `buildBindings` expects.
 *
 * It is the only binding that sends anything off this machine and the only one that costs money, which is
 * why it is behind a switch rather than in the built-in list. A caller that cannot tell why an answer did
 * not arrive gets the failure kind and the reason in the same sentence, because "it did not work" is the
 * one report this project keeps removing.
 */
export function llmFunctions(ctx = {}) {
  return {
    vos_ask: async (args) => {
      if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
        throw new TypeError('vos_ask takes one object argument')
      }
      const r = await ask(ctx, {
        prompt: args?.prompt,
        system: args?.system,
        model: args?.model,
        maxTokens: args?.maxTokens,
      })
      return { ...r, text: r.ok ? r.text : `not answered: ${r.kind} -- ${r.why}` }
    },
  }
}

/** Descriptors for the discovery endpoint, in the same shape `TOOLS` entries use. */
export function llmTools() {
  return [
    {
      name: 'vos_ask',
      description:
        'Ask a language model one question and get the text back. The only binding here that sends data off this machine and costs money, which is why it exists only with --allow-llm. The endpoint and model come from the context, so this is not tied to one provider. Failures come back as a kind -- no-key, network, timeout, http, bad-response, empty-prompt, prompt-too-long -- with the reason attached, so a program can decide whether to retry instead of guessing.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The question. Required; an empty one never reaches the network.' },
          system: { type: 'string', description: 'Override the default voice for this one call.' },
          model: { type: 'string', description: 'Override the configured model for this one call.' },
          maxTokens: { type: 'integer', description: 'Cap the answer length. Defaults to the configured value.' },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
    },
  ]
}
