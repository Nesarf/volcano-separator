#!/usr/bin/env node
/**
 * volcano-separator MCP server (stdio, hand-rolled JSON-RPC, zero dependencies)
 *
 * For any harness.
 *
 * Service lifecycle
 *   volcano_status       whole-chain check (read-only unless deep=true)
 *   volcano_heal         intelligent repair: warm -> serve -> watch
 *   volcano_doctor       historical start-failure diagnosis
 *
 * Observation -- read-only
 *   volcano_resources    free memory, CPU load, largest processes, and whether heavy work fits
 *   volcano_activity     the system-wide process/window/persistence record
 *   volcano_busy         what has actually been running, grouped
 *   volcano_ps           what is running now, with ages
 *   volcano_redline      what is sitting in user-writable space on the system drive
 *   volcano_cache_plan   what a uv cache prune would remove -- the plan only, never applied
 *
 * Incident response -- read-only
 *   volcano_signals      what looks like stealth, with evidence
 *   volcano_decide       what would be done about each signal, and the current mode
 *   volcano_detained     what is under custody, reconciled against the live system
 *   volcano_timeline     the life of each custody decision
 *
 * Why there is no mutating tool beyond `heal`
 * -------------------------------------------
 * `heal` repairs a service the agent is usually the reason for needing; it removes nothing and the
 * worst outcome is a slower path to the same state. Everything else that changes the machine --
 * `detain`, `release`, `cache --apply`, `policy allow` -- needs a human in the loop, and an agent
 * that can freeze a process or delete cache entries on its own is a worse failure than an agent
 * that has to ask. `cache_plan` exists precisely so an agent can show a person what a prune WOULD
 * do and let them run it.
 *
 * Read-only here means read-only: nothing in this list writes to the activity record, the policy
 * file, the cache, or any process. `volcano_status` is the one that borders on it -- measuring uv
 * warmth runs uvx, and uvx writes to the cache -- so that probe is behind `deep` and off by default.
 */

import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as g from './core.mjs'
import * as res from './resources.mjs'
import * as uvc from './uvcache.mjs'
import * as enf from './enforce.mjs'

// One version, read from the one place that declares it.
//
// This was hardcoded to '1.0.0' and stayed there through five releases, so an MCP client asking
// the server what it was got an answer five versions out of date. A second copy of a value is a
// second thing to forget. The fallback is deliberately not a plausible version number: if
// package.json cannot be read, saying so is better than naming a release that does not exist.
let VERSION = 'unknown (package.json unreadable)'
try {
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
  if (pkg?.version) VERSION = pkg.version
} catch {
  /* keep the honest placeholder */
}

/** Clamp a caller-supplied number. An agent asking for `limit: 1e9` should get a bound, not a hang. */
function num(v, def, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, Math.round(n)))
}

const NL = String.fromCharCode(10)
const readOnly = (properties = {}) => ({ type: 'object', properties, additionalProperties: false })
const minutes = (def, max) => ({ type: 'integer', description: `Look back this many minutes (default ${def}, capped at ${max}).` })

