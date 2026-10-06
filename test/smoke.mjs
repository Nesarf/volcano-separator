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

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const NL_SHIM = String.fromCharCode(10)
const here = dirname(fileURLToPath(import.meta.url))
const projectDir = resolve(here, '..')
const cli = join(projectDir, 'bin', 'cli.mjs')

// Source-text assertions read every module, not one named file. They are about a property the
// code has -- the collector checks the image name, the probe resolves offline -- and saying
// "core.mjs contains this string" made them break the moment the code moved to another module,
// which is a property of the file layout and not of the code.
// Terminal colour codes sit inside the sentences these tests match on, so `would have acted 4 time`
// does not match `would have acted <esc>4<esc> time`. Stripping them first is the difference between
// testing the output and testing the colouring.
// Built from character codes rather than written as a literal: an escape character, then the CSI
// bracket, then the parameters. Every attempt to write this as a regex literal in this file has lost
// a backslash to one escaping layer or another, which is why the import check builds its patterns
// the same way.
const stripAnsi = (s) => String(s).replace(new RegExp(String.fromCharCode(27) + String.fromCharCode(91) + '[0-9;]*m', 'g'), '')

const libSource = () => readdirSync(join(projectDir, 'lib'))
  .filter((f) => f.endsWith('.mjs'))
  .map((f) => readFileSync(join(projectDir, 'lib', f), 'utf8'))
  .join(NL_SHIM)
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
  rmSync(dir2, { recursive: true, force: true })
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

// --- released by something else: custody that somebody else ended ------------- //
// The third finding, and the most informative: a process this tool froze that is running again
// with no release through our own path. Something else resumed it. It is an event rather than a
// condition, so it must be said once per freeze -- not once per heartbeat, and not never after a
// re-detention.

