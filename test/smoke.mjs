#!/usr/bin/env node
/**
 * Offline smoke test. Zero dependencies, no network, no uv, no hindsight required.
 *
 * It checks the properties that matter for a supervisor:
 *   - the module loads and exports the documented surface
 *   - every probe degrades gracefully instead of throwing when its dependency is missing
 *   - the CLI behaves (help, JSON doctor, unknown command exit code)
 *
 * Run: node test/smoke.mjs
 */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectDir = resolve(here, '..')
const cli = join(projectDir, 'bin', 'cli.mjs')

let failures = 0
let checks = 0

function ok(label, cond, extra = '') {
  checks++
  if (cond) {
    console.log(`  ok   ${label}`)
  } else {
    failures++
    console.log(`  FAIL ${label}${extra ? ' -- ' + extra : ''}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

// A port nothing should be listening on.
const DEAD_PORT = 59987

// ── 1. module surface ────────────────────────────────────────────────────────
section('module surface')
const g = await import('../lib/core.mjs')

const expected = [
  'DEFAULTS',
  'resolveContext',
  'findPluginLogs',
  'probeUv',
  'probePort',
  'probeDaemon',
  'probeDaemonLog',
  'probePostgres',
  'probeEnv',
  'warm',
  'serve',
  'stop',
  'restart',
  'heal',
  'doctor',
  'status',
  'guardCacheOp',
  'installService',
  'uninstallService',
  'serviceState',
  'killDaemonTree',
  'findPortOwner',
]
for (const name of expected) ok(`exports ${name}`, typeof g[name] === 'function' || typeof g[name] === 'object')

// ── 2. context resolution ────────────────────────────────────────────────────
section('context resolution')
const ctx = g.resolveContext({ port: DEAD_PORT })
ok('port honoured', ctx.port === DEAD_PORT, `got ${ctx.port}`)
ok('url derived from port', ctx.url === `http://127.0.0.1:${DEAD_PORT}`, ctx.url)
ok('profile default', ctx.profile === 'coding-agent', ctx.profile)
ok('env carries UV_CACHE_DIR when known', !ctx.uvCacheDir || ctx.env.UV_CACHE_DIR === ctx.uvCacheDir)
ok('profile paths derived', typeof ctx.profileEnvFile === 'string' && ctx.profileEnvFile.endsWith('.env'))

// ── 3. probes degrade instead of throwing ────────────────────────────────────
section('probes degrade gracefully')
const noUv = await g.probeUv({ uvx: null })
ok('probeUv with no uvx -> ok:false', noUv.ok === false)
ok('probeUv explains the broken first link', /PATH/.test(noUv.detail), noUv.detail)

ok('probePort on a dead port -> false', (await g.probePort(DEAD_PORT, 800)) === false)

const dead = await g.probeDaemon(ctx)
ok('probeDaemon on a dead port -> ok:false', dead.ok === false)
ok('probeDaemon reports the port', String(dead.detail).includes(String(DEAD_PORT)), dead.detail)

const tree = await g.killDaemonTree(ctx, {})
ok('killDaemonTree on a dead port is a no-op', tree.killed.length === 0 && tree.ok === true)

// The two probes that catch a daemon which is "up" but not working.
const pgDead = await g.probePostgres({ ...ctx, pgPort: DEAD_PORT })
ok('probePostgres on a dead port -> ok:false', pgDead.ok === false, pgDead.detail)
ok('probePostgres reports the port', String(pgDead.detail).includes(String(DEAD_PORT)), pgDead.detail)

const noLog = await g.probeDaemonLog({ ...ctx, profileLogFile: join(projectDir, 'no-such-log.log') })
ok('probeDaemonLog with no log -> ok:true (absence is not a failure)', noLog.ok === true)
ok('probeDaemonLog reports it is unavailable', noLog.available === false)
ok('probeDaemonLog counts zero errors', noLog.fresh === 0 && noLog.count === 0)

// ── 4. the cache guardrail ───────────────────────────────────────────────────
section('cache guardrail')
const safeRead = await g.guardCacheOp(ctx, 'status')
ok('non-mutating op -> safe', safeRead.safe === true)
const safeClean = await g.guardCacheOp(ctx, 'clean')
ok('clean with no daemon running -> safe', safeClean.safe === true, safeClean.detail)
const safePrune = await g.guardCacheOp(ctx, 'prune')
ok('prune with no daemon running -> safe', safePrune.safe === true)

// ── 5. doctor over an empty log set ──────────────────────────────────────────
section('doctor')
const doc = await g.doctor(ctx)
ok('doctor returns a report', typeof doc === 'object' && Array.isArray(doc.events))
ok('doctor counts are numbers', Number.isInteger(doc.attempts) && Number.isInteger(doc.failed))
ok('doctor always has a verdict', typeof doc.verdict === 'string' && doc.verdict.length > 0)

// ── 6. CLI behaviour ─────────────────────────────────────────────────────────
section('cli')
function runCli(args) {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 60000 })
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

const help = runCli(['--help'])
ok('--help exits 0', help.code === 0, `code ${help.code}`)
ok('--help names the tool', help.out.includes('volcano-separator'))
ok('--help lists heal', help.out.includes('heal'))

const docJson = runCli(['doctor', '--json'])
ok('doctor --json exits 0', docJson.code === 0, `code ${docJson.code}`)
let parsed = null
try {
  parsed = JSON.parse(docJson.out)
} catch {
  /* reported below */
}
ok('doctor --json emits valid JSON', parsed !== null && typeof parsed.verdict === 'string')

const bogus = runCli(['definitely-not-a-command'])
ok('unknown command exits 2', bogus.code === 2, `code ${bogus.code}`)

// ── summary ──────────────────────────────────────────────────────────────────
console.log('')
if (failures === 0) {
  console.log(`all ${checks} checks passed`)
  process.exit(0)
}
console.log(`${failures} of ${checks} checks FAILED`)
process.exit(1)
