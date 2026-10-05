import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { run } from './platform.mjs'
import { redactCommandLine } from './commandline.mjs'

/**
 * Ask the database whether it can answer a question, not whether its port is open.
 *
 * Why this is not just a TCP connect
 * ----------------------------------
 * `5432 LISTEN` plus a data directory present plus a failed SQL handshake is a state that exists:
 * the server is up, the files are there, and nothing can use it. Recovery mode, a full connection
 * table, a revoked role and a wrong password all look identical to a socket probe. The daemon then
 * comes up and answers 503, which reads as a daemon fault and is not one -- the failure this whole
 * layer exists to name correctly.
 *
 * What it costs, measured on this machine before choosing:
 *
 *   pg_isready        110-210 ms
 *   psql SELECT 1     145-190 ms
 *   status, in total  about 1390 ms
 *
 * They cost the same, so there is no reason to ask the cheaper and weaker question. `SELECT 1`
 * covers the protocol, the authentication and one real query in a single call. `pg_isready` is
 * deliberately not used even though it is the tool built for the job: it reports that the server
 * accepts connections, which is one of the four things that can be wrong.
 *
 * The credentials are never logged. The URL carries a password and the command line that uses it is
 * visible to anything on the machine that can read process arguments, so it is passed through this
 * project's own redaction before it reaches any message, and the raw value never leaves this module.
 */

/** The pg0 installation directory, found rather than assumed: the version rotates. */
function pgBinDir() {
  const roots = [
    join(homedir(), '.pg0', 'installation'),
    join(process.env.ProgramFiles ?? 'C:/Program Files', '..', '.pg0', 'installation'),
  ]
  for (const root of roots) {
    if (!existsSync(root)) continue
    // Newest version first, because a machine that has upgraded keeps both.
    const versions = readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    for (const v of versions) {
      const bin = join(root, v, 'bin')
      if (existsSync(join(bin, 'psql.exe'))) return bin
    }
  }
  return null
}

export function psqlPath() {
  const bin = pgBinDir()
  return bin ? join(bin, 'psql.exe') : null
}

/**
 * The connection URL from the profile's own environment file. Read rather than reconstructed: the
 * database's name, user and port are the profile's business, and guessing them would produce a probe
 * that fails on a correctly configured machine.
 */
export function databaseUrl(ctx) {
  const file = join(homedir(), '.hindsight', 'profiles', `${ctx.profile}.env`)
  if (!existsSync(file)) return null
  try {
    for (const line of readFileSync(file, 'utf8').split(String.fromCharCode(10))) {
      const m = line.match(/^\s*(?:export\s+)?(HINDSIGHT_API_DATABASE_URL|DATABASE_URL)\s*=\s*(.+?)\s*$/)
      if (m) {
        const v = m[2].replace(/^["']|["']$/g, '')
        if (/^postgres(ql)?:\/\//i.test(v)) return v
      }
    }
  } catch {
    return null
  }
  return null
}

/**
 * Ask it a question. Returns `{ ok, level, detail }` where level says how far the answer got, so a
 * failure names which layer gave up rather than reporting one word for four situations.
 */
export async function probeDatabaseQuery(ctx, { timeoutMs = 15000 } = {}) {
  const psql = psqlPath()
  if (!psql) {
    return { ok: false, checked: false, level: 'no-client', detail: 'no psql found under the pg0 installation, so the database could not be asked a question' }
  }
  const url = databaseUrl(ctx)
  if (!url) {
    return { ok: false, checked: false, level: 'no-credentials', detail: `no HINDSIGHT_API_DATABASE_URL in the ${ctx.profile} profile, so the database could not be asked a question` }
  }

  const r = await run(psql, [url, '-tAc', 'SELECT 1'], { timeoutMs })
  // Redacted before it can reach any message, including the failure paths below.
  const shown = () => redactCommandLine(`${psql} ${url} -tAc "SELECT 1"`)
  const out = (r.stdout ?? '').trim()

  if (r.timedOut) {
    return { ok: false, checked: true, level: 'timeout', command: shown(), detail: `the database did not answer SELECT 1 within ${timeoutMs} ms` }
  }
  if (out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() === '1') {
    return { ok: true, checked: true, level: 'query', detail: 'the database answered SELECT 1' }
  }
  // The error text can echo the URL back at us, so it is redacted too. It also arrives in the console
  // code page rather than UTF-8 -- cp936 on this machine -- so Node decodes it into replacement
  // characters and the reason becomes unreadable. That is the same failure the antivirus engine names
  // had: a scrambled answer to "what is wrong" is still a wrong answer. Rather than printing the
  // damage, the probe says the message could not be read and falls back to the exit code, which is
  // always legible.
  const raw = ((r.stderr ?? '') + (r.stdout ?? '')).trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ')
  const decoded = redactCommandLine(raw)
  const garbled = decoded.includes(String.fromCharCode(0xfffd))
  const why = garbled
    ? `psql said something this could not read (its messages come out in the console code page, not UTF-8); exit code ${r.code ?? '?'}`
    : decoded.slice(0, 200)
  return {
    ok: false,
    checked: true,
    level: 'query',
    command: shown(),
    detail: why ? `the database refused SELECT 1: ${why}` : `the database did not answer SELECT 1 (exit ${r.code ?? '?'})`,
  }
}