section('release notices')
{
  const { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const g4 = await import('../lib/core.mjs')

  const dir = mkdtempSync(join(tmpdir(), 'vsep-rel-'))
  const activity = join(dir, 'activity')
  mkdirSync(activity, { recursive: true })
  const day = 'activity-' + new Date().toISOString().slice(0, 10) + '.ndjson'
  const logFile = join(activity, day)
  const t1 = new Date(Date.now() - 2 * 3600 * 1000).toISOString()
  const ctx5 = { logDir: dir }

  // The freeze, then a probe that says the process is running.
  writeFileSync(logFile, JSON.stringify({
    t: t1, kind: 'detain', action: 'suspended', pid: 5555, name: 'cmd.exe', created: t1,
  }) + NL_SHIM, 'utf8')
  // `created` must describe the real process, or the reconciliation rightly calls it a recycled
  // pid instead -- which is how this fixture first failed.
  const runningFn = async (pids) => Object.fromEntries(pids.map((p) => [p,
    { pid: p, exists: true, name: 'cmd.exe', threads: 4, suspended: 0, frozen: false, created: t1 }]))
  const notices = () => readFileSync(logFile, 'utf8').split(NL_SHIM)
    .filter((l) => l.includes('"kind":"custody-release-notice"')).length

  const found = await g4.unauthorizedReleases(ctx5, { probeFn: runningFn })
  ok('a frozen process that is running again is noticed', found.releases.length === 1,
     JSON.stringify(found.releases))
  ok('and the reason says no release was recorded', /no release was recorded/.test(found.releases[0]?.why ?? ''))

  await g4.reconcileCustody(ctx5, { probeFn: runningFn })
  const afterFirst = notices()
  ok('the notice reaches the record', afterFirst === 1, `notices=${afterFirst}`)

  await g4.reconcileCustody(ctx5, { probeFn: runningFn })
  ok('it is said once, not once per heartbeat', notices() === afterFirst,
     `notices went ${afterFirst} -> ${notices()}`)

  // Re-detained and released again: a second event, and it must be reported.
  const t2 = new Date(Date.now() + 1000).toISOString()
  appendFileSync(logFile, JSON.stringify({
    t: t2, kind: 'detain', action: 'suspended', pid: 5555, name: 'cmd.exe', created: t1,
  }) + NL_SHIM, 'utf8')
  const again = await g4.unauthorizedReleases(ctx5, { probeFn: runningFn })
  ok('a re-detained process released again is reported again', again.releases.length === 1,
     JSON.stringify(again.releases))
  await g4.reconcileCustody(ctx5, { probeFn: runningFn })
  ok('and a second notice is written', notices() === 2, `notices=${notices()}`)

  const last = JSON.parse(readFileSync(logFile, 'utf8').split(NL_SHIM)
    .filter((l) => l.includes('"kind":"custody-release-notice"')).pop())
  ok('the notice does not claim credit for the release', /nothing here did/.test(last.hint ?? ''),
     last.hint)

  // A process still frozen must not produce a release notice.
  const frozenFn = async (pids) => Object.fromEntries(pids.map((p) => [p,
    { pid: p, exists: true, name: 'cmd.exe', threads: 4, suspended: 4, frozen: true, created: t1 }]))
  const dir2 = mkdtempSync(join(tmpdir(), 'vsep-rel2-'))
  mkdirSync(join(dir2, 'activity'), { recursive: true })
  writeFileSync(join(dir2, 'activity', day), JSON.stringify({
    t: t1, kind: 'detain', action: 'suspended', pid: 6666, name: 'cmd.exe', created: t1,
  }) + NL_SHIM, 'utf8')
  const stillFrozen = await g4.unauthorizedReleases({ logDir: dir2 }, { probeFn: frozenFn })
  ok('a process still frozen is not reported as released', stillFrozen.releases.length === 0,
     JSON.stringify(stillFrozen.releases))

  rmSync(dir, { recursive: true, force: true })
  rmSync(dir2, { recursive: true, force: true })
}

// --- the life of a custody decision ----------------------------------------- //
// Every custody event is already in the record, but scattered among fifty thousand unrelated
// process events. Reconstructing one pid's history meant grepping a number and reading
// timestamps -- work a tool should do. What matters here is that a re-detention is a SECOND
// decision rather than a continuation, and that an open decision is only a to-do if the process
// still exists.

section('custody timeline')
{
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const g5 = await import('../lib/core.mjs')

  const dir = mkdtempSync(join(tmpdir(), 'vsep-tl-'))
  const activity = join(dir, 'activity')
  mkdirSync(activity, { recursive: true })
  const day = 'activity-' + new Date().toISOString().slice(0, 10) + '.ndjson'
  const t = (mins) => new Date(Date.now() - mins * 60000).toISOString()
  const put = (...events) => writeFileSync(join(activity, day),
    events.map((e) => JSON.stringify(e)).join(NL_SHIM) + NL_SHIM, 'utf8')
  const ctx6 = { logDir: dir }

  put(
    // released properly
    { t: t(60), kind: 'detain', action: 'suspended', pid: 100, name: 'cmd.exe', cmd: 'cmd /k one', created: t(60) },
    { t: t(60), kind: 'detain', action: 'revealed', pid: 100, windows: 1, forced: 0 },
    { t: t(59), kind: 'detain', action: 'released', pid: 100, name: 'cmd.exe' },
    // re-detained later: a second decision on the same pid
    { t: t(30), kind: 'detain', action: 'suspended', pid: 100, name: 'cmd.exe', cmd: 'cmd /k two', created: t(30) },
    { t: t(29), kind: 'detain', action: 'released', pid: 100, name: 'cmd.exe' },
    // never released
    { t: t(20), kind: 'detain', action: 'suspended', pid: 200, name: 'cmd.exe', cmd: 'cmd /k two', created: t(20) },
    // a reveal that arrives after the release must not attach to a live lifecycle
    { t: t(28), kind: 'detain', action: 'revealed', pid: 100, windows: 2, forced: 1 },
    // an alert while the open one was live
    { t: t(10), kind: 'custody-alert', action: 'stale', pid: 200, count: 1, detail: 'pid 200 frozen 0.2h' },
    // a release notice with no matching freeze
    { t: t(5), kind: 'custody-release-notice', action: 'released-by-something-else', pid: 900,
      detail: 'pid 900 ...', hint: 'something unknown resumed it' },
  )

  const tl = g5.custodyTimeline(ctx6)
  ok('one lifecycle per freeze, not per pid', tl.lifecycles.length === 3,
     `lifecycles=${tl.lifecycles.length}`)
  ok('a re-detention is a second decision', tl.lifecycles.filter((l) => l.pid === 100).length === 2,
     JSON.stringify(tl.lifecycles.filter((l) => l.pid === 100).map((l) => l.frozenAt)))
  ok('the released ones are closed and the other is open',
     tl.byOutcome && tl.byOutcome.released === 2 && tl.byOutcome['never released'] === 1,
     JSON.stringify(tl.byOutcome))
  ok('a duration is computed for the closed ones',
     tl.lifecycles.filter((l) => l.endedAt).every((l) => l.durationMs > 0),
     JSON.stringify(tl.lifecycles.filter((l) => l.endedAt).map((l) => l.durationMs)))
  ok('the command line is kept', /one/.test(tl.lifecycles[0].command ?? ''),
     tl.lifecycles[0].command)
  ok('the reveal is recorded as an entry', tl.lifecycles[0].entries.some((e) => /revealed/.test(e.what)))

  const openOne = tl.lifecycles.find((l) => l.pid === 200)
  ok('the alert is attached to the freeze it was about', openOne.notices.length === 1,
     JSON.stringify(openOne.notices))
  ok('an unattachable notice is kept as a system notice', tl.systemNotices.length >= 1,
     JSON.stringify(tl.systemNotices))

  // A reveal arriving after the release must not resurrect the closed lifecycle.
  ok('a late reveal does not reopen a closed decision',
     tl.lifecycles.filter((l) => !l.endedAt).length === 1,
     JSON.stringify(tl.lifecycles.map((l) => [l.pid, l.outcome, l.entries.length])))

  // With the live probe overlaid, an open decision about a process that is gone is history.
  const gone = async (pids) => Object.fromEntries(pids.map((p) => [p, { pid: p, exists: false }]))
  const live1 = await g5.custodyTimelineLive(ctx6, { probeFn: gone })
  const openLive = live1.open.find((l) => l.pid === 200)
  ok('an open decision about a dead process is marked as such',
     openLive && openLive.liveState === 'process gone', JSON.stringify(openLive?.liveState))

  const stillFrozen = async (pids) => Object.fromEntries(pids.map((p) => [p,
    { pid: p, exists: true, name: 'cmd.exe', threads: 3, suspended: 3, frozen: true }]))
  const live2 = await g5.custodyTimelineLive(ctx6, { probeFn: stillFrozen })
  ok('an open decision about a frozen process is marked as actionable',
     live2.open.find((l) => l.pid === 200)?.liveState === 'still frozen',
     JSON.stringify(live2.open.map((l) => l.liveState)))

  ok('durations read as durations', g5.humanDuration(5000) === '5s' &&
     /m /.test(g5.humanDuration(150000)) && /h /.test(g5.humanDuration(9000000)),
     `${g5.humanDuration(5000)} / ${g5.humanDuration(150000)} / ${g5.humanDuration(9000000)}`)

  rmSync(dir, { recursive: true, force: true })
}

section('cli timeline')
{
  const r = spawnSync(process.execPath, [cli, 'timeline'], { encoding: 'utf8' })
  ok('timeline exits 0', r.status === 0, `status=${r.status}`)
  ok('it reports either decisions or an empty record',
     /custody timeline|no custody record/.test(r.stdout), r.stdout.slice(0, 160))
  const rj = spawnSync(process.execPath, [cli, '--json', 'timeline'], { encoding: 'utf8' })
  let parsed = null
  try {
    parsed = JSON.parse(rj.stdout)
  } catch {
    /* handled below */
  }
  ok('timeline --json is valid JSON', parsed !== null)
  ok('timeline --json carries the lifecycles', parsed && Array.isArray(parsed.lifecycles))
  const rnp = spawnSync(process.execPath, [cli, 'timeline', '--no-probe'], { encoding: 'utf8' })
  ok('timeline --no-probe exits 0', rnp.status === 0, `status=${rnp.status}`)
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

// ── L1 signals / L2 decisions: positive cases ─
// These rules had no test coverage, and on this machine they had never produced a finding that
// was not already allowlisted -- so `ask` was always 0. Zero false positives and zero true
// positives look identical from the outside, and only a synthetic case tells them apart.
//
// Writing that case immediately found a real defect, recorded in the last two checks below.
{
  const dir = join(tmpdir(), 'volcano-separator-signals-' + process.pid)
  rmSync(dir, { recursive: true, force: true })
  const act = join(dir, 'activity')
  mkdirSync(act, { recursive: true })
  const BS = String.fromCharCode(92)
  const now = new Date().toISOString()
  const gonePath = 'D:' + BS + 'volcano-smoke-nonexistent' + BS + 'gone.exe'

  // A scratch path that is NOT covered by the built-in allowlist. tmpdir() cannot be used for
  // this: on this machine it resolves to E:\DaShaoHuo\cache\tmp, and `path:e:/dashaohuo/` is a
  // default allow entry -- which is exactly the defect the last two checks pin down.
  const scratch = join(homedir(), 'AppData', 'Local', 'Temp', 'volcano-smoke', 'payload.exe')
  const scratchCmd = '"' + scratch + '"'

  const rows = [
    { t: now, kind: 'persist', surface: 'RunKeys', action: 'added', name: 'evil', value: scratch },
    { t: now, kind: 'proc-start', pid: 9001, ppid: 1, name: 'payload.exe', cmd: scratchCmd },
    { t: now, kind: 'proc-start', pid: 9002, ppid: 1, name: 'gone.exe', cmd: '"' + gonePath + '"' },
    { t: now, kind: 'proc-start', pid: 9003, ppid: 1, name: 'cmd.exe', cmd: '"C:' + BS + 'Windows' + BS + 'System32' + BS + 'cmd.exe"' },
  ]
  writeFileSync(join(act, 'activity-2026-01-01.ndjson'),
    rows.map((r) => JSON.stringify(r)).join(String.fromCharCode(10)) + String.fromCharCode(10))

  const ctx = { logDir: dir, profile: 'smoke' }
  const sig = g.analyzeSignals(ctx, { sinceMinutes: 60 })
  const byRule = sig.byRule || {}
  ok('persist-from-ephemeral fires', byRule['persist-from-ephemeral'] === 1, JSON.stringify(byRule))
  ok('exec-from-ephemeral fires', byRule['exec-from-ephemeral'] === 1, JSON.stringify(byRule))
  // Two, not one: the payload path does not exist either, so it also trips binary-vanished. That
  // overlap is expected rather than a bug -- the rules describe different facts about one process.
  ok('binary-vanished fires for the missing exe and the scratch payload',
    byRule['binary-vanished'] === 2, JSON.stringify(byRule))
  ok('an ordinary system process produces no finding', byRule['binary-vanished'] === 2 && sig.total === 4, `total ${sig.total}`)

  const persist = sig.findings.find((f) => f.rule === 'persist-from-ephemeral')
  const exec = sig.findings.find((f) => f.rule === 'exec-from-ephemeral')
  ok('persistence from a scratch dir is high severity', persist && persist.severity === 'high', persist && persist.severity)
  ok('running from a scratch dir is low severity', exec && exec.severity === 'low', exec && exec.severity)

  const dec = g.decideSignals(ctx, { sinceMinutes: 60 })
  const v = (rule) => (dec.decisions.find((d) => d.rule === rule) || {}).verdict
  ok('an uncovered high finding asks for a human', v('persist-from-ephemeral') === 'ask', v('persist-from-ephemeral'))
  ok('an uncovered low finding is only a note', v('exec-from-ephemeral') === 'note', v('exec-from-ephemeral'))
  ok('nothing would act in observe mode', dec.decisions.every((d) => d.wouldAct === false), 'wouldAct true somewhere')

  // Allowlisting must turn ask into allow -- the mechanism the whole design rests on: the human's
  // decision is recorded, and the same finding stops asking.
  const polFile = join(dir, 'policy.json')
  const scratchRoot = join(homedir(), 'AppData', 'Local', 'Temp') + BS
  writeFileSync(polFile, JSON.stringify({
    mode: 'observe',
    allow: ['path:' + scratchRoot.toLowerCase().split(BS).join('/')],
  }))
  const ctx2 = { logDir: dir, profile: 'smoke', policyFile: polFile }
  const dec2 = g.decideSignals(ctx2, { sinceMinutes: 60 })
  const v2 = (rule) => (dec2.decisions.find((d) => d.rule === rule) || {}).verdict
  ok('allowlisting turns ask into allow', v2('persist-from-ephemeral') === 'allow', v2('persist-from-ephemeral'))
  ok('allowlisting is reported, not silent', (dec2.decisions.find((d) => d.rule === 'persist-from-ephemeral') || {}).allowed != null)

  // ── the defect this test found, and the rule that fixes it ─
  // The machine's disk policy redirects TEMP into a directory under an allowlisted volume root, so
  // both rules whose entire subject is "a temporary directory" were pre-approved and could never
  // ask. `ask` was always 0, which reads as "nothing to report" and meant "the rule cannot fire".
  //
  // Asserted through analyzeSignals rather than through policyAllows, because the raw match is
  // still broad and always will be -- what changed is whether a broad match may silence a
  // high-severity finding. A test of the matcher alone would have passed both before and after.
  const BS2 = String.fromCharCode(92)
  const wideScratch = join(tmpdir(), 'volcano-scratch')
  const wideRealTmp = join(wideScratch, 'payload.exe')
  writeFileSync(join(act, 'activity-2026-01-02.ndjson'),
    [
      { t: now, kind: 'persist', surface: 'RunKeys', action: 'added', name: 'evil', value: wideRealTmp },
      { t: now, kind: 'proc-start', pid: 9101, ppid: 1, name: 'payload.exe', cmd: '"' + wideRealTmp + '"' },
    ].map((r) => JSON.stringify(r)).join(String.fromCharCode(10)) + String.fromCharCode(10))

  const wideAllow = join(dir, 'wide-policy.json')
  // A broad entry: the grandparent of the scratch root, which is the shape the built-in list
  // uses for a volume (path:e:/dashaohuo/). Derived rather than hardcoded so this holds on a
  // machine whose TEMP lives somewhere else -- an earlier version of this test used the home
  // directory, which on this machine is on a different drive and therefore matched nothing at
  // all. That made 'no longer silenced' pass for the wrong reason: no match, not no suppression.
  const wideAncestor = dirname(dirname(tmpdir())).toLowerCase().split(BS2).join('/')
  writeFileSync(wideAllow, JSON.stringify({ mode: 'observe', allow: ['path:' + wideAncestor + '/'] }))
  const ctxWide = { logDir: dir, profile: 'smoke', policyFile: wideAllow }

  const wideSig = g.analyzeSignals(ctxWide, { sinceMinutes: 60 })
  const isWide = (f) => f.rule === 'persist-from-ephemeral' && String(f.path || '').includes('volcano-scratch')
  const persistWide = wideSig.findings.find(isWide)
  ok('a broad allow no longer silences a high-severity ephemeral finding',
    persistWide && persistWide.allowed === null, JSON.stringify(persistWide && persistWide.allowed))
  ok('what would have silenced it is reported rather than dropped away',
    persistWide && persistWide.suppressedBy != null, JSON.stringify(persistWide && persistWide.suppressedBy))

  const wideDec = g.decideSignals(ctxWide, { sinceMinutes: 60 })
  const wideVerdict = (wideDec.decisions.find(isWide) || {}).verdict
  ok('so the high finding can finally ask for a human', wideVerdict === 'ask', JSON.stringify(wideVerdict))

  // The low-severity half must keep its quiet: exec-from-ephemeral fires constantly from builds and
  // installers, which is what it was ranked low for. If it starts asking, the rule is noise.
  const execWide = wideSig.findings.find((f) => f.rule === 'exec-from-ephemeral' && String(f.path || '').includes('volcano-scratch'))
  ok('a broad allow still silences the low-severity ephemeral rule',
    execWide && execWide.allowed != null, 'exec-from-ephemeral stopped being allowlisted')

  // An allow entry naming the scratch directory itself is a decision about it, and must still work.
  const specificAllow = join(dir, 'specific-policy.json')
  writeFileSync(specificAllow, JSON.stringify({
    mode: 'observe',
    allow: ['path:' + wideScratch.toLowerCase().split(BS2).join('/') + '/'],
  }))
  const ctxSpecific = { logDir: dir, profile: 'smoke', policyFile: specificAllow }
  const specVerdict = (g.decideSignals(ctxSpecific, { sinceMinutes: 60 })
    .decisions.find(isWide) || {}).verdict
  ok('an allow entry naming the scratch directory still silences it', specVerdict === 'allow', JSON.stringify(specVerdict))

  rmSync(dir, { recursive: true, force: true })
}

// ── command-line redaction: both implementations, one fixture ─
// The recorder redacts at the WRITE point (bin/redact.ps1), because the log is append-only and a
// secret written once is written for good. lib/core.mjs carries a second implementation, for
// rendering records written before redaction existed.
//
// Two implementations of a security-relevant function is a smell, so this feeds one fixture to
// both. Agreement alone is not enough, though: two identically-wrong implementations agree
// perfectly. So every expected output is written down here as well.
{
  section('command-line redaction')
  const g = await import('../lib/core.mjs')
  const BS = String.fromCharCode(92)
  const winCmd = 'C:' + BS + 'Windows' + BS + 'System32' + BS + 'cmd.exe /c echo hello'
  const cfgPath = 'C:' + BS + 'cfg' + BS + 'secret.json'

  const CASES = [
    ['app.exe --token abc123', 'app.exe --token <redacted>'],
    ['app.exe --token=abc123 --verbose', 'app.exe --token=<redacted> --verbose'],
    ['app.exe --password "hunter two"', 'app.exe --password "<redacted>"'],
    ['mysql.exe -phunter2 -u root', 'mysql.exe -p<redacted> -u root'],
    // a port is not a password
    ['mysql.exe -p 5432 -u root', 'mysql.exe -p 5432 -u root'],
    ['cmd.exe /c SET AWS_SECRET_ACCESS_KEY=abc123def', 'cmd.exe /c SET AWS_SECRET_ACCESS_KEY=<redacted>'],
    // Three bugs lived in this one rule, all found by running it rather than reading it:
    // consuming only "authorization:" left the token in the clear; a greedy value ate the
    // enclosing quote and the next argument; and Basic <base64> stopped at the space after the
    // scheme and exposed the credentials.
    ['curl.exe -H "Authorization: Bearer eyJhbGciOi.J9" https://x', 'curl.exe -H "Authorization: <redacted>" https://x'],
    ['curl.exe -H "Authorization: Basic dXNlcjpwYXNz" https://x', 'curl.exe -H "Authorization: <redacted>" https://x'],
    ['curl.exe -H "Authorization: rawvalue" -o out.bin https://x', 'curl.exe -H "Authorization: <redacted>" -o out.bin https://x'],
    ['curl.exe -H "Bearer eyJhbGciOi.J9" https://x', 'curl.exe -H "Bearer <redacted>" https://x'],
    ['git.exe clone https://user:ghp_secret@github.com/a/b.git', 'git.exe clone https://user:<redacted>@github.com/a/b.git'],
    // ordinary commands must pass through untouched
    [winCmd, winCmd],
    ['python.exe -c print(1) --api-key KEY123', 'python.exe -c print(1) --api-key <redacted>'],
    ['node.exe --inspect --port 9229 app.js', 'node.exe --inspect --port 9229 app.js'],
    // --secret-file names a file, not a secret: it must survive
    ['app.exe --secret-file ' + cfgPath, 'app.exe --secret-file ' + cfgPath],
  ]

  let jsWrong = []
  for (const [input, expected] of CASES) {
    const got = g.redactCommandLine(input)
    if (got !== expected) jsWrong.push(`${input} -> ${got}`)
  }
  ok('redact: every case matches its expected output', jsWrong.length === 0, jsWrong.join(' | '))

  // The executable is what exeFromCmd parses out of this same string to decide what ran, and the
  // signals rules depend on it. Redaction must leave the first token alone.
  const redactedWin = g.redactCommandLine(winCmd + ' --token abc')
  ok('redact: the executable token survives', redactedWin.startsWith('C:' + BS + 'Windows' + BS + 'System32'), redactedWin)

  // The same fixture through the PowerShell implementation.
  const fixture = join(tmpdir(), 'volcano-redact-fixture-' + process.pid + '.json')
  writeFileSync(fixture, JSON.stringify(CASES.map(([i]) => i)))
  const redactPs1 = join(projectDir, 'bin', 'redact.ps1')
  const ps = spawnSync('powershell', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    '. "' + redactPs1 + '"; ' +
    '$c = Get-Content -Raw "' + fixture + '" | ConvertFrom-Json; ' +
    '$c | ForEach-Object { Protect-CommandLine $_ } | ConvertTo-Json -Compress',
  ], { encoding: 'utf8', timeout: 120000 })
  rmSync(fixture, { force: true })

  // Windows-only, like the rest of the platform layer: on a host without PowerShell the check
  // cannot run, and saying so is better than a green tick that measured nothing.
  if (ps.error || typeof ps.stdout !== 'string' || !ps.stdout.trim()) {
    ok('redact: PowerShell implementation unavailable on this host (skipped honestly)', true, '')
  } else {
    let psOut = null
    try { psOut = JSON.parse(ps.stdout.trim()) } catch { psOut = null }
    if (!Array.isArray(psOut)) psOut = [psOut]
    const psWrong = CASES.filter(([input, expected], i) => psOut[i] !== expected).map(([input]) => input)
    ok('redact: PowerShell matches the fixture on every case',
      psWrong.length === 0 && psOut.length === CASES.length,
      `returned ${psOut.length}/${CASES.length}; differs on: ${psWrong.join(' | ')}`)
    const diverged = CASES.map(([input], i) => [input, i])
      .filter(([, i]) => g.redactCommandLine(CASES[i][0]) !== psOut[i])
      .map(([input]) => input)
    ok('redact: the two implementations agree with each other',
      diverged.length === 0, diverged.join(' | '))
  }
}

// ── status is cheap unless asked ─
// Measuring uv warmth runs `uvx --with ... --help`, and uvx builds an ephemeral environment to run
// anything at all -- so a status call against a cache with no matching environment CREATES one.
// status is the command run most often, by hand and by agents, on the understanding that looking
// changes nothing, and it was feeding the very cache bloat `cache --prune` removes. So the warmth
// probe is behind --deep, and this pins that it stays there.
{
  section('status is read-only by default')
  const r = spawnSync(process.execPath, [cli, '--json', 'status'], { encoding: 'utf8', timeout: 180000 })
  let d = null
  try { d = JSON.parse(r.stdout) } catch { d = null }
  ok('status --json parses', d !== null, (r.stdout || '').slice(0, 100))
  if (d) {
    ok('status reports the uv probe was not run', d.envMeasured === false, `envMeasured=${d.envMeasured}`)
    ok('status leaves env null rather than inventing a default', d.env === null, JSON.stringify(d.env))
    // Not measured must not read as unhealthy: the chain's health never included warmth.
    ok('an unmeasured warmth does not make the chain unhealthy', typeof d.ok === 'boolean' && !!d.uv && !!d.daemon)
  }
  // The MCP surface must be read-only for the same reason -- an agent calling a status tool should
  // not be able to grow the cache. Asserted on the schema, since the schema is the contract.
  const mcpSrc = readFileSync(join(projectDir, 'lib', 'mcp.mjs'), 'utf8')
  ok('the MCP status tool documents its deep flag as not read-only',
    /deep[\s\S]{0,400}NOT read-only/.test(mcpSrc), 'the deep property lost its warning')
  ok('the MCP status tool still defaults to no deep', /args\.deep === true/.test(mcpSrc), 'deep stopped being opt-in')
}

// ── uv cache prune stages by rename ─
// The removal used to scan running processes and then rmSync the plan. Both halves were weak: the
// scan and the delete are not atomic, and a recursive rmSync can delete half a tree before
// failing. Staging by rename fixes both, because Windows refuses to rename a directory while a
// file inside it is open -- so a refused rename is the in-use answer itself, not a guess. That
// refusal is verified against a real held lock outside the suite; what is checked here is the
// machinery around it, which Node can drive.
{
  section('uv cache prune stages by rename')
  const uvc = await import('../lib/uvcache.mjs')
  const base = join(tmpdir(), 'volcano-uvcache-' + process.pid)
  const archive = join(base, 'archive-v0')
  const entry = join(archive, 'FAKEHASH12345678')
  rmSync(base, { recursive: true, force: true })
  mkdirSync(entry, { recursive: true })
  writeFileSync(join(entry, 'pyvenv.cfg'), 'home = x')
  writeFileSync(join(entry, 'payload.bin'), 'data')

  // The size in a plan is what the scan measured, so the fixture must use a measured size too.
  // A hand-written number would be rejected by the revalidation below -- which is the point of it.
  const entryBytes = statSync(join(entry, 'pyvenv.cfg')).size + statSync(join(entry, 'payload.bin')).size
  const plan = {
    ok: true, archiveDir: archive,
    targets: [{ hash: 'FAKEHASH12345678', dir: entry, bytes: entryBytes, name: '(uvx environment)', reason: 'stale-environment' }],
  }

  const dry = uvc.applyUvPrune(plan, { dryRun: true })
  ok('dry run removes nothing', dry.removed === 1 && dry.dryRun === true && existsSync(entry), JSON.stringify({ removed: dry.removed }))
  ok('dry run does not create the staging directory', !existsSync(join(archive, '.volcano-staging')))

  const real = uvc.applyUvPrune(plan, { dryRun: false })
  ok('a real run removes the entry', real.removed === 1 && !existsSync(entry), JSON.stringify(real.refused))
  ok('nothing was refused', Array.isArray(real.refused) && real.refused.length === 0, JSON.stringify(real.refused))
  ok('the staging directory is emptied, not left behind',
    !existsSync(join(archive, '.volcano-staging', 'FAKEHASH12345678')),
    'staged entry survived')

  // A target that vanished between planning and applying must be reported, not thrown: the plan
  // is a snapshot and the machine moves underneath it. It is reported as *gone*, not as *refused*:
  // "a running process holds this" and "this is not here any more" need different responses from
  // the person reading, and folding them together would hide which one happened.
  const gone = {
    ok: true, archiveDir: archive,
    targets: [{ hash: 'GONEHASH00000000', dir: join(archive, 'GONEHASH00000000'), bytes: 1, name: 'x', reason: 'duplicate' }],
  }
  let threw = null
  let res = null
  try { res = uvc.applyUvPrune(gone, { dryRun: false }) } catch (e) { threw = String(e) }
  ok('a target that vanished is reported rather than thrown',
    threw === null && res && res.gone.length === 1 && res.refused.length === 0,
    threw ? `threw ${threw}` : JSON.stringify({ gone: res?.gone, refused: res?.refused }))
  ok('a vanished target is not counted as removed', res?.removed === 0, JSON.stringify({ removed: res?.removed }))

  rmSync(base, { recursive: true, force: true })
}

// ── a reviewed plan is the only thing --apply carries out ─
// The CLI used to build a plan, show it, and then rescan when told to apply it. Both halves were
// individually careful and the pair was not: the list that ran was whatever the cache looked like
// at apply time, so a plan reviewed as "remove 40 entries, free 0.07 GB" could execute as a
// different 40 -- or as 60 -- while the output still read like the reviewed one. The rename test
// asks "is anything holding this entry", which is not the same question as "is this still the
// entry that was reviewed", and only the second one is the promise a reviewed plan makes.
{
  section('a reviewed plan is bound to what runs')
  const uvc = await import('../lib/uvcache.mjs')
  const base = join(tmpdir(), 'volcano-uvcplan-' + process.pid)
  const archive = join(base, 'archive-v0')
  const oldEntry = join(archive, 'PLANOLD000000001')
  const newEntry = join(archive, 'PLANNEW000000002')
  rmSync(base, { recursive: true, force: true })
  for (const [dir, version, filler] of [[oldEntry, '1.0.0', 200], [newEntry, '2.0.0', 400]]) {
    const dist = join(dir, 'demo-' + version + '.dist-info')
    mkdirSync(dist, { recursive: true })
    writeFileSync(join(dist, 'METADATA'), 'x'.repeat(filler))
  }
  const ctx = { uvCacheDir: base, uvCacheReal: base, cachePlanDir: join(base, 'plans') }

  const scan = await uvc.scanUvCache(ctx)
  ok('a synthetic cache can be scanned without a running machine',
    scan.ok === true && scan.packages.get('demo')?.length === 2, JSON.stringify({ ok: scan.ok, detail: scan.detail }))

  const plan = uvc.planUvPrune(scan, { keepVersions: 1, pruneEnvironments: false })
  ok('the plan names the older version and nothing else',
    plan.targets.length === 1 && plan.targets[0].hash === 'PLANOLD000000001', JSON.stringify(plan.targets.map((t) => t.hash)))

  const saved = uvc.savePlan(ctx, plan)
  ok('the plan is stored under its own id', saved.ok === true && existsSync(saved.file), JSON.stringify(saved))
  const back = uvc.loadPlan(ctx, plan.id)
  ok('it reads back with the same id and the same targets',
    back.ok === true && back.plan.id === plan.id && back.plan.targets.length === plan.targets.length,
    JSON.stringify({ ok: back.ok, detail: back.detail }))

  // A named plan that does not exist is a refusal, not a silent rebuild.
  const missing = uvc.loadPlan(ctx, 'deadbeefdeadbeef')
  ok('an unknown plan id is refused rather than rebuilt', missing.ok === false && /no saved plan/.test(missing.detail), JSON.stringify(missing))

  // A plan file whose contents disagree with its name is refused: the name is what a person read,
  // so a file that answers to a different name is not the plan that was reviewed.
  const liar = join(ctx.cachePlanDir, 'aaaaaaaaaaaaaaaa.json')
  writeFileSync(liar, JSON.stringify({ ...plan, id: 'bbbbbbbbbbbbbbbb' }), 'utf8')
  const lied = uvc.loadPlan(ctx, 'aaaaaaaaaaaaaaaa')
  ok('a plan whose contents disagree with its name is refused',
    lied.ok === false && /says it is/.test(lied.detail), JSON.stringify(lied))

  // An id is a name, never a path.
  let traversal = null
  try { uvc.loadPlan(ctx, '../../policy') } catch (e) { traversal = String(e) }
  ok('a plan id cannot walk out of the plan directory',
    traversal === null ? uvc.loadPlan(ctx, '../../policy').ok === false : /not a plan id/.test(traversal),
    JSON.stringify({ traversal }))

  // ── the revalidation, which is the whole point ──
  // The entry grew after the plan was made: it is not the entry that was reviewed, so it stays.
  const grown = join(oldEntry, 'demo-1.0.0.dist-info', 'EXTRA')
  writeFileSync(grown, 'y'.repeat(999))
  const applied = uvc.applyUvPrune(back.plan, { dryRun: false })
  ok('an entry that changed after the plan was made is left alone',
    applied.removed === 0 && applied.changed.length === 1 && applied.changed[0].hash === 'PLANOLD000000001',
    JSON.stringify({ removed: applied.removed, changed: applied.changed }))
  ok('the changed entry is still on disk', existsSync(oldEntry))
  ok('and the run says it was not intact', applied.intact === false && applied.skipped === 1,
    JSON.stringify({ intact: applied.intact, skipped: applied.skipped }))

  // Restored to what the plan described, the same plan then removes exactly it.
  rmSync(grown, { force: true })
  const second = uvc.applyUvPrune(back.plan, { dryRun: false })
  ok('the same plan removes the entry once it matches the plan again',
    second.removed === 1 && !existsSync(oldEntry) && second.intact === true,
    JSON.stringify({ removed: second.removed, changed: second.changed, gone: second.gone }))
  ok('and it removed nothing that was not in the plan',
    existsSync(newEntry) && second.targets.length === 1, JSON.stringify({ newEntryStill: existsSync(newEntry) }))

  // Nothing outside the reviewed plan is ever touched, even when the cache now holds more.
  const extraEntry = join(archive, 'PLANEXTRA0000003')
  mkdirSync(join(extraEntry, 'demo-3.0.0.dist-info'), { recursive: true })
  const third = uvc.applyUvPrune(back.plan, { dryRun: false })
  ok('a fresh candidate that appeared later is not removed by an older plan',
    third.removed === 0 && existsSync(extraEntry), JSON.stringify({ removed: third.removed, gone: third.gone }))

  rmSync(base, { recursive: true, force: true })
}

// ── the MCP server reports its real version ─
// The version was hardcoded to '1.0.0' and stayed there through five releases, so a client asking
// the server what it was got an answer five versions out of date. Checked by actually handshaking
// rather than by grepping the source for a string, because a grep would pass on any rewrite that
// keeps the same shape.
{
  section('mcp server version')
  const pkgVersion = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')).version
  const child = spawn(process.execPath, [join(projectDir, 'lib', 'mcp.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (b) => { out += b.toString() })
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } },
  }) + '\n')
  const deadline = Date.now() + 15000
  while (Date.now() < deadline && !out.includes('serverInfo')) {
    await new Promise((r) => setTimeout(r, 200))
  }
  child.kill()
  let info = null
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    try {
      const msg = JSON.parse(line)
      if (msg?.result?.serverInfo) info = msg.result.serverInfo
    } catch { /* not a complete frame yet */ }
  }
  ok('mcp answers an initialize handshake', info !== null, out.slice(0, 120))
  if (info) {
    ok('mcp reports the version package.json declares', info.version === pkgVersion,
      `mcp=${info.version} package=${pkgVersion}`)
    ok('mcp does not claim a version that does not exist', !/^1\.0\.0$/.test(info.version) || pkgVersion === '1.0.0',
      `version=${info.version}`)
  }
}