const TOOLS = [
  {
    name: 'volcano_status',
    description:
      'Whole-chain check of the Hindsight memory service: is the uv toolchain present, is the daemon port answering, is Postgres reachable, is the watchdog task installed. Also scans the daemon log for errors, because a service can answer on its port while being unable to reach its database. Read-only by default: the uv env warmth probe is skipped because measuring it runs uvx, which writes to the uv cache.',
    inputSchema: readOnly({
      deep: {
        type: 'boolean',
        description: 'Also measure whether the uv env is warm. NOT read-only: it runs a uvx dry run, and uvx creates a cache environment to do so.',
      },
    }),
  },
  {
    name: 'volcano_heal_status',
    description:
      'What the background repair is doing, for a caller that did not wait for it: whether one is running and who holds it, whether the service is healthy, and the tail of its log. Answers from files, so it still works after the process that started the repair is gone. volcano_heal no longer blocks, so this is how a repair is followed.',
    inputSchema: readOnly(),
  },
  {
    name: 'volcano_heal',
    description:
      'Intelligently repair the Hindsight memory service: probe first (returns immediately, nearly free, when healthy); otherwise close the gaps in stages -- warm (bring the uv env up to date, no watchdog) -> serve (seconds once warm) -> watch (confirm stability across consecutive probes). The only tool here that changes machine state, and it removes nothing.',
    inputSchema: readOnly({ force: { type: 'boolean', description: 'Ignore the "already healthy" check and redo it from the start.' } }),
  },
  {
    name: 'volcano_doctor',
    description:
      'Count historical Hindsight daemon start failures from the host plugin log, answering "why did it used to die without warning" (typical answer: the start path carried a download/build and tripped a ~180 s watchdog).',
    inputSchema: readOnly(),
  },
  {
    name: 'volcano_resources',
    description:
      'Free memory, CPU load and the largest running processes with their command lines, plus a verdict on whether heavy work fits right now. Use this before starting anything expensive: the embedded services run as a generic interpreter image and are easy to mistake for something disposable.',
    inputSchema: readOnly({ top: { type: 'integer', description: 'How many largest processes to list (default 6, capped at 25).' } }),
  },
  {
    name: 'volcano_activity',
    description:
      'The system-wide activity record: process starts and stops, window titles, and changes to persistence surfaces (Run keys, Startup folders, scheduled tasks). This is the raw record rather than a summary; the recorder is event-driven and starts at boot, so short-lived processes are in it too.',
    inputSchema: readOnly({ limit: { type: 'integer', description: 'How many of the most recent events to return (default 40, capped at 500).' } }),
  },
  {
    name: 'volcano_busy',
    description:
      'What has actually been running over a window, grouped by executable and location, with allowlist membership. Recording is not transparency: this is the view that says which of it mattered.',
    inputSchema: readOnly({
      minutes: minutes(120, 10080),
      limit: { type: 'integer', description: 'How many groups to return (default 25, capped at 200).' },
    }),
  },
  {
    name: 'volcano_ps',
    description: 'What is running right now, with ages, so a wedged process is visible as one that has been alive far longer than it should.',
    inputSchema: readOnly(),
  },
  {
    name: 'volcano_redline',
    description:
      'What is sitting in user-writable space on the system drive, with items whose name says cache / download / temp flagged. A workstation hygiene scan, not a malware scan -- for behaviour, use volcano_signals.',
    inputSchema: readOnly({ budgetMs: { type: 'integer', description: 'Time budget for the walk (default 45000, capped at 300000).' } }),
  },
  {
    name: 'volcano_cache_plan',
    description:
      'What a uv cache prune would remove, and how much it would free: duplicate copies, superseded versions, and uvx environments no running process is using. Returns the plan only and never removes anything -- the plan is stored under its own id, and a human runs `volcano-separator cache --apply` to carry out exactly that list. Show this to a human.',
    inputSchema: readOnly({ keep: { type: 'integer', description: 'How many versions of each package to keep (default 1, capped at 10).' } }),
  },
  {
    name: 'volcano_signals',
    description:
      'What looks like stealth, with the evidence behind each finding: persistence written from a temporary directory, processes running from one, and executables that are gone by the time we look. Observe-only -- this tool notices, it does not act.',
    inputSchema: readOnly({ minutes: minutes(60, 10080) }),
  },
  {
    name: 'volcano_decide',
    description:
      'What would be done about each signal, and the current policy mode. Reports verdicts (allow / ask / note) and what would have been suppressed by an inherited allowlist, so "detected but allowed" is distinguishable from "nothing found". The default mode is observe, under which nothing would be done about any of them.',
    inputSchema: readOnly({ minutes: minutes(60, 10080) }),
  },
  {
    name: 'volcano_detained',
    description:
      'What is under custody right now, each record reconciled against the live system, plus anything frozen that nothing recorded. A suspension is persistent, so a process frozen by an earlier run stays frozen.',
    inputSchema: readOnly({ probe: { type: 'boolean', description: 'Check each record against the live process (default true).' } }),
  },
  {
    name: 'volcano_timeline',
    description: 'The life of each custody decision: frozen, what was done, how it ended, and what was reported while it was live.',
    inputSchema: readOnly({ days: { type: 'integer', description: 'How many days back to read (default all, capped at 90).' } }),
  },
  {
    name: 'volcano_isolated',
    description: 'Files this tool has been asked to isolate, and whether the deny is still in place. The state is read from the filesystem, not from the record, because an ACL can be restored by hand -- so an entry may read as not-denied while its journal still exists. Read-only: isolating and restoring are deliberately NOT exposed here, because an agent should not be able to change what can execute on this machine.',
    inputSchema: readOnly({}),
  },
  {
    name: 'volcano_evidence',
    description: 'The accumulated counterfactual: per day, how many findings a mode other than observe would have acted on. This is what a decision to enforce anything would have to be made from, and the design refuses to promote a rule until it is a sample rather than a number.',
    inputSchema: readOnly({}),
  },
]

