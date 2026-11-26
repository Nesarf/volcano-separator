/**
 * Optional external commands, exposed to a program as extra bindings.
 *
 * Why this is a file and not four hardcoded paths
 * -----------------------------------------------
 * This tool's value rests on not depending on anything: no third-party modules, no network, and no
 * other project's tree. kp records the distinction the project has kept since the shared-asset work:
 * *origin is not dependency* -- a resource may be produced elsewhere as long as what runs reads
 * nothing outside its own repository. Pointing a binding at `nanodesu.py` would be a dependency in the
 * running process, and the first time that checkout moved, the tool would start failing for a reason
 * that has nothing to do with supervising anything.
 *
 * So the core knows nothing about any of them. A file describes them, `vos web --extras <path>`
 * loads it, and omitting the flag leaves the built-in sixteen as the whole surface. The person who
 * starts the server is the person who decided those commands run.
 *
 * What a binding promises, and what it refuses to promise
 * ------------------------------------------------------
 * A binding runs the command and answers `{ ok, exitCode, json?, text }`. `json` is present only when
 * stdout parsed as JSON; when it did not, `text` is the raw output and no structure is invented. A
 * non-zero exit is reported as `ok: false` with the code, not thrown -- the same rule the built-in
 * tools follow, where a refusal is an answer rather than an exception.
 *
 * This is not a sandbox either. The command runs with this user's authority and the arguments the
 * file gives it. The only thing the boundary does is keep the list fixed and visible.
 */

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'

export const EXTRAS_FORMAT = 'vos-extras/1'

const LIMITS = Object.freeze({
  maxBindings: 32,
  maxArgs: 32,
  maxArgChars: 4096,
  maxBufferBytes: 8 * 1024 * 1024,
  defaultTimeoutMs: 60_000,
  maxTimeoutMs: 10 * 60_000,
})

/**
 * Read and validate a description file.
 *
 * Returns `{ bindings, problems }` rather than throwing on the first bad entry: a file with one typo
 * should say which entry is wrong and still load the rest, because the alternative is a server that
 * refuses to start over one line somebody can fix in a second.
 */
export function loadExtras(path) {
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    return { bindings: [], problems: [`cannot read ${path}: ${e?.message ?? e}`] }
  }
  if (raw?.format !== EXTRAS_FORMAT) {
    return { bindings: [], problems: [`format must be ${EXTRAS_FORMAT}, got ${JSON.stringify(raw?.format)}`] }
  }
  const list = Array.isArray(raw.bindings) ? raw.bindings : []
  if (list.length > LIMITS.maxBindings) {
    return { bindings: [], problems: [`${list.length} bindings exceeds the cap of ${LIMITS.maxBindings}`] }
  }

  const bindings = []
  const problems = []
  for (const [index, entry] of list.entries()) {
    const label = entry?.name ?? `#${index}`
    if (typeof entry?.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name)) {
      problems.push(`${label}: name must match [A-Za-z_][A-Za-z0-9_]*`)
      continue
    }
    if (typeof entry?.command !== 'string' || !entry.command.trim()) {
      problems.push(`${label}: command is required`)
      continue
    }
    const args = Array.isArray(entry.args) ? entry.args : []
    if (args.length > LIMITS.maxArgs) {
      problems.push(`${label}: ${args.length} args exceeds the cap of ${LIMITS.maxArgs}`)
      continue
    }
    if (!args.every((a) => typeof a === 'string' && a.length <= LIMITS.maxArgChars)) {
      problems.push(`${label}: every arg must be a string of at most ${LIMITS.maxArgChars} characters`)
      continue
    }
    const timeoutMs = Number(entry.timeoutMs ?? LIMITS.defaultTimeoutMs)
    bindings.push({
      name: entry.name,
      description: typeof entry.description === 'string' ? entry.description : `external: ${entry.command}`,
      command: entry.command,
      args: [...args],
      timeoutMs: Number.isFinite(timeoutMs) ? Math.min(LIMITS.maxTimeoutMs, Math.max(1000, Math.round(timeoutMs))) : LIMITS.defaultTimeoutMs,
      /** When true, an optional `path` argument from the program is appended to `args`. */
      acceptsPath: entry.acceptsPath === true,
    })
  }
  return { bindings, problems }
}

/** Run one external binding. Never throws: a failure is a field, the same shape the built-ins use. */
export function runExtra(spec, args = {}) {
  return new Promise((done) => {
    const argv = [...spec.args]
    if (spec.acceptsPath && args && args.path !== undefined && args.path !== null) {
      argv.push(String(args.path))
    }
    const started = Date.now()
    execFile(spec.command, argv, {
      timeout: spec.timeoutMs,
      maxBuffer: LIMITS.maxBufferBytes,
      windowsHide: true,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      const text = String(stdout ?? '')
      let json
      let parsed = false
      if (text.trim()) {
        try {
          json = JSON.parse(text)
          parsed = true
        } catch {
          /* keep json absent; text is the answer */
        }
      }
      const exitCode = error?.code === undefined ? (error ? 1 : 0) : Number(error.code) || 0
      const timedOut = Boolean(error?.killed) || error?.signal === 'SIGTERM'
      done({
        ok: !error,
        exitCode,
        timedOut,
        ms: Date.now() - started,
        binding: spec.name,
        ...(parsed ? { json } : {}),
        text,
        ...(stderr ? { stderr: String(stderr) } : {}),
        ...(error && !timedOut ? { error: String(error.message ?? error) } : {}),
      })
    })
  })
}

/**
 * The bindings as a namespace, in the shape `ptc.mjs` merges into `tools`.
 *
 * Functions are generated from the validated list rather than written out per command, for the same
 * reason the built-in bindings are: one description, one generated wrapper, no second copy to drift.
 */
export function extrasFunctions(bindings) {
  const functions = Object.create(null)
  for (const spec of bindings) {
    functions[spec.name] = async (args) => {
      if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
        throw new TypeError(`${spec.name} takes one object argument`)
      }
      return runExtra(spec, args ?? {})
    }
  }
  return functions
}

/** Descriptors for the discovery endpoint, in the same shape `TOOLS` entries use. */
export function extrasTools(bindings) {
  return bindings.map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.acceptsPath
      ? { type: 'object', properties: { path: { type: 'string', description: 'Appended to the command line.' } }, additionalProperties: false }
      : { type: 'object', properties: {}, additionalProperties: false },
  }))
}