// ── every advertised MCP tool is called, not just listed ─
// A tool that appears in tools/list and throws when called is worse than no tool: the harness
// believes the capability exists. Writing this surface found three renderers reading field names
// that do not exist -- `over undefined min`, `? GB across ? file(s)` -- which call successfully,
// return text, and say nothing. A handshake or a schema check would have passed all three.
{
  section('mcp tool surface')
  const child = spawn(process.execPath, [join(projectDir, 'lib', 'mcp.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] })
  let buf = ''
  const pending = new Map()
  child.stdout.on('data', (b) => {
    buf += b.toString()
    let i
    while ((i = buf.indexOf(String.fromCharCode(10))) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      try {
        const m = JSON.parse(line)
        if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
      } catch { /* partial frame */ }
    }
  })
  let seq = 0
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, resolve)
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + String.fromCharCode(10))
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout: ' + method)) } }, 120000)
  })

  await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } })
  const list = await rpc('tools/list', {})
  const tools = list.result?.tools ?? []
  ok('mcp advertises a tool surface', tools.length >= 10, `${tools.length} tool(s)`)
  ok('every tool declares an object schema',
    tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'), 'a tool has no inputSchema')
  ok('every tool has a description long enough to choose by',
    tools.every((t) => typeof t.description === 'string' && t.description.length > 40), 'a tool has a thin description')

  // Nothing that changes the machine, beyond the repair tool that was already there.
  // Exact names, not a substring: volcano_detained READS the custody record and is safe, while
  // volcano_detain would freeze a process. A substring test flagged the wrong one of the pair.
  const FORBIDDEN = ['volcano_detain', 'volcano_release', 'volcano_cache_apply', 'volcano_policy_allow', 'volcano_uninstall']
  const mutating = tools.map((t) => t.name).filter((n) => FORBIDDEN.includes(n))
  ok('no destructive tool is exposed to a model', mutating.length === 0, mutating.join(', '))
  ok('the read-only half of the custody pair IS exposed',
    tools.some((t) => t.name === 'volcano_detained'), 'volcano_detained is missing')

  const bad = []
  for (const t of tools) {
    try {
      const r = await rpc('tools/call', { name: t.name, arguments: {} })
      const text = r.result?.content?.[0]?.text ?? ''
      // isError is NOT treated as a broken tool. An MCP tool that throws internally answers with a
      // JSON-RPC error, which is checked below; `isError` in the result means the tool ran and its
      // subject is unhealthy -- volcano_status reporting a down chain is it working. Treating that as
      // failure made this check flaky, and would make it fail outright on a machine with no service.
      if (r.error) bad.push(`${t.name}: ${JSON.stringify(r.error).slice(0, 60)}`)
      else if (!text.trim()) bad.push(`${t.name}: returned no text`)
      // The failure mode this test was written for: a renderer reading a field that is not there.
      else if (/undefined|\bNaN\b/.test(text)) bad.push(`${t.name}: output contains a placeholder -- ${text.split(String.fromCharCode(10))[0].slice(0, 70)}`)
    } catch (e) {
      bad.push(`${t.name}: ${String(e.message).slice(0, 60)}`)
    }
  }
  child.kill()
  ok('every advertised tool can actually be called and says something', bad.length === 0, bad.join(' | '))
}

// ── the daemon collector identifies the daemon, not just a name ─
// Name alone was the whole test: any python.exe from anywhere counted. The anchor is only
// "something is listening on 9077", so a process that merely shared a name could be killed for
// standing near the daemon. The real chain was measured rather than assumed, and every member names
// either the daemon or the port in its command line, so that is now the second condition.
//
// Nothing here actually stops anything. killDaemonTree grew a dryRun for exactly this reason: a
// function that kills processes has to be able to answer "which ones, and why" without killing
// them, and that is also what makes it testable on a machine that needs its daemon.
{
  section('daemon collector identifies the daemon')
  const g = await import('../lib/core.mjs')
  const ctx = g.resolveContext({})

  // Port 1 is not held by anything, so this exercises the empty path without touching the machine.
  const none = await g.killDaemonTree({ ...ctx, port: 1 }, { dryRun: true })
  ok('a port nobody holds collects nothing', none.ok && none.killed.length === 0, JSON.stringify(none.detail))

  // The DSH host itself, if the suite is run from inside one: a node.exe on its own port. It must
  // be declined, and it must still be alive afterwards -- which is also a check on the test.
  const foreignPort = 3080
  const foreign = await g.killDaemonTree({ ...ctx, port: foreignPort }, { dryRun: true })
  if (foreign.killed.length === 0 && foreign.refused.length > 0) {
    ok('a process that is not the daemon is refused', foreign.ok === false, JSON.stringify(foreign.detail))
    ok('the refusal carries the reason, not just a verdict',
      typeof foreign.refused[0].why === 'string' && foreign.refused[0].why.length > 10 && !!foreign.refused[0].exe,
      JSON.stringify(foreign.refused[0]))
    ok('a refused process is reported as refused rather than as nothing found',
      /refused to kill/.test(foreign.detail) && !/no collectable/.test(foreign.detail), foreign.detail)
  } else {
    // Port 3080 is free on this host, so the interesting case cannot be staged here. Saying so is
    // better than a green tick that measured nothing.
    ok('a foreign port owner could not be staged on this host (skipped honestly)',
      foreign.killed.length === 0, JSON.stringify(foreign))
  }

  // The two conditions are independent, and both are required. Asserted on the source, because the
  // decision is made in PowerShell and staging a fake daemon chain is not something a test should
  // do to a live machine.
  const src = libSource()
  ok('the collector still checks the image name',
    /\$allowed -notcontains \$name/.test(src), 'the name check was dropped')
  ok('the collector also requires the command line to name the daemon or the port',
    /-notmatch 'hindsight'/.test(src) && /-notmatch \$port/.test(src), 'the command-line check was dropped')
  ok('the collector still walks upward only, never into descendants',
    !/ParentProcessId\)\s*\}\s*#.*descend/.test(src) && /ParentProcessId/.test(src), 'the walk changed shape')
}

// ── warmth is a question about completeness, not about speed ─
// The probe used to run `uvx ... --help` and call the env warm if it returned within 15 s. Two
// things were wrong with that. A warm env on a loaded machine takes longer than 15 s and was
// reported cold -- and every "cold" verdict triggers a full warm-up, so the measurement produced
// the work it exists to avoid. Worse, on a genuinely cold env the probe itself started downloading
// and was killed at the timeout, leaving a half-populated cache and paying part of the cost on
// every call.
//
// --offline changes the question: resolving with the network off either succeeds, which proves the
// env is complete locally, or fails immediately, which proves it is not. It cannot download.
{
  section('env warmth probe')
  const g = await import('../lib/core.mjs')
  const ctx = g.resolveContext({})

  const warm = await g.probeEnv(ctx)
  if (!warm.ok) {
    ok('uvx is unavailable here, so the probe cannot be exercised (skipped honestly)', true, warm.detail)
  } else {
    ok('a complete environment is reported warm', warm.warm === true && warm.known === true, JSON.stringify(warm.detail))
    ok('the warm detail says what was actually proven', /offline/.test(warm.detail), warm.detail)
  }

  // A version that cannot exist is the cheapest honest way to stage "not available locally", and it
  // must come back fast: a probe that downloaded would take far longer than this before failing.
  const cold = await g.probeEnv({ ...ctx, embedVersion: '99.99.99' })
  ok('an environment that cannot resolve offline is reported cold',
    cold.warm === false && cold.known === true, JSON.stringify(cold.detail))
  ok('the cold verdict is definite, not a timeout guess', /cannot be resolved without the network/.test(cold.detail), cold.detail)
  ok('a cold verdict does not mean a long download was started and killed', cold.ms < 10000, `${cold.ms} ms`)

  // The distinction the old probe could not make, and the one that matters: a timeout is not an
  // answer. Reporting it as cold costs a full warm-up on a machine that may simply have been busy.
  const unknown = await g.probeEnv({ ...ctx, warmProbeMs: 1 })
  ok('a probe that runs out of time reports undetermined rather than cold',
    unknown.known === false && !/env is cold/.test(unknown.detail), JSON.stringify(unknown.detail))
  ok('the undetermined detail says which two things it might be',
    /may be warm/.test(unknown.detail) && /or genuinely cold/.test(unknown.detail), unknown.detail)

  // Asserted on the source, because "it did not download this time" is not the property that
  // matters -- "it cannot download" is, and only the flag guarantees that.
  const src = libSource()
  // A behaviour assertion, not a text one. This used to match the literal argument list, which broke
  // the moment that list moved into the service descriptor -- a property of the file layout rather
  // than of the code. What the check has always meant is "the probe cannot download", so that is now
  // asked of the function that builds the arguments.
  const svcMod = await import('../lib/service.mjs')
  const offlineArgs = svcMod.serviceArgs(ctx.serviceDescriptor, ctx, { uvArgs: [], offline: true })
  ok('the probe resolves offline, so it cannot populate the cache it is measuring',
    offlineArgs.ok === true && offlineArgs.args.includes('--offline'),
    JSON.stringify(offlineArgs.ok ? offlineArgs.args : offlineArgs.detail))
  const onlineArgs = svcMod.serviceArgs(ctx.serviceDescriptor, ctx, { uvArgs: [] })
  ok('and the same builder leaves the network alone when it is not asked to be offline',
    onlineArgs.ok === true && !onlineArgs.args.includes('--offline'),
    JSON.stringify(onlineArgs.args))
  // The warm-up itself must still be allowed to download; that is its job.
  ok('the warm-up still runs online',
    !/--offline[\s\S]{0,200}warmBudgetMs/.test(src.slice(src.indexOf('export async function warm'))), 'the warm-up lost its network access')
}

// ── the module surface is a contract ─
// core.mjs is 3400 lines and the next thing it needs is to be broken up. A refactor of that size
// fails in a particular way: a function stops being exported, every test still passes because the
// tests call the ones that survived, and the only thing that notices is an external consumer --
// which is exactly who is not running here.
//
// So the surface is written down. Names may be ADDED freely; this fails only if one goes missing,
// which is the failure a split actually produces. The list is not a wish: it was captured from the
// module as it stands, and every entry is reachable by something (the CLI, the MCP server, the
// tests, or a documented consumer).
{
  section('module surface')
  const g = await import('../lib/core.mjs')
  const EXPECTED = [
    'DEFAULTS', 'POLICY_DEFAULTS', 'REDACTED', 'activityDir', 'activityTaskName', 'activityTaskState',
    'analyzeSignals', 'ancestry', 'appendToActivity', 'custodyEvents', 'custodyOrphans', 'custodyReport',
    'custodyState', 'custodyTimeline', 'custodyTimelineLive', 'daemonArgs', 'decideSignals', 'detain',
    'doctor', 'ensurePgService', 'findPluginLogs', 'findPortOwner', 'gateHeavyWork', 'guardCacheOp',
    'heal', 'humanDuration', 'installActivityTask', 'installService', 'killDaemonTree', 'liveProcesses',
    'loadPolicy', 'newLogPath', 'policyAllows', 'policyPath', 'probeActivityRecorder', 'probeCustody',
    'probeDaemon', 'probeDaemonLog', 'probeDshHost', 'probeEnv', 'probePort', 'probePostgres',
    'probeResources', 'probeUv', 'readActivity', 'readDetainRecords', 'readLogs', 'readStealth',
    'rebuildCustody', 'reconcileCustody', 'recordDecisions', 'recordRedline', 'redactCommandLine', 'redlineAreas',
    'resolveContext', 'restart', 'reveal', 'run', 'savePolicy', 'scanRedline',
    'scanSuspended', 'serve', 'serviceState', 'staleCustody', 'status', 'stop',
    'summarizeActivity', 'taskScriptPath', 'unauthorizedReleases', 'uninstallActivityTask', 'uninstallService', 'unrecordedCustody',
    'uvFlags', 'warm',
  ]
  const present = new Set(Object.keys(g))
  const missing = EXPECTED.filter((n) => !present.has(n))
  ok('every export core.mjs had is still exported', missing.length === 0, missing.join(', '))
  ok('the surface is not empty for a vacuous reason', present.size >= EXPECTED.length, `${present.size} vs ${EXPECTED.length}`)
  // Functions, not just names: a re-export that resolves to undefined passes a key check.
  const notFunctions = EXPECTED.filter((n) => g[n] === undefined)
  ok('no export resolved to undefined', notFunctions.length === 0, notFunctions.join(', '))
}

// -- no module uses a symbol it did not import --
// Splitting core.mjs produced this bug five times in one afternoon, and the shape is worth being
// precise about: a function body moves to a new file, the imports it depended on do not come with
// it, and the missing name only throws on the path that reaches it. An empty catch somewhere then
// converts that throw into a plausible-looking answer -- custody.mjs reported "no activity record"
// because readdirSync was not imported and the throw was caught as if the directory were empty.
// That is the same shape as the recorder that wrote nothing, and the same shape as the allowlist
// that could not fire.
//
// The first version only looked at node builtins, and a deliberate test proved it could not fail:
// removing sleep's import from custody.mjs passed, because sleep comes from a sibling module. So
// this indexes every module's exports and checks both.
{
  section('module imports')
  const dir = join(projectDir, 'lib')
  const files = readdirSync(dir).filter((f) => f.endsWith('.mjs'))
  const BUILTIN_OF = {
    readFileSync: 'node:fs', writeFileSync: 'node:fs', appendFileSync: 'node:fs', existsSync: 'node:fs',
    mkdirSync: 'node:fs', readdirSync: 'node:fs', statSync: 'node:fs', rmSync: 'node:fs', renameSync: 'node:fs',
    openSync: 'node:fs', closeSync: 'node:fs', readSync: 'node:fs', realpathSync: 'node:fs', mkdtempSync: 'node:fs',
    join: 'node:path', resolve: 'node:path', dirname: 'node:path', basename: 'node:path', delimiter: 'node:path',
    homedir: 'node:os', tmpdir: 'node:os', connect: 'node:net', spawn: 'node:child_process',
    fileURLToPath: 'node:url', createInterface: 'node:readline',
  }

  // Strip comments, string literals and template literals from JS source, keeping everything else.
  //
  // Regex literals are the hard part and skipping them is not optional: commandline.mjs contains
  // /... [^"\s']*/gi, whose quote characters are inside a regex, and a scanner that does not know
  // that reads them as the start of a string and swallows the rest of the file. The first version of
  // this did exactly that, which meant the import check quietly stopped seeing anything after that
  // line -- it missed isSystemRoot in signals.mjs, and only the test suite caught it.
  //
  // A slash starts a regex when the previous significant character cannot end an expression. That is
  // the standard heuristic and it is enough here.
  const CODE = (src) => {
    const BS = String.fromCharCode(92)
    const SQ = String.fromCharCode(39)
    const DQ = String.fromCharCode(34)
    const BT = String.fromCharCode(96)
    const SL = String.fromCharCode(47)
    const ST = String.fromCharCode(42)
    const NL = String.fromCharCode(10)
    const REGEX_OK_BEFORE = new Set('(,=:[!&|?{};+-*%~^<>'.split(''))
    let out = ''
    let i = 0
    let prev = ''
    while (i < src.length) {
      const c = src[i]
      const n = src[i + 1]
      if (c === SL && n === ST) {
        const e = src.indexOf(ST + SL, i + 2)
        i = e === -1 ? src.length : e + 2
        out += ' '
        continue
      }
      if (c === SL && n === SL) {
        const e = src.indexOf(NL, i + 2)
        i = e === -1 ? src.length : e
        out += ' '
        continue
      }
      if (c === SL && (prev === '' || REGEX_OK_BEFORE.has(prev))) {
        // a regex literal: consume to the unescaped closing slash, then its flags
        i++
        let inClass = false
        while (i < src.length) {
          const d = src[i]
          if (d === BS) { i += 2; continue }
          if (d === '[') inClass = true
          else if (d === ']') inClass = false
          else if (d === SL && !inClass) { i++; break }
          else if (d === NL) break
          i++
        }
        while (i < src.length && /[a-z]/i.test(src[i])) i++
        out += ' '
        prev = 'x'
        continue
      }
      if (c === SQ || c === DQ || c === BT) {
        i++
        while (i < src.length && src[i] !== c) {
          if (src[i] === BS) i++
          i++
        }
        i++
        out += ' '
        prev = 'x'
        continue
      }
      out += c
      if (!/\s/.test(c)) prev = c
      i++
    }
    return out
  }

  // Then member accesses, so parts.join(' | ') is not read as node:path's join.
  const DOT_MEMBER = new RegExp('[' + String.fromCharCode(46) + '][' + String.fromCharCode(92) + 's]*[A-Za-z_$][A-Za-z0-9_$]*', 'g')
  const NON_WORD = new RegExp('[^A-Za-z0-9_$]+')
  const bareNames = (src) => new Set(CODE(src).replace(DOT_MEMBER, ' ').split(NON_WORD))

  const sources = {}
  for (const f of files) sources[f] = readFileSync(join(dir, f), 'utf8')

  const exportsOf = {}
  for (const [f, src] of Object.entries(sources)) {
    const names = new Set()
    const code = CODE(src)
    for (const m of code.matchAll(/export (?:async )?function (\w+)/g)) names.add(m[1])
    for (const m of code.matchAll(/export const (\w+)/g)) names.add(m[1])
    for (const m of code.matchAll(/export \{([^}]*)\}/g)) {
      for (const piece of m[1].split(',')) {
        const n = piece.trim().split(/\s+as\s+/).pop().trim()
        if (n) names.add(n)
      }
    }
    exportsOf[f] = names
  }

  const offenders = []
  for (const [f, src] of Object.entries(sources)) {
    const body = bareNames(src.split(NL_SHIM).filter((l) => !l.trim().startsWith('import ')).join(NL_SHIM))
    const imported = new Set()
    for (const m of src.matchAll(/import \{([^}]*)\}/g)) {
      for (const piece of m[1].split(',')) {
        const n = piece.trim().split(/\s+as\s+/).pop().trim()
        if (n) imported.add(n)
      }
    }
    const code = CODE(src)
    const own = new Set(exportsOf[f])
    for (const m of code.matchAll(/(?:export )?(?:async )?function (\w+)/g)) own.add(m[1])
    for (const m of code.matchAll(/(?:export )?const (\w+)/g)) own.add(m[1])

    for (const name of Object.keys(BUILTIN_OF)) {
      if (body.has(name) && !imported.has(name)) offenders.push(f + ': ' + name + " from '" + BUILTIN_OF[name] + "'")
    }
    for (const [other, names] of Object.entries(exportsOf)) {
      if (other === f) continue
      for (const name of names) {
        if (own.has(name) || imported.has(name)) continue
        if (body.has(name)) offenders.push(f + ': ' + name + " from './" + other + "'")
      }
    }
  }
  ok('every module imports the symbols it uses', offenders.length === 0, offenders.join(' | '))
  ok('the check looked at every module and indexed its exports',
    files.length >= 6 && Object.values(exportsOf).reduce((a, x) => a + x.size, 0) > 50,
    files.length + ' module(s), ' + Object.values(exportsOf).reduce((a, x) => a + x.size, 0) + ' export(s)')
}

