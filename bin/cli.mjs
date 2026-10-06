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
 *   volcano-separator resources         headroom check: free memory, CPU, largest processes
 *   volcano-separator defer [--wait]    exit 0 when heavy work is safe to start, 3 when it is not
 *                                       --wait blocks until there is headroom (or --max-wait)
 *   volcano-separator install-service   register the watchdog task (at logon + every N minutes)
 *   volcano-separator uninstall-service
 *   volcano-separator service           show the watchdog task state
 *
 * Global options: --profile <name>  --port <n>  --json  --quiet  --project <dir>
 */

import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import * as g from '../lib/core.mjs'
import * as res from '../lib/resources.mjs'
import * as uvc from '../lib/uvcache.mjs'
import * as enf from '../lib/enforce.mjs'
import * as cry from '../lib/crypt.mjs'

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
    else if (a === '--signals') opts.signals = true
    else if (a === '--redline') opts.redline = true
    else if (a === '--custody') opts.custody = true
    else if (a === '--record') opts.record = true
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
  status [--deep]    whole-chain check (uv / daemon / database / watchdog task).
                     Warmth is left unmeasured unless --deep: the uvx dry run that measures it
                     creates a uvx environment, so plain status is safe to run freely.
  heal               intelligent repair: warm -> serve -> watch.
                     A single TCP probe when healthy, so it is nearly free to run often.
  warm [--force]     warm the uv env only. **No watchdog**: it may take minutes.
  serve              start the service only (seconds once the env is hot)
  stop | restart
  activity [n]       the system-wide process/window/persistence record (default last 40)
  busy [minutes]     what has actually been running, grouped (runs, location, allowlist)
  redline [seconds]  what is sitting on C: in user-writable space (--record keeps findings)
  cache [--prune] [--apply] [--keep N]   uv cache hygiene: duplicates, old versions, idle environments
                     --prune shows the plan and stores it; --apply carries out exactly that plan
                     (--plan-id <id> to run an older one; a plan whose targets have changed or gone
                     is left alone and named)
  (heal --custody     also reconcile custody: a suspension is persistent, so a freeze nobody
                      came back for stays frozen; the alert names the release command)
  signals [minutes]  what looks like stealth, with evidence (observe-only)
  decide [minutes]   what would be done about each signal -- still acts on nothing (--record keeps open questions)
  reveal windows [--show] [--all] [--filter re]   every top-level window; --show forces hidden ones visible
  reveal process <pid>                            everything observable about a live process
  reveal chain <pid>                              inherited chain, recovered from history
  policy [show|allow <e>|deny <e>|mode <m>]        what stealth is permitted, and what happens to the rest
  detain <pid> [--reason "..."] [--no-suspend]     freeze it, force its windows open, open a custody window
  isolate <path|pid> [--dry-run] [--include-system-root]
                     deny a file the right to execute, reversibly. Prints the icacls command that
                     undoes it, which works even if this tool is gone. A lock on a file does not
                     reach into a process already running from it -- use detain for those.
  restore <journal>  put an isolated file's original ACL back
  isolated           what this tool has isolated and not undone
  encrypt <path> [--dry-run]
                     encrypt a file in place. Refuses if it is in use, writes the key before touching
                     anything, and proves the ciphertext decrypts back to the original bytes BEFORE
                     replacing them. Rewrites the bytes, so any signature it carried no longer holds.
  decrypt <journal>  restore the original bytes, refusing if they do not match the recorded sha256
  encrypted          what this tool has encrypted, with the state read from the bytes
  evidence           what a mode other than observe would have done, per day, accumulated
  release <pid>                                   resume a detained process
  detained [--no-probe] [--no-scan]               what is under custody now, checked against the
                                                  live system, plus anything frozen with no
                                                  record at all (a suspension is persistent)
  timeline [--all] [--days N]                     the life of each custody decision: frozen,
                                                  what was done, how it ended, and what was
                                                  reported while it was live
  ps                 what is running right now, with ages (spots a wedged process)
  logs [n]           the last n uv transcripts, plus the heartbeat trail
  doctor             count historical start failures from the plugin log
  guard <op>         check whether a uv cache operation is safe (op = clean | prune)
  install-service    register the watchdog task: at logon + every N minutes
  uninstall-service
  service            show the watchdog task state
  resources [n]      free memory, CPU load and the largest processes with their command lines
  defer [--wait]     turn that into a verdict: exit 0 = go ahead, 3 = not now

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
      const s = await g.status(ctx, { deep: opts.deep === true })
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
      // Custody reconciliation, run BEFORE the service chain is touched. A suspension is
      // persistent, so a freeze nobody came back for stays frozen forever, and the only moment it
      // gets noticed is when somebody thinks to ask -- which is exactly what does not happen.
      //
      // It runs first on purpose: the recorder's contract is that visibility is not a function of
      // service health, and on a machine where uv is missing the chain fails at its first link. If
      // this ran after that, the alert would go silent on precisely the broken machines that need
      // watching. It resumes nothing; the alert names the command instead.
      let cus = null
      if (opts.custody) {
        try {
          const rec = await g.reconcileCustody(ctx)
          const rel = (rec.released ?? []).length
          cus = {
            alerted: rec.alerted,
            released: rel,
            forgotten: (rec.stale ?? []).length,
            unrecorded: (rec.unrecorded ?? []).length,
            detail: rec.detail,
            why: rec.why,
          }
        } catch (e) {
          // A custody failure must never make the service heartbeat look broken.
          cus = { error: String(e?.message ?? e) }
        }
      }

      const r = await g.heal(ctx, { log, force: opts.force, requireDsh: opts['require-dsh'] === true })

      // Always leave a trace, even in heartbeat mode. A task that starts, does something and
      // closes without writing a single byte is indistinguishable from one that crashed -- and
      // "I cannot tell what it did" is its own failure mode.
      // The heartbeat's second job: look at what happened since the last tick and record
      // anything that needs a human. Observe-only, bounded to a window wider than the interval,
      // and silent -- a five-minute task that prints is a five-minute nuisance.
      let sig = null
      if (opts.signals) {
        try {
          const d = g.decideSignals(ctx, { sinceMinutes: 6 })
          const rec = g.recordDecisions(ctx, d.decisions)
          // Spread, not a hand-written list of fields.
          //
          // The first version named three fields and omitted `actionable`, so `would:` would have
          // read 0 for ever -- a number that can only ever say "nothing would be acted on",
          // presented as the evidence a promotion decision gets made from. A count that cannot vary
          // is not a measurement, and it is the most convincing kind of wrong.
          //
          // Adding the missing field fixes that instance. Spreading fixes the class: a field added
          // to decideSignals now reaches the log because nothing has to remember to name it.
          sig = { ...d, ask: d.byVerdict.ask, fresh: rec.written }
          // Rolled up daily into a durable file, because the activity record lives under the log
          // directory -- which defaults to the system temp directory, where this machine's disk
          // hygiene tooling removes files after seven days with no exclusion list. Asking a rule to
          // prove itself over a longer window than its evidence survives fails quietly, and it fails
          // by showing FEWER findings, which reads as good news.
          g.rollUpEvidence(ctx, d, { newlyRecorded: rec.written })
        } catch (e) {
          // A signal-layer failure must never make the service heartbeat look broken.
          sig = { error: String(e?.message ?? e) }
        }
      }
      // The C: red-line check is automatic but not frequent: a full walk is seconds to tens of
      // seconds, which is not something to spend every five minutes. Twelve hours is often enough to
      // notice a new violation and rare enough to stay invisible.
      let rl = null
      if (opts.redline) {
        try {
          const { existsSync, readFileSync, writeFileSync, mkdirSync } = await import('node:fs')
          mkdirSync(ctx.logDir, { recursive: true })
          const stamp = join(ctx.logDir, 'redline.last')
          const last = existsSync(stamp) ? Number(readFileSync(stamp, 'utf8').trim()) : 0
          const dueMs = 12 * 60 * 60 * 1000
          if (Date.now() - last >= dueMs) {
            const scan = await g.scanRedline(ctx, { budgetMs: 30000, top: 15 })
            const rec = g.recordRedline(ctx, scan)
            writeFileSync(stamp, String(Date.now()), 'utf8')
            rl = { gb: scan.gb, flagged: scan.flagged.length, fresh: rec.written, truncated: scan.truncated }
          }
        } catch (e) {
          rl = { error: String(e?.message ?? e) }
        }
      }

      const verdict = r.skipped
        ? `skipped(${r.reason})`
        : r.deferred
          ? `deferred@${r.deferredAt}`
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
            `${r.steps?.length ? '| ' + r.steps.map((st) => st.step).join('>') : ''}` +
            // `?? 0` would make a missing field look like a measured zero, and this is exactly the
            // field where that matters: `would:` is the evidence a promotion decision gets made from,
            // and a count that can only ever say "nothing" is the most convincing kind of wrong. A
            // missing field says `?`, so the log itself reports that it does not know -- the same
            // rule the daemon's /health was fixed to follow.
            `${sig ? ' | signals=' + (sig.error ? 'ERROR' : 'ask:' + sig.ask + '/new:' + sig.fresh + '/would:' + (Number.isInteger(sig.actionable) ? sig.actionable : '?')) : ''}` +
            `${cus ? (cus.error
                ? ' | custody=ERROR'
                : ' | custody=' + (cus.released ? 'RELEASED(' + cus.released + ')'
                    : cus.alerted ? 'ALERT(forgotten:' + cus.forgotten + ',unrecorded:' + cus.unrecorded + ')'
                    : 'clear')) : ''}` +
            `${rl ? ' | cdisk=' + (rl.error ? 'ERROR' : rl.gb + 'GB/flagged:' + rl.flagged + '/new:' + rl.fresh) : ''}` +
            '\n',
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
      if (rec.health?.known) {
        const h = rec.health
        const n0 = (v) => (Number.isFinite(v) ? String(v) : '?')
        const lost = h.eventsDropped > 0 ? C.red(`${h.eventsDropped} lost`) : `${n0(h.eventsDropped)} lost`
        const errs = h.handlerErrors > 0 ? C.red(`${h.handlerErrors} handler error(s)`) : `${n0(h.handlerErrors)} handler error(s)`
        // An equation that does not hold is worse than no equation. `written` also counts rows from
        // outside the event stream (the watcher's own start, the baseline), so asserting that the
        // parts sum to `seen` -- as an earlier version did -- printed arithmetic that was visibly
        // wrong. The counters are listed, not made to add up.
        // A field a slightly older recorder does not publish reads as `?`, not as `undefined`: a
        // missing number and a zero are different answers, which is the rule the heartbeat's
        // counterfactual was fixed to follow.
        const n = n0
        console.log(C.dim(`             pid ${h.pid}, up ${h.uptimeSeconds}s, ${h.passes} pass(es); ` +
          `events: ${n(h.eventsSeen)} seen, ${n(h.eventsDuplicate)} repeat(s), ${n(h.eventsSelf)} own, ` +
          `${n(h.eventsAccepted)} distinct -> ${n(h.eventsWritten)} row(s) written; ${lost}, ${errs}`))
        if (h.lockNote) console.log(C.yellow(`             ${h.lockNote}`))
      } else if (rec.health) {
        console.log(C.dim(`             ${rec.health.detail}`))
      }
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
        const why = !r.recorderRunning
          ? 'nothing recorded and no record file -- the recorder is not installed (run: volcano-separator install-service)'
          : !r.readable
            ? `the recorder is running but ${r.readFailures} file(s) could not be read -- most likely another instance is holding them`
            : 'the record file is there but empty for this window'
        console.log(C.yellow('  ' + why))
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
        // This used to print "(unpermitted stealth will be TERMINATED)" for reject. Nothing in this
        // tool terminates anything: `suspend` and `reject` are accepted here and implemented nowhere,
        // so the message promised an action the tool cannot take -- which is the exact kind of false
        // signal this project exists to remove. It now says what actually happens.
        const caveat = m === 'observe' ? '' : C.yellow('  (recorded; nothing acts on this mode yet -- see DESIGN-enforcement.md)')
        console.log(`${w.ok ? C.green('ok') : C.red('FAIL')} mode -> ${m}${caveat}`)
        // Stage 0: the moment a person flips the switch is the moment they should see what it
        // would have done. A number they have to go and look up is a number they will not look up,
        // and this is the only place the promotion decision is actually made.
        if (m !== 'observe') {
          const d = g.decideSignals(ctx, { sinceMinutes: 4320 })
          console.log('')
          // Not "would have <modeAction> N times": those are imperative phrases and the sentence
          // came out as "would have freeze the process 4 time(s)". Said the other way round it
          // reads correctly whatever the verb is.
          console.log(`  over the last 72 hours this mode would have acted ${C.yellow(String(d.actionable))} time(s), each time to ${g.modeAction(m)}`)
          console.log(C.dim(`  (${d.total} finding(s) seen, ${d.byVerdict.allow} already covered by the allowlist)`))
          console.log(C.dim('  nothing has been done about any of them, and nothing will be until a mode is read -- see DESIGN-enforcement.md'))
        }
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
      // A policy that could not be read is not the default policy. It used to be reported as
      // one: same output, same green, while the file on disk said something nobody had chosen.
      if (pol.integrity === 'invalid') {
        console.log('')
        console.log(C.red('  POLICY UNVERIFIED') + ' -- the file exists and could not be parsed')
        console.log(C.dim('    ' + String(pol.parseError ?? '').slice(0, 100)))
        console.log(C.dim('    everything below is the built-in default, not what this file says.'))
        console.log(C.dim('    the switch is not to observe because you chose it; it is observe because we could not read your choice.'))
      } else if (pol.integrity === 'absent') {
        console.log(C.dim('  no file yet: these are the built-in defaults'))
      }
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

    case 'isolate': {
      const target = opts._[1] ?? ''
      const asPid = Number(target)
      const r = await enf.isolate(ctx, {
        path: Number.isFinite(asPid) && asPid > 0 ? '' : target,
        pid: Number.isFinite(asPid) && asPid > 0 ? asPid : 0,
        dryRun: opts.dryRun === true,
        includeSystemRoot: opts['include-system-root'] === true,
      })
      if (opts.json) return emit(r)
      if (!r.ok) { console.log(C.red('FAIL') + ' isolate: ' + r.detail); process.exit(1) }
      if (r.dryRun) { console.log(`${C.yellow('dry-run')} would deny execute on ${r.path}`); break }
      if (r.alreadyIsolated) { console.log(`${C.green('ok')} already isolated: ${r.path}`); break }
      console.log(`${C.green('ok')} execute denied on ${r.path}`)
      console.log(`  backup      ${r.backupFile}`)
      if (r.stillRunning) console.log(`  ${C.yellow('note')}        ${r.note}`)
      console.log('')
      console.log('  undo without this tool, even if it is gone:')
      console.log(`    ${r.restoreCommand}`)
      console.log(C.dim('  or: volcano-separator restore ' + r.journalFile))
      break
    }

    case 'restore': {
      const j = opts._[1] ?? ''
      const r = await enf.restoreIsolation(ctx, { journal: j })
      if (opts.json) return emit(r)
      if (!r.ok) { console.log(C.red('FAIL') + ' restore: ' + r.detail); process.exit(1) }
      console.log(`${C.green('ok')} ${r.detail}`)
      console.log(`  ${r.path}`)
      break
    }

    case 'encrypt': {
      const t = opts._[1] ?? ''
      const r = await cry.encryptFile(ctx, { path: t, dryRun: opts.dryRun === true })
      if (opts.json) return emit(r)
      if (!r.ok) { console.log(C.red('FAIL') + ' encrypt: ' + r.detail); process.exit(1) }
      if (r.dryRun) { console.log(`${C.yellow('dry-run')} would encrypt ${r.path} (${r.bytes} bytes)`); break }
      if (r.alreadyEncrypted) { console.log(`${C.green('ok')} already a container: ${r.path}`); break }
      console.log(`${C.green('ok')} encrypted in place: ${r.path}`)
      console.log(`  ${r.bytes} -> ${r.encryptedBytes} bytes`)
      console.log(`  sha256     ${r.originalSha256}`)
      console.log(`  key        ${r.keyFile}${r.keyCreated ? C.yellow('  (created just now)') : ''}`)
      console.log(`  undo       ${r.decryptCommand}`)
      console.log('')
      console.log(C.yellow('  boundary   ') + 'encryption rewrites the bytes, so any hash or signature this file')
      console.log(C.dim('             carried no longer holds. The undo restores the exact bytes, and the'))
      console.log(C.dim('             journal records their sha256 so it can be checked rather than believed.'))
      break
    }

    case 'decrypt': {
      const j = opts._[1] ?? ''
      const r = await cry.decryptFile(ctx, { journal: j })
      if (opts.json) return emit(r)
      if (!r.ok) { console.log(C.red('FAIL') + ' decrypt: ' + r.detail); if (r.note) console.log(C.dim('  ' + r.note)); process.exit(1) }
      if (r.alreadyDecrypted) { console.log(`${C.green('ok')} nothing to undo: ${r.path}`); break }
      console.log(`${C.green('ok')} restored: ${r.path} (${r.bytes} bytes)`)
      console.log(`  ${r.detail}`)
      break
    }

    case 'encrypted': {
      const l = cry.encryptedFileList(ctx)
      if (opts.json) return emit(l)
      console.log(`encryption journals: ${l.dir}`)
      if (!l.entries.length) { console.log(C.dim('  (none)')); break }
      for (const e of l.entries) {
        console.log(`  ${String(e.state ?? '?').padEnd(13)} ${e.path}`)
        console.log(C.dim(`                ${e.journal}`))
      }
      break
    }

    case 'isolated': {
      const l = await enf.isolatedFiles(ctx)
      if (opts.json) return emit(l)
      console.log(`isolation journals: ${l.dir}`)
      if (!l.entries.length) { console.log(C.dim('  (none)')); break }
      for (const e of l.entries) {
        console.log(`  ${String(e.state ?? '?').padEnd(10)} ${e.path}`)
        console.log(C.dim(`             ${e.journal}`))
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

    case 'evidence': {
      const days = g.readEvidence(ctx)
      if (opts.json) return emit({ ok: true, days })
      if (!days.length) {
        console.log('no evidence yet: the heartbeat rolls up one line a day')
        console.log(C.dim('  it starts accumulating the first time the watchdog task runs with --signals'))
        break
      }
      console.log(`evidence for a promotion decision -- ${days.length} day(s)`)
      console.log('')
      const total = days.reduce((n, d) => n + (d.actionable ?? 0), 0)
      for (const d of days) {
        console.log(`  ${String(d.day).padEnd(12)} would act ${String(d.actionable ?? 0).padStart(4)}   (${d.total ?? 0} finding(s) in the last window, mode ${d.mode ?? '?'})`)
      }
      console.log('')
      console.log(`  ${total} time(s) in ${days.length} day(s) -- a mode other than observe would have acted that often`)
      console.log(C.dim('  DESIGN-enforcement.md will not promote a rule until this is a sample, not a number'))
      break
    }

    case 'timeline': {
      const t = await g.custodyTimelineLive(ctx, {
        sinceDays: opts.days ? Number(opts.days) : null,
        probeFn: opts['no-probe'] === true ? async () => ({}) : null,
      })
      if (opts.json) return emit(t)
      if (!t.ok) {
        console.log(C.yellow(`no custody record: ${t.reason}`))
        process.exit(0)
      }
      const open = t.open
      const closed = t.lifecycles.filter((l) => l.endedAt)
      console.log(`custody timeline  (${t.lifecycles.length} decision(s) across ${t.files} record file(s))`)
      const dist = Object.entries(t.byOutcome).map(([k, v]) => `${k}: ${v}`).join(', ')
      console.log(C.dim(`  ${dist}`))
      console.log()

      const showClosed = opts.all === true
      const list = showClosed ? t.lifecycles : [...open, ...closed.slice(-3)]

      for (const l of list) {
        const when = (l.frozenAt ?? '').replace('T', ' ').slice(0, 19)
        // An open decision means different things depending on whether the process still exists:
        // with no process there is nothing to release, and the record is history rather than a
        // to-do. Say which.
        const liveNote = l.liveState === 'process gone' ? C.dim(' (process gone -- nothing to release)')
          : l.liveState === 'still frozen' ? C.red(' (still frozen now)')
          : l.liveState === 'running' ? C.yellow(' (running again, unreleased)')
          : l.liveState === 'unknown' ? C.dim(' (live state unknown)') : ''
        const end = l.endedAt ? `  ended after ${g.humanDuration(l.durationMs)}`
                              : `  ${C.red('STILL OPEN')} for ${g.humanDuration(l.durationMs)}${liveNote}`
        const head = l.endedAt ? C.dim('closed') : C.red('open  ')
        console.log(`${head}  pid ${String(l.pid).padEnd(8)} ${l.name ?? ''}  ${when}`)
        console.log(`       ${l.outcome}${end}`)
        for (const e of l.entries.slice(1)) {
          console.log(`         ${(e.at ?? '').slice(11, 19)}  ${e.what}${e.detail ? ' -- ' + e.detail : ''}`)
        }
        for (const n of l.notices) {
          console.log(`         ${C.yellow((n.at ?? '').slice(11, 19) + '  ' + n.what)}`)
          console.log(`            ${C.dim((n.detail ?? '').slice(0, 110))}`)
        }
        if (l.command) console.log(`       ${C.dim(l.command.slice(0, 110))}`)
        console.log()
      }
      if (!showClosed && closed.length > 3) {
        console.log(C.dim(`  ${closed.length - 3} earlier closed decision(s) not shown; --all for everything`))
      }
      const actionable = open.filter((l) => l.liveState === 'still frozen' || l.liveState === 'running')
      if (open.length) {
        console.log(actionable.length
          ? C.red(`  ${actionable.length} open decision(s) still concern a live process.`)
          : C.dim(`  all ${open.length} open decision(s) concern processes that no longer exist: history, not a to-do.`))
        console.log()
      }
      if (!t.lifecycles.length) console.log(C.dim('  nothing recorded'))
      if (t.systemNotices.length) {
        console.log(C.dim(`  ${t.systemNotices.length} notice(s) not tied to a freeze`))
      }
      process.exit(0)
    }

    case 'detained': {
      const r = await g.custodyReport(ctx, { probe: opts['no-probe'] !== true })
      if (opts.json) return emit(r)
      if (!r.ok) {
        console.log(C.yellow(`no custody record: ${r.reason}`))
        process.exit(0)
      }
      console.log(`${r.rows.length} pid(s) in the record, ${r.events} event(s) across ${r.recordFiles} file(s)`)
      console.log()
      const label = {
        frozen: C.red('FROZEN      '),
        'frozen-after-release': C.red('STILL FROZEN'),
        'resumed-without-release': C.yellow('NOT FROZEN  '),
        'pid-reused': C.yellow('PID REUSED  '),
        resumed: C.dim('released    '),
        running: C.dim('not frozen  '),
        exited: C.dim('exited      '),
        unverified: C.dim('unverified  '),
      }
      for (const row of r.rows) {
        console.log(`  ${label[row.state] ?? row.state}  pid ${String(row.pid).padEnd(8)} ${row.name ?? ''}`)
        if (row.state === 'frozen' || row.state === 'frozen-after-release') {
          console.log(`      frozen at ${row.frozenAt ?? '?'} -- nothing released it`)
          console.log(`      release with: volcano-separator release ${row.pid}`)
        }
        if (row.state === 'resumed-without-release') {
          console.log('      a release was recorded but it did not take; the process is still running')
        }
        if (row.state === 'pid-reused') {
          console.log('      the process holding this pid is not the one that was frozen')
        }
      }
      // Frozen with no record of anybody freezing it. Walked separately because the loop above
      // enumerates the record, so anything absent from the record can never appear in it.
      if (opts['no-scan'] !== true) {
        try {
          const un = await g.unrecordedCustody(ctx)
          if (un.ok && un.unrecorded.length) {
            console.log()
            console.log(C.yellow(`${un.unrecorded.length} process(es) are frozen with no record of a detain:`))
            for (const u of un.unrecorded) {
              console.log(`  pid ${String(u.pid).padEnd(8)} ${u.name ?? ''}  (${u.why})`)
            }
            console.log('Nothing here knows who froze them or why. A debugger and a stalled driver')
            console.log('look the same from this side, so look before acting.')
          } else if (un.ok && un.denied) {
            console.log()
            console.log(C.dim(`${un.denied} process(es) could not be inspected, so this is not a clean sweep.`))
          }
        } catch (e) {
          console.log(C.dim(`unrecorded scan failed: ${e?.message ?? e}`))
        }
      }

      console.log()
      if (r.frozen.length) {
        console.log(C.red(`${r.frozen.length} process(es) are still frozen.`))
        console.log('A suspension is persistent: it stays frozen until something resumes it.')
      } else {
        console.log(C.green('nothing from the record is frozen now.'))
      }
      process.exit(0)
    }

    case 'release': {
      const pid = Number(opts._[1] ?? opts.pid ?? 0)
      const r = await g.detain(ctx, { pid, release: true })
      if (opts.json) return emit(r)
      console.log(`${r.ok ? C.green('ok') : C.red('FAIL')} release: ${r.ok ? `resumed pid ${r.pid}` : r.detail}`)
      process.exit(r.ok ? 0 : 1)
    }

    case 'signals': {
      const mins = Number(opts._[1] ?? 60)
      const r = g.analyzeSignals(ctx, { sinceMinutes: Number.isFinite(mins) ? mins : 60, limit: opts.all ? 500 : 40 })
      if (opts.json) return emit(r)
      console.log(`signals over the last ${r.window}  (${r.observed} recorded events examined)`)
      console.log('')
      console.log(`  findings   ${r.total}   (${r.allowed} already covered by the allowlist)`)
      console.log(`  by rule    ${Object.entries(r.byRule).map(([k, v]) => `${k}=${v}`).join('  ') || '(none)'}`)
      console.log(`  mode       ${r.mode}${r.mode === 'observe' ? C.green('  (this layer only notices)') : C.red('  (enforcement is ON)')}`)
      console.log('')
      for (const f of r.findings) {
        const sev = f.severity === 'high' ? C.red('HIGH') : f.severity === 'medium' ? C.yellow('MED ') : C.dim('low ')
        const tag = f.allowed ? C.dim('[allowed]') : ''
        console.log(`  ${sev} ${String(f.rule).padEnd(22)} ${f.subject} ${tag}`)
        console.log(`       ${C.dim(f.why)}`)
        if (f.path && f.path !== f.subject) console.log(`       ${C.dim(String(f.path).slice(0, 120))}`)
      }
      if (!r.total) console.log(C.dim('  nothing flagged in this window'))
      console.log('')
      console.log(C.dim('  observe-only by design: findings are reported, never acted on'))
      break
    }

    case 'decide': {
      const mins = Number(opts._[1] ?? 120)
      const r = g.decideSignals(ctx, { sinceMinutes: Number.isFinite(mins) ? mins : 120 })
      let rec = null
      if (opts.record && r.byVerdict.ask > 0) rec = g.recordDecisions(ctx, r.decisions)
      if (opts.json) return emit({ ...r, recorded: rec })
      console.log(`decisions over the last ${r.window}  (${r.observed} recorded events, ${r.total} findings)`)
      console.log('')
      console.log(`  allow  ${String(r.byVerdict.allow).padStart(4)}   covered by the allowlist, no decision needed`)
      console.log(`  ask    ${String(r.byVerdict.ask).padStart(4)}   needs a human`)
      console.log(`  note   ${String(r.byVerdict.note).padStart(4)}   recorded, not worth interrupting anyone`)
      // `enforcement is ON` was wrong in the same way `policy mode reject` claiming a termination was:
      // suspend and reject are implemented nowhere, so a non-observe mode that says enforcement is on
      // is the tool describing something it does not do.
      console.log(`  mode   ${r.mode}${r.mode === 'observe' ? C.green('   nothing would be done about any of them') : C.yellow('   ' + r.wouldDo + ' -- if anything read the mode; nothing does yet')}`)
      console.log('')
      // Stage 0 of DESIGN-enforcement.md: the counterfactual, said out loud.
      //
      // It is the number the promotion gate needs. `wouldAct` has been computed since this layer was
      // written and read by nothing, and an unread count is not evidence -- which is why making it
      // readable is the first thing stage 0 does, before anything is attached to it.
      console.log(`  would act  ${r.actionable} of ${r.total}  -- that many findings are serious and uncovered`)
      console.log(C.dim('             a mode other than observe would act on exactly that many; nothing does today'))
      console.log('')
      for (const d of r.decisions) {
        const v = d.verdict === 'ask' ? C.yellow('ASK ') : d.verdict === 'allow' ? C.green('ALLOW') : C.dim('NOTE ')
        console.log(`  ${v} ${String(d.rule).padEnd(22)} ${d.subject}`)
        console.log(`        ${C.dim(d.why)}`)
        if (d.allowed) console.log(`        ${C.dim('allowed by ' + d.allowed)}`)
      }
      if (!r.total) console.log(C.dim('  nothing to decide in this window'))
      if (rec) console.log(C.dim(`
  recorded ${rec.written} open question(s) -> ${rec.file}`))
      else if (r.byVerdict.ask) { console.log(''); console.log(C.dim('  add --record to keep these questions in the activity record')) }
      break
    }

    case 'busy': {
      const mins = Number(opts._[1] ?? 120)
      const r = g.summarizeActivity(ctx, { sinceMinutes: Number.isFinite(mins) ? mins : 120, limit: opts.all ? 500 : 25 })
      if (opts.json) return emit(r)
      console.log(`what has been running -- last ${r.window}  (${r.observed} events, ${r.distinctPrograms} distinct programs)`)
      console.log('')
      console.log(C.dim('  runs  program                    location'))
      for (const x of r.rows) {
        const runs = String(x.runs).padStart(5)
        const name = String(x.name).padEnd(24).slice(0, 24)
        // A program outside the allowlist that runs hundreds of times is the interesting row.
        const mark = x.allowed ? C.dim('allowed') : C.yellow('not allowlisted')
        const where = x.exe ? C.dim(String(x.exe).slice(0, 58)) : C.dim('(command line not captured)')
        console.log(`  ${runs}  ${name}  ${mark}`)
        console.log(`         ${where}`)
      }
      console.log('')
      console.log(C.dim('  recording is not transparency -- this is the view that answers "what ran here"'))
      break
    }

    case 'redline': {
      const budget = Number(opts._[1] ?? 45)
      const r = await g.scanRedline(ctx, { budgetMs: (Number.isFinite(budget) ? budget : 45) * 1000, top: opts.all ? 40 : 12 })
      let rec = null
      if (opts.record && r.flagged.length) rec = g.recordRedline(ctx, r)
      if (opts.json) return emit({ ...r, recorded: rec })
      console.log(`C: red line -- what is sitting in user-writable space  (${r.ms} ms)`)
      console.log('')
      console.log('  ' + (r.truncated ? C.yellow(r.detail) : r.detail))
      console.log('')
      for (const [k, v] of Object.entries(r.areas)) {
        console.log(`  ${String(k).padEnd(18)} ${String((v.bytes / 1048576).toFixed(1)).padStart(9)} MB  ${String(v.files).padStart(7)} files`)
      }
      console.log('')
      console.log(`  flagged ${r.flagged.length} item(s) whose name says cache / download / temp:`)
      for (const f of r.flagged) {
        console.log(`    ${String((f.size / 1048576).toFixed(1)).padStart(8)} MB  ${String(f.path).slice(0, 96)}`)
      }
      console.log('')
      console.log(C.dim('  this measures and names; it does not block. Blocking a write needs a filter driver.'))
      if (rec) console.log(C.dim(`  recorded ${rec.written} new finding(s) -> ${rec.file}`))
      break
    }

    case 'cache': {
      const keep = Number(opts.keep ?? 1) || 1
      const envs = opts['keep-envs'] !== true
      const doApply = opts.apply === true
      const wanted = typeof opts['plan-id'] === 'string' ? opts['plan-id'] : null

      const scan = await uvc.scanUvCache(ctx)
      if (!scan.ok) { console.log(C.red('FAIL') + ' cache: ' + scan.detail); process.exit(1) }
      const fresh = uvc.planUvPrune(scan, { keepVersions: keep, pruneEnvironments: envs })

      let plan = fresh
      let saved = null
      let result = null
      let applied = null

      if (doApply) {
        // --apply carries out a plan that was reviewed, not whatever the cache looks like now.
        // The plan shown by --prune is saved under a name derived from its own contents, and that
        // is the plan that runs. New candidates are left for the next plan, where a person sees
        // them before they are approved.
        const newest = uvc.listPlans(ctx)[0] ?? null
        const id = wanted ?? newest?.id ?? null
        if (!id) {
          console.log(C.red('FAIL') + ' cache --apply: no reviewed plan to carry out')
          console.log(C.dim('  run `cache --prune` first: it prints the plan, and --apply runs exactly that one'))
          process.exit(1)
        }
        const loaded = uvc.loadPlan(ctx, id)
        if (!loaded.ok) { console.log(C.red('FAIL') + ' cache --apply: ' + loaded.detail); process.exit(1) }
        plan = loaded.plan
        saved = { file: loaded.file, id }
        applied = { requestedId: id, isNewest: newest?.id === id, freshlyBuilt: false }
        if (fresh.id !== plan.id) {
          // Named, not silent. The plan being run is the one that was reviewed; the cache has
          // moved since, and that is worth knowing rather than hiding behind either plan.
          applied.differsFromCurrentScan = true
          applied.currentPlanId = fresh.id
        }
        result = uvc.applyUvPrune(plan, { dryRun: false })
      } else if (opts.prune) {
        saved = uvc.savePlan(ctx, fresh)
        result = uvc.applyUvPrune(fresh, { dryRun: true })
      } else {
        saved = uvc.savePlan(ctx, fresh)
      }

      if (opts.json) return emit({ root: scan.root, total: scan.total, subdirs: scan.subdirs, plan, saved, applied, currentPlan: fresh, result })

      const mb = (b) => (b / 1048576).toFixed(1).padStart(9) + ' MB'
      console.log('uv cache: ' + scan.root)
      console.log('  total ' + (scan.total / 1024 ** 3).toFixed(2) + ' GB')
      for (const [k, v] of Object.entries(scan.subdirs).sort((a, b) => b[1].bytes - a[1].bytes)) {
        console.log('    ' + String(k).padEnd(18) + mb(v.bytes) + '  ' + String(v.files).padStart(7) + ' files')
      }
      console.log('')
      const sum = (arr) => arr.reduce((s, t) => s + t.bytes, 0)
      const dupes = plan.targets.filter((t) => t.reason === 'duplicate')
      const oldv = plan.targets.filter((t) => t.reason === 'old-version')
      const staleEnvs = plan.targets.filter((t) => t.reason === 'stale-environment')
      console.log('  packages cached        ' + scan.packages.size)
      console.log('  duplicate copies       ' + dupes.length + '  (' + (sum(dupes) / 1048576).toFixed(0) + ' MB)')
      console.log('  older versions         ' + oldv.length + '  (' + (sum(oldv) / 1048576).toFixed(0) + ' MB)')
      console.log('  idle environments      ' + staleEnvs.length + '  (' + (sum(staleEnvs) / 1048576).toFixed(0) + ' MB)')
      console.log('  in use, never touched  ' + plan.skippedInUse)
      console.log('')
      console.log('  reclaimable ' + plan.gb + ' GB, keeping the newest ' + plan.keepVersions + ' version(s) per package')
      console.log('')
      for (const t of plan.targets.slice(0, 12)) {
        console.log('    ' + mb(t.bytes) + '  ' + String(t.reason).padEnd(18) + ' ' + t.name + (t.version ? ' ' + t.version : ''))
      }
      if (plan.targets.length > 12) console.log(C.dim('    ... and ' + (plan.targets.length - 12) + ' more'))
      console.log('')
      console.log('  plan ' + plan.id + ' -- ' + plan.targets.length + ' entr(ies), ' + plan.gb + ' GB')
      if (doApply) {
        console.log(C.dim('    this is the plan that --apply carried out, and the only one it will ever carry out'))
      } else {
        console.log(C.dim('    --apply carries out exactly this list, so it is stored under this name'))
        if (saved?.file) console.log(C.dim('    ' + saved.file))
      }
      console.log('')
      if (applied?.differsFromCurrentScan) {
        console.log(C.yellow('  the cache has moved since this plan was made'))
        console.log(C.dim('    reviewed ' + plan.id + ' (' + plan.targets.length + ' entries)'))
        console.log(C.dim('    a fresh scan right now would be ' + applied.currentPlanId + ' (' + fresh.targets.length + ' entries)'))
        console.log(C.dim('    the reviewed plan ran; anything new is left for the next plan'))
        console.log('')
      }
      if (result) {
        console.log((result.dryRun ? C.yellow('dry-run') : C.green('applied')) + ': ' + (result.dryRun ? 'would remove ' : 'removed ') + result.removed + ' entries, ' + result.gb + ' GB')
        for (const f of result.refused || []) console.log(C.dim('  refused by the filesystem (in use): ' + f.hash))
        for (const f of result.failed) console.log(C.dim('  staged but not deleted: ' + f.hash + ' at ' + f.at))
        for (const f of result.gone || []) console.log(C.yellow('  gone before it could be removed: ') + f.hash + ' (' + f.why + ')')
        for (const f of result.changed || []) {
          console.log(C.yellow('  changed after the plan was made, left alone: ') + f.hash + ' (' + f.name + ': ' + f.was + ' -> ' + f.now + ' bytes)')
        }
        if (result.dryRun) console.log(C.dim('  add --apply to actually remove'))
        else if (result.skipped) console.log(C.dim('  ' + result.skipped + ' entr(ies) from the plan were not removed; a fresh plan would show what is left'))
      } else {
        console.log(C.dim('  add --prune to list the exact removals, --apply to carry them out'))
      }
      console.log(C.dim('  Each removal is staged by renaming the entry first. Windows refuses to rename a'))
      console.log(C.dim('  directory while a file inside it is open, so a refused rename IS the in-use answer --'))
      console.log(C.dim('  authoritative and atomic, where scanning process paths is only a pre-filter.'))
      console.log(C.dim('  Before staging, each entry is rechecked: same path, same size. The rename answers'))
      console.log(C.dim('  "is this in use"; it cannot answer "is this still what was reviewed", and a plan'))
      console.log(C.dim('  approved as 40 entries must not execute as a different 40.'))
      break
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

    case 'resources': {
      const probe = await res.probeResources({ top: Number(opts._[1]) || 6 })
      const decision = res.decideDefer(probe, {
        free: opts.free ? Number(opts.free) : undefined,
        cpu: opts.cpu ? Number(opts.cpu) : undefined,
      })
      const report = [res.summarizeResources(probe, decision)]
      for (const p of probe.top ?? []) {
        report.push(`    ${String(p.mb).padStart(5)} MB  ${p.name}  #${p.pid}`)
      }
      if (decision.held?.length) {
        report.push(`  protected: ${decision.held.map((h) => `${h.name} #${h.pid} (${h.why})`).join(', ')}`)
      }
      emit({ ...probe, decision }, report.join(String.fromCharCode(10)))
      // 0 = room for heavy work; 3 = defer. Three is deliberate: 'not now' is not a failure.
      process.exit(decision.defer ? 3 : 0)
    }

    case 'defer': {
      const want = {
        free: opts.free ? Number(opts.free) : undefined,
        cpu: opts.cpu ? Number(opts.cpu) : undefined,
      }
      let decision
      if (opts.wait) {
        decision = await res.waitForHeadroom({
          ...want,
          maxWaitMs: opts['max-wait'] ? Number(opts['max-wait']) * 1000 : undefined,
          log: (m) => {
            if (!opts.quiet) {
              console.error(`  ${C.yellow('waiting')}: ${m.replace(/^waiting: /, '')}`)
            }
          },
        })
      } else {
        decision = res.decideDefer(await res.probeResources({ top: 4 }), want)
      }
      emit(decision, decision.defer ? C.yellow(`defer: ${decision.reason}`) : C.green(`go: ${decision.reason}`))
      process.exit(decision.defer ? 3 : 0)
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