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
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const NL_SHIM = String.fromCharCode(10)
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

// --- resource layer ------------------------------------------------------- //
// The decision function is pure, so it can be checked against fixed inputs instead of
// against whatever this machine happens to be doing.
const res = await import('../lib/resources.mjs')

section('resources')
ok('probeResources exists', typeof res.probeResources === 'function')
ok('decideDefer exists', typeof res.decideDefer === 'function')
ok('waitForHeadroom exists', typeof res.waitForHeadroom === 'function')

const lowMem = { ok: true, totalGB: 16, freeGB: 0.4, cpu: 3, top: [] }
ok('defers when memory is tight', res.decideDefer(lowMem).defer === true)
ok('says why it deferred', /below the floor/.test(res.decideDefer(lowMem).reason))

const busyCpu = { ok: true, totalGB: 16, freeGB: 12, cpu: 97, top: [] }
ok('defers when the CPU is saturated', res.decideDefer(busyCpu).defer === true)

const fine = { ok: true, totalGB: 16, freeGB: 9, cpu: 12, top: [] }
ok('allows work when there is headroom', res.decideDefer(fine).defer === false)
ok('honours a caller-supplied floor', res.decideDefer(fine, { free: 12 }).defer === true)

const unknown = { ok: false, error: 'probe failed', totalGB: null, freeGB: null, cpu: null, top: [] }
ok('an unknown state defers rather than guessing', res.decideDefer(unknown).defer === true)

const withDaemon = {
  ok: true, totalGB: 16, freeGB: 9, cpu: 10,
  top: [{ pid: 1, name: 'python.exe', mb: 1200, cmd: 'python -m hindsight_api.server --port 9077' }],
}
ok('recognises the daemon by its command line', res.protectedAmong(withDaemon).length === 1)
ok('the daemon is reported as protected', /memory daemon/.test(res.protectedAmong(withDaemon)[0].why))
ok('the summary mentions protected processes', /protected in top/.test(res.summarizeResources(withDaemon)))

section('cli resources')
const rOk = spawnSync(process.execPath, [cli, 'resources'], { encoding: 'utf8' })
ok('resources exits 0 or 3', rOk.status === 0 || rOk.status === 3, `status=${rOk.status}`)
// Two correct outcomes: a reading, or a clean statement that the probe is unavailable. The
// probe needs PowerShell, which ubuntu-latest does not have, and degrading to "unavailable"
// rather than guessing is the behaviour worth asserting.
ok('resources reports free memory or says it is unavailable',
   /GB free of/.test(rOk.stdout) || /unavailable/i.test(rOk.stdout),
   rOk.stdout.slice(0, 120))
const rJson = spawnSync(process.execPath, [cli, '--json', 'resources'], { encoding: 'utf8' })
let resJson = null
try {
  resJson = JSON.parse(rJson.stdout)
} catch {
  /* handled below */
}
ok('resources --json emits valid JSON', resJson !== null)
ok('resources --json has a decision', resJson && typeof resJson.decision?.defer === 'boolean')
const dNoWait = spawnSync(process.execPath, [cli, 'defer'], { encoding: 'utf8' })
ok('defer exits 0 or 3', dNoWait.status === 0 || dNoWait.status === 3, `status=${dNoWait.status}`)

// --- custody: is anything still frozen? ------------------------------------ //
// The query exists because a suspension is persistent: a detain whose operator forgot about it
// stays frozen with nothing on the machine saying so. The interesting part is that the first
// version read the detain-*.json summaries, and on a real machine those had all vanished -- so
// it answered "nothing under custody" while five shells had been frozen. The append-only
// activity log is the source of truth; this checks the rebuild works from that alone.