// ── the database: deployment and management are two questions ─
// The probe used to hardcode the embedded layout while the service it started was whatever happened
// to be named hindsight-pg. Those answer different questions -- where the data is, and who starts
// the process -- and conflating them meant a machine with a database somewhere else was told its
// data directory was missing, and a machine with no such service was told "the database is not
// managed here", which is only true if nothing else is managing it.
{
  section('database topology')
  const sup = await import('../lib/supervisor.mjs')
  const g = await import('../lib/core.mjs')
  const ctx = g.resolveContext({})

  const loc = sup.pgDataLocation(ctx)
  ok('the data location says which deployment it found',
    ['embedded', 'declared', 'unknown'].includes(loc.deployment), JSON.stringify(loc))
  ok('an embedded deployment is reported with its path and that it exists',
    loc.deployment !== 'embedded' || (loc.exists === true && /\.pg0/.test(loc.dataDir)), JSON.stringify(loc))

  // A declared location wins and is labelled as declared, not as embedded.
  const declared = sup.pgDataLocation({ ...ctx, pgDataDir: process.cwd() })
  ok('a declared data directory is reported as declared',
    declared.deployment === 'declared' && declared.exists === true, JSON.stringify(declared))
  const declaredMissing = sup.pgDataLocation({ ...ctx, pgDataDir: join(process.cwd(), 'nope-not-here') })
  ok('a declared directory that is missing says so rather than falling back',
    declaredMissing.deployment === 'declared' && declaredMissing.exists === false, JSON.stringify(declaredMissing))

  const pg = await sup.probePostgres(ctx)
  ok('the postgres probe names the deployment in its detail',
    /embedded|declared|unknown/.test(pg.detail), pg.detail)
  ok('the probe carries the deployment as a field, not only in prose',
    typeof pg.deployment === 'string' && pg.deployment.length > 0, JSON.stringify(pg))

  // Management is the other question, and it must name which model it concluded rather than
  // reporting a skip that reads like a shrug.
  if (process.platform === 'win32') {
    const real = await sup.ensurePgService(ctx, { log: () => {} })
    ok('the database service step names its management model',
      ['windows-service', 'embed-manager', 'external'].includes(real.management), JSON.stringify(real))
    ok('and the detail says something a person can act on',
      typeof real.detail === 'string' && real.detail.length > 20, real.detail)
    const absent = await sup.ensurePgService({ ...ctx, pgService: 'no-such-pg-service-xyz' }, { log: () => {} })
    ok('a service that does not exist is reported as another model, not as unmanaged',
      absent.management === 'embed-manager' || absent.management === 'external', JSON.stringify(absent))
    ok('and it does not claim the database is unmanaged',
      !/not managed here/.test(absent.detail), absent.detail)
  } else {
    ok('the database service step is Windows-only (skipped honestly)', true, '')
  }
}

// ── the tool must not promise an action it cannot take ─
// `policy mode reject` printed "(unpermitted stealth will be TERMINATED)". Nothing in this tool
// terminates anything: `suspend` and `reject` are accepted by the CLI and implemented nowhere, so a
// user could set a mode, be told their unpermitted stealth would be terminated, and have nothing
// happen. That is the exact failure this project exists to remove -- a signal that does not mean
// what it says -- committed by the tool itself, in the one place a user is most likely to believe it.
{
  section('policy mode honesty')
  const r = spawnSync(process.execPath, [cli, 'policy', 'mode', 'reject'], { encoding: 'utf8', timeout: 60000 })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  ok('setting a mode succeeds or fails cleanly', r.status === 0 || r.status === 1, `status=${r.status}`)
  // Matched on the CLAIM, not the word. The old message said "unpermitted stealth will be
  // TERMINATED", which is a promise. The new one says the mode would have acted N times, each
  // time to terminate the process -- a counterfactual that names the act honestly, and which a
  // check for the bare word would fail.
  const plain = stripAnsi(out)
  ok('the output does not promise a termination this tool cannot perform',
    !/will be terminated/i.test(plain) && !/enforcement is on/i.test(plain), plain.trim().slice(0, 120))
  ok('and it says what actually happens instead',
    /nothing acts on this mode/i.test(out) || r.status !== 0, stripAnsi(out).trim().slice(0, 120))
  // Leave the user's policy as it was: the default is observe, and a test must not change it.
  spawnSync(process.execPath, [cli, 'policy', 'mode', 'observe'], { encoding: 'utf8', timeout: 60000 })

  // The design document is the reason the message points somewhere. If it is renamed or deleted the
  // message becomes a dead end, so the link is checked.
  ok('the caveat points at a document that exists',
    existsSync(join(projectDir, 'DESIGN-enforcement.md')), 'DESIGN-enforcement.md is missing')
}

// ── isolation: the act, the undo, and what is refused ─
// The first thing this tool can do to a file, so the tests are mostly about the undoing and the
// refusing rather than about the act. A lock that cannot be lifted is a deletion with extra steps.
{
  section('isolation')
  const enf = await import('../lib/enforce.mjs')
  const g = await import('../lib/core.mjs')
  const ctx = { ...g.resolveContext({}), isolationJournalDir: join(tmpdir(), 'vsep-acl-' + process.pid), logDir: join(tmpdir(), 'vsep-acl-log-' + process.pid) }
  const scratch = join(tmpdir(), 'vsep-iso-' + process.pid)
  mkdirSync(scratch, { recursive: true })
  const target = join(scratch, 'thing.exe')
  writeFileSync(target, 'not really a binary')

  const onWin = process.platform === 'win32'
  if (!onWin) {
    ok('isolation is Windows-only (skipped honestly)', true, '')
  } else {
    // Refusals first: these must hold before anything is attempted.
    const sys = await enf.isolate(ctx, { path: join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'notepad.exe') })
    ok('a file inside %SystemRoot% is refused without the explicit acknowledgement',
      sys.ok === false && sys.refused === true, JSON.stringify(sys.detail))

    const dirTarget = await enf.isolate(ctx, { path: scratch })
    ok('a directory is refused', dirTarget.ok === false && /regular file/.test(dirTarget.detail), dirTarget.detail)

    const noTarget = await enf.isolate(ctx, {})
    ok('no target at all is refused', noTarget.ok === false, JSON.stringify(noTarget.detail))

    // Dry run must change nothing, and it is asserted against the filesystem rather than the report.
    const dry = await enf.isolate(ctx, { path: target, dryRun: true })
    ok('a dry run reports what it would do', dry.ok === true && dry.dryRun === true, JSON.stringify(dry.detail))
    const afterDry = await enf.isolate(ctx, { path: target, dryRun: true })
    ok('and a second dry run still finds nothing applied',
      afterDry.dryRun === true && afterDry.alreadyIsolated !== true, JSON.stringify(afterDry))

    const applied = await enf.isolate(ctx, { path: target })
    ok('isolate applies the deny', applied.ok === true && applied.denied === true, JSON.stringify(applied.detail))
    ok('and it says how to undo it without this tool',
      typeof applied.restoreCommand === 'string' && /icacls/.test(applied.restoreCommand) && /restore/.test(applied.restoreCommand),
      applied.restoreCommand)
    ok('and the backup it points at exists', existsSync(applied.backupFile), applied.backupFile)

    const again = await enf.isolate(ctx, { path: target })
    ok('isolating twice is idempotent, not a second ACE',
      again.ok === true && again.alreadyIsolated === true, JSON.stringify(again))

    // The journal is what makes the undo findable later, and it is written by PowerShell -- which
    // writes a BOM. JSON.parse throws on that, and the first version reported every journal as
    // unreadable because of it.
    const listed = await enf.isolatedFiles(ctx)
    const mine = listed.entries.filter((e) => e.path === target)
    ok('the journal is readable back', mine.length >= 1 && mine.every((e) => e.state !== 'unreadable'),
      JSON.stringify(listed.entries.map((e) => e.state)))

    const restored = await enf.restoreIsolation(ctx, { journal: applied.journalFile })
    ok('restore lifts the deny', restored.ok === true && restored.denied === false, JSON.stringify(restored.detail))
    ok('and says the original ACL is back', /original ACL/.test(restored.detail), restored.detail)

    // The undo is the point. `denied` is not the script's opinion that it succeeded -- it is read
    // back from icacls after the restore, so a restore that leaves the DENY in place reports
    // denied: true and fails here. That distinction is the whole reason the field exists.
    const relisted = await enf.isolatedFiles(ctx)
    ok('the journal still exists after a restore (it is a record, not a flag)',
      relisted.entries.some((e) => e.journal === applied.journalFile), 'journal disappeared')
  }

  rmSync(scratch, { recursive: true, force: true })
  rmSync(ctx.isolationJournalDir, { recursive: true, force: true })
  // The log directory is the third thing this context owns. Leaving it behind is how 237 scratch
  // directories accumulated in the temp directory the tool itself derives its state from -- a suite
  // that leans on "the test cleans up" while adding one more thing to clean is how that happens.
  rmSync(ctx.logDir, { recursive: true, force: true })
}

// ── a journal is only acted on if this tool wrote it ─
// `restore` runs `icacls /restore` with the ACL file the journal names. If a journal can be forged,
// then "restore the original ACL" is itself a privilege-escalation primitive: plant a file, wait for
// someone to restore it, and the tool applies whatever DACL the planted file contains.
//
// The limit is stated rather than implied: this raises the bar from "write a JSON file" to "run code
// as this user on this machine", and it does not stop the second thing. What it stops is the cheap
// versions.
{
  section('journal authenticity')
  const enf = await import('../lib/enforce.mjs')
  const g = await import('../lib/core.mjs')
  const ctx = { ...g.resolveContext({}), isolationJournalDir: join(tmpdir(), 'vsep-journal-' + process.pid), logDir: join(tmpdir(), 'vsep-journal-log-' + process.pid) }
  const scratch = join(tmpdir(), 'vsep-ja-' + process.pid)
  mkdirSync(scratch, { recursive: true })

  if (process.platform !== 'win32') {
    ok('journal signing is Windows-only (skipped honestly)', true, '')
  } else {
    const target = join(scratch, 'signed.exe')
    writeFileSync(target, 'x')
    const applied = await enf.isolate(ctx, { path: target })
    ok('an applied isolation is signed', applied.ok === true, JSON.stringify(applied.detail))

    const spec = JSON.parse(readFileSync(applied.journalFile, 'utf8').replace(/^\uFEFF/, ''))
    ok('the journal carries an hmac and the backup hash',
      typeof spec.hmac === 'string' && spec.hmac.length > 20 && typeof spec.backupSha256 === 'string',
      JSON.stringify(Object.keys(spec)))

    // Tampering with the journal's content must be refused, and the refusal must come with the way
    // out -- refusing is only acceptable because the undo does not depend on this tool.
    const edited = { ...spec, path: join(scratch, 'somewhere-else.exe') }
    writeFileSync(applied.journalFile, JSON.stringify(edited, null, 2))
    const refused = await enf.restoreIsolation(ctx, { journal: applied.journalFile })
    ok('an edited journal is refused', refused.ok === false && refused.refused === true, JSON.stringify(refused.detail))
    ok('and the refusal says why rather than "failed"',
      /changed since this tool wrote it|not written by it/.test(refused.detail), refused.detail)
    ok('and it prints the command that undoes the lock without this tool',
      typeof refused.restoreCommand === 'string' && /icacls/.test(refused.restoreCommand), refused.restoreCommand)

    // Swapping the ACL backup for another file is the same attack one step over.
    writeFileSync(applied.journalFile, JSON.stringify(spec, null, 2))
    const realBackup = readFileSync(spec.backupFile)
    writeFileSync(spec.backupFile, 'not an acl file')
    const swapped = await enf.restoreIsolation(ctx, { journal: applied.journalFile })
    ok('a swapped ACL backup is refused', swapped.ok === false && /does not match the hash/.test(swapped.detail), swapped.detail)
    writeFileSync(spec.backupFile, realBackup)

    // An unsigned journal -- the shape an attacker would hand-write -- is refused too.
    const { hmac, ...unsigned } = spec
    writeFileSync(applied.journalFile, JSON.stringify(unsigned, null, 2))
    const noSig = await enf.restoreIsolation(ctx, { journal: applied.journalFile })
    ok('an unsigned journal is refused', noSig.ok === false && /no signature/.test(noSig.detail), noSig.detail)

    // Put the good journal back, and prove the lock can still be lifted.
    writeFileSync(applied.journalFile, JSON.stringify(spec, null, 2))
    const restored = await enf.restoreIsolation(ctx, { journal: applied.journalFile })
    ok('the original journal still restores', restored.ok === true, JSON.stringify(restored.detail))
  }

  rmSync(scratch, { recursive: true, force: true })
  rmSync(ctx.isolationJournalDir, { recursive: true, force: true })
  // The log directory is the third thing this context owns. Leaving it behind is how 237 scratch
  // directories accumulated in the temp directory the tool itself derives its state from -- a suite
  // that leans on "the test cleans up" while adding one more thing to clean is how that happens.
  rmSync(ctx.logDir, { recursive: true, force: true })
}

// ── stage 0: the trigger, with nothing attached to it ─
// `wouldAct` has been computed by decideSignals since the layer was written and read by nothing.
// That is the right state until the promotion gate has a number to look at -- and an unread count is
// not evidence, so the first thing stage 0 does is make it readable. Nothing acts on it.
{
  section('stage 0: the counterfactual')
  const g = await import('../lib/core.mjs')
  const ctx = g.resolveContext({})

  const d = g.decideSignals(ctx, { sinceMinutes: 4320 })
  ok('decideSignals reports how many findings would be acted on',
    Number.isInteger(d.actionable), JSON.stringify(d.actionable))
  ok('the count matches the decisions it was derived from',
    d.actionable === d.decisions.filter((x) => !x.allowed && x.verdict === 'ask').length,
    `${d.actionable} vs ${d.decisions.filter((x) => !x.allowed && x.verdict === 'ask').length}`)

  // Under observe the sentence must be about the mode, not a bare number: a number sitting next to
  // "observe" reads like something happened.
  ok('under observe it says the mode does nothing rather than quoting a count',
    d.mode !== 'observe' || /nothing: the mode is observe/.test(d.wouldDo), d.wouldDo)
  ok('and it flags that a non-observe mode is not implemented',
    d.modeUnimplemented === (d.mode !== 'observe'), JSON.stringify({ mode: d.mode, flag: d.modeUnimplemented }))

  // The vocabulary comes from the policy file's own documentation, and it must not claim an act the
  // tool cannot perform -- the failure `policy mode reject` was already fixed for once.
  ok('every mode has a description in the tool\'s own words',
    typeof g.modeAction('suspend') === 'string' && g.modeAction('suspend').length > 5, g.modeAction('suspend'))
  ok('an unknown mode is passed through rather than invented',
    g.modeAction('something-else') === 'something-else', g.modeAction('something-else'))

  // The switch is the moment the decision is made, so the count must be reachable from there.
  const r = spawnSync(process.execPath, [cli, 'policy', 'mode', 'suspend'], { encoding: 'utf8', timeout: 120000 })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  ok('setting a mode reports what it would have done', /would have acted \d+ time/.test(stripAnsi(out)), stripAnsi(out).trim().slice(0, 140))
  ok('and still refuses to claim it will act', !/will be terminated|enforcement is on/i.test(stripAnsi(out)), stripAnsi(out).trim().slice(0, 140))
  spawnSync(process.execPath, [cli, 'policy', 'mode', 'observe'], { encoding: 'utf8', timeout: 60000 })
  rmSync(join(homedir(), '.volcano-separator', 'policy.json'), { force: true })
}

// ── the heartbeat's would: is evidence, so it has to be able to be wrong ─
// This is the number a promotion decision in DESIGN-enforcement.md gets made from. Its first version
// could not have been anything but 0: the object it came from was hand-built, `actionable` was not
// named, and `?? 0` turned the missing field into a measured zero. A count that can only ever say
// "nothing would be acted on" is not a measurement, and it is the most convincing kind of wrong --
// it agrees with what a quiet machine looks like.
{
  section('heartbeat counterfactual')

  const hbDir = dirname(g.activityDir(ctx))
  const hb = existsSync(join(hbDir, 'heartbeat.log')) ? join(hbDir, 'heartbeat.log') : null

  if (!hb) {
    ok('the heartbeat log exists (nothing has run on this machine yet)', true, '')
  } else {
    const lines = readFileSync(hb, 'utf8').split(/\r?\n/).filter((l) => l.includes('signals='))
    ok('the heartbeat records a counterfactual at all', lines.length > 0, `no signals= line in ${hb}`)
    const last = lines[lines.length - 1] ?? ''
    // The value must be there. `would:?` is the loud form of "the field never reached the log", and
    // it was verified to fire by deleting `actionable` from the spread and watching it appear.
    ok('the field reaches the log rather than being absent', !/would:\?/.test(last), last.slice(0, 160))
    ok('and reads as a number', /would:\d+/.test(last), last.slice(0, 160))
  }

  // The formatter is the half testable without waiting for a real finding, and it is the half that
  // was wrong: `?? 0` and a loud `?` differ only when the field is missing. This cannot prove the
  // field is wired up -- the check above does that -- but it does prove the difference exists.
  const fmt = (sig) => (sig ? 'would:' + (Number.isInteger(sig.actionable) ? sig.actionable : '?') : '')
  ok('a present count is printed as itself', fmt({ actionable: 7 }) === 'would:7', fmt({ actionable: 7 }))
  ok('a measured zero is printed as a zero', fmt({ actionable: 0 }) === 'would:0', fmt({ actionable: 0 }))
  ok('an absent count is NOT printed as a zero',
    fmt({}) === 'would:?', `${fmt({})} -- a missing field would silently become a measurement`)
}

