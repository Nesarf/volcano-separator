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
 * Which PowerShell runs the platform layer.
 *
 * **Decided once, on measurement, and kept in one place.** The interpreter name used to be written
 * into nineteen call sites across six modules, which is not a decision -- it is nineteen assumptions
 * that happen to agree. The choice only became visible when a second interpreter appeared on the
 * machine and someone asked why the first one was still being used.
 *
 * PowerShell 5.1 wins here, and the reason is the whole point of this tool: the platform layer is
 * called often, and its cost is per call.
 *
 *   measured on this machine, short round trip (2026-10-06)
 *     powershell 5.1    806 ms bare, 1349 ms with a script
 *     pwsh     7.6.6   1136 ms bare, 1157 ms with a script
 *
 * `pwsh` pays a fixed ~1.1 s to bring up the .NET runtime. That is most of its cost, so it cannot be
 * amortised, and 5.1 starts and executes faster than that for everything this tool asks it to do --
 * including the expensive probe, where 5.1 was 1850 ms against pwsh's 4667 ms.
 *
 * What choosing 5.1 costs, all of it already paid for in this codebase rather than newly accepted:
 *   * `Set-Content -Encoding UTF8` writes a BOM here and does not on pwsh. `readJsonLoose` exists
 *     because of it, and this project spent a whole debugging round on that byte once.
 *   * no `AesGcm` (it is .NET Framework 4.x), which is why the encryption path is split the way it is:
 *     Node does the crypto, PowerShell does DPAPI.
 *   * no `ResolveLinkTarget`, which is why `resolve-path.ps1` uses `GetFinalPathNameByHandle` through
 *     P/Invoke.
 *
 * The alternative is not "use pwsh instead" but "use whichever", and that is what the nineteen call
 * sites were already doing by accident. On a non-Windows host there is only `pwsh`, so that is what
 * this returns there -- the choice is about Windows, where both exist.
 */
export function powershellHost() {
  if (process.platform !== 'win32') return 'pwsh'
  return process.env.VSEP_POWERSHELL === 'pwsh' ? 'pwsh' : 'powershell'
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

/** Synchronous sleep -- readActivity is sync, and a busy-wait would be worse than useless here. */
export function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    /* if it is unavailable, skip the backoff rather than fail the read */
  }
}
