import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { activityDir, readActivity } from './activity.mjs'
import { exeFromCmd, isSystemRoot } from './commandline.mjs'
import { normalizePath } from './platform.mjs'
import { loadPolicy, policyAllows } from './policy.mjs'

/**
 * L1 signals and L2 decisions: what looks like it does not want to be seen, and what would be done
 * about it.
 *
 * Extracted from core.mjs. The two layers are together because the second is a reading of the
 * first and neither means much alone -- signals reports evidence, decisions turns it into
 * allow / ask / note and refuses to act.
 *
 * The rule that took the longest to get right is the one about the allowlist, in
 * allowIsBroadForScratch below: trust propagates down to ordinary paths, but not into a directory
 * that exists to be disposable, or the rules whose whole subject is a temporary directory are
 * pre-approved and can never ask.
 */
/** Roots where a program has no business living permanently. */
function ephemeralRoots(ctx) {
  const home = homedir()
  return [
    tmpdir(),
    join(home, 'AppData', 'Local', 'Temp'),
    join(home, 'Downloads'),
    join(home, 'Desktop'),
  ].map((p) => p.toLowerCase())
}

function isEphemeral(p, roots) {
  if (!p) return null
  const low = String(p).toLowerCase()
  for (const r of roots) if (low.startsWith(r)) return r
  // Anything sitting in a directory literally named temp/downloads/cache, wherever it is.
  const m = /[\/](temp|tmp|downloads?|cache)[\/]/i.exec(low)
  return m ? m[0] : null
}

/**
 * The scratch directory a finding sits inside, as a path prefix.
 *
 * `where` comes from isEphemeral and is either one of the named roots or a bare marker like
 * `/cache/`. The marker case still has a prefix -- everything up to and including the marker --
 * and that prefix is what decides whether an allow entry is a decision about this file or just a
 * statement about the volume it happens to sit on.
 */
function scratchPrefixOf(path, where) {
  const low = normalizePath(path)
  if (!low || !where) return ''
  const w = normalizePath(where)
  const i = low.indexOf(w)
  if (i < 0) return ''
  // A named root already ends at a separator; a bare marker does too.
  return low.slice(0, i + w.length)
}

/**
 * Is this allow entry too broad to be a decision about this path?
 *
 * Trust propagates down to ordinary paths; it does not propagate into a directory that exists to
 * be disposable. The concrete failure: the allow list answered `path:e:/dashaohuo/` for everything
 * under E:\DaShaoHuo, and this machine's TEMP is E:\DaShaoHuo\cache\tmp -- so the two rules whose
 * entire subject is "a temporary directory" were pre-approved and could never ask for a decision.
 * `ask` was always 0, which reads as "nothing to report" and meant "the rule cannot fire".
 *
 * An entry that names the scratch directory itself, or something inside it, is a decision and
 * still counts. The requirement is a decision about this file, not that temp be unallowable.
 */
function allowIsBroadForScratch(entry, path, where) {
  if (!entry || !entry.startsWith('path:')) return false
  const allowPath = normalizePath(entry.slice(5)).replace(/\/+$/, '')
  const scratch = scratchPrefixOf(path, where).replace(/\/+$/, '')
  if (!allowPath || !scratch) return false
  if (scratch === allowPath) return false            // names the scratch root: specific enough
  if (!scratch.startsWith(allowPath + '/')) return false  // does not even cover it
  return true                                        // a strict ancestor: too broad to count
}

/**
 * Read the record and report what looks like stealth.
 *
 * Rules, and why each is defensible:
 *
 *   persist-from-ephemeral  Something was added to a persistence surface (Run key, Startup
 *                           folder, scheduled task) and it points into a temporary or download
 *                           directory. Legitimate software installs itself somewhere stable;
 *                           persistence from a scratch directory is the shape of a dropper.
 *
 *   exec-from-ephemeral     A process ran from such a directory. Common and often innocent --
 *                           installers, portable tools -- which is exactly why this is ranked
 *                           low and why the allowlist is consulted.
 *
 *   binary-vanished         A process ran and its executable is gone by the time we look. Some
 *                           installers clean up after themselves; self-deletion is also a
 *                           standard trick. Ranked high because it is rare.
 */