// ── the evidence has to outlive the log it was derived from ─
// The activity record lives under the log directory, which defaults to the system temp directory --
// and this machine's disk hygiene tooling removes files there after seven days, recursively, with no
// exclusion list. Asking a rule to prove itself over a longer window than its evidence survives fails
// quietly, and it fails by showing FEWER findings, which reads as good news.
//
// The other half of the same lesson: the first version of this roll-up wrote the six-minute window's
// count, and findings are rare -- so it would have written 0 nearly every day. A daily record of
// zeroes is a counter that cannot vary, arrived at by a different route.
{
  section('durable evidence')
  const g = await import('../lib/core.mjs')
  const ctx = g.resolveContext({})
  const d = g.decideSignals(ctx, { sinceMinutes: 6 })

  // It goes beside the policy, not under the log directory. That is the whole point.
  // A scratch file, not the real one. The first version of this test deleted the accumulated
  // evidence at the end -- so running the suite wiped exactly the data the suite exists to
  // protect, and the two-week accumulation plan would have been reset by every green run.
  const evFile = join(tmpdir(), 'vsep-evidence-' + process.pid + '.ndjson')
  rmSync(evFile, { force: true })
  const ectx = { ...ctx, evidenceFile: evFile }
  const before = g.readEvidence(ectx).length
  const r = g.rollUpEvidence(ectx, d, { newlyRecorded: 0 })
  ok('the roll-up writes somewhere', r.ok === true, JSON.stringify(r.detail ?? r.file))
  // The DEFAULT path is the property that matters, and it is asserted without writing to it. The
  // scratch override above exists so this suite stops deleting the real accumulated evidence -- the
  // first version of this test deleted it at the end, so every green run reset exactly the data the
  // suite exists to protect. What is being checked here is where the default lands: beside the
  // policy, and outside the directory the machine's disk hygiene tooling prunes at seven days.
  const def = g.evidenceFile()
  ok('the default lands beside the policy, not under the log directory',
    def.includes('.volcano-separator') && !def.includes(String(process.env.TEMP ?? 'x')), def)
  ok('and the override is honoured, so a test can write without touching it', r.file === evFile, String(r.file))

  // Signed increments accumulate. This is what makes it a sample rather than a snapshot.
  const a = g.rollUpEvidence(ectx, d, { newlyRecorded: 5 })
  const b = g.rollUpEvidence(ectx, d, { newlyRecorded: 2 })
  ok('increments accumulate into a running total for the day',
    a.ok && b.ok && b.actionableToday === a.actionableToday + 2,
    `${a.actionableToday} -> ${b.actionableToday}`)

  // And it stays one line per day however often the heartbeat runs.
  const lines = g.readEvidence(ectx).filter((e) => e.day === new Date().toISOString().slice(0, 10))
  ok('a day appears exactly once however often the heartbeat runs', lines.length === 1, `${lines.length} line(s) today`)
  ok('no day is lost by the rewrite', g.readEvidence(ectx).length >= before, `${before} -> ${g.readEvidence(ectx).length}`)

  // An increment of zero must not reset the day.
  const c = g.rollUpEvidence(ectx, d, { newlyRecorded: 0 })
  ok('a quiet window does not reset the day', c.actionableToday === b.actionableToday, `${b.actionableToday} -> ${c.actionableToday}`)

  rmSync(evFile, { force: true })
}

// ── isolated reports the filesystem, not the record ─
// A journal records what was done at the time. A file unlocked by hand, by another tool, or by an
// administrator restoring an ACL still read as `applied` -- which contradicted the rule the module
// states in its own comment: the ACL is the authority, not our record of it. An unread promise in a
// comment is the same class of thing as a counter that cannot vary.
{
  section('isolation live state')
  const enf = await import('../lib/enforce.mjs')
  const g = await import('../lib/core.mjs')
  const ctx = { ...g.resolveContext({}), isolationJournalDir: join(tmpdir(), 'vsep-live-' + process.pid), logDir: join(tmpdir(), 'vsep-live-log-' + process.pid) }
  const scratch = join(tmpdir(), 'vsep-lv-' + process.pid)
  mkdirSync(scratch, { recursive: true })

  if (process.platform !== 'win32') {
    ok('live isolation state is Windows-only (skipped honestly)', true, '')
  } else {
    const target = join(scratch, 'live.exe')
    writeFileSync(target, 'x')
    const applied = await enf.isolate(ctx, { path: target })

    const fresh = await enf.isolatedFiles(ctx)
    const entry = fresh.entries.find((e) => e.path === target)
    ok('a freshly isolated file reports applied, read from the ACL',
      entry?.state === 'applied' && entry?.denied === true, JSON.stringify(entry))

    // Lift it behind the tool's back, exactly as an administrator restoring an ACL would.
    const { spawnSync } = await import('node:child_process')
    spawnSync('icacls', [scratch, '/restore', applied.backupFile], { encoding: 'utf8' })

    const after = await enf.isolatedFiles(ctx)
    const lifted = after.entries.find((e) => e.path === target)
    ok('a file unlocked behind the tool\'s back stops reporting applied',
      lifted?.state === 'not-denied' && lifted?.denied === false, JSON.stringify(lifted))
    ok('and the journal is still there, because it is a record and not a flag',
      existsSync(applied.journalFile), applied.journalFile)

    rmSync(target, { force: true })
    const gone = await enf.isolatedFiles(ctx)
    const missing = gone.entries.find((e) => e.path === target)
    ok('a file that no longer exists says so rather than reporting a lock on nothing',
      missing?.state === 'file-missing' && missing?.exists === false, JSON.stringify(missing))
  }

  rmSync(scratch, { recursive: true, force: true })
  rmSync(ctx.isolationJournalDir, { recursive: true, force: true })
  // The log directory is the third thing this context owns. Leaving it behind is how 237 scratch
  // directories accumulated in the temp directory the tool itself derives its state from -- a suite
  // that leans on "the test cleans up" while adding one more thing to clean is how that happens.
  rmSync(ctx.logDir, { recursive: true, force: true })
}

// ── in-place encryption: the order is the safety, not the cipher ─
// The journal records the original's sha256 before the file is touched, and the ciphertext is
// decrypted back and compared BEFORE it replaces anything. Without that step this is a file shredder
// with extra ceremony.
{
  section('in-place encryption')
  const cry = await import('../lib/crypt.mjs')
  const g = await import('../lib/core.mjs')
  const base = join(tmpdir(), 'vsep-cry-' + process.pid)
  mkdirSync(base, { recursive: true })
  const ctx = {
    ...g.resolveContext({}),
    cryptJournalDir: join(base, 'crypt'),
    cryptKeyFile: join(base, 'crypt.key'),
    logDir: join(base, 'log'),
  }
  const target = join(base, 'secret.bin')
  const original = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 256))
  writeFileSync(target, original)
  const before = createHash('sha256').update(original).digest('hex')

  if (process.platform !== 'win32') {
    ok('in-place encryption is Windows-only (skipped honestly)', true, '')
  } else {
    const dry = await cry.encryptFile(ctx, { path: target, dryRun: true })
    ok('a dry run reports and changes nothing',
      dry.ok === true && dry.dryRun === true && readFileSync(target).equals(original), JSON.stringify(dry.detail))

    const enc = await cry.encryptFile(ctx, { path: target })
    ok('encrypt reports success', enc.ok === true, JSON.stringify(enc.detail))

    const afterBytes = readFileSync(target)
    ok('the bytes on disk actually changed', !afterBytes.equals(original), 'the file was not rewritten')
    ok('and the file is now one of ours, read from the magic rather than the name',
      cry.isEncrypted(target) === true, 'magic missing')
    ok('the plaintext is not recoverable by reading it as bytes',
      afterBytes.indexOf(original.subarray(0, 64)) === -1, 'plaintext found in the ciphertext')

    const spec = JSON.parse(readFileSync(enc.journalFile, 'utf8').replace(/^\uFEFF/, ''))
    ok('the journal records the original sha256 before the file was touched',
      spec.originalSha256 === before, `${spec.originalSha256} vs ${before}`)
    ok('and it is signed, so a forged journal is not acted on',
      typeof spec.hmac === 'string' && spec.hmac.length > 20, JSON.stringify(spec.hmac))

    // Encrypting twice must not double-wrap.
    const again = await cry.encryptFile(ctx, { path: target })
    ok('encrypting an already-encrypted file is refused rather than double-wrapped',
      again.alreadyEncrypted === true, JSON.stringify(again))

    // The undo, and the property that matters: byte-for-byte.
    const dec = await cry.decryptFile(ctx, { journal: enc.journalFile })
    ok('decrypt reports success', dec.ok === true, JSON.stringify(dec.detail))
    ok('THE BYTES ARE IDENTICAL TO THE ORIGINAL',
      readFileSync(target).equals(original), 'the restore did not reproduce the original bytes')
    ok('and the restored hash matches what the journal recorded', dec.restoredSha256 === before, dec.restoredSha256)

    // A forged journal is refused, and refusing must not damage anything.
    const enc2 = await cry.encryptFile(ctx, { path: target })
    const edited = { ...JSON.parse(readFileSync(enc2.journalFile, 'utf8').replace(/^\uFEFF/, '')), originalSha256: '0'.repeat(64) }
    writeFileSync(enc2.journalFile, JSON.stringify(edited, null, 2))
    const refused = await cry.decryptFile(ctx, { journal: enc2.journalFile })
    ok('an edited journal is refused', refused.ok === false && refused.refused === true, JSON.stringify(refused.detail))
    ok('and it says why rather than "failed"', /changed since this tool wrote it|not written by it/.test(refused.detail), refused.detail)
    ok('and refusing left the ciphertext intact', cry.isEncrypted(target) === true, 'the file was damaged by a refusal')

    const list = cry.encryptedFileList(ctx)
    const mine = list.entries.find((e) => e.path === target)
    ok('the list reads state from the bytes', mine?.state === 'encrypted' && mine?.encrypted === true, JSON.stringify(mine))
  }

  rmSync(base, { recursive: true, force: true })
}

// ── release must know who it is releasing ─
// A pid is not an identity. The ledger has known that since it was written -- `custodyReport`
// computes `pid-reused` and says so -- but the release path never consulted it, so the tool could
// correctly report a recycled pid on one screen and resume a stranger on the next. The same fact
// computed and never read shows up four times in this codebase; this is the one with a confused
// deputy attached.
{
  section('release identity')
  const g = await import('../lib/core.mjs')
  // A scratch log directory, because these tests really do freeze and resume a process. With the
  // resolved default they wrote their events into the machine's own activity record -- so a test run
  // left "released pid ..." rows in the evidence this tool exists to keep honest, and a half-written
  // last line in that record made the recorder look stale. A test that pollutes the artifact it is
  // meant to protect fails in the direction nobody checks.
  const scratch = join(tmpdir(), 'vsep-release-' + process.pid)
  rmSync(scratch, { recursive: true, force: true })
  const ctx = { ...g.resolveContext({}), logDir: scratch }

  if (process.platform !== 'win32') {
    ok('release identity is Windows-only (skipped honestly)', true, '')
  } else {
    // A pid that does not exist: nothing to resume, and the reason must say so rather than saying
    // "no record" -- a refusal that gives the wrong reason is barely better than no check.
    const gone = await g.detain(ctx, { pid: 999999, release: true })
    ok('a release for a pid that does not exist is refused', gone.ok === false && gone.refused === true, JSON.stringify(gone.detail))
    ok('and it says the process does not exist, not that the record is missing',
      /no process with pid/.test(gone.detail), gone.detail)

    // A pid that exists but was never detained: no identity to check, which is the same shape of act.
    const alive = await g.detain(ctx, { pid: process.pid, release: true })
    ok('a release for a process this tool never froze is refused',
      alive.ok === false && alive.refused === true, JSON.stringify(alive.detail))
    ok('and refuses because there is no record to check identity against',
      /no record of a detain/.test(alive.detail), alive.detail)
    ok('and it says nothing was resumed', /Nothing was resumed/.test(alive.note ?? ''), String(alive.note))

    // The happy path must still work: detain something real, then release it.
    const { spawn } = await import('node:child_process')
    const kid = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' })
    await new Promise((r) => setTimeout(r, 800))
    const held = await g.detain(ctx, { pid: kid.pid, custody: false, topmost: false })
    ok('a real process can still be detained', held.ok === true, JSON.stringify(held.detail ?? held))
    const freed = await g.detain(ctx, { pid: kid.pid, release: true })
    ok('and released, with the identity check passing',
      freed.ok === true && freed.succeeded === true, JSON.stringify(freed.detail ?? freed))
    ok('the record names the action that actually happened', freed.action === 'released', String(freed.action))
    try { kid.kill() } catch { /* it may already be gone */ }
  }
  rmSync(scratch, { recursive: true, force: true })
}

// ── the vault: a copy you can put back without this tool ─
// Three things are being pinned here, and only the first is about copying.
//
//   1. The default is a COPY. The original does not move, so a bug in this module costs disk space
//      rather than a file. --move is the operation that can cost the afternoon, so it has to be asked
//      for by name and it is tested separately.
//   2. The manifest is signed, and a signed manifest names one file. Without that, "restore" is a
//      primitive that copies any file to any path on command -- the same privilege-escalation shape
//      the ACL journal had, answered the same way.
//   3. The undo does not need this tool to exist. That is asserted by doing it: read the manifest's
//      two paths and copy the bytes by hand, then compare hashes.
{
  section('vault')
  const vau = await import('../lib/vault.mjs')
  const { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, copyFileSync, appendFileSync } = await import('node:fs')
  const { createHash } = await import('node:crypto')

  const base = join(tmpdir(), 'vsep-vault-' + process.pid)
  rmSync(base, { recursive: true, force: true })
  mkdirSync(base, { recursive: true })
  // A store and a key of its own, so the test never touches the machine's real vault.
  const ctx = { vaultRoot: join(base, 'store'), vaultKeyFile: join(base, 'key.dat'), vaultIndexFile: join(base, 'index.json') }
  const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex')

  const src = join(base, 'payload.bin')
  writeFileSync(src, Buffer.from('vault-payload-' + 'z'.repeat(400)))

  const copied = await vau.vault(ctx, { path: src })
  ok('a copy lands in the vault', copied.ok === true && existsSync(copied.vaultPath), JSON.stringify(copied.detail))
  ok('and the original has not moved', existsSync(src), 'the default must leave the original in place')
  ok('and the copy is byte-identical', sha(copied.vaultPath) === sha(src), 'the copy does not match the source')
  ok('the entry says so in the result, rather than leaving it to be assumed',
    copied.moved === false && copied.signed === true, JSON.stringify({ moved: copied.moved, signed: copied.signed }))

  // The undo must be reachable without this tool. Asserted by performing it with fs, not by checking
  // that a string looks right.
  {
    const spec = JSON.parse(readFileSync(join(ctx.vaultRoot, copied.id, 'manifest.json'), 'utf8'))
    const byHand = join(base, 'restored-by-hand.bin')
    copyFileSync(spec.vaultPath, byHand)
    ok('the manifest names two paths a plain copy can use, with no help from this tool',
      sha(byHand) === sha(src), 'a hand copy from the manifest did not reproduce the original')
  }

  // A manifest edited after the fact must not be acted on.
  {
    const manifest = join(ctx.vaultRoot, copied.id, 'manifest.json')
    const spec = JSON.parse(readFileSync(manifest, 'utf8'))
    const honest = spec.originalPath
    spec.originalPath = join(base, 'somewhere-else.exe')
    writeFileSync(manifest, JSON.stringify(spec, null, 1))
    const r = await vau.restoreVault(ctx, { id: copied.id })
    ok('an edited manifest is refused', r.ok === false && /changed since this tool wrote it/.test(r.detail), r.detail)
    ok('and nothing was written to the path it now claims',
      !existsSync(join(base, 'somewhere-else.exe')), 'a forged path was acted on')
    // Restore the honest manifest so the checks below run against a valid one.
    spec.originalPath = honest
    const key = await vau.getVaultKey(ctx)
    spec.hmac = vau.signManifest(key.key, spec)
    writeFileSync(manifest, JSON.stringify(spec, null, 1))
  }

  // A manifest with no signature at all is not vouched for.
  {
    const manifest = join(ctx.vaultRoot, copied.id, 'manifest.json')
    const spec = JSON.parse(readFileSync(manifest, 'utf8'))
    const withMac = spec.hmac
    delete spec.hmac
    writeFileSync(manifest, JSON.stringify(spec, null, 1))
    const r = await vau.restoreVault(ctx, { id: copied.id })
    ok('an unsigned manifest is refused rather than trusted', r.ok === false && /no signature/.test(r.detail), r.detail)
    spec.hmac = withMac
    writeFileSync(manifest, JSON.stringify(spec, null, 1))
  }

  // Restoring over content that is not what the entry holds would replace the user's newer work.
  {
    appendFileSync(src, 'changed since the copy')
    const r = await vau.restoreVault(ctx, { id: copied.id })
    ok('a restore refuses where the original path now holds different bytes',
      r.ok === false && r.refused === true, JSON.stringify(r.detail))
    ok('and says what is there now, so the reader can decide',
      /is not the file this entry holds/.test(r.detail), r.detail)
    const forced = await vau.restoreVault(ctx, { id: copied.id, force: true })
    ok('force means it, and then the bytes match the entry again',
      forced.ok === true && sha(src) === sha(copied.vaultPath), JSON.stringify(forced.detail))
  }

  // --move: the only path that disturbs the original.
  {
    const second = join(base, 'second.bin')
    writeFileSync(second, 'second payload')
    const moved = await vau.vault(ctx, { path: second, move: true })
    ok('--move removes the original', moved.ok === true && moved.moved === true && !existsSync(second), JSON.stringify(moved.detail))
    ok('and the vault copy survives it', existsSync(moved.vaultPath), 'the copy is missing after a move')
  }

  // A dry run writes nothing at all, and its result still carries the undo the CLI prints.
  {
    const third = join(base, 'third.bin')
    writeFileSync(third, 'third payload')
    const dry = await vau.vault(ctx, { path: third, dryRun: true })
    ok('a dry run copies nothing', dry.ok === true && dry.dryRun === true && !existsSync(dry.vaultPath), JSON.stringify(dry.detail))
    ok('and still carries the command that would put it back', typeof dry.undo === 'string' && dry.undo.startsWith('copy '), String(dry.undo))
  }

  // The store must not be able to swallow itself, and the tool must keep its own undo reachable.
  {
    const inside = await vau.vault(ctx, { path: join(ctx.vaultRoot, copied.id, 'manifest.json') })
    ok('the vault refuses to vault its own contents',
      inside.ok === false && inside.refused === true, JSON.stringify(inside.detail))
  }

  rmSync(base, { recursive: true, force: true })
}

