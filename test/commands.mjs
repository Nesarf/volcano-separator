#!/usr/bin/env node
/**
 * Every CLI command, run for real, once.
 *
 * Why this exists next to test/smoke.mjs
 * --------------------------------------
 * The smoke suite checks behaviour: it asserts what the probes answer, that they degrade instead of
 * throwing, that the redaction rules agree with their second implementation. It does not check that
 * every command is still *reachable*, and that is the thing a large refactor breaks. Splitting
 * core.mjs moved three thousand lines between files; a command whose handler lost an import, or a
 * function that stopped being re-exported, fails in exactly the way a behaviour test cannot see --
 * the tests call the functions that survived.
 *
 * So this does the crude thing instead. It runs each command and looks at the exit code.
 *
 * The commands that change the machine are not here
 * -------------------------------------------------
 * stop, restart, warm --force, serve, detain, release, install-service and uninstall-service are
 * deliberately absent. This script is meant to be safe to run on a working machine at any time, so
 * it only exercises commands that read. `guard clean` is included *because* it must refuse while
 * the daemon is running: exit 1 there is the correct answer, not a failure, and the expectation is
 * written per command rather than assumed.
 *
 * Run:  node test/commands.mjs
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'bin', 'cli.mjs')

// `want` is the set of exit codes that mean this command worked. Three is a real answer for defer
// -- "not now" is not a failure -- and guard refuses on purpose when the service is up.
const COMMANDS = [
  ['status', { args: ['status'], want: [0] }],
  ['activity', { args: ['activity', '5'], want: [0] }],
  ['busy', { args: ['busy', '30'], want: [0] }],
  ['ps', { args: ['ps'], want: [0] }],
  ['logs', { args: ['logs', '3'], want: [0] }],
  ['doctor', { args: ['doctor'], want: [0] }],
  ['resources', { args: ['resources'], want: [0, 3] }],
  ['defer', { args: ['defer'], want: [0, 3] }],
  ['signals', { args: ['signals', '30'], want: [0] }],
  ['decide', { args: ['decide', '30'], want: [0] }],
  ['policy show', { args: ['policy', 'show'], want: [0] }],
  ['detained', { args: ['detained'], want: [0] }],
  // The three "what has this tool done" listings. `isolated` and `encrypted` were never in this list
  // even though they are read-only and run fine with no arguments -- which is the omission this file
  // exists to catch. `vaulted` covers every store on the machine, so it is safe by construction.
  ['isolated', { args: ['isolated'], want: [0] }],
  ['encrypted', { args: ['encrypted'], want: [0] }],
  ['vaulted', { args: ['vaulted'], want: [0] }],
  ['chamber (bad pid)', { args: ['chamber', 'not-a-pid'], want: [2] }],
  // The repair sequence belongs to one service. Pointed at a service that declares none, the three
  // verbs must refuse -- and refuse as a distinct outcome, not as a failure and not as success.
  // Exit 3 already means "a real answer that is not 0", which is exactly what this is.
  ['warm (other service)', { args: ['warm', '--service', 'dsh'], want: [3] }],
  ['serve (other service)', { args: ['serve', '--service', 'dsh'], want: [3] }],
  ['heal (other service)', { args: ['heal', '--service', 'dsh'], want: [3] }],
  // A descriptor that does not exist is an error, not a refusal: nothing can be said about a service
  // this tool has never heard of, and pretending otherwise would be a silent fallback.
  ['warm (unknown service)', { args: ['warm', '--service', 'no-such-service'], want: [1] }],
  // And the service that does declare a sequence still works.
  ['warm (own service)', { args: ['warm'], want: [0] }],
  ['entity (bad kind)', { args: ['entity', 'socket', 'x'], want: [2] }],
  ['entity (pid)', { args: ['entity', 'pid', String(process.pid)], want: [0] }],
  ['chamber (gone pid)', { args: ['chamber', '999999'], want: [0] }],
  ['timeline', { args: ['timeline'], want: [0] }],
  ['service', { args: ['service'], want: [0] }],
  ['cache', { args: ['cache'], want: [0] }],
  ['reveal windows', { args: ['reveal', 'windows'], want: [0] }],
  ['redline', { args: ['redline', '5'], want: [0] }],
  ['guard clean', { args: ['guard', 'clean'], want: [0, 1] }],
  ['--json status', { args: ['--json', 'status'], want: [0] }],
  ['--json busy', { args: ['--json', 'busy', '30'], want: [0] }],
  ['unknown command', { args: ['definitely-not-a-command'], want: [2] }],
]

let failed = 0
for (const [label, { args, want }] of COMMANDS) {
  const started = Date.now()
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 300000 })
  const rc = r.status
  const good = want.includes(rc)
  if (!good) failed++
  const first = (r.stdout + r.stderr).split(/\r?\n/).filter(Boolean)[0] ?? ''
  console.log(
    `  ${good ? 'ok  ' : 'FAIL'} ${label.padEnd(22)} rc=${String(rc).padEnd(3)} want=${want.join('/').padEnd(5)} ${String(Date.now() - started).padStart(6)}ms  ${first.slice(0, 60)}`,
  )
}

console.log(failed === 0 ? `\nall ${COMMANDS.length} commands answered` : `\n${failed} of ${COMMANDS.length} commands did not`)
process.exit(failed === 0 ? 0 : 1)
