import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { readActivity } from './activity.mjs'
import { redactCommandLine } from './commandline.mjs'
import { CORE_ROOT, powershellHost, run } from './platform.mjs'

/**
 * Live view: what is running right now, and forcing hidden things into the open.
 *
 * Extracted from core.mjs. reveal is the one part of this tool with teeth beyond the custody
 * window -- it enumerates top-level windows and can force hidden ones visible -- so it lives with
 * the process listing rather than with the detection rules it is usually used from.
 *
 * PROJECT_ROOT was a second name for CORE_ROOT, the same expression written twice. This module
 * uses the one in the platform layer, because two names for one directory is two things to be
 * wrong after the code moves.
 */
/**
 * The processes that make up the stack, with their age.
 *
 * Age is the point: a `uvx` that has been alive for four minutes is either working hard or
 * wedged, and without the timestamp there is no way to tell those apart.
 */
export async function liveProcesses(ctx) {
  const ps = `
$names = @('uvx.exe','uv.exe','hindsight-api.exe','postgres.exe','wscript.exe','cmd.exe')
Get-CimInstance Win32_Process -Filter "Name='uvx.exe' or Name='uv.exe' or Name='hindsight-api.exe' or Name='postgres.exe'" |
  Select-Object ProcessId,ParentProcessId,Name,CreationDate,@{n='cmd';e={$_.CommandLine}} |
  Sort-Object CreationDate |
  ForEach-Object {
    $age = [math]::Round(((Get-Date) - $_.CreationDate).TotalSeconds, 1)
    "{0}|{1}|{2}|{3}|{4}" -f $_.ProcessId, $_.Name, $age, $_.ParentProcessId, ($_.cmd -replace "[\r\n]+",' ')
  }
`.trim()
  const r = await run(powershellHost(), ['-NoProfile', '-Command', ps], { timeoutMs: 30000 })
  const rows = []
  for (const line of (r.stdout ?? '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || !t.includes('|')) continue
    const [pid, name, age, ppid, ...rest] = t.split('|')
    let cmd = rest.join('|')
    // Only keep processes that belong to this stack; a bare cmd.exe from anywhere else is noise.
    if (!/uvx|uv\.exe|hindsight|postgres|pg_ctl|daemon|embed/i.test(cmd)) continue
    if (cmd.length > 130) cmd = cmd.slice(0, 130) + '...'
    rows.push({ pid: Number(pid), name, ageSeconds: Number(age), parentPid: Number(ppid), cmd })
  }
  return rows
}

/** The newest transcripts plus the heartbeat trail. */
export function readLogs(ctx, { limit = 3, tailLines = 25 } = {}) {
  const dir = ctx.logDir
  const out = { dir, transcripts: [], heartbeat: null }
  let files = []
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs, size: statSync(join(dir, f)).size }))
      .sort((a, b) => b.t - a.t)
  } catch {
    return out
  }
  for (const entry of files.filter((f) => f.f !== 'heartbeat.log').slice(0, limit)) {
    let text = ''
    try {
      text = readFileSync(join(dir, entry.f), 'utf8')
    } catch {
      /* ignore */
    }
    const lines = text.split(/\r?\n/)
    out.transcripts.push({
      file: join(dir, entry.f),
      name: entry.f,
      size: entry.size,
      modified: new Date(entry.t).toISOString(),
      tail: lines.slice(-tailLines).join('\n'),
    })
  }
  const hb = join(dir, 'heartbeat.log')
  if (existsSync(hb)) {
    let text = ''
    try {
      text = readFileSync(hb, 'utf8')
    } catch {
      /* ignore */
    }
    const lines = text.trim().split(/\r?\n/)
    out.heartbeat = { file: hb, lines: lines.slice(-tailLines) }
  }
  return out
}

/**
 * Force hidden windows visible, and expose what a live process is actually doing.
 *
 * Honest limits, stated here so the caller does not over-trust it:
 *   * `show` reveals a window that EXISTS but is hidden. A process that never created a window
 *     cannot be given one without injecting code into it, which this tool does not do.
 *   * Everything else is read-only observation: command line, owner, modules, connections,
 *     windows. Nothing is written into the target process.
 */
export async function reveal(ctx, { mode = 'windows', pid = 0, filter = '', show = false, includeInvisible = false } = {}) {
  const script = join(CORE_ROOT, 'bin', 'reveal.ps1')
  if (!existsSync(script)) return { ok: false, detail: `reveal script missing: ${script}` }

  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Mode', mode]
  if (pid > 0) args.push('-TargetPid', String(pid))
  if (filter) args.push('-Filter', filter)
  if (show) args.push('-Show')
  if (includeInvisible) args.push('-IncludeInvisible')

  const r = await run(powershellHost(), args, { timeoutMs: 90000 })
  const text = (r.stdout ?? '').trim()
  if (!text) return { ok: false, detail: r.error ?? 'no output', stderr: (r.stderr ?? '').slice(-500) }
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, detail: 'could not parse reveal output', raw: text.slice(-800) }
  }
  return { ok: true, mode, data, ms: r.ms }
}

/**
 * The inherited chain, with history.
 *
 * A parent that has already exited cannot be asked anything -- WMI only knows live processes.
 * The activity record can, because it captured the parent when it was alive. So the chain is
 * built from two sources: the live tree, then the record for whatever is no longer running.
 */
export function ancestry(ctx, pid, { maxDepth = 12 } = {}) {
  const a = readActivity(ctx, { limit: 100000, files: 5 })
  const byPid = new Map()
  for (const e of a.events) {
    if (e.kind !== 'proc-start') continue
    // Last write wins: a pid can be reused, and the newest start is the one that matters.
    byPid.set(Number(e.pid), e)
  }
  const chain = []
  let cur = Number(pid)
  const seen = new Set()
  for (let i = 0; i < maxDepth && cur && !seen.has(cur); i++) {
    seen.add(cur)
    const rec = byPid.get(cur)
    if (!rec) break
    chain.push({
      pid: rec.pid,
      ppid: rec.ppid,
      name: rec.name,
      // Records written before redaction existed still carry whatever the command line held, so
      // the value is redacted again on the way out. The write point is the real defence; this
      // covers the archive behind it.
      cmd: redactCommandLine(rec.cmd),
      user: rec.user,
      started: rec.t,
    })
    cur = Number(rec.ppid)
  }
  return { pid: Number(pid), depth: chain.length, chain, source: a.dir, recorded: byPid.size }
}
