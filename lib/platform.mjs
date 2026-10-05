import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The bottom layer: pure helpers that everything above needs and that depend on nothing here.
 *
 * These three lived in core.mjs, where every module reaching for them meant the file could only
 * ever grow. They have no dependency on the rest of the tool -- a path string, a JSON file read
 * that tolerates a BOM, and a timer -- which is what makes them safe to lift out first: nothing
 * that imports them can be surprised, because nothing about them changed.
 */

/**
 * Normalise a path for comparison.
 *
 * Windows paths arrive with backslashes and the policy is written with forward slashes, so a
 * plain string prefix test never matched: `C:\Windows\System32\cmd.exe` was not recognised as
 * living under `path:c:/windows/`, and therefore **nothing** was ever covered by the allowlist.
 * Every finding looked unauthorised. Separators are folded here so the comparison is about the
 * path and not about which slash the writer happened to use.
 */
export function normalizePath(p) {
  if (!p) return ''
  return String(p).split(String.fromCharCode(92)).join('/').toLowerCase()
}

/**
 * Read JSON, tolerating the byte Windows PowerShell puts in front of it.
 *
 * `Set-Content -Encoding UTF8` writes a BOM in Windows PowerShell 5.1, and JSON.parse throws on a
 * leading U+FEFF. That single byte cost a whole debugging round: the file existed, the poll saw it
 * 37 times out of 40, and every parse failed silently inside an empty catch. Strip it here rather
 * than trusting every writer to remember.
 */
export function readJsonLoose(file) {
  const raw = readFileSync(file, 'utf8')
  const clean = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  return JSON.parse(clean)
}

/**
 * Where the tool is installed. One definition, because "the directory above lib/" is a fact
 * about the checkout, not about whichever module happens to need it -- and a second copy of it
 * is a second thing to be wrong after the code moves, which is exactly how custody came to
 * reference CORE_ROOT without having one.
 */
export const CORE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))


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

/** Synchronous sleep -- readActivity is sync, and a busy-wait would be worse than useless here. */
export function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    /* if it is unavailable, skip the backoff rather than fail the read */
  }
}
