import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { CORE_ROOT, readJsonLoose, run } from './platform.mjs'
// readJsonLoose, not JSON.parse: PowerShell's Set-Content -Encoding UTF8 writes a BOM, and a
// leading U+FEFF makes JSON.parse throw. This project already paid a whole debugging round for
// that byte once -- the file existed, the poll saw it, and every parse failed silently -- so the
// helper exists and this is what it is for. The first version of isolatedFiles used JSON.parse
// and reported every journal as unreadable.
import { activityDir } from './activity.mjs'

/**
 * Enforcement: the acts this tool can take against a file, and their undo.
 *
 * Deliberately separate from custody.mjs. Custody acts on a running *process* -- it freezes, reveals
 * and asks. This acts on a *file* -- it stops the file being launched again, and it can put that
 * back. Different subject, different failure modes, and keeping them in one file invited reading
 * this one as more than a door lock.
 *
 * Why the undo is the OS's own tooling
 * ------------------------------------
 * The ACL is saved with `icacls /save` and restored with `icacls /restore`. That is not laziness: the
 * undo must not depend on this tool, this module, or this machine's copy of either. If
 * volcano-separator is deleted, or broken, or the machine only boots to a recovery prompt, the
 * restore still works -- and every result below prints the command that does it, because an undo
 * nobody can find is not an undo.
 *
 * Why the journal is not in the cache directory
 * ---------------------------------------------
 * A cache is something a person is invited to clean. The journal lives beside the policy, because
 * undoing a decision about this machine is itself a decision about this machine.
 *
 * What this does not defend against, stated plainly
 * -------------------------------------------------
 * Anyone with administrative rights can take ownership of the file and put the ACL back. The lock is
 * aimed at software that relaunches itself, not at an adversary, and the README says the same thing.
 */

const SCRIPT_NAME = 'isolate.ps1'

/** Where the ACL backups and their journals live. Beside the policy, never in a prunable place. */
export function isolationJournalDir(ctx) {
  return ctx.isolationJournalDir ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.volcano-separator', 'acl')
}

function psArgs(script, extra) {
  return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...extra]
}

function parseLastJson(stdout) {
  const last = (stdout ?? '').split(String.fromCharCode(10)).filter(Boolean).pop() || '{}'
  try {
    return JSON.parse(last)
  } catch {
    return null
  }
}

async function callScript(ctx, extra, { timeoutMs = 180000 } = {}) {
  const script = join(CORE_ROOT, 'bin', SCRIPT_NAME)
  if (!existsSync(script)) return { ok: false, detail: `isolation script missing: ${script}` }
  const r = await run(process.platform === 'win32' ? 'powershell.exe' : 'pwsh', psArgs(script, extra), { timeoutMs })
  const parsed = parseLastJson(r.stdout)
  if (parsed) return { ok: parsed.ok !== false, ...parsed }
  return {
    ok: false,
    detail: r.timedOut ? `the isolation script did not finish within ${timeoutMs} ms` : (r.error ?? 'the isolation script produced no result'),
    raw: (r.stdout ?? '').slice(-400),
    stderr: (r.stderr ?? '').slice(-400),
  }
}

/**
 * Deny a file the right to execute, reversibly.
 *
 * Give a path, or a pid whose executable path can be read. The answer says what was done, where the
 * undo lives, and -- if processes are already running from that file -- that they are unaffected,
 * because a lock on a file does not reach into a process that is already mapped.
 */
export async function isolate(ctx, { path = '', pid = 0, dryRun = false, includeSystemRoot = false } = {}) {
  const extra = []
  if (path) extra.push('-TargetPath', path)
  if (Number(pid) > 0) extra.push('-TargetPid', String(Number(pid)))
  if (!path && !(Number(pid) > 0)) return { ok: false, detail: 'give a path or a pid' }
  extra.push('-JournalDir', isolationJournalDir(ctx))
  const act = activityDir(ctx)
  if (act) extra.push('-ActivityDir', act)
  if (dryRun) extra.push('-DryRun')
  if (includeSystemRoot) extra.push('-IncludeSystemRoot')
  return callScript(ctx, extra)
}

/** Put the original ACL back, using a journal this tool wrote earlier. */
export async function restoreIsolation(ctx, { journal } = {}) {
  if (!journal) return { ok: false, detail: 'give the journal file printed by `isolate`' }
  const extra = ['-Restore', '-TargetPath', journal, '-JournalDir', isolationJournalDir(ctx)]
  const act = activityDir(ctx)
  if (act) extra.push('-ActivityDir', act)
  return callScript(ctx, extra)
}

/**
 * Every isolation this tool has applied and not yet undone, read from the journals.
 *
 * The journals are the state, so this is a directory read rather than a query against the activity
 * log: the log is the history and the journal is what is true now, and only one of those answers
 * "what is currently locked". A journal whose file has since been unlocked by hand is reported as
 * such rather than assumed still locked -- the ACL is the authority, not our record of it.
 */
export function isolatedFiles(ctx) {
  const dir = isolationJournalDir(ctx)
  if (!existsSync(dir)) return { ok: true, dir, entries: [] }
  const entries = []
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    let spec = null
    try {
      spec = readJsonLoose(join(dir, f))
    } catch {
      entries.push({ journal: join(dir, f), state: 'unreadable' })
      continue
    }
    entries.push({
      journal: join(dir, f),
      id: spec.id,
      path: spec.path,
      at: spec.at,
      state: spec.state,
      backupExists: spec.backupFile ? existsSync(spec.backupFile) : false,
      restoreCommand: spec.restoreCommand,
      // Whether it is denied right now is not recorded here, because it can be changed by hand. The
      // caller that needs the live answer asks the filesystem.
    })
  }
  return { ok: true, dir, entries }
}
