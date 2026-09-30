#!/usr/bin/env node
/**
 * volcano-separator CLI
 *
 *   volcano-separator status            whole-chain check (uv / env warmth / daemon / database / watchdog)
 *   volcano-separator heal              intelligent repair: warm -> serve -> watch
 *   volcano-separator warm [--force]    warm the env only (no watchdog)
 *   volcano-separator serve             start the service only (env must be hot)
 *   volcano-separator stop|restart
 *   volcano-separator doctor            count historical start failures from the plugin log
 *   volcano-separator guard <op>        check whether a uv cache operation is safe (clean / prune)
 *   volcano-separator install-service   register the watchdog task (at logon + every N minutes)
 *   volcano-separator uninstall-service
 *   volcano-separator service           show the watchdog task state
 *
 * Global options: --profile <name>  --port <n>  --json  --quiet  --project <dir>
 */

import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import * as g from '../lib/core.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const PROJECT_DIR = resolve(here, '..')

function parseArgs(argv) {
  const opts = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') opts.json = true
    else if (a === '--quiet' || a === '-q') opts.quiet = true
    else if (a === '--force' || a === '-f') opts.force = true
    else if (a === '--dry-run') opts.dryRun = true
    else if (a === '--help' || a === '-h') opts.help = true
    else if (a.startsWith('--')) {
      const key = a.slice(2)
      const val = argv[++i]
      opts[key] = val
    } else opts._.push(a)
  }
  return opts
}

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
}

const HELP = `volcano-separator -- keeps uv / daemon / hindsight from being one fragile chain

Usage: volcano-separator <command> [options]

Commands:
  status             whole-chain check (uv / env warmth / daemon / database / watchdog task)
  heal               intelligent repair: warm -> serve -> watch.
                     A single TCP probe when healthy, so it is nearly free to run often.
  warm [--force]     warm the uv env only. **No watchdog**: it may take minutes.
  serve              start the service only (seconds once the env is hot)
  stop | restart
  doctor             count historical start failures from the plugin log
  guard <op>         check whether a uv cache operation is safe (op = clean | prune)
  install-service    register the watchdog task: at logon + every N minutes
  uninstall-service
  service            show the watchdog task state

Options:
  --profile <name>   hindsight profile (default: coding-agent)
  --port <n>         daemon port (default: 9077)
  --project <dir>    project directory (default: this repository)
  --json             machine-readable output
  --quiet            only report conclusions
  --force            ignore the "already warm / already healthy" checks
  --dry-run          for install-service: print what would happen
`