export function analyzeSignals(ctx, { sinceMinutes = 60, limit = 100 } = {}) {
  const a = readActivity(ctx, { limit: 200000, files: 3 })
  const policy = loadPolicy(ctx)
  const roots = ephemeralRoots(ctx)
  const cutoff = Date.now() - sinceMinutes * 60 * 1000

  const findings = []
  // `where` is what isEphemeral matched. A high-severity finding inside a scratch directory is not
  // silenced by an allow entry that only covers it by covering the volume above it -- otherwise
  // the allowlist decides nothing and the rule can never ask. Low-severity findings still consult
  // the allowlist normally: exec-from-ephemeral is frequent and often innocent (builds, portable
  // tools), which is what it was ranked low for.
  const add = (f, where = null) => {
    const allowHit = policyAllows(policy, { name: f.name, path: f.path })
    const suppressed = allowHit && f.severity === 'high' && allowIsBroadForScratch(allowHit, f.path, where)
    findings.push({
      ...f,
      allowed: suppressed ? null : allowHit,
      suppressedBy: suppressed ? allowHit : null,
      policyMode: policy.mode,
    })
  }

  const seenPid = new Set()

  for (const e of a.events) {
    const t = Date.parse(e.t ?? '')
    if (Number.isFinite(t) && t < cutoff) continue

    if (e.kind === 'persist' && e.action !== 'removed') {
      const where = isEphemeral(e.value, roots)
      if (where) {
        add({
          rule: 'persist-from-ephemeral',
          severity: 'high',
          name: e.name,
          path: e.value,
          subject: `${e.surface} -> ${e.name}`,
          why: `persistence was added under ${where}`,
          at: e.t,
        }, where)
      }
    }

    if (e.kind === 'proc-start') {
      const pid = Number(e.pid)
      if (seenPid.has(pid)) continue
      seenPid.add(pid)

      const exe = exeFromCmd(e.cmd)
      const where = isEphemeral(exe, roots)
      if (where) {
        add({
          rule: 'exec-from-ephemeral',
          severity: 'low',
          pid,
          name: e.name,
          path: exe,
          subject: `${e.name} (pid ${pid})`,
          why: `ran from ${where}`,
          at: e.t,
        }, where)
      }
            const systemRoot = isSystemRoot(exe)
      if (exe && !systemRoot && !existsSync(exe)) {
        add({
          rule: 'binary-vanished',
          severity: 'high',
          pid,
          name: e.name,
          path: exe,
          subject: `${e.name} (pid ${pid})`,
          why: 'the executable no longer exists at the path it ran from',
          at: e.t,
        }, where)
      }
    }
  }

  // Newest first, and never let one noisy rule bury the rest.
  findings.sort((x, y) => String(y.at).localeCompare(String(x.at)))
  const byRule = {}
  for (const f of findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1

  return {
    ok: true,
    observed: a.total,
    window: `${sinceMinutes} min`,
    total: findings.length,
    byRule,
    allowed: findings.filter((f) => f.allowed).length,
    findings: findings.slice(0, limit),
    mode: policy.mode,
    // Carried through from the record, because a finding count computed over a record with holes
    // in it is a lower bound and nothing else said so. The 410 damaged records on this machine
    // were 0.1% of the window, which is 0.1% of the findings, and 16 findings read as 16.
    unreadableLines: a.unreadableLines ?? 0,
    unreadableMidFile: a.unreadableMidFile ?? 0,
    recordComplete: (a.unreadableMidFile ?? 0) === 0,
  }
}

/**
 * Apply policy to the signals and produce a verdict per finding, plus a roll-up.
 *
 *   allow  the allowlist already covers it -- no decision needed
 *   ask    serious enough to need a human, and not covered
 *   note   worth recording, not worth interrupting anyone over
 *
 * `wouldAct` is deliberately separate from `verdict`: it says what the configured mode *would*
 * have done, which is only meaningful once enforcement is switched on. In the default mode it is
 * always false, and that is the point of this layer.
 */
/**
 * What each mode would do, in the mode's own vocabulary.
 *
 * These are the three values policy.mode documents, and suspend and reject are implemented nowhere
 * -- see DESIGN-enforcement.md. Saying what a mode *would* do is the whole point of stage 0: the
 * number a promotion decision needs is "how often would this have acted", and a number nobody can
 * see is not evidence.
 */
export function modeAction(mode) {
  return (MODE_ACTION[mode] ?? String(mode))
}

const MODE_ACTION = {
  observe: 'record it and change nothing',
  suspend: 'freeze the process',
  reject: 'terminate the process',
}
export function decideSignals(ctx, { sinceMinutes = 60 } = {}) {
  const s = analyzeSignals(ctx, { sinceMinutes, limit: 100000 })
  const policy = loadPolicy(ctx)

  const decisions = s.findings.map((f) => {
    // analyzeSignals already made this call, including whether a broad allow entry is allowed to
    // silence a high-severity finding. Re-deriving it here discarded that decision and let the old
    // behaviour back in through a second door: the suppression rule was implemented, the analysis
    // honoured it, and the verdict ignored it. Caught by a test that asserted the verdict rather
    // than the analysis.
    const allowed = f.allowed ?? null
    const verdict = allowed ? 'allow' : f.severity === 'high' ? 'ask' : 'note'
    const wouldAct = !allowed && verdict === 'ask' && policy.mode !== 'observe'
    // rawPath is kept for the dedupe key; `path` may have been normalised for matching.
    return { ...f, verdict, wouldAct, rawPath: f.path ?? '' }
  })

  const byVerdict = { allow: 0, ask: 0, note: 0 }
  for (const d of decisions) byVerdict[d.verdict]++

  // Stage 0 of DESIGN-enforcement.md: the trigger, with nothing attached to it.
  //
  // `wouldAct` has been computed here since this layer was written and read by nothing. That is the
  // right state until the promotion gate has a number to look at, and this is that number: how many
  // findings are serious enough and uncovered, and therefore how many times a mode other than
  // observe would have done something. Nothing acts on it. It exists so that promoting a rule can be
  // a decision made from evidence rather than from an impression of how noisy it feels.
  //
  // Mode-independent on purpose. The mode decides WHAT would happen, not WHETHER: a finding is
  // actionable or it is not, and `suspend` and `reject` differ in what they do to it, not in which
  // findings they touch.
  const actionable = decisions.filter((d) => !d.allowed && d.verdict === 'ask').length
  const action = MODE_ACTION[policy.mode] ?? policy.mode

  return {
    ok: true,
    window: s.window,
    observed: s.observed,
    mode: policy.mode,
    total: decisions.length,
    byVerdict,
    byRule: s.byRule,
    decisions,
    actionable,
    // Under observe this is a sentence about the mode rather than a count, because a bare number
    // next to "observe" reads like something happened.
    wouldDo: policy.mode === 'observe' ? 'nothing: the mode is observe' : `${action} ${actionable} finding(s)`,
    // The design is explicit that suspend and reject are accepted and implemented nowhere. Saying so
    // in the data means a caller cannot render them as though they worked.
    modeUnimplemented: policy.mode !== 'observe',
  }
}

/**
 * Write the decisions that need a human into the activity record as `stealth` events, so the
 * question survives the terminal it was printed in. `policy show` reads these back.
 */
export function recordDecisions(ctx, decisions) {
  const file = join(activityDir(ctx), `stealth-${new Date().toISOString().slice(0, 10)}.ndjson`)

  // Deduplicate against what is already recorded. The heartbeat runs every five minutes over a
  // window slightly wider than that, so without this the same finding is written again and again
  // and the log stops being a list of open questions.
  const already = new Set()
  try {
    for (const line of readFileSync(file, 'utf8').split(String.fromCharCode(10))) {
      const t = line.trim()
      if (!t) continue
      try {
        const e = JSON.parse(t)
        already.add(`${e.rule}|${e.subject}|${e.path ?? ''}`)
      } catch {
        /* skip a half-written line */
      }
    }
  } catch {
    /* no file yet */
  }

  let written = 0
  let skipped = 0
  for (const d of decisions) {
    if (d.verdict !== 'ask') continue
    const key = `${d.rule}|${d.subject}|${d.rawPath ?? ''}`
    if (already.has(key)) {
      skipped++
      continue
    }
    already.add(key)
    const line = JSON.stringify({
      t: d.at ?? new Date().toISOString(),
      kind: 'stealth',
      rule: d.rule,
      severity: d.severity,
      pid: d.pid ?? null,
      name: d.name ?? null,
      subject: d.subject,
      why: d.why,
      action: 'needs-decision',
      verdict: d.verdict,
      path: d.path ?? null,
      rawPath: d.rawPath ?? null,
    })
    try {
      appendFileSync(file, line + String.fromCharCode(10))
      written++
    } catch {
      /* never let bookkeeping break the report */
    }
  }
  return { ok: true, file, written, skipped }
}

/** Stealth findings recorded by the recorder, newest last. */
export function readStealth(ctx, { limit = 50 } = {}) {
  const a = readActivity(ctx, { limit: 100000, files: 3 })
  const events = a.events.filter((e) => e.kind === 'stealth')
  return { dir: a.dir, total: events.length, events: events.slice(-limit) }
}

/**
 * The evidence a promotion decision gets made from, in a place that is not a cache.
 *
 * Why this exists next to recordDecisions
 * ---------------------------------------
 * The activity record lives under the configured log directory, which defaults to the system temp
 * directory -- and the machine's disk hygiene tooling is configured to remove files there after
 * seven days, recursively, with no exclusion list. That is fine for a rolling log of what ran. It is
 * not fine for the number that DESIGN-enforcement.md says a rule may only be promoted on: asking a
 * rule to prove itself over a longer window than the window its evidence survives is a plan that
 * fails quietly, and it fails by reporting *fewer* findings, which looks like good news.
 *
 * So the counterfactual is rolled up once a day into a small durable file beside the policy. The
 * raw event log can then be pruned without taking the evidence with it. The same reason the
 * isolation journal is not in the cache: undoing, and deciding, are decisions about this machine,
 * not artifacts of running a tool.
 *
 * One line per day, rewritten in place rather than appended to, so running the heartbeat a hundred
 * times a day produces one line a day.
 */
export function evidenceFile(ctx = {}) {
  return ctx.evidenceFile ?? join(homedir(), '.volcano-separator', 'evidence.ndjson')
}

export function rollUpEvidence(ctx, decided, { newlyRecorded = 0 } = {}) {
  const file = evidenceFile(ctx)
  const dir = dirname(file)
  const day = new Date().toISOString().slice(0, 10)

  let existing = []
  try {
    // Everything, including today's line: the running total needs the previous version of it.
    existing = readFileSync(file, 'utf8')
      .split(String.fromCharCode(10))
      .map((l) => l.trim())
      .filter(Boolean)
  } catch {
    /* no file yet */
  }

  // The day's line is a RUNNING TOTAL, not the last window's count.
  //
  // The heartbeat runs every five minutes over a six-minute window, and findings are rare -- four in
  // three days. Writing each window's number would therefore write 0 nearly every day, and a daily
  // record of zeroes is the same useless evidence as a counter that cannot vary, arrived at by a
  // different route. `newlyRecorded` is how many findings recordDecisions just wrote for the first
  // time, so summing it over the day gives the day's total.
  let today = null
  for (const l of existing) {
    try {
      const e = JSON.parse(l)
      if (e.day === day) today = e
    } catch {
      /* skip a half-written line */
    }
  }

  const line = JSON.stringify({
    day,
    at: new Date().toISOString(),
    // The running total, or this window's increment if the day has just started.
    actionable: (today?.actionable ?? 0) + newlyRecorded,
    // The window's own numbers, kept for context: how much was examined to reach that total.
    total: decided.total,
    allow: decided.byVerdict.allow,
    ask: decided.byVerdict.ask,
    note: decided.byVerdict.note,
    mode: decided.mode,
  })

  const kept = existing.filter((l) => {
    try {
      return JSON.parse(l).day !== day
    } catch {
      return false
    }
  })

  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, kept.concat(line).join(String.fromCharCode(10)) + String.fromCharCode(10))
    return { ok: true, file, day, days: kept.length + 1, actionableToday: (today?.actionable ?? 0) + newlyRecorded }
  } catch (e) {
    return { ok: false, file, detail: String(e?.message ?? e) }
  }
}

/** The rolled-up evidence, oldest first. */
export function readEvidence(ctx = {}) {
  const file = evidenceFile(ctx)
  try {
    return readFileSync(file, 'utf8')
      .split(String.fromCharCode(10))
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(a.day).localeCompare(String(b.day)))
  } catch {
    return []
  }
}