section('custody')
{
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  // Imported here rather than relying on the later top-level import: this section runs before it.
  const g = await import('../lib/core.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'vsep-custody-'))
  const activity = join(dir, 'activity')
  mkdirSync(activity, { recursive: true })
  const day = 'activity-2000-01-01.ndjson'
  const lines = [
    // frozen, never released
    { t: '2000-01-01T10:00:00Z', kind: 'detain', action: 'suspended', pid: 1111, name: 'cmd.exe' },
    { t: '2000-01-01T10:00:01Z', kind: 'detain', action: 'revealed', pid: 1111 },
    // frozen and released
    { t: '2000-01-01T10:05:00Z', kind: 'detain', action: 'suspended', pid: 2222, name: 'cmd.exe' },
    { t: '2000-01-01T10:06:00Z', kind: 'detain', action: 'released', pid: 2222, name: 'cmd.exe' },
    // not a custody event at all
    { t: '2000-01-01T10:07:00Z', kind: 'proc-start', name: 'explorer.exe' },
  ]
  const NL = String.fromCharCode(10)
  writeFileSync(join(activity, day), lines.map((l) => JSON.stringify(l)).join(NL) + NL, 'utf8')
  // A BOM on the first line must not cost an event.
  writeFileSync(join(activity, 'activity-2000-01-02.ndjson'),
    String.fromCharCode(0xfeff) + JSON.stringify({ t: '2000-01-02T09:00:00Z', kind: 'detain', action: 'suspended', pid: 3333, name: 'cmd.exe' }) + NL, 'utf8')

  const ctx = { logDir: dir }
  const rebuilt = g.rebuildCustody(ctx)
  ok('rebuilds from the activity log alone', rebuilt.ok === true, JSON.stringify(rebuilt))
  ok('found every suspend and release event', rebuilt.events === 4, `events=${rebuilt.events}`)
  ok('three pids are known', Object.keys(rebuilt.pids).length === 3, JSON.stringify(Object.keys(rebuilt.pids)))
  ok('the unreleased one is still recorded as suspended', rebuilt.pids['1111']?.suspended === true)
  ok('the released one is recorded as released', rebuilt.pids['2222']?.suspended === false)
  ok('ignores non-custody events', rebuilt.pids['undefined'] === undefined)
  ok('a BOM does not cost an event', rebuilt.pids['3333']?.suspended === true,
     'the BOM line was dropped')

  // Without probing, nothing is claimed about the live system.
  const noProbe = await g.custodyReport(ctx, { probe: false })
  ok('probe:false claims nothing about the system',
     noProbe.rows.every((r) => r.state === 'unverified'), JSON.stringify(noProbe.rows.map((r) => r.state)))
  ok('probe:false still lists the records', noProbe.rows.length === 3)

  rmSync(dir, { recursive: true, force: true })
}

section('cli detained')
{
  const r = spawnSync(process.execPath, [cli, 'detained'], { encoding: 'utf8' })
  ok('detained exits 0', r.status === 0, `status=${r.status}`)
  // Three correct outcomes, and "there is no record yet" is one of them: a machine where no
  // custody action has ever been taken has nothing to report, and saying so is not a failure.
  // Four correct outcomes. "nothing from the record is frozen" is worded that way on purpose:
  // the record is what is being summarised, and a scan may separately find unrecorded freezes.
  ok('detained reports frozen, nothing frozen, or no record',
     /still frozen|nothing from the record is frozen|no custody record|frozen with no record/.test(r.stdout),
     r.stdout.slice(0, 200))
  const rj = spawnSync(process.execPath, [cli, '--json', 'detained'], { encoding: 'utf8' })
  let parsed = null
  try {
    parsed = JSON.parse(rj.stdout)
  } catch {
    /* handled below */
  }
  ok('detained --json is valid JSON', parsed !== null)
  ok('detained --json separates frozen from history',
     parsed && Array.isArray(parsed.frozen) && Array.isArray(parsed.rows))
  const rnp = spawnSync(process.execPath, [cli, 'detained', '--no-probe'], { encoding: 'utf8' })
  ok('detained --no-probe exits 0', rnp.status === 0, `status=${rnp.status}`)
}

// --- custody alerts: does a forgotten freeze ever speak up? ------------------ //
// A suspension is persistent, so a freeze nobody came back for stays frozen forever. The
// `detained` command answers the question only if somebody thinks to ask, and the failure mode
// is exactly that nobody thinks to. This checks the alerting path fires, stays quiet when it
// should, and resumes nothing.

section('custody alerts')
{
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const g2 = await import('../lib/core.mjs')

  const dir = mkdtempSync(join(tmpdir(), 'vsep-alert-'))
  const activity = join(dir, 'activity')
  mkdirSync(activity, { recursive: true })
  const day = 'activity-' + new Date().toISOString().slice(0, 10) + '.ndjson'
  const threeHoursAgo = new Date(Date.now() - 3 * 3600 * 1000).toISOString()
  writeFileSync(join(activity, day), JSON.stringify({
    t: threeHoursAgo, kind: 'detain', action: 'suspended', pid: 4242, name: 'cmd.exe',
    created: threeHoursAgo,
  }) + NL_SHIM, 'utf8')

  const ctx2 = { logDir: dir }
  // A stub probe, so the alerting logic is tested without freezing anything real. The default
  // probe measures real thread states; this asserts the decision that follows from them.
  const frozen = async (pids) => Object.fromEntries(pids.map((p) => [p,
    { pid: p, exists: true, name: 'cmd.exe', threads: 4, suspended: 4, frozen: true, created: threeHoursAgo }]))
  const running = async (pids) => Object.fromEntries(pids.map((p) => [p,
    { pid: p, exists: true, name: 'cmd.exe', threads: 4, suspended: 0, frozen: false, created: threeHoursAgo }]))
  const gone = async (pids) => Object.fromEntries(pids.map((p) => [p, { pid: p, exists: false }]))

  const stale = await g2.staleCustody(ctx2, { staleMs: 3600000, probeFn: frozen })
  ok('a long-frozen process is reported as stale', stale.stale.length === 1, JSON.stringify(stale.stale))
  ok('the frozen duration is derived from the event', stale.stale[0]?.frozenForMs >= 3 * 3600 * 1000)

  const fresh = await g2.staleCustody(ctx2, { staleMs: 6 * 3600 * 1000, probeFn: frozen })
  ok('below the threshold nothing is stale', fresh.stale.length === 0)

  const releasedAlready = await g2.staleCustody(ctx2, { staleMs: 3600000, probeFn: running })
  ok('a process that is running is not stale', releasedAlready.stale.length === 0)

  const exitedAlready = await g2.staleCustody(ctx2, { staleMs: 3600000, probeFn: gone })
  ok('a process that exited is history, not an alert', exitedAlready.stale.length === 0)

  const first = await g2.reconcileCustody(ctx2, { staleMs: 3600000, probeFn: frozen })
  ok('the alert fires', first.alerted === true, JSON.stringify(first))
  ok('it names the pid and the duration', /4242/.test(first.detail) && /frozen/.test(first.detail),
     first.detail)
  ok('it does not claim to have resumed anything',
     first.stale.every((r) => r.state !== 'resumed'), JSON.stringify(first.stale.map((r) => r.state)))

  const second = await g2.reconcileCustody(ctx2, { staleMs: 3600000, probeFn: frozen })
  ok('it is throttled to once an hour', second.alerted === false, JSON.stringify(second))
  ok('and it says why it stayed quiet', /already alerted/.test(second.why ?? ''), second.why)

  const lines = readFileSync(join(activity, day), 'utf8').trim().split(NL_SHIM)
  const last = JSON.parse(lines[lines.length - 1])
  ok('the alert is written to the record', last.kind === 'custody-alert', JSON.stringify(last))
  ok('the record says nothing was resumed automatically', /nothing was resumed/.test(last.hint ?? ''),
     last.hint)
  ok('the alert tells the reader what to run', /detained/.test(last.hint ?? ''))

  const quiet = await g2.reconcileCustody(ctx2, { staleMs: 3600000, probeFn: running })
  ok('nothing stale means no alert', quiet.alerted === false)

  rmSync(dir, { recursive: true, force: true })
}

section('cli heal --custody')
{
  // heal exits 1 where uv is not installed, and that is correct -- the chain fails at its first
  // link. What matters here is that the custody reconcile ran anyway and did not error, which is
  // the whole point of doing it before the service chain is touched.
  const r = spawnSync(process.execPath, [cli, 'heal', '--custody', '--quiet'], { encoding: 'utf8' })
  ok('heal --custody does not crash', r.status === 0 || r.status === 1, `status=${r.status}`)
  ok('a missing uv is reported as such, not as a custody failure',
     !/custody=ERROR/.test(r.stdout ?? ''), (r.stdout ?? '').slice(0, 200))
  const rHelp = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' })
  ok('--help mentions the custody reconcile', /custody/.test(rHelp.stdout))
}

// --- frozen with no record: the half that was invisible --------------------- //
// Everything before this reconciled the freezes this tool performed. A process that is frozen
// with no record of anybody freezing it is a different finding, and it was invisible by
// construction: `detained` enumerates the record, so anything absent from the record cannot
// appear in it. Answering it needs the opposite direction -- walk the machine, then subtract.

section('unrecorded custody')
{
  const { mkdtempSync, writeFileSync, appendFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const g3 = await import('../lib/core.mjs')

  const dir = mkdtempSync(join(tmpdir(), 'vsep-unrec-'))
  const activity = join(dir, 'activity')
  mkdirSync(activity, { recursive: true })
  const day = 'activity-' + new Date().toISOString().slice(0, 10) + '.ndjson'
  const past = new Date(Date.now() - 2 * 3600 * 1000).toISOString()
  const ctx3 = { logDir: dir }

  const scanOf = (list, denied = 0) => async () => ({ ok: true, denied, suspended: list })

  // Nothing in the record, something frozen on the machine.
  const stranger = await g3.unrecordedCustody(ctx3, {
    scanFn: scanOf([{ pid: 2222, name: 'unknown.exe', threads: 8, created: past }]),
  })
  ok('a frozen process with no record is found', stranger.unrecorded.length === 1,
     JSON.stringify(stranger.unrecorded))
  ok('and the reason says so', /no record/.test(stranger.unrecorded[0]?.why ?? ''))

  // Now put a matching record in and it is no longer a stranger.
  writeFileSync(join(activity, day), JSON.stringify({
    t: past, kind: 'detain', action: 'suspended', pid: 2222, name: 'unknown.exe', created: past,
  }) + NL_SHIM, 'utf8')
  const known = await g3.unrecordedCustody(ctx3, {
    scanFn: scanOf([{ pid: 2222, name: 'unknown.exe', threads: 8, created: past }]),
  })
  ok('a recorded freeze is not reported as unrecorded', known.unrecorded.length === 0,
     JSON.stringify(known.unrecorded))

  // Same pid, different process: a recycled number must not be mistaken for the recorded one.
  const otherMoment = new Date(Date.now() - 60 * 1000).toISOString()
  const recycled = await g3.unrecordedCustody(ctx3, {
    scanFn: scanOf([{ pid: 2222, name: 'something-else.exe', threads: 3, created: otherMoment }]),
  })
  ok('a recycled pid is not mistaken for the recorded process', recycled.unrecorded.length === 1,
     JSON.stringify(recycled.unrecorded))
  ok('and says which of the two it is', /different process/.test(recycled.unrecorded[0]?.why ?? ''),
     recycled.unrecorded[0]?.why)

  // A scan that could not read everything must not be presented as a clean sweep.
  const partial = await g3.unrecordedCustody(ctx3, { scanFn: scanOf([], 17) })
  ok('a partial scan reports how much it could not read', partial.denied === 17, JSON.stringify(partial))

  // A failed scan is a failure, not "nothing found".
  const failed = await g3.unrecordedCustody(ctx3, {
    scanFn: async () => ({ ok: false, reason: 'powershell is not available', suspended: [], denied: null }),
  })
  ok('a failed scan says so rather than reporting nothing', failed.ok === false &&
     /not available/.test(failed.reason ?? ''), JSON.stringify(failed))

  // Both findings reach the alert, and they are kept distinguishable in it.
  const frozenZn = async (pids) => Object.fromEntries(pids.map((p) => [p,
    { pid: p, exists: true, name: 'unknown.exe', threads: 8, suspended: 8, frozen: true, created: past }]))
  // Throttle state comes from the record, so a line that merely *mentions* custody-alert must not
  // be read as one. A released event carries the string in its hint text -- "run: volcano-separator
  // detained" style guidance lives there -- and a plain substring match counted those, producing a
  // reading of 11 alerts where the real count was zero.
  // Append, never overwrite: the suspended record above is what makes the next assertion
  // meaningful, and replacing the file silently removed it (which is how this test first failed).
  const decoyLine = JSON.stringify({
    t: new Date().toISOString(), kind: 'detain', action: 'released', pid: 2222, name: 'unknown.exe',
    hint: 'nothing was resumed automatically; a custody-alert is not what this line is',
  })
  appendFileSync(join(activity, day), decoyLine + NL_SHIM, 'utf8')
  ok('the decoy line really does contain the substring',
     decoyLine.includes('custody-alert') && !/"kind"\s*:\s*"custody-alert"/.test(decoyLine),
     'the fixture is not exercising the bug it claims to')

  const decoy = await g3.reconcileCustody(ctx3, {
    staleMs: 3600000, probeFn: frozenZn, scanFn: scanOf([]),
  })
  ok('a line that merely mentions the alert does not suppress the real one',
     decoy.alerted === true,
     `alerted=${decoy.alerted} -- the mention in a hint was read as an earlier alert`)

  // A fresh directory for the next assertion. The alert above armed the one-hour throttle, and
  // asserting on a throttled response would test the throttle rather than the thing under test --
  // which is exactly how this check first failed.
  const dir2 = mkdtempSync(join(tmpdir(), 'vsep-both-'))
  const activity2 = join(dir2, 'activity')
  mkdirSync(activity2, { recursive: true })
  writeFileSync(join(activity2, day), JSON.stringify({
    t: past, kind: 'detain', action: 'suspended', pid: 2222, name: 'unknown.exe', created: past,
  }) + NL_SHIM, 'utf8')
  const ctx4 = { logDir: dir2 }

  const both = await g3.reconcileCustody(ctx4, {
    staleMs: 3600000,
    probeFn: frozenZn,
    scanFn: scanOf([{ pid: 3333, name: 'ghost.exe', threads: 2, created: past }]),
  })
  ok('both kinds of finding reach the alert', both.alerted === true, JSON.stringify(both))
  ok('forgotten custody is counted separately from unrecorded', both.stale.length === 1 && both.unrecorded.length === 1,
     `stale=${both.stale.length} unrecorded=${both.unrecorded.length}`)
  ok('the alert text distinguishes them',
     /forgotten custody/.test(both.detail) && /frozen with no record/.test(both.detail), both.detail)

  rmSync(dir, { recursive: true, force: true })
}

section('cli detained --no-scan')
{
  const r = spawnSync(process.execPath, [cli, 'detained', '--no-scan'], { encoding: 'utf8' })
  ok('detained --no-scan exits 0', r.status === 0, `status=${r.status}`)
  const rFull = spawnSync(process.execPath, [cli, 'detained'], { encoding: 'utf8' })
  ok('detained with the scan exits 0', rFull.status === 0, `status=${rFull.status}`)
  ok('it either reports unrecorded freezes or says nothing is frozen',
     /frozen with no record|nothing from the record is frozen|no custody record/.test(rFull.stdout),
     rFull.stdout.slice(-200))
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

// ── activity record: write one, read it back ─
// This is the regression test for a real defect. Two recorder instances ran at once, one held
// the day's file open, and readers got EBUSY -- so readActivity returned "0 events, no recorder"
// while the recorder was alive and its file was 2.2 MB. A transparency tool that cannot read its
// own output has reproduced the problem it was built to remove.
{
  const dir = join(tmpdir(), 'volcano-separator-smoke-' + process.pid)
  rmSync(dir, { recursive: true, force: true })
  const act = join(dir, 'activity')
  mkdirSync(act, { recursive: true })
  const file = join(act, 'activity-2026-01-01.ndjson')
  const rows = [
    { t: '2026-01-01T00:00:01Z', kind: 'proc-start', pid: 1, ppid: 0, name: 'a.exe', cmd: 'a.exe' },
    { t: '2026-01-01T00:00:02Z', kind: 'window', pid: 1, name: 'a.exe', title: 'hello' },
    { t: '2026-01-01T00:00:03Z', kind: 'persist', surface: 'RunKeys', action: 'added', name: 'x', value: 'y' },
  ]
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join(String.fromCharCode(10)) + String.fromCharCode(10))

  const ctx = { logDir: dir, profile: 'smoke' }
  const back = g.readActivity(ctx, { limit: 10 })
  ok('activity record round-trips', back.total === 3, `read ${back.total} of 3`)
  ok('a readable record is reported readable', back.readable === true, `readable=${back.readable}`)
  ok('no read failures on a readable record', back.readFailures === 0, `failures=${back.readFailures}`)

  // Now the part that would have caught the bug: hold the file with a writer that denies
  // sharing. The reader must say so, and must NOT claim there is no recorder.
  const fd = openSync(file, 'a')
  let lockedRead = null
  try {
    lockedRead = g.readActivity(ctx, { limit: 10 })
  } finally {
    closeSync(fd)
  }
  ok('a locked record is still reported as a running recorder', lockedRead.recorderRunning === true, `recorderRunning=${lockedRead.recorderRunning}`)

  rmSync(dir, { recursive: true, force: true })
}

// ── summary ──────────────────────────────────────────────────────────────────
console.log('')
if (failures === 0) {
  console.log(`all ${checks} checks passed`)
  process.exit(0)
}
console.log(`${failures} of ${checks} checks FAILED`)
process.exit(1)