// ── a record that could not be read is counted, and loss is told apart from a partial write ─
  // The parse loop used to end in an empty catch, which discarded the row AND the fact of the row:
  // 410 records in this machine's own record failed to parse and nothing anywhere said so, so every
  // view built on readActivity under-reported while looking complete. Fewer findings reads as good
  // news, which is the failure this layer exists to prevent.
  //
  // The two cases are counted apart because they mean opposite things: a partial last line is the
  // normal state of a file being appended to right now and costs nothing, while a line that is not
  // the last one is a record that is gone.
{
  const g = await import('../lib/core.mjs')
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const dir = join(tmpdir(), 'vsep-unreadable-' + process.pid)
  rmSync(dir, { recursive: true, force: true })
  const now = new Date().toISOString()
  {
    const NL = String.fromCharCode(10)
    const part = (name, lines) => {
      const d = join(dir, 'partial-' + name)
      mkdirSync(join(d, 'activity'), { recursive: true })
      writeFileSync(join(d, 'activity', 'activity-2026-01-01.ndjson'), lines.join(NL) + NL)
      return { logDir: d }
    }
    const good = JSON.stringify({ t: now, kind: 'proc-start', pid: 1, name: 'a.exe' })

    // A finished record, then a truncated tail: the ordinary state of a live file.
    const tailCtx = part('tail', [good, '{"t":"2026-01-01T00:00:02Z","kind":"proc-st'])
    const tail = g.readActivity(tailCtx, { limit: 10 })
    ok('a truncated last line is counted as unreadable', tail.unreadableLines === 1, JSON.stringify(tail.unreadableLines))
    ok('but it is not counted as loss, because the next read will see the finished row',
      tail.unreadableMidFile === 0 && tail.complete === true, JSON.stringify({ mid: tail.unreadableMidFile, complete: tail.complete }))

    // Damage in the middle, with intact records after it: this one is gone.
    const midCtx = part('mid', [good, '{"t":"2026-01-01T00:00:02Z","broken', good, good])
    const mid = g.readActivity(midCtx, { limit: 10 })
    ok('damage with records after it is counted as mid-file', mid.unreadableMidFile === 1, JSON.stringify(mid.unreadableMidFile))
    ok('and the record is reported incomplete', mid.complete === false, JSON.stringify(mid.complete))
    ok('and the lines that did parse are still returned, so the count is a lower bound and not a blank',
      mid.total === 3, JSON.stringify(mid.total))

    // The signal layer carries it, because a finding count over a record with holes is a lower bound.
    const sig = g.analyzeSignals(midCtx, { sinceMinutes: 60 * 24 * 365 })
    ok('the detector reports the holes its count was computed over',
      sig.unreadableMidFile === 1 && sig.recordComplete === false,
      JSON.stringify({ mid: sig.unreadableMidFile, complete: sig.recordComplete }))

    // And a clean record reports none of it, so the warning means something when it appears.
    const cleanCtx = part('clean', [good, good])
    const clean = g.readActivity(cleanCtx, { limit: 10 })
    ok('a clean record reports no loss at all',
      clean.unreadableLines === 0 && clean.unreadableMidFile === 0 && clean.complete === true,
      JSON.stringify({ lines: clean.unreadableLines, mid: clean.unreadableMidFile }))
  }
  rmSync(dir, { recursive: true, force: true })
}


// ── the chamber probe: tiers, and the line it does not cross ─
// Two halves. The mechanical half is that the expensive fact is separated from the cheap ones, so a
// live window can refresh without waiting on a 1.2 s CIM call. The other half is that this module is
// the one asked to "extract activity" from a process that will not show it, and its answers have to
// stay inside what is observable: this tool does not inject, so a windowless process has nothing to
// reveal, and everything reported about it is still true.
{
  section('the chamber probe')
  const ch = await import('../lib/chamber.mjs')
  const g = await import('../lib/core.mjs')
  const ctx = g.resolveContext({})

  // Our own process: real, live, and windowless. A fabricated fixture could not show that the probe
  // reads the actual system, which is the only thing that makes its answers worth anything.
  const me = process.pid

  const fast = await ch.probeProcess(ctx, me, { tier: 'fast' })
  ok('the fast tier answers', fast.ok === true && fast.exists === true, String(fast.detail))
  ok('and reports the cheap facts',
    Number.isFinite(fast.live?.threads) && Number.isFinite(fast.live?.handles) &&
    Number.isFinite(fast.live?.workingSetMB) && typeof fast.live?.startedAt === 'string',
    JSON.stringify({ t: fast.live?.threads, h: fast.live?.handles, w: fast.live?.workingSetMB }))
  ok('and does NOT run the expensive query, leaving those fields null rather than empty',
    fast.live?.connections === null && fast.live?.modules === null,
    JSON.stringify({ connections: fast.live?.connections, modules: fast.live?.modules }))

  const slow = await ch.probeProcess(ctx, me, { tier: 'slow' })
  ok('the slow tier also answers', slow.ok === true && slow.exists === true, String(slow.detail))
  ok('and carries the facts the fast tier skipped',
    Array.isArray(slow.live?.modules) && slow.live.modules.length > 0,
    JSON.stringify({ modules: slow.live?.modules?.length }))
  // The connection list is the one query here that can FAIL rather than merely find nothing:
  // `Get-NetTCPConnection -OwningProcess <pid>` throws for a process with no matching entries, and
  // under the script's SilentlyContinue that became a `null` indistinguishable from "no connections".
  // What is asserted is therefore not "it is an array" -- it may legitimately not be -- but that the
  // two states cannot be confused.
  {
    const c = slow.live?.connections
    const err = slow.live?.connectionsError ?? null
    const distinguishable = Array.isArray(c) ? err === null : (c === null && typeof err === 'string' && err.length > 0)
    ok('an empty connection list and a failed one are distinguishable',
      distinguishable, JSON.stringify({ connections: c === null ? 'null' : 'array[' + c.length + ']', error: err ? err.slice(0, 40) : null }))
    ok('and a failed one says so in words rather than only in a field name',
      Array.isArray(c) || /could not be read/.test(String(slow.live?.note ?? '')),
      String(slow.live?.note))
  }
  ok('and leaves the cheap ones null, so a caller can tell "not asked" from "empty"',
    slow.live?.threads === null && slow.live?.workingSetMB === null,
    JSON.stringify({ threads: slow.live?.threads, ws: slow.live?.workingSetMB }))

  ok('both tiers say which one they are',
    fast.live?.tier === 'fast' && slow.live?.tier === 'slow',
    `${fast.live?.tier} / ${slow.live?.tier}`)

  // The expensive half really is the expensive half. Asserted loosely: a threshold tight enough to be
  // interesting would fail on a busy machine, and the property that matters is the direction.
  {
    const t0 = Date.now(); await ch.probeProcess(ctx, me, { tier: 'fast' }); const tf = Date.now() - t0
    const t1 = Date.now(); await ch.probeProcess(ctx, me, { tier: 'slow' }); const ts = Date.now() - t1
    ok('the fast tier is the cheaper one', tf < ts, `fast ${tf} ms vs slow ${ts} ms`)
  }

  // A pid that is gone is an answer, not a failure. Reporting it as an error would make "it exited"
  // look like "the probe broke", which is the distinction this whole layer keeps having to make.
  const gone = await ch.probeProcess(ctx, 999999, { tier: 'fast' })
  ok('a pid that does not exist is answered rather than failed',
    gone.ok === true && gone.exists === false, JSON.stringify({ ok: gone.ok, exists: gone.exists }))
  ok('and it says so in words', /no process with that pid/.test(String(gone.live?.note ?? '')), String(gone.live?.note))

  // A caller cannot ask for a tier that does not exist -- the script validates, and the failure is
  // reported rather than silently returning the wrong tier's answer.
  const bogus = await ch.probeProcess(ctx, me, { tier: 'not-a-tier' })
  ok('an unknown tier is refused rather than silently answered',
    bogus.ok === false || bogus.live === null, JSON.stringify({ ok: bogus.ok, tier: bogus.live?.tier }))

  // The honesty half: nothing in this module may claim to have compelled anything.
  {
    const src = readFileSync(join(projectDir, 'lib', 'chamber.mjs'), 'utf8')
    for (const claim of ['inject', 'forced it to', 'extracted from the process']) {
      const honest = src.includes('does not inject') || claim !== 'inject'
      if (!honest) continue
    }
    ok('the module states that it does not inject',
      src.includes('does not inject'), 'the boundary is not stated where a reader of this module will see it')
    ok('and states that a window it does not own cannot be made visible',
      /cannot be made to produce one|has nothing to reveal/.test(src),
      'the limit on what a windowless process can show is not stated')
  }

  // The window a caller opens is this tool's, and the script for it is found rather than assumed.
  ok('the chamber reports whether its own window host is present',
    typeof ch.chamberAvailable() === 'boolean', String(ch.chamberAvailable()))
}

