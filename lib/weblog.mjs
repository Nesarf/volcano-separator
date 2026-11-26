/**
 * Reading back the log `vos web timed` writes.
 *
 * The server keeps a timestamped log per start so that a run which went wrong is still on disk after
 * the next one has scrolled the terminal away -- but until now nothing could read one, so the only way
 * to answer "did vos itself complain while I was repairing the host" was to open the file by hand.
 * That is the one question an agent asks immediately after changing something, which made this the
 * largest remaining hole in what it can check about itself.
 *
 * Two facts the reader needs and the filename alone cannot give:
 *
 *   * **Which directory.** `--log-dir` moves the logs (this machine keeps them beside the dsh ones on
 *     D:), and the default is `~/.volcano-separator/logs`, so a reader that assumed either would be
 *     wrong on the other machine. The server therefore records where it wrote when it starts.
 *   * **Which start is current.** A `timed` log whose file is empty is not a missing log: it is a start
 *     that said nothing. Reporting "0 bytes" without saying that the previous run had content is the
 *     shape this project keeps removing -- an absence that reads as a fault when it is a fact.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const NL = String.fromCharCode(10)

export const STATE_FILE = join(homedir(), '.volcano-separator', 'web.last.json')
export const DEFAULT_LOG_DIR = join(homedir(), '.volcano-separator', 'logs')

/** `vos-web-20261127-042139.log` -> `2026-11-27T04:21:39`, or null for anything else. */
export function startFromName(name) {
  const m = /^vos-web-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.log$/.exec(name)
  if (!m) return null
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`
}

/**
 * Recorded at start-up by `vos web timed`, rewritten when it exits.
 *
 * The state file exists because the reader is a *different process* from the server -- the MCP surface
 * is loaded by the host, the web surface is typed by a person -- so nothing in memory is shared and the
 * directory has to be written down somewhere both can see.
 */
export function recordWebStart(record, { path = STATE_FILE, logger = () => {} } = {}) {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(record, null, 2) + NL)
    return { ok: true, path }
  } catch (e) {
    // A log nobody can find is worth less than a start that says why it could not record one.
    const why = e?.message ?? String(e)
    logger(`web: could not record the log location at ${path}: ${why}`)
    return { ok: false, path, why }
  }
}

/** Merge a patch into whatever the start wrote. Absent state is left absent rather than invented. */
export function recordWebStop(patch, { path = STATE_FILE, logger = () => {} } = {}) {
  const now = readWebState({ path })
  if (!now.known) return { ok: true, skipped: 'no start was recorded' }
  try {
    const merged = { ...now.record, ...patch }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(merged, null, 2) + NL)
    return { ok: true, path, record: merged }
  } catch (e) {
    const why = e?.message ?? String(e)
    logger(`web: could not update ${path} on the way out: ${why}`)
    return { ok: false, path, why }
  }
}

export function readWebState({ path = STATE_FILE } = {}) {
  if (!existsSync(path)) {
    return {
      known: false,
      path,
      // Three causes, and the first one is not a fault: a surface started before this record existed
      // leaves nothing behind, and saying "started without timed" about that start would send somebody
      // looking for a switch they did set.
      detail: 'no web start has been recorded here -- the surface was started before this record existed, ' +
        'without timed, or by another account',
    }
  }
  let record = null
  try {
    record = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return { known: false, path, detail: 'the record exists but could not be read' }
  }
  return { known: true, path, record }
}

/** Every `vos-web-*.log` in a directory, newest start first. */
export function listWebLogs(dir) {
  if (!dir || !existsSync(dir)) {
    return { dir, logs: [], detail: dir ? `no such directory: ${dir}` : 'no directory given' }
  }
  let names = []
  try {
    names = readdirSync(dir).filter((f) => startFromName(f))
  } catch (e) {
    return { dir, logs: [], detail: `could not list ${dir}: ${e?.message ?? e}` }
  }
  const logs = names.map((name) => {
    const file = join(dir, name)
    let bytes = null
    let writtenAt = null
    try {
      const st = statSync(file)
      bytes = st.size
      writtenAt = st.mtime.toISOString()
    } catch {
      /* counted as unknown rather than as zero: an unreadable file is not an empty one */
    }
    return { name, file, start: startFromName(name), bytes, writtenAt }
  })
  logs.sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : 0))
  return { dir, logs }
}

/**
 * The tail of one log, plus the thing a bare tail cannot say: whether any other start has content.
 *
 * `empty` is reported as its own fact. A start that wrote nothing is not a missing run and it is not a
 * failure -- `--json` prints one line to stdout and nothing through this log -- and both of the wrong
 * readings lead somebody to hunt a problem that does not exist.
 */
export function readWebLog({ dir = DEFAULT_LOG_DIR, file = null, limit = 40 } = {}) {
  const listing = listWebLogs(dir)
  if (!listing.logs.length) {
    return { ok: false, dir, logs: [], detail: listing.detail ?? `no vos-web logs under ${dir}`, file: null, lines: [] }
  }
  const target = file
    ? listing.logs.find((l) => l.name === file || l.name.startsWith(file)) ?? null
    : listing.logs[0]
  if (!target) {
    return {
      ok: false,
      dir,
      logs: listing.logs.map((l) => l.name),
      detail: `no log matching ${file} among ${listing.logs.length} file(s)`,
      file: null,
      lines: [],
    }
  }

  let text = ''
  let readFailure = null
  try {
    text = readFileSync(target.file, 'utf8')
  } catch (e) {
    readFailure = e?.message ?? String(e)
  }
  const all = readFailure ? [] : text.split(/\r?\n/).filter((l) => l.trim())
  const cap = Math.max(1, Math.min(2000, Number(limit) || 40))
  const lines = all.slice(-cap)

  // The other starts, so "this one wrote nothing" arrives beside "the previous one wrote 1.3 KB"
  // rather than on its own.
  const others = listing.logs.filter((l) => l.name !== target.name)
  const newestWithContent = others.find((l) => Number(l.bytes) > 0) ?? null

  return {
    ok: !readFailure,
    dir,
    file: target.file,
    start: target.start,
    bytes: target.bytes,
    writtenAt: target.writtenAt,
    empty: all.length === 0,
    total: all.length,
    shown: lines.length,
    lines,
    readFailure,
    others: others.length,
    newestWithContent,
    detail: readFailure
      ? `could not read ${target.file}: ${readFailure}`
      : all.length === 0
        ? `this start wrote no line at all${newestWithContent ? `; the newest start with content is ${newestWithContent.name} (${newestWithContent.bytes} bytes)` : ''}`
        : `${all.length} line(s), showing the last ${lines.length}`,
  }
}