/**
 * Each entry returns { ok, text }. Text is what the harness sees; keep it compact, because an
 * agent pays for every line and a dump of 40,000 events is worse than useless.
 */
async function call(name, args = {}) {
  const ctx = g.resolveContext({})

  if (name === 'volcano_status') {
    const s = await g.status(ctx, { deep: args.deep === true })
    const svc = await g.serviceState(ctx)
    const text = `${s.text}${NL}  watchdog    : ${svc.installed ? `[ok  ] ${svc.state} (last ${svc.lastRun}, result ${svc.lastResult})` : '[FAIL] not installed'}`
    return { ok: s.ok, text }
  }

  if (name === 'volcano_heal') {
    // NOT blocking. This used to await the whole repair, which meant a caller could wait the worst
    // case this tool can produce -- thirty minutes, measured -- to learn something that is usually
    // decided in fifty milliseconds. The server's tool timeout was set to thirty minutes for that one
    // tool, and all fifteen tools share it.
    //
    // Healthy still answers synchronously, in the same process, at the same cost as before. A repair
    // that is actually needed is handed to its own process and reported as a receipt.
    const r = await g.beginHeal(ctx, { force: args.force === true })
    if (r.done) return { ok: true, text: r.detail }
    if (r.busy) return { ok: true, text: 'A repair is already running. ' + r.detail + `
  log: ${r.logFile}` }
    if (!r.started) return { ok: false, text: r.detail }
    return {
      ok: true,
      text: [
        'A repair was needed and has been started; this call did not wait for it.',
        `  log:  ${r.logFile}`,
        '  poll: volcano_heal_status (or read the log file)',
      ].join(NL),
    }
  }

  if (name === 'volcano_heal_status') {
    // Answers from files rather than from memory, so it still works after the process that started the
    // repair is gone -- which is the entire reason the repair is in its own process.
    const s2 = await g.healStatus(ctx)
    const lines = [
      s2.running
        ? `repair running (${s2.holder?.holder ?? 'unknown'}, pid ${s2.holder?.pid ?? '?'})`
        : 'no repair running',
      `service: ${s2.healthy ? 'healthy' : 'NOT healthy'} -- ${s2.healthDetail}`,
      `log: ${s2.logFile}`,
    ]
    if (s2.logTail.length) {
      lines.push('  last lines:')
      for (const l of s2.logTail) lines.push('    ' + l.slice(0, 150))
    }
    return { ok: true, text: lines.join(NL) }
  }

  if (name === 'volcano_doctor') {
    const d = await g.doctor(ctx)
    return { ok: true, text: d.verdict }
  }

  if (name === 'volcano_resources') {
    const probe = await res.probeResources({ top: num(args.top, 6, 1, 25) })
    const decision = res.decideDefer(probe)
    const lines = [res.summarizeResources(probe, decision)]
    for (const p of probe.top ?? []) lines.push(`    ${String(p.mb).padStart(5)} MB  ${p.name}  #${p.pid}`)
    if (decision.held?.length) lines.push(`  protected: ${decision.held.map((h) => `${h.name} #${h.pid} (${h.why})`).join(', ')}`)
    return { ok: true, text: lines.join(NL) }
  }

  if (name === 'volcano_activity') {
    const a = g.readActivity(ctx, { limit: num(args.limit, 40, 1, 500) })
    const lines = [
      `${a.total} event(s) in the record; recorder ${a.recorderRunning ? 'running' : 'not running'}`,
      `  dir: ${a.dir}`,
    ]
    for (const e of a.events) lines.push(`  ${e.t ?? '?'}  ${e.kind ?? '?'}  ${(e.cmd || e.title || e.name || e.value || '').toString().slice(0, 110)}`)
    return { ok: true, text: lines.join(NL) }
  }

  if (name === 'volcano_busy') {
    const s = g.summarizeActivity(ctx, { sinceMinutes: num(args.minutes, 120, 1, 10080), limit: num(args.limit, 25, 1, 200) })
    const lines = [`over the last ${s.window}: ${s.observed} event(s), ${s.distinctPrograms} distinct program(s)`]
    for (const x of s.rows ?? []) {
      lines.push(`  ${String(x.runs).padStart(5)} run(s)  ${String(x.name).padEnd(22)} ${x.allowed ? 'allowed' : 'not allowlisted'}`)
      if (x.exe) lines.push(`         ${String(x.exe).slice(0, 110)}`)
    }
    return { ok: true, text: lines.join(NL) }
  }

  if (name === 'volcano_ps') {
    const p = await g.liveProcesses(ctx)
    const lines = [`${p.length} process(es)`]
    for (const x of p.slice(0, 60)) lines.push(`  ${String(x.ageSeconds ?? '').padStart(8)}s  ${x.name}  #${x.pid}`)
    if (p.length > 60) lines.push(`  ... and ${p.length - 60} more`)
    return { ok: true, text: lines.join(NL) }
  }

  if (name === 'volcano_redline') {
    const r = await g.scanRedline(ctx, { budgetMs: num(args.budgetMs, 45000, 1000, 300000) })
    const lines = [r.detail]
    for (const [k, v] of Object.entries(r.areas ?? {})) {
      lines.push(`  ${String((v.bytes / 1048576).toFixed(1)).padStart(9)} MB  ${String(v.files).padStart(7)} files  ${k}`)
    }
    if (r.flagged?.length) {
      lines.push(`  flagged ${r.flagged.length} item(s) whose name says cache / download / temp:`)
      for (const f of r.flagged.slice(0, 15)) lines.push(`    ${String((f.size / 1048576).toFixed(1)).padStart(8)} MB  ${String(f.path).slice(0, 110)}`)
    }
    lines.push('  this measures and names; it does not block.')
    return { ok: true, text: lines.join(NL) }
  }

  if (name === 'volcano_cache_plan') {
    const scan = await uvc.scanUvCache(ctx)
    if (!scan.ok) return { ok: false, text: `cannot read the uv cache: ${scan.detail}` }
    const plan = uvc.planUvPrune(scan, { keepVersions: num(args.keep, 1, 1, 10) })
    // Stored, not just printed. `--apply` carries out a stored plan by name, so a plan an agent
    // showed a human has to be the same plan that later runs -- otherwise the person approves one
    // list and executes whichever the cache happens to produce at that moment.
    const saved = uvc.savePlan(ctx, plan)
    const sum = (arr) => arr.reduce((s2, t) => s2 + t.bytes, 0)
    const by = (reason) => plan.targets.filter((t) => t.reason === reason)
    const lines = [
      `uv cache ${scan.root}: ${(scan.total / 1024 ** 3).toFixed(2)} GB`,
      `  reclaimable ${plan.gb} GB across ${plan.targets.length} entr(ies); ${plan.skippedInUse} entr(ies) are in use and would be left alone`,
      `  duplicate copies ${by('duplicate').length} (${(sum(by('duplicate')) / 1048576).toFixed(0)} MB)`,
      `  older versions   ${by('old-version').length} (${(sum(by('old-version')) / 1048576).toFixed(0)} MB)`,
      `  idle environments ${by('stale-environment').length} (${(sum(by('stale-environment')) / 1048576).toFixed(0)} MB)`,
    ]
    for (const t of plan.targets.slice(0, 10)) lines.push(`    ${(t.bytes / 1048576).toFixed(1).padStart(9)} MB  ${t.reason}  ${t.name}`)
    if (plan.targets.length > 10) lines.push(`    ... and ${plan.targets.length - 10} more`)
    lines.push(`  plan ${plan.id} -- this is the exact list, and the only one it will act on`)
    lines.push('  Nothing was removed. Show this to a human; they run `volcano-separator cache --apply`.')
    lines.push('  A plan whose entries changed or vanished in the meantime is left alone and named, never')
    lines.push('  silently replaced by a fresh one.')
    return { ok: true, text: lines.join(NL), planId: plan.id, saved: saved.ok === true, targets: plan.targets.length }
  }

  if (name === 'volcano_signals') {
    const s = g.analyzeSignals(ctx, { sinceMinutes: num(args.minutes, 60, 1, 10080) })
    const lines = [`${s.total} finding(s) over the last ${s.window}; mode ${s.mode}`]
    for (const f of s.findings.slice(0, 20)) {
      lines.push(`  ${String(f.severity).toUpperCase().padEnd(4)}  ${f.rule}  ${f.subject}${f.allowed ? '  [allowed ' + f.allowed + ']' : ''}`)
      lines.push(`        ${f.why}`)
      if (f.path) lines.push(`        ${f.path}`)
    }
    return { ok: true, text: lines.join(NL) }
  }

  if (name === 'volcano_decide') {
    const d = g.decideSignals(ctx, { sinceMinutes: num(args.minutes, 60, 1, 10080) })
    const lines = [
      `${d.total} finding(s) across ${d.observed} event(s); mode ${d.mode}`,
      `  allow ${d.byVerdict.allow}   ask ${d.byVerdict.ask}   note ${d.byVerdict.note}`,
      `  would act ${d.actionable} of ${d.total} -- a mode other than observe would act on that many; nothing does today`,
    ]
    for (const x of d.decisions.slice(0, 20)) {
      lines.push(`  ${String(x.verdict).toUpperCase().padEnd(5)}  ${x.rule}  ${x.subject}`)
      if (x.suppressedBy) lines.push(`        would have been suppressed by ${x.suppressedBy}; a broad allow entry does not silence a high-severity finding inside a scratch directory`)
    }
    if (d.mode === 'observe') lines.push('  mode is observe: nothing would be done about any of them.')
    return { ok: true, text: lines.join(NL) }
  }

  if (name === 'volcano_detained') {
    const r = await g.custodyReport(ctx, { probe: args.probe !== false })
    if (!r.ok) return { ok: true, text: `no custody record: ${r.reason}` }
    const lines = [`${r.entries?.length ?? 0} entr(ies) in the custody record`]
    for (const e of (r.entries ?? []).slice(0, 30)) lines.push(`  ${String(e.state ?? '?').padEnd(10)}  pid ${e.pid}  ${e.name ?? ''}${e.why ? '  -- ' + e.why : ''}`)
    for (const o of (r.orphans ?? []).slice(0, 10)) lines.push(`  ${'ORPHAN'.padEnd(10)}  pid ${o.pid}  ${o.name ?? ''}  (frozen with no record)`)
    return { ok: true, text: lines.join(NL) }
  }

  if (name === 'volcano_isolated') {
    const l = await enf.isolatedFiles(ctx)
    if (!l.entries.length) return { ok: true, text: 'nothing has been isolated on this machine' }
    const lines = [`isolation journals in ${l.dir}`, '']
    for (const e of l.entries) {
      lines.push(`  ${String(e.state ?? '?').padEnd(13)} ${e.path}`)
      if (e.state === 'not-denied') lines.push('                the deny is gone but the journal remains -- it was lifted, possibly by hand')
      if (e.state === 'file-missing') lines.push('                the file is gone, so the journal describes something that no longer exists')
    }
    lines.push('')
    lines.push('  nothing here can be changed through this interface: isolate and restore are CLI-only on purpose')
    return { ok: true, text: lines.join(NL) }
  }

  if (name === 'volcano_evidence') {
    const days = g.readEvidence()
    if (!days.length) {
      return { ok: true, text: 'no evidence accumulated yet -- the heartbeat rolls up one line a day when it runs with --signals' }
    }
    const total = days.reduce((n, d) => n + (d.actionable ?? 0), 0)
    const lines = [`${days.length} day(s) of evidence`, '']
    for (const d of days) lines.push(`  ${String(d.day).padEnd(12)} would act ${String(d.actionable ?? 0).padStart(4)}`)
    lines.push('')
    lines.push(`  ${total} time(s) in ${days.length} day(s); a mode other than observe would have acted that often`)
    lines.push('  nothing acts on any of it: policy.mode is consulted for reporting and read by nothing')
    return { ok: true, text: lines.join(NL) }
  }

  if (name === 'volcano_timeline') {
    const days = args.days === undefined ? null : num(args.days, null, 1, 90)
    const t = g.custodyTimeline(ctx, days === null ? {} : { sinceDays: days })
    const lines = [`${t.entries?.length ?? 0} custody decision(s)`]
    for (const e of (t.entries ?? []).slice(0, 25)) {
      lines.push(`  ${e.pid}  ${e.name ?? ''}  frozen ${e.frozenAt ?? '?'}  ended ${e.endedAt ?? '(still open)'}`)
    }
    return { ok: true, text: lines.join(NL) }
  }

  throw new Error(`unknown tool: ${name}`)
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

const rl = createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  const t = line.trim()
  if (!t) return
  let req
  try {
    req = JSON.parse(t)
  } catch {
    return
  }
  const { id, method, params } = req
  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'volcano-separator', version: VERSION },
        },
      })
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    } else if (method === 'tools/call') {
      const r = await call(params?.name, params?.arguments ?? {})
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: r.text }], isError: !r.ok },
      })
    } else if (method === 'notifications/initialized') {
      /* notification: no reply */
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `not implemented: ${method}` } })
    }
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32000, message: String(e?.message ?? e) } })
  }
})