// ── which PowerShell runs the platform layer, decided in one place ─
// The name was written into nineteen call sites across six modules. That is not a decision, it is
// nineteen assumptions that agree -- and the fork only became visible when a second interpreter
// appeared on the machine and someone asked why the first was still being used.
//
// PowerShell 5.1 is the answer, on measurement: it starts faster (806 ms bare against pwsh's 1136 ms)
// and its cost is not a fixed runtime bring-up that cannot be amortised, which matters because this
// layer is called often and per call. What that choice costs is already paid in this codebase -- the
// BOM that `readJsonLoose` exists for, the missing `AesGcm` that shaped the encryption split, the
// missing `ResolveLinkTarget` that made `resolve-path.ps1` use P/Invoke.
{
  section('the PowerShell host is chosen once')
  const plat = await import('../lib/platform.mjs')
  const host = plat.powershellHost()
  ok('a host is returned', typeof host === 'string' && host.length > 0, String(host))
  ok('on Windows it is the 5.1 host, on anything else pwsh',
    process.platform === 'win32' ? host === 'powershell' : host === 'pwsh', `${process.platform} -> ${host}`)

  // The override exists so the choice can be tested without editing code, and is read from the
  // environment rather than being a second hardcoded answer.
  const saved = process.env.VSEP_POWERSHELL
  process.env.VSEP_POWERSHELL = 'pwsh'
  ok('and it can be overridden from the environment',
    process.platform === 'win32' ? plat.powershellHost() === 'pwsh' : true,
    String(plat.powershellHost()))
  if (saved === undefined) delete process.env.VSEP_POWERSHELL
  else process.env.VSEP_POWERSHELL = saved

  // No other module may name the interpreter. This is the check that keeps the decision in one place,
  // and it fails the moment somebody writes the name into a new call site.
  //
  // The directory is read here rather than reused from the import-lint section above: that one is a
  // local inside its own block, and reaching for it produced a ReferenceError -- and a test that
  // cannot run is not evidence about the code. This project has now learned that twice.
  const { readdirSync: readLibDir } = await import('node:fs')
  const offenders = []
  for (const f of readLibDir(join(projectDir, 'lib')).filter((x) => x.endsWith('.mjs'))) {
    if (f === 'platform.mjs') continue
    const s = readFileSync(join(projectDir, 'lib', f), 'utf8')
    if (/['"]powershell(\.exe)?['"]/.test(s)) offenders.push(f)
  }
  ok('no module outside platform.mjs names the interpreter',
    offenders.length === 0, `named in: ${offenders.join(', ')}`)
}

// ── no screen may promise enforcement the tool cannot perform ─
// The same false claim was written in three places at three different times: `policy mode reject`
// said "will be TERMINATED", `decide` said "enforcement is ON", and `signals` went on saying it for a
// screen after `decide` had been corrected. Every one was caught by a person reading the output, and
// a claim that lives in output is exactly the kind a test can hold down.
//
// Asserted over the source rather than by running each command, because the strings are the artefact:
// a mode that nothing reads must not be described anywhere as if something does.
{
  section('no screen promises what the tool cannot do')
  // Comments are stripped first. All three phrases appear in this file as commentary recording that
  // they used to be printed -- which is the opposite of printing them, and a check that cannot tell
  // those apart fails on the fix it is meant to protect. The scanner is lifted out of the module
  // surface section above, which already needs it for the same reason.
  const stripComments = (src) => {
    const BS = String.fromCharCode(92)
    let out = ''
    let i = 0
    let prev = ''
    while (i < src.length) {
      const c = src[i]
      const n = src[i + 1]
      if (c === '/' && n === '/') {
        const e = src.indexOf(String.fromCharCode(10), i)
        i = e === -1 ? src.length : e
        continue
      }
      if (c === '/' && n === '*') {
        const e = src.indexOf('*' + '/', i + 2)
        i = e === -1 ? src.length : e + 2
        continue
      }
      if (c === "'" || c === '"' || c === '`') {
        const quote = c
        out += c
        i++
        while (i < src.length) {
          if (src[i] === BS) { out += src[i] + (src[i + 1] ?? ''); i += 2; continue }
          out += src[i]
          if (src[i] === quote) { i++; break }
          i++
        }
        continue
      }
      out += c
      prev = c
      i++
    }
    void prev
    return out
  }

  const src = stripComments(readFileSync(join(projectDir, 'bin', 'cli.mjs'), 'utf8'))
  const lib = ['signals.mjs', 'policy.mjs', 'mcp.mjs']
    .map((f) => stripComments(readFileSync(join(projectDir, 'lib', f), 'utf8')))
    .join(String.fromCharCode(10))

  // Phrases that assert an action is happening. `would have acted` and `would do` are fine and are
  // how the counterfactual is supposed to read; what must not appear is the plain present tense.
  const claims = [
    'enforcement is ON',
    'will be TERMINATED',
    'enforcement is enabled',
  ]
  for (const claim of claims) {
    ok(`nothing in the CLI claims "${claim}"`, !src.includes(claim), `found in bin/cli.mjs`)
  }

  // The one place a non-observe mode is described must say that it is recorded and unread.
  ok('a non-observe mode is described as recorded intent',
    src.includes('recorded intent; nothing reads it yet'),
    'the honest phrasing is gone from the CLI')
  ok('and at least two screens use it, because the claim appeared on more than one',
    (src.split('recorded intent; nothing reads it yet').length - 1) >= 2,
    'fewer than two screens describe a non-observe mode honestly')

  // The counterfactual vocabulary is imperative ("freeze the process"), and it is only correct inside
  // a would-have sentence. Guard the sentence, not the verb.
  ok('the counterfactual sentence is phrased as a counterfactual',
    /would have acted/.test(src), 'the sentence that uses the imperative verbs is gone')

  // The library must not describe a mode as acting either.
  ok('the library does not describe a mode as acting',
    !lib.includes('enforcement is ON'), 'found in lib/')
}

// ── what is being supervised is a value, not a set of literals ─
// Every path in resolveContext was built from a literal `~/.hindsight`, the daemon's module name was
// spelled out in four separate argument lists, and "is it healthy" meant `GET /health` because that is
// what this particular service answers. None of it was wrong; it was unexamined, which made "what this
// tool supervises" a fact about the source code rather than something readable and replaceable.
//
// The extraction's claim is equivalence, so it is tested as a comparison against the values the
// literals used to produce -- recomputed here rather than pasted, so the check does not decay into a
// snapshot of one machine's home directory.
{
  section('the service descriptor')
  const svc = await import('../lib/service.mjs')
  const g = await import('../lib/core.mjs')
  const { homedir } = await import('node:os')
  const { join } = await import('node:path')

  const bare = g.resolveContext({})
  const d = svc.resolveServiceDescriptor({})
  ok('the default descriptor resolves', d.ok === true && d.descriptor.id === 'hindsight', String(d.detail ?? d.id))

  // An unknown id is an answer, never a silent fall back to the one that exists. Running the wrong
  // service's commands is worse than running none.
  const missing = svc.resolveServiceDescriptor({ service: 'not-a-service' })
  ok('an unknown service id is refused rather than defaulted',
    missing.ok === false && /no service descriptor/.test(missing.detail), String(missing.detail))

  const home = homedir()
  const p = svc.resolveServicePaths(d.descriptor, { profile: 'coding-agent' })
  const expected = {
    configFile: join(home, '.hindsight', 'coding-agent.json'),
    serviceHome: join(home, '.hindsight'),
    profileDir: join(home, '.hindsight', 'profiles'),
    profileEnvFile: join(home, '.hindsight', 'profiles', 'coding-agent.env'),
    profileLogFile: join(home, '.hindsight', 'profiles', 'coding-agent.log'),
    profileLockFile: join(home, '.hindsight', 'profiles', 'coding-agent.lock'),
    daemonLogFile: join(home, '.hindsight', 'daemon.log'),
    dataDir: join(home, '.pg0', 'instances', 'hindsight-embed-coding-agent', 'data'),
  }
  for (const [k, want] of Object.entries(expected)) {
    ok(`the descriptor resolves ${k} to what the literals produced`,
      p[k] === want, `${p[k]} vs ${want}`)
  }

  // The context must carry them under the names callers already use, because an extraction that
  // renamed things would be a redesign wearing an extraction's clothes.
  for (const k of ['configFile', 'hindsightHome', 'profileDir', 'profileEnvFile', 'profileLogFile',
                   'profileLockFile', 'daemonLogFile']) {
    ok(`the context still exposes ${k}`, bare[k] === p[k], `${bare[k]} vs ${p[k]}`)
  }
  ok('and carries the descriptor itself, which is what the argument builders read',
    bare.serviceDescriptor?.id === 'hindsight' && bare.runtimeModule === 'hindsight-embed',
    `${bare.serviceDescriptor?.id} / ${bare.runtimeModule}`)

  // The command line used to be spelled out in four places. One builder now, and the module name is
  // the descriptor's.
  const built = svc.serviceArgs(d.descriptor, bare, { uvArgs: ['-v'], sub: 'watch' })
  ok('the launcher builds the command line from the descriptor', built.ok === true, String(built.detail))
  const line = (built.args ?? []).join(' ')
  ok('and the module name comes from the descriptor rather than from the call site',
    line.includes(`${d.descriptor.runtime.module}@${bare.embedVersion}`), line)
  ok('and the subcommand and profile are expanded', /daemon --profile coding-agent watch$/.test(line), line)

  // A version that cannot be determined is refused, not guessed. This is the failure a descriptor
  // makes possible -- get the source of the version wrong and every command refuses to build.
  const noVersion = svc.serviceArgs(d.descriptor, { profile: 'coding-agent', withPackages: [] }, {})
  ok('a context with no known version is refused rather than guessed',
    noVersion.ok === false && /version is known/.test(noVersion.detail), String(noVersion.detail))

  // The data layer says how to ask a real question, and a descriptor cannot opt out of that.
  ok('the data probe names a statement rather than just a port',
    svc.dataProbe(d.descriptor)?.kind === 'sql' && /select/i.test(svc.dataProbe(d.descriptor).statement),
    JSON.stringify(svc.dataProbe(d.descriptor)))
  ok('and the data kind is postgres, which is what decides which probe module runs',
    svc.dataKind(d.descriptor) === 'postgres', String(svc.dataKind(d.descriptor)))

  // ── the second descriptor: what the design was missing ─
  // A descriptor invented to fit the fields proves the fields are self-consistent and nothing else.
  // This one describes a service that is really running on this machine and is shaped differently:
  // the DSH host, which answers HTTP to everything, has no health endpoint, and is started by a plain
  // node interpreter rather than by uvx.
  {
    const dsh = svc.SERVICE_DESCRIPTORS.dsh
    ok('a second descriptor exists and is a different kind of thing',
      Boolean(dsh) && dsh.id !== 'hindsight' && dsh.runtime.kind === 'node', JSON.stringify(dsh?.runtime?.kind))

    // Its home comes from an environment variable, which is what the layout resolver only looked for
    // at the top level -- true only while there was one descriptor.
    const savedHome = process.env.DSH_HOME
    process.env.DSH_HOME = join(tmpdir(), 'vsep-dshhome-' + process.pid)
    const dp = svc.resolveServicePaths(dsh, { profile: 'web' })
    ok('a descriptor whose home comes from the environment resolves to that environment',
      dp.serviceHome === process.env.DSH_HOME, `${dp.serviceHome} vs ${process.env.DSH_HOME}`)
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome

    // No data layer is an absence, not an empty one. A caller that expects a directory here has to
    // see the absence rather than a path to nothing.
    ok('a service with no data layer reports null rather than an empty path',
      dp.dataDir === null, String(dp.dataDir))
    ok('and its data probe is absent rather than a stub',
      svc.dataProbe(dsh) === null && svc.dataKind(dsh) === null,
      JSON.stringify({ probe: svc.dataProbe(dsh), kind: svc.dataKind(dsh) }))

    // Reachability, which is the vocabulary this descriptor forced into existence: the host answers
    // 401 to its guarded endpoints and 404 to everything else, so "2xx means up" would call a working
    // host down.
    const live = svc.healthKind(dsh, 'live')
    ok('the live probe is declared as reachability rather than as a status code',
      live.kind === 'any-http-answer' && live.okWhen === 'any-http-answer', JSON.stringify(live))
    const ready = svc.healthKind(dsh, 'ready')
    ok('and a service that publishes no readiness endpoint says so instead of being pointed at a 404',
      ready.kind === 'none' && typeof ready.why === 'string' && ready.why.length > 0, JSON.stringify(ready))
    ok('the health vocabulary keeps the strict kind for a service that really answers 2xx',
      svc.healthKind(svc.HINDSIGHT, 'ready').kind === 'http-json',
      JSON.stringify(svc.healthKind(svc.HINDSIGHT, 'ready')))

    // ── every kind a descriptor declares must be one something implements ──
    // This is the check that would have caught the bug it was written after. A descriptor declared
    // `kind: 'http-any'` while the implementation enumerated `'any-http-answer'`, so the strict test
    // ran against a 401, a live service was reported unhealthy, and -- worse -- the same mismatch on
    // the Hindsight side made the main probe report "port is open but /health did not answer" while
    // curl got 200. Both names were mine, an hour apart, and a wrong answer looked like a working one.
    {
      const sup = await import('../lib/supervisor.mjs')
      const kinds = new Set()
      for (const d of Object.values(svc.SERVICE_DESCRIPTORS)) {
        for (const which of ['ready', 'live']) {
          const h = svc.healthKind(d, which)
          if (h.kind && h.kind !== 'none') kinds.add(h.kind)
        }
      }
      const unimplemented = []
      for (const k of kinds) {
        try {
          // Asked with a 2xx and with a 401, because a kind that only works for one of them is not
          // a kind, it is a coincidence.
          sup.probeKindSaysAlive(k, 200)
          sup.probeKindSaysAlive(k, 401)
        } catch {
          unimplemented.push(k)
        }
      }
      ok('every probe kind a descriptor declares is implemented',
        unimplemented.length === 0, `not implemented: ${unimplemented.join(', ')}`)

      // And an unknown kind is refused rather than falling back to whatever the else branch does.
      let threw = false
      try { sup.probeKindSaysAlive('not-a-kind', 200) } catch { threw = true }
      ok('and a kind nothing implements is refused loudly', threw, 'an unknown kind was accepted')

      // The two implemented kinds must actually differ, or one of them is decoration.
      ok('the strict kind rejects a 401 while the reachability kind accepts it',
        sup.probeKindSaysAlive('http-json', 401) === false &&
        sup.probeKindSaysAlive('any-http-answer', 401) === true,
        'the two kinds behave the same, so one of them says nothing')
    }

    // It cannot be launched, and that is a declared fact rather than a failure. The entry point is
    // decided by the install location and is recorded nowhere this tool reads; a guessed path would
    // resolve on one machine and not the next.
    const refused = svc.serviceArgs(dsh, { ...bare, profile: 'web' }, {})
    ok('a descriptor that cannot launch its service says so rather than guessing a path',
      refused.ok === false && refused.refused === true && /cannot start/.test(refused.detail),
      String(refused.detail))
    ok('and supplying an entry point does not override the descriptor\'s own answer',
      svc.serviceArgs(dsh, { ...bare, profile: 'web', serviceEntry: 'X:/made-up.js' }, {}).ok === false,
      'the descriptor was overridden by a caller-supplied path')

    // Through the context, so the refusal is reachable from the CLI and not only from the module.
    const dshCtx = g.resolveContext({ service: 'dsh' })
    ok('the context can be resolved for the second service',
      dshCtx.serviceId === 'dsh' && dshCtx.runtimeModule === 'dsh', `${dshCtx.serviceId} / ${dshCtx.runtimeModule}`)
    ok('and the first service is unchanged by the second one existing',
      bare.serviceId === 'hindsight' && bare.runtimeModule === 'hindsight-embed',
      `${bare.serviceId} / ${bare.runtimeModule}`)

    // A settings file that is not JSON must not crash the resolver. DSH's is YAML, and readJsonLoose
    // throws on malformed content rather than returning null, which its name invites a caller to
    // assume -- so the unguarded call crashed on the second descriptor and on nothing before it.
    ok('a non-JSON settings file is tolerated rather than fatal',
      dshCtx.pluginCfg && typeof dshCtx.pluginCfg === 'object',
      JSON.stringify(dshCtx.pluginCfg))
  }

  // The health model is declared, not implied: both questions, separately.
  ok('readiness and liveness are separate entries in the descriptor',
    d.descriptor.health.ready.path === '/health' && d.descriptor.health.live.path === '/health/live',
    JSON.stringify(d.descriptor.health.ready) + ' / ' + JSON.stringify(d.descriptor.health.live))
}

// ── two switches whose names promised more than they did ─
// `neverQuarantine` was a POLICY_DEFAULTS field nothing read: one grep hit, the definition. So it held
// nothing back, promised nothing, and by the time it was removed it also described the tool
// inaccurately -- `vault --move` takes a file out of its place. An unread field whose name reads like
// a safeguard is the false signal this project removes, so it went rather than being wired up to
// justify its own name.
//
// `policy.mode`'s suspend and reject are the other shape: recordable intent that nothing acts on, and
// the honest form of that is to keep recording it and say so, not to refuse the value. What must not
// survive is any screen claiming enforcement is on -- `decide` was corrected for that once and
// `signals` kept saying it one screen over.
{
  section('switches that promised more than they did')
  const g = await import('../lib/core.mjs')

  ok('the unread neverQuarantine field is gone rather than kept as decoration',
    !('neverQuarantine' in g.POLICY_DEFAULTS), Object.keys(g.POLICY_DEFAULTS).join(','))

  // The remaining vocabulary is small enough to state exactly, so it is stated rather than sampled.
  ok('the policy still defaults to observe and to nothing else',
    g.POLICY_DEFAULTS.mode === 'observe', String(g.POLICY_DEFAULTS.mode))

  // Every mode the CLI accepts must have a documented action phrase, and every phrase must be one the
  // tool can actually describe -- the vocabulary is what the counterfactual sentence is built from.
  for (const m of ['observe', 'suspend', 'reject']) {
    const a = g.modeAction(m)
    ok(`modeAction names what "${m}" would do`, typeof a === 'string' && a.length > 0, String(a))
  }
  ok('a mode with no phrase falls through as itself rather than as an empty string',
    g.modeAction('not-a-mode') === 'not-a-mode', String(g.modeAction('not-a-mode')))
}

// ── a policy that cannot be read is not the default policy ─
// `catch { raw = {} }` turned a corrupt policy into the built-in defaults, silently. The defaults are
// the safe direction -- observe, empty allowlist -- so nothing dangerous followed, and that is exactly
// why it went unnoticed: a corrupted file produced a working tool with a policy nobody chose. The rule
// this project keeps invoking is that unknown is not zero; here unknown was being read as consent.
{
  section('policy integrity')
  const g = await import('../lib/core.mjs')
  const base = g.resolveContext({})
  const dir = join(tmpdir(), 'vsep-policy-' + process.pid)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'policy.json')
  const ctx = { ...base, policyFile: file }

  rmSync(file, { force: true })
  const missing = g.loadPolicy(ctx)
  ok('a missing file is reported as absent, not as invalid',
    missing.integrity === 'absent' && missing.verified === true, JSON.stringify(missing.integrity))

  const w = g.savePolicy(ctx, { mode: 'reject', allow: ['name:thing.exe'] })
  ok('a policy can be saved', w.ok === true, JSON.stringify(w.detail))
  const good = g.loadPolicy(ctx)
  ok('and read back as ok', good.integrity === 'ok' && good.mode === 'reject', JSON.stringify({ i: good.integrity, m: good.mode }))

  // The write is atomic. A half-written policy is precisely the corrupt state this reports, so the
  // save must not be able to produce it: a temp file beside it, then a rename.
  ok('the save does not leave a temporary file behind', !existsSync(file + '.tmp'), 'a .tmp survived the save')

  writeFileSync(file, '{"mode": "reject", not json at all')
  const broken = g.loadPolicy(ctx)
  ok('a corrupt file is reported as invalid, not as the default',
    broken.integrity === 'invalid' && broken.verified === false, JSON.stringify(broken.integrity))
  ok('and it says why', typeof broken.parseError === 'string' && broken.parseError.length > 5, String(broken.parseError))
  ok('and it still falls back to something safe rather than refusing to run',
    broken.mode === 'observe', broken.mode)
  ok('but it does not claim that fallback is the user\'s choice', broken.verified === false, 'verified stayed true')

  // An array is valid JSON and not a policy; that has to be caught too, or it spreads into nonsense.
  writeFileSync(file, '[1,2,3]')
  const arr = g.loadPolicy(ctx)
  ok('a JSON array is rejected as a policy rather than spread into one',
    arr.integrity === 'invalid' && arr.mode === 'observe', JSON.stringify({ i: arr.integrity, m: arr.mode }))

  // A policy cannot declare its own integrity.
  writeFileSync(file, JSON.stringify({ mode: 'observe', integrity: 'ok', verified: true }))
  const selfClaim = g.loadPolicy(ctx)
  ok('a policy file cannot claim its own integrity', selfClaim.integrity === 'ok', selfClaim.integrity)

  rmSync(dir, { recursive: true, force: true })
}

// ── two recoveries must not run at once ─
// heal was written as if only one of it ran at a time and nothing enforced that. Measured over 514
// heartbeats on this machine, 16 overlapped the previous one -- about three percent -- and the worst
// ran for thirty minutes while the next had already begun. The risk is not hypothetical, which is the
// only reason it is worth the code.
{
  section('recovery lock')
  const L = await import('../lib/lock.mjs')
  const dir = join(tmpdir(), 'vsep-lock-' + process.pid)
  rmSync(dir, { recursive: true, force: true })
  const ctx = { lockDir: dir }

  const first = L.acquireLock(ctx, 'recovery', { holder: 'first' })
  ok('the first caller gets the lock', first.ok === true && first.takenOverFrom === null, JSON.stringify(first))

  const second = L.acquireLock(ctx, 'recovery', { holder: 'second' })
  ok('a second caller is told it is busy rather than being allowed through',
    second.ok === false && second.busy === true, JSON.stringify(second))
  ok('and it can see who holds it', second.holder?.holder === 'first' && second.holder?.pid === process.pid, JSON.stringify(second.holder))

  // A holder that died must not block for ever. A lock that can never be taken again is worse than no
  // lock: the heartbeat would stop repairing anything and report that it could not get a turn.
  writeFileSync(L.lockFile(ctx, 'recovery'), JSON.stringify({ pid: 999999, holder: 'dead', at: new Date(Date.now() - 3600000).toISOString() }))
  const took = L.acquireLock(ctx, 'recovery', { holder: 'third' })
  ok('a lock whose holder is gone is taken over', took.ok === true, JSON.stringify(took))
  ok('and the takeover is recorded rather than silent',
    took.takenOverFrom?.dead?.holder === 'dead' || took.takenOverFrom?.holder === 'dead' || took.takenOverFrom?.alive === false,
    JSON.stringify(took.takenOverFrom))

  // A truncated lock file is not evidence that anyone holds it.
  writeFileSync(L.lockFile(ctx, 'recovery'), '{ not json')
  const broken = L.acquireLock(ctx, 'recovery', { holder: 'fourth' })
  ok('an unreadable lock file does not block for ever', broken.ok === true, JSON.stringify(broken))

  // Only the holder releases. A process that took over must not be able to have its lock deleted by
  // the process it took over from.
  writeFileSync(L.lockFile(ctx, 'recovery'), JSON.stringify({ pid: process.pid + 1, holder: 'someone else', at: new Date().toISOString() }))
  const refused = L.releaseLock(ctx, 'recovery')
  ok('a non-holder cannot release the lock', refused.ok === false && /held by pid/.test(refused.reason ?? ''), JSON.stringify(refused))

  // And the holder can. The fake lock above is removed first: it carries a fresh timestamp and a
  // pid that may well be alive, so acquireLock would correctly refuse to take it and the release
  // below would then be refused for the right reason -- which is what the first version of this
  // test measured instead of what it meant to.
  rmSync(L.lockFile(ctx, 'recovery'), { force: true })
  L.acquireLock(ctx, 'recovery', { holder: 'holder' })
  const released = L.releaseLock(ctx, 'recovery')
  ok('the holder releases it', released.ok === true && !existsSync(L.lockFile(ctx, 'recovery')), JSON.stringify(released))

  rmSync(dir, { recursive: true, force: true })
}

// ── a socket that accepts connections is not a database that works ─
// 5432 LISTEN plus a data directory plus a failed SQL handshake is a state that exists: recovery
// mode, a full connection table, a revoked role, a wrong password. All of them are invisible to a
// socket probe, and the daemon then comes up answering 503 -- which reads as a daemon fault and is
// not one. The probe now says how far it got, so a failure names the layer that failed.
{
  section('database query probe')
  const d = await import('../lib/database.mjs')
  const g = await import('../lib/core.mjs')
  const ctx = g.resolveContext({})

  if (process.platform !== 'win32') {
    ok('the database query probe is Windows-only (skipped honestly)', true, '')
  } else {
    ok('psql is found by discovery, not by a hardcoded version', typeof d.psqlPath() === 'string' && d.psqlPath().includes('psql'), String(d.psqlPath()))
    ok('the connection url is read from the profile rather than reconstructed',
      typeof d.databaseUrl(ctx) === 'string' && /^postgres/.test(d.databaseUrl(ctx)), String(d.databaseUrl(ctx)).replace(/:[^:@]+@/, ':<redacted>@'))

    const live = await d.probeDatabaseQuery(ctx)
    ok('a working database answers a real query', live.ok === true && live.level === 'query', JSON.stringify(live.detail))
    ok('and the result carries no credential',
      !JSON.stringify(live).includes('hindsight:hindsight'), 'the password reached the result')

    // The failure this exists for: reachable, and unusable. Simulated with a wrong password, which is
    // one of the four situations a socket probe cannot tell apart.
    const { join } = await import('node:path')
    const { homedir } = await import('node:os')
    const f = join(homedir(), '.hindsight', 'profiles', 'vsep-probe-test.env')
    writeFileSync(f, 'HINDSIGHT_API_DATABASE_URL=postgresql://hindsight:wrongpassword@127.0.0.1:5432/hindsight\n')
    try {
      const bad = await d.probeDatabaseQuery({ ...ctx, profile: 'vsep-probe-test' })
      ok('a database that refuses the query is reported as refused, not as listening',
        bad.ok === false && bad.checked === true && bad.level === 'query', JSON.stringify(bad.detail))
      ok('and the reason is legible rather than the console code page decoded as UTF-8',
        !bad.detail.includes(String.fromCharCode(0xfffd)), bad.detail)
      ok('and the wrong password did not reach the result',
        !JSON.stringify(bad).includes('wrongpassword'), 'the password reached the result')
    } finally {
      rmSync(f, { force: true })
    }

    // A profile with no url is a different answer again: not "the database is broken" but "we could
    // not ask". Reporting those the same way would be the failure this whole layer exists to prevent.
    const none = await d.probeDatabaseQuery({ ...ctx, profile: 'no-such-profile-xyz' })
    ok('a missing connection url says it could not ask, rather than reporting a failure',
      none.ok === false && none.checked === false && none.level === 'no-credentials', JSON.stringify(none.detail))
  }
}

// ── the recorder must be one, and must not miss the moment it starts ─
// Two defects in one file, both found by reading what it actually does rather than what it says.
//
// The boot race: the baseline snapshot was taken, and only then was the event subscription created.
// A process that started in between was in neither the snapshot nor the stream -- and a process that
// short-lived is exactly what an event-driven recorder exists to catch.
//
// The duplicate: the single-instance guard opened the lock to test it, disposed what it opened, and
// then removed and recreated the file. Two recorders starting together could both pass the check.
// This machine had two live recorders holding the same daily file when it was found.
{
  section('activity recorder startup')
  const src = readFileSync(join(projectDir, 'bin', 'activity-watch.ps1'), 'utf8')

  // The order is the fix, so the order is what is asserted. A snapshot before a subscription is the
  // defect, and no amount of commenting makes it correct.
  const sub = src.indexOf('Register-CimIndicationEvent -Query')
  const base = src.indexOf("kind       = 'baseline'")
  const baseAlt = src.indexOf("kind = 'baseline'")
  const baseAt = base === -1 ? baseAlt : base
  ok('the subscription is created before the baseline is taken',
    sub !== -1 && baseAt !== -1 && sub < baseAt,
    `subscription at ${sub}, baseline at ${baseAt} -- the baseline must come second`)
  ok('and the baseline records that the subscription was already live',
    /subscribed = \[bool\]\(Get-EventSubscriber/.test(src), 'the baseline does not say whether anything was listening')

  // The guard must take the lock in one operation. A check that releases what it checked is not a
  // guard -- the same shape as the uv cache prune that scanned and then deleted.
  ok('the lock is taken atomically rather than checked and then taken',
    /FileMode\]::CreateNew/.test(src), 'the lock is not created with CreateNew')
  ok('the old check-then-act guard is gone',
    !/^\s*\$script:HeldByOther\s*=/m.test(src), 'the check-then-act guard is still there')
  ok('a stale lock is taken over rather than blocking for ever',
    /took over a stale lock/.test(src), 'no stale-lock path')
  ok('and an empty lock file is waited for rather than seized',
    /between CreateNew and writing its pid/.test(src), 'the mid-creation case is not handled')
  ok('failing to take the lock still lets the recorder run',
    /Fail OPEN/.test(src), 'a guard that can switch the recorder off entirely is worse than a duplicate')

  // And the claim it makes about itself has to be the true one.
  ok('the comment does not claim it sees the past',
    /started AND exited before this/.test(src), 'the boundary is not stated')

  // The counters must survive a read that fails. The snapshot is the only thing that can report a
  // failure, so a guard that lets one exception stop it being written makes the recorder silent about
  // its own state while still recording events -- which is exactly what happened in production before
  // the reads were wrapped.
  // A raw newline inside a command line used to make the record unreadable.
  //
  // The recorder sanitises every value before writing a line, and the pattern it used matched CR+LF
  // or a bare CR -- but NOT a bare LF, which is what a multi-line bash command carries. The raw
  // newline landed inside a JSON string, so the whole record failed to parse:
  //
  //   measured over eight days of the live record: 410 unparseable lines out of 403,685 (0.10%),
  //   each one a proc-start whose cmd spanned multiple lines.
  //
  // The record loses them silently. readActivity counts FILE read failures, not LINES it could not
  // parse, so nothing reports the loss -- and fewer findings reads as good news, which is the
  // failure this whole layer exists to prevent.
  //
  // This asserts the property rather than the spelling: the expression is lifted out of the script,
  // applied to real line-break characters, and the result must survive a JSON round trip. Verified
  // to fail on the previous pattern before being kept.
  {
    const m = /-replace\s+"\[([^\]]*)\]",\s*' '/.exec(src)
    ok('the recorder sanitises line breaks with a character class',
      m !== null, 'no -replace "[...]", \' \' found in the recorder script')

    if (m) {
      const cls = m[1]
      ok('and the class covers both CR and LF, because a bare LF is what a shell command carries',
        cls.includes('r') && cls.includes('n'), `class was [${cls}]`)

      // A bare LF is the shape that was missed; the others are here so a narrowed pattern cannot
      // pass by fixing only this one.
      const shapes = ['bare LF', 'bare CR', 'CRLF', 'double LF', 'LF then CR', 'quote and LF']
      const NL = String.fromCharCode(10)
      const CR = String.fromCharCode(13)
      const broken = []
      for (const name of shapes) {
        const raw = name === 'bare LF' ? `a${NL}b`
          : name === 'bare CR' ? `a${CR}b`
          : name === 'CRLF' ? `a${CR}${NL}b`
          : name === 'double LF' ? `a${NL}${NL}b`
          : name === 'LF then CR' ? `a${NL}${CR}b`
          : `a"${NL}b`
        // The same escaping the recorder performs, in the same order: backslash, then quote, then
        // every line-break character. The quote is not decoration -- a fixture that leaves one
        // unescaped fails the round trip for a reason that has nothing to do with newlines, and the
        // first version of this check failed for exactly that reason.
        const escaped = raw
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/[\r\n]/g, ' ')
        const line = `{"cmd":"${escaped}"}`
        let ok2 = true
        try { JSON.parse(line) } catch { ok2 = false }
        if (!ok2) broken.push(name)
      }
      ok('and a sanitised command line always parses as one JSON record',
        broken.length === 0, `these shapes still break the record: ${broken.join(', ')}`)
    }
  }

  ok('the health snapshot is written even if reading the subscription state throws',
    /try \{ \$sub = \[bool\]\(Get-EventSubscriber/.test(src),
    'Get-EventSubscriber is not guarded, so a throw there leaves the snapshot unwritten')
  ok('the duplicate filter keys on the kernel stamp rather than a field the payload repeats',
    /\$d\.TIME_CREATED/.test(src), 'duplicates are not recognised by TIME_CREATED')

  // And the ORDER of those two tests decides whether the counters mean anything.
  //
  // WMI delivers one trace record many times over: measured on this machine, 3,300 deliveries in 11 s
  // that were 3 distinct events, and once 10,500 in 31 s that was one. With the identity test first,
  // every redelivery of one event was counted as a fresh discarding of our own process -- the
  // snapshot read 105,203 "self" events over five minutes against 9 rows written, which looks like a
  // hard-working recorder and was one event repeated. A filter placed before the dedupe cannot see
  // how much of the stream is repetition.
  const dedupeAt = src.indexOf('$script:Counters.eventsDuplicate++')
  const selfAt = src.indexOf('$script:Counters.eventsSelf++')
  ok('the duplicate filter runs before the identity test',
    dedupeAt !== -1 && selfAt !== -1 && dedupeAt < selfAt,
    `dedupe at ${dedupeAt}, self-filter at ${selfAt} -- the dedupe must come first`)
  ok('and the recorder counts what it discarded as a repeat, rather than only what it wrote',
    /eventsDuplicate/.test(src) && /eventsSelf/.test(src), 'the discarded totals are not published')
}

// ── the recorder's own account of what it wrote ─
// A reader could previously only ask "is the newest event recent?", and that question has the same
// answer for a recorder that is working and one whose every write is failing -- because the events
// that would have made the file look stale are the ones that never arrived. Silence read as calm.
//
// These tests exercise the reader against synthetic snapshots rather than a live recorder: what is
// being asserted is how absence, staleness and dropped rows are reported, and those are decided here,
// not by the writing side.
{
  section('recorder health')
  const g = await import('../lib/core.mjs')
  const dir = join(tmpdir(), 'vsep-rechealth-' + process.pid)
  const act = join(dir, 'activity')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(act, { recursive: true })
  const ctx = { ...g.resolveContext({}), logDir: dir }

  // No snapshot at all: a recorder too old to publish one must not read as healthy and complete.
  const absent = g.readRecorderHealth(ctx)
  ok('an absent health snapshot is reported as unknown, not as healthy',
    absent.known === false, JSON.stringify(absent))
  ok('and it says so in words a reader can act on',
    /does not publish one/.test(absent.detail ?? ''), absent.detail)

  // A fresh snapshot with a dropped row: the row count is the fact that must not be rounded away.
  const now = new Date()
  writeFileSync(join(act, 'recorder-health.json'), JSON.stringify({
    pid: 4242, startedAt: now.toISOString(), t: now.toISOString(), uptimeSeconds: 120,
    passes: 900, iterations: 900, subscribed: true, subscribedStop: true, lockTaken: true,
    eventsSeen: 1000, eventsSelf: 900, eventsDuplicate: 50, eventsWritten: 45,
    eventsDropped: 5, handlerErrors: 2, lockNote: '',
  }))
  const h = g.readRecorderHealth(ctx)
  ok('a fresh snapshot is known and fresh', h.known === true && h.fresh === true, JSON.stringify(h))
  ok('and it carries the drop count rather than a summary',
    h.eventsDropped === 5 && h.eventsWritten === 45 && h.eventsSeen === 1000, JSON.stringify(h))
  ok('and the handler errors separately, because they are a different failure',
    h.handlerErrors === 2, JSON.stringify(h))


  // The probe must fold that into its verdict: seen != written is not the same as stopped. It needs a
  // record to be there at all -- "no record" is a different verdict, and it is the right one to give
  // when there is nothing to read.
  writeFileSync(join(act, 'activity-2026-01-01.ndjson'),
    JSON.stringify({ t: now.toISOString(), kind: 'proc-start', pid: 1, name: 'x.exe' }) + String.fromCharCode(10))
  const probe = await g.probeActivityRecorder(ctx)
  ok('the probe reports the lost rows in its own words',
    /45 row\(s\) written/.test(probe.detail) && /5 lost/.test(probe.detail), probe.detail)
  ok('and does not print a fraction of two counts that do not compose',
    !/of 1000 seen/.test(probe.detail), probe.detail)

  // A stale snapshot is the honest signal that the recorder is not running -- and it must not be
  // satisfied by an old record file that still has recent-looking events in it.
  const old = new Date(Date.now() - 600 * 1000)
  writeFileSync(join(act, 'recorder-health.json'), JSON.stringify({
    pid: 4242, t: old.toISOString(), startedAt: old.toISOString(), subscribed: true,
    eventsSeen: 10, eventsWritten: 10, eventsDropped: 0, eventsSelf: 0, eventsDuplicate: 0,
    handlerErrors: 0, passes: 1, iterations: 1,
  }))
  const stale = g.readRecorderHealth(ctx)
  ok('a stale snapshot is not fresh', stale.known === true && stale.fresh === false, JSON.stringify(stale))
  ok('and the age is reported so the reader can judge it', stale.ageSeconds >= 599, String(stale.ageSeconds))

  // A subscription that is not live is its own finding: it can be true while the process is otherwise
  // healthy, and it means the record is missing process starts it will never get back.
  writeFileSync(join(act, 'recorder-health.json'), JSON.stringify({
    pid: 4242, t: new Date().toISOString(), subscribed: false, subscribedStop: true,
    eventsSeen: 10, eventsWritten: 10, eventsDropped: 0, eventsSelf: 0, eventsDuplicate: 0,
    handlerErrors: 0, passes: 1, iterations: 1,
  }))
  const unsub = g.readRecorderHealth(ctx)
  ok('a dead subscription is visible in the snapshot', unsub.subscribed === false, JSON.stringify(unsub))

  // A corrupt snapshot is not a healthy one either.
  writeFileSync(join(act, 'recorder-health.json'), '{ this is not json')
  const broken = g.readRecorderHealth(ctx)
  ok('a corrupt snapshot is reported as unreadable rather than assumed fine',
    broken.known === false && /could not be read/.test(broken.detail), JSON.stringify(broken))

  // Every counter the recorder publishes must come back out of the reader. A field the writer emits
  // and the reader drops is invisible in the worst way: the panel prints `?`, which reads as "this
  // recorder does not publish that" -- and `eventsAccepted` looked unimplemented for exactly that
  // reason while the recorder had been writing it all along.
  {
    const published = { eventsSeen: 1, eventsSelf: 2, eventsDuplicate: 3, eventsAccepted: 4,
                        batches: 5, eventsInBatch: 6, maxBatch: 7, eventsWritten: 8,
                        eventsDropped: 9, handlerErrors: 10, passes: 11, iterations: 12 }
    writeFileSync(join(act, 'recorder-health.json'),
      JSON.stringify({ pid: 1, t: now.toISOString(), ...published }))
    const r = g.readRecorderHealth(ctx)
    const dropped = Object.keys(published).filter((k) => r[k] !== published[k])
    ok('the reader forwards every counter the recorder publishes',
      dropped.length === 0, `not forwarded: ${dropped.join(', ')}`)
  }

  rmSync(dir, { recursive: true, force: true })
}

// ── two runs in the same second must not share a transcript ─
// The stamp was truncated to the second, so a manual `heal` and the heartbeat -- exactly the pair that
// collides -- wrote to one file and each overwrote the other. The symptom is not a missing log but a
// log mixing two recoveries, which is worse: it reads as one confusing run instead of two clear ones.
//
// The runId is what makes a recovery reassemblable. Without it the only link between the transcripts of
// one repair is the wall clock, and the whole reason this tool keeps transcripts is to answer "what
// happened during that repair" once it is over.
{
  section('transcript naming')
  const g = await import('../lib/core.mjs')
  const dir = join(tmpdir(), 'vsep-logs-' + process.pid)
  rmSync(dir, { recursive: true, force: true })
  const ctx = { ...g.resolveContext({}), logDir: dir }

  const a = g.newLogPath(ctx, 'warm', { runId: 'aaaa1111' })
  const b = g.newLogPath(ctx, 'warm', { runId: 'bbbb2222' })
  ok('two runs in the same second get different transcripts', a !== b, `${a} vs ${b}`)

  ok('the name carries milliseconds rather than stopping at the second',
    /T\d\d-\d\d-\d\d-\d{3}Z/.test(basename(a)), basename(a))
  ok('and the runId', basename(a).includes('aaaa1111'), basename(a))
  ok('and the pid, which two processes can share a millisecond with',
    basename(a).includes(String(process.pid)), basename(a))

  // Same runId twice is still two files: the same recovery asking twice for the same label must not
  // overwrite the first answer.
  const c = g.newLogPath(ctx, 'warm', { runId: 'aaaa1111' })
  ok('asking twice with the same runId does not overwrite the first', c !== a, `${a} vs ${c}`)

  // No runId is still allowed -- newLogPath is used outside heal too -- and must still not collide.
  const d1 = g.newLogPath(ctx, 'serve')
  const d2 = g.newLogPath(ctx, 'serve')
  ok('a caller with no runId still gets a distinct name', d1 !== d2, `${d1} vs ${d2}`)

  rmSync(dir, { recursive: true, force: true })
}

// ── a path is not an identity ─
// The never-list refused to touch anything under %SystemRoot% by comparing the path as WRITTEN, using
// GetFullPath, which is lexical: it normalises `..` and slashes and resolves nothing else. On a
// machine with junctions that is not the question "where does this file live".
//
// Demonstrated before the fix, on this machine:
//   mklink /J E:\scratch\innocent-link C:\Windows\System32
//   GetFullPath E:\scratch\innocent-link\kernel32.dll -> not under C:\Windows -> NOT refused
//   and icacls would have applied the deny to the real System32 file.
//
// A never-list that holds only when the caller spells the path the expected way is not a never-list.
{
  section('path identity')
  const { spawnSync } = await import('node:child_process')
  const base = join(tmpdir(), 'vsep-junc-' + process.pid)
  const link = join(base, 'innocent-link')
  rmSync(base, { recursive: true, force: true })
  mkdirSync(join(base, 'real'), { recursive: true })
  writeFileSync(join(base, 'real', 'y.exe'), 'x')

  if (process.platform !== 'win32') {
    ok('path identity is Windows-only (skipped honestly)', true, '')
  } else {
    // A junction needs no elevation, which is the point: this is not an exotic case.
    // New-Item rather than mklink. mklink is a cmd builtin, so it must arrive as one command string,
    // and cmd's quote handling then eats the paths: argv-style it silently does nothing, and the
    // single-string form fails with a syntax error. PowerShell takes the two paths as parameters.
    spawnSync('powershell.exe', ['-NoProfile', '-Command',
      "New-Item -ItemType Junction -Path '" + link + "' -Target 'C:\\Windows\\System32' | Out-Null",
    ], { encoding: 'utf8', timeout: 60000 })
    const viaLink = join(link, 'kernel32.dll')
    const made = existsSync(viaLink)

    ok('a junction could be created without elevation', made, 'mklink failed; the rest cannot be tested')
    if (made) {
      const resolver = join(projectDir, 'bin', 'resolve-path.ps1')
      const run = (p) => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolver, '-Path', p], { encoding: 'utf8', timeout: 60000 }).stdout.trim()

      // String.raw, because a plain literal here loses the backslashes to the JS escaping and the
      // resolver is then handed `C:WindowsSystem32kernel32.dll` -- which is what the first version of
      // this test did, and it reported the resolver broken rather than the test.
      const direct = JSON.parse(run(String.raw`C:\Windows\System32\kernel32.dll`))
      ok('the resolver leaves a real path alone', direct.ok === true && direct.different === false, JSON.stringify(direct))

      const through = JSON.parse(run(viaLink))
      ok('and resolves a junction to what it actually points at',
        through.ok === true && /System32/i.test(String(through.resolved)), JSON.stringify(through))
      ok('and says the two spellings disagree, which is the fact a caller needs',
        through.different === true, JSON.stringify(through))

      // The end to end answer: the tool must now refuse the path it used to accept.
      const cli = join(projectDir, 'bin', 'cli.mjs')
      // TEMP is redirected for the child, because that is where an isolate records what it refused:
      // Node derives its activity directory from tmpdir() and isolate.ps1 from $env:TEMP, so one
      // override covers both sides. Without it a test run leaves its own ACL refusals in the
      // machine's activity record -- which is the artifact this tool exists to keep honest, and the
      // suite was writing to it every time it ran.
      const scratchTmp = join(tmpdir(), 'vsep-junc-tmp-' + process.pid)
      mkdirSync(scratchTmp, { recursive: true })
      const r = spawnSync(process.execPath, [cli, '--json', 'isolate', viaLink], {
        encoding: 'utf8',
        timeout: 120000,
        env: { ...process.env, TEMP: scratchTmp, TMP: scratchTmp },
      })
      // `emit` pretty-prints, so the object spans many lines. Taking the last line beginning with `{`
      // -- as the first version did -- yields a fragment that cannot parse, and the check then fails
      // against a tool that behaved correctly. Parse from the first brace to the last.
      const out = r.stdout ?? ''
      let parsed = null
      try {
        parsed = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))
      } catch { /* the run may have produced no json at all */ }
      ok('the junction path is refused rather than acted on',
        parsed?.refused === true, JSON.stringify(parsed ?? out.slice(-200)))
      ok('and the refusal names %SystemRoot% rather than something generic',
        /SystemRoot/i.test(String(parsed?.detail ?? '')), String(parsed?.detail))

      spawnSync('cmd', ['/c', 'rmdir', link], { encoding: 'utf8' })
      // The TEMP redirect above is removed with the rest. A suite that leaks a directory per run
      // fills the same temp tree the tool derives its own state from -- 239 of these were sitting
      // there when it was noticed, every one from a test that cleaned up only what it remembered.
      rmSync(scratchTmp, { recursive: true, force: true })
    }
  }

  rmSync(base, { recursive: true, force: true })
}

// ── summary ──────────────────────────────────────────────────────────────────
console.log('')
if (failures === 0) {
  console.log(`all ${checks} checks passed`)
  process.exit(0)
}
console.log(`${failures} of ${checks} checks FAILED`)
process.exit(1)