function logFactory(quiet) {
  return (msg) => {
    if (!quiet) console.log(C.dim('  . ') + msg)
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const cmd = opts._[0]

  if (!cmd || opts.help) {
    console.log(HELP)
    // An explicit --help is a success; being invoked with no command at all is a usage error.
    process.exit(opts.help ? 0 : 1)
  }

  const ctx = g.resolveContext({
    ...(opts.profile ? { profile: opts.profile } : {}),
    ...(opts.port ? { port: Number(opts.port) } : {}),
  })
  const projectDir = opts.project ? resolve(opts.project) : PROJECT_DIR
  const log = logFactory(opts.quiet)
  const emit = (obj, text) => {
    if (opts.json) console.log(JSON.stringify(obj, null, 2))
    else if (text) console.log(text)
  }

  switch (cmd) {
    case 'status': {
      const s = await g.status(ctx)
      const svc = await g.serviceState(ctx)
      if (opts.json) return emit({ ...s, service: svc })
      console.log(s.text)
      console.log(
        `  watchdog    : ${
          svc.installed
            ? `[ok  ] ${ctx.taskName} (${svc.state}, last ${svc.lastRun ?? '-'}, result ${svc.lastResult ?? '-'})`
            : `[FAIL] not installed -- run: volcano-separator install-service`
        }`,
      )
      console.log('')
      console.log(s.ok ? C.green('Whole chain healthy.') : C.red('Whole chain unhealthy -- run `volcano-separator heal`.'))
      process.exit(s.ok ? 0 : 1)
    }

    case 'warm': {
      const r = await g.warm(ctx, { force: opts.force, log })
      emit(r, `${r.ok ? C.green('ok') : C.red('FAIL')} warm: ${r.detail}`)
      process.exit(r.ok ? 0 : 1)
    }

    case 'serve': {
      const r = await g.serve(ctx, { log })
      emit(r, `${r.ok ? C.green('ok') : C.red('FAIL')} serve: ${r.detail}`)
      process.exit(r.ok ? 0 : 1)
    }

    case 'stop': {
      const r = await g.stop(ctx)
      if (opts.json) return emit(r)
      console.log(`${r.ok ? C.green('ok') : C.red('FAIL')} stop: ${r.detail}`)
      if (!r.ok && r.tail) console.log(C.dim(r.tail))
      process.exit(r.ok ? 0 : 1)
    }

    case 'restart': {
      const r = await g.restart(ctx, { log })
      emit(r, `${r.ok ? C.green('ok') : C.red('FAIL')} restart: ${r.detail}`)
      process.exit(r.ok ? 0 : 1)
    }

    case 'heal': {
      const r = await g.heal(ctx, { log, force: opts.force })
      if (opts.quiet) {
        // heartbeat mode: stay silent unless something is actually wrong
        if (!r.ok) console.error(`volcano-separator: heal failed at ${r.failedAt} -- ${r.steps.at(-1)?.detail ?? ''}`)
      } else {
        emit(r, `${r.ok ? C.green('ok') : C.red('FAIL')} heal: ${r.ok ? (r.fastPath ? 'healthy, nothing to do' : 'repaired') : `failed at ${r.failedAt}`}`)
      }
      process.exit(r.ok ? 0 : 1)
    }

    case 'doctor': {
      const d = await g.doctor(ctx)
      if (opts.json) return emit(d)
      console.log('volcano-separator doctor -- historical start failures')
      console.log('')
      console.log('  plugin logs: ' + (d.logs.join('\n               ') || '(none found)'))
      console.log('')
      console.log('  ' + d.verdict)
      console.log('')
      for (const e of d.events.slice(-25)) {
        const mark = e.kind === 'timeout' ? C.red('TIMEOUT') : e.kind === 'success' ? C.green('OK     ') : 'start  '
        console.log(`  ${e.ts ?? '?'}  ${mark}`)
      }
      console.log('')
      console.log(C.dim('  What the timeouts share: the start path carried a download/build while the'))
      console.log(C.dim('  watchdog allowed only ~180 s. Staging (warm with no watchdog -> serve in'))
      console.log(C.dim('  seconds -> watch heartbeat) is what targets exactly that.'))
      break
    }

    case 'guard': {
      const op = opts._[1]
      if (!op) {
        console.error('usage: volcano-separator guard <clean|prune>')
        process.exit(2)
      }
      const r = await g.guardCacheOp(ctx, op)
      emit(r, `${r.safe ? C.green('safe') : C.yellow('UNSAFE')}: ${r.detail}${r.remedy ? `\n\n  ${r.remedy}` : ''}`)
      process.exit(r.safe ? 0 : 1)
    }

    case 'install-service': {
      const r = await g.installService(ctx, { projectDir, dryRun: opts.dryRun })
      if (opts.json) return emit(r)
      console.log(`${r.ok ? C.green('ok') : C.red('FAIL')} install-service: ${r.detail}`)
      if (!r.ok && r.tail) console.log(C.dim(r.tail))
      if (r.dryRun && r.script) console.log(C.dim(r.script))
      process.exit(r.ok ? 0 : 1)
    }

    case 'uninstall-service': {
      const r = await g.uninstallService(ctx)
      emit(r, `${r.ok ? C.green('ok') : C.red('FAIL')} uninstall-service: ${r.detail}`)
      process.exit(r.ok ? 0 : 1)
    }

    case 'service': {
      const r = await g.serviceState(ctx)
      emit(
        r,
        r.installed
          ? `scheduled task ${ctx.taskName}: ${r.state}, last ${r.lastRun}, result ${r.lastResult}, next ${r.nextRun}`
          : `scheduled task ${ctx.taskName} is not installed`,
      )
      process.exit(0)
    }

    default:
      console.error(`unknown command: ${cmd}\n`)
      console.log(HELP)
      process.exit(2)
  }
}

main().catch((e) => {
  console.error('volcano-separator error: ' + (e?.stack ?? e))
  process.exit(1)
})
