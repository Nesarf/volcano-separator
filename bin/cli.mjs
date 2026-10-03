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
    else if (a === '--require-dsh') opts['require-dsh'] = true
    else if (a === '--no-activity') opts['no-activity'] = true
    else if (a === '--no-custody') opts['no-custody'] = true
    else if (a === '--no-suspend') opts['no-suspend'] = true
    else if (a === '--no-topmost') opts['no-topmost'] = true
    else if (a === '--show') opts.show = true
    else if (a === '--all') opts.all = true
    else if (a === '--stops') opts.stops = true
    else if (a === '--help' || a === '-h') opts.help = true
    else if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      // A bare switch must not swallow the following argument: `detain 123 --no-custody`
      // previously consumed nothing and silently left custody ON, so the flag did the
      // opposite of what it said.
      if (next === undefined || next.startsWith('-')) {
        opts[key] = true
      } else {
        opts[key] = argv[++i]
      }
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
  activity [n]       the system-wide process/window/persistence record (default last 40)
  reveal windows [--show] [--all] [--filter re]   every top-level window; --show forces hidden ones visible
  reveal process <pid>                            everything observable about a live process
  reveal chain <pid>                              inherited chain, recovered from history
  policy [show|allow <e>|deny <e>|mode <m>]        what stealth is permitted, and what happens to the rest
  detain <pid> [--reason "..."] [--no-suspend]     freeze it, force its windows open, open a custody window
  release <pid>                                   resume a detained process
  ps                 what is running right now, with ages (spots a wedged process)
  logs [n]           the last n uv transcripts, plus the heartbeat trail
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
  --require-dsh      do nothing unless a DSH host is running (the heartbeat uses this, so the
                     task can never become a boot auto-start for the daemon)
  --no-activity      install-service: skip the system-wide activity recorder
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
      const t0 = Date.now()
      const r = await g.heal(ctx, { log, force: opts.force, requireDsh: opts['require-dsh'] === true })

      // Always leave a trace, even in heartbeat mode. A task that starts, does something and
      // closes without writing a single byte is indistinguishable from one that crashed -- and
      // "I cannot tell what it did" is its own failure mode.
      const verdict = r.skipped
        ? `skipped(${r.reason})`
        : r.ok
          ? r.fastPath
            ? 'healthy'
            : 'repaired'
          : `FAILED@${r.failedAt}`
      try {
        const { appendFileSync, mkdirSync } = await import('node:fs')
        mkdirSync(ctx.logDir, { recursive: true })
        appendFileSync(
          join(ctx.logDir, 'heartbeat.log'),
          `${new Date().toISOString()}  ${verdict.padEnd(18)} ${String(Date.now() - t0).padStart(6)}ms  ` +
            `uv=${ctx.uvx ? 'y' : 'n'} profile=${ctx.profile} ` +
            `${r.steps?.length ? '| ' + r.steps.map((s) => s.step).join('>') : ''}\n`,
        )
      } catch {
        /* logging must never break the run */
      }

      if (opts.quiet) {
        if (!r.ok) console.error(`volcano-separator: heal failed at ${r.failedAt} -- ${r.steps.at(-1)?.detail ?? ''}`)
      } else {
        emit(r, `${r.ok ? C.green('ok') : C.red('FAIL')} heal: ${verdict}`)
        for (const s of r.steps ?? []) if (s.logFile) console.log(C.dim(`   ${s.step} transcript: ${s.logFile}`))
      }
      process.exit(r.ok ? 0 : 1)
    }

    case 'ps': {
      const [procs, db, daemon, svc, rec] = await Promise.all([
        g.liveProcesses(ctx),
        g.probePostgres(ctx),
        g.probeDaemon(ctx),
        g.serviceState(ctx),
        g.probeActivityRecorder(ctx),
      ])
      if (opts.json) return emit({ procs, db, daemon, svc, recorder: rec })
      console.log('what is running right now')
      console.log('')
      console.log(`  database   ${db.ok ? C.green('up  ') : C.red('DOWN')}  ${db.detail}`)
      console.log(`  daemon     ${daemon.ok ? C.green('up  ') : C.red('DOWN')}  ${daemon.detail}`)
      console.log(`  watchdog   ${svc.installed ? C.green('on  ') : C.yellow('off ')}  ${svc.installed ? `${svc.state}, last ${svc.lastRun} -> ${svc.lastResult}` : 'not installed'}`)
      console.log(`  recorder   ${rec.ok ? C.green('on  ') : C.yellow('off ')}  ${rec.detail}`)
      console.log('')
      if (procs.length === 0) console.log(C.dim('  no stack processes'))
      for (const p of procs) {
        const age = p.ageSeconds
        // Age is the signal: a uvx alive for minutes is either working or wedged.
        // Long-lived servers are long-lived; only launchers can be "stuck".
        const isServer = /postgres|hindsight-api/i.test(p.name)
        const flag = isServer ? '      ' : age > 240 ? C.red('STUCK?') : age > 60 ? C.yellow('busy  ') : '      '
        console.log(`  ${flag} ${String(p.name).padEnd(17)} pid=${String(p.pid).padEnd(7)} ${String(age + 's').padStart(8)}  ${C.dim(p.cmd)}`)
      }
      console.log('')
      console.log(C.dim(`  transcripts: ${ctx.logDir}`))
      process.exit(0)
    }

    case 'logs': {
      const limit = Number(opts._[1] ?? 3)
      const r = g.readLogs(ctx, {
        limit: Number.isFinite(limit) ? limit : 3,
        tailLines: opts.lines ? Number(opts.lines) : 25,
      })
      if (opts.json) return emit(r)
      console.log(`transcripts in ${r.dir}`)
      console.log('')
      if (r.heartbeat) {
        console.log(C.dim(`  --- heartbeat.log (last ${r.heartbeat.lines.length}) ---`))
        for (const l of r.heartbeat.lines) console.log('  ' + l)
        console.log('')
      }
      if (r.transcripts.length === 0) console.log(C.dim('  (no uv transcripts yet)'))
      for (const t of r.transcripts) {
        console.log(C.dim(`  --- ${t.name}  (${t.size} bytes, ${t.modified}) ---`))
        for (const l of t.tail) console.log('  ' + l)
        console.log('')
      }
      break
    }

    case 'activity': {
      const limit = Number(opts._[1] ?? 40)
      const r = g.readActivity(ctx, {
        limit: Number.isFinite(limit) ? limit : 40,
        kind: opts.kind ?? null,
        grep: opts.grep ?? null,
        files: opts.files ? Number(opts.files) : 2,
      })
      if (opts.json) return emit(r)
      console.log(`activity record: ${r.dir}`)
      console.log(C.dim(`  ${r.total} events in the window shown${r.kind || opts.kind ? '' : ''}`))
      console.log('')
      if (r.events.length === 0) {
        console.log(C.dim('  (nothing recorded -- is the recorder installed? run: volcano-separator install-service)'))
      }
      for (const e of r.events) {
        const when = String(e.t ?? '').replace('T', ' ').slice(0, 19)
        if (e.kind === 'proc-start') {
          console.log(`  ${when}  ${C.green('START')}  ${String(e.name).padEnd(18)} pid=${String(e.pid).padEnd(7)} ${C.dim((e.cmd || '').slice(0, 110))}`)
        } else if (e.kind === 'window') {
          console.log(`  ${when}  ${C.yellow('WINDOW')} ${String(e.name).padEnd(18)} pid=${String(e.pid).padEnd(7)} ${C.dim("'" + String(e.title).slice(0, 90) + "'")}`)
        } else if (e.kind === 'persist') {
          const mark = e.action === 'added' ? C.red('PERSIST+') : e.action === 'removed' ? C.dim('PERSIST-') : C.yellow('PERSIST~')
          console.log(`  ${when}  ${mark} ${String(e.surface).padEnd(14)} ${e.name}`)
          console.log(`  ${' '.repeat(21)}${C.dim(String(e.value).slice(0, 120))}`)
        } else if (e.kind === 'proc-stop') {
          if (opts.stops) console.log(`  ${when}  ${C.dim('STOP ')}  ${String(e.name).padEnd(18)} pid=${e.pid}`)
        } else {
          console.log(`  ${when}  ${C.dim(String(e.kind).toUpperCase().padEnd(7))} ${C.dim(JSON.stringify(e).slice(0, 120))}`)
        }
      }
      console.log('')
      console.log(C.dim('  filter: --kind proc-start|window|persist   --grep <regex>   --stops to include exits'))
      break
    }

    case 'reveal': {
      const sub = opts._[1] ?? 'windows'
      if (sub === 'chain') {
        const pid = Number(opts._[2] ?? opts.pid ?? 0)
        const r = g.ancestry(ctx, pid)
        if (opts.json) return emit(r)
        console.log(`inherited chain for pid ${pid}  (${r.depth} links, ${r.recorded} starts on record)`)
        console.log('')
        for (const l of r.chain) {
          console.log(`  ${String(l.started ?? '').slice(0, 19)}  pid=${String(l.pid).padEnd(7)} <- ppid=${String(l.ppid).padEnd(7)} ${l.name}`)
          console.log(`  ${' '.repeat(21)}${C.dim((l.cmd || '').slice(0, 120))}`)
        }
        console.log('')
        console.log(C.dim('  parents that already exited are recovered from the activity record'))
        break
      }
      const r = await g.reveal(ctx, {
        mode: sub === 'process' ? 'process' : 'windows',
        pid: Number(opts._[2] ?? opts.pid ?? 0),
        filter: opts.filter ?? '',
        show: opts.show === true,
        includeInvisible: opts.all === true,
      })
      if (opts.json) return emit(r)
      if (!r.ok) { console.log(C.red('FAIL') + ' reveal: ' + r.detail); process.exit(1) }
      const rows = Array.isArray(r.data) ? r.data : [r.data]
      if (sub === 'process') {
        const d = rows[0]
        console.log(`process ${d.name} (pid ${d.pid}, parent ${d.ppid})`)
        console.log(`  owner     ${d.owner}`)
        console.log(`  started   ${d.started}`)
        console.log(`  exe       ${d.exe}`)
        console.log(`  cmd       ${d.cmd}`)
        if (d.connections?.length) {
          console.log('  network')
          for (const cn of d.connections) console.log(`    ${cn.state.padEnd(12)} ${cn.local} -> ${cn.remote}`)
        }
        if (d.windows?.length) {
          console.log('  windows')
          for (const w of d.windows) console.log(`    ${w.visible ? 'visible' : C.yellow('HIDDEN ')} ${w.class}  '${w.title}'`)
        }
        if (d.modules?.length) console.log(`  modules   ${d.modules.length} shown, first: ${d.modules[0]}`)
        break
      }
      const hidden = rows.filter((w) => !w.visible)
      console.log(`${rows.length} top-level windows, ${hidden.length} hidden${r.data && r.data.forced !== undefined ? '' : ''}`)
      console.log('')
      for (const w of rows) {
        const tag = w.visible ? C.green('visible') : w.forced ? C.yellow('REVEALED') : C.red('HIDDEN  ')
        console.log(`  ${tag} pid=${String(w.pid).padEnd(7)} ${String(w.process).padEnd(20)} ${C.dim(w.class)}  '${String(w.title).slice(0, 70)}'`)
      }
      if (!opts.show && hidden.length) {
        console.log('')
        console.log(C.dim('  add --show to force the hidden ones visible (existing windows only)'))
      }
      break
    }

    case 'policy': {
      const sub = opts._[1] ?? 'show'
      const pol = g.loadPolicy(ctx)
      if (sub === 'mode') {
        const m = opts._[2]
        if (!['observe', 'suspend', 'reject'].includes(m)) {
          console.error('usage: volcano-separator policy mode <observe|suspend|reject>')
          process.exit(2)
        }
        pol.mode = m
        const w = g.savePolicy(ctx, pol)
        console.log(`${w.ok ? C.green('ok') : C.red('FAIL')} mode -> ${m}${m === 'reject' ? C.red('  (unpermitted stealth will be TERMINATED)') : ''}`)
        process.exit(w.ok ? 0 : 1)
      }
      if (sub === 'allow' || sub === 'deny') {
        const entry = opts._[2]
        if (!entry) { console.error('usage: volcano-separator policy allow <name:foo.exe|path:c:/dir/>'); process.exit(2) }
        const norm = entry.toLowerCase()
        const cur = new Set(pol.allow ?? [])
        if (sub === 'allow') cur.add(norm)
        else cur.delete(norm)
        pol.allow = [...cur]
        const w = g.savePolicy(ctx, pol)
        console.log(`${w.ok ? C.green('ok') : C.red('FAIL')} ${sub} ${norm} (${pol.allow.length} entries)`)
        process.exit(w.ok ? 0 : 1)
      }
      const st = g.readStealth(ctx, { limit: 15 })
      if (opts.json) return emit({ ...pol, stealth: st })
      console.log(`policy: ${pol.file}`)
      console.log('')
      console.log(`  mode         ${pol.mode === 'observe' ? C.green(pol.mode) : C.red(pol.mode)}`)
      console.log(`  grace        ${pol.graceSeconds}s (a window hidden for less than this is not stealth)`)
      console.log(`  allow        ${pol.allow.length} entries`)
      for (const a of pol.allow) console.log(`     ${a}`)
      console.log('')
      console.log(`  stealth findings on record: ${st.total}`)
      for (const e of st.events.slice(-10)) {
        console.log(`     ${String(e.t).replace('T', ' ').slice(0, 19)}  ${String(e.action ?? 'observed').padEnd(9)} ${e.name} pid=${e.pid} ${C.dim(String(e.why ?? '').slice(0, 70))}`)
      }
      break
    }

    case 'detain': {
      const pid = Number(opts._[1] ?? opts.pid ?? 0)
      const r = await g.detain(ctx, {
        pid,
        suspend: opts['no-suspend'] !== true,
        custody: opts['no-custody'] !== true,
        topmost: opts['no-topmost'] !== true,
        reason: opts.reason ?? '',
      })
      if (opts.json) return emit(r)
      if (!r.ok) { console.log(C.red('FAIL') + ' detain: ' + r.detail); process.exit(1) }
      console.log(`${C.green('ok')} detained ${r.name} (pid ${r.pid})`)
      console.log(`  frozen          ${r.suspended ? C.green('yes') + ' -- it cannot close, hide or change anything' : C.yellow('no') + ' -- only observed'}`)
      console.log(`  windows found   ${r.windows} (forced visible: ${r.forcedVisible})`)
      console.log(`  custody window  ${r.custody ? 'open -- it belongs to us, the target cannot close it' : 'not opened'}`)
      console.log('')
      console.log(C.dim('  the window offers ALLOW (records your decision) or RELEASE (just resumes it)'))
      break
    }

    case 'release': {
      const pid = Number(opts._[1] ?? opts.pid ?? 0)
      const r = await g.detain(ctx, { pid, release: true })
      if (opts.json) return emit(r)
      console.log(`${r.ok ? C.green('ok') : C.red('FAIL')} release: ${r.ok ? `resumed pid ${r.pid}` : r.detail}`)
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
      // Transparency is a default, not an opt-in: installing the supervisor installs the
      // system-wide activity recorder with it. --no-activity opts out.
      let act = null
      if (r.ok && opts['no-activity'] !== true) {
        act = await g.installActivityTask(ctx, { projectDir, dryRun: opts.dryRun })
      }
      if (opts.json) return emit(r)
      console.log(`${r.ok ? C.green('ok') : C.red('FAIL')} install-service: ${r.detail}`)
      if (act) console.log(`${act.ok ? C.green('ok') : C.red('FAIL')} activity recorder: ${act.detail}`)
      if (!r.ok && r.tail) console.log(C.dim(r.tail))
      if (r.dryRun && r.script) console.log(C.dim(r.script))
      process.exit(r.ok ? 0 : 1)
    }

    case 'uninstall-service': {
      const a = await g.uninstallActivityTask(ctx)
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
