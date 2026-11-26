/**
 * Plugins: a program with a name, so the page is usable without writing JavaScript first.
 *
 * Why this is a file and not a button in the markup
 * -------------------------------------------------
 * The page already has an editor, and an empty editor is only useful to somebody who already knows
 * what to type. Every routine question this tool answers -- is the daemon healthy, what is running,
 * has anything looked like stealth, is the uv cache holding something in use -- is four or five lines
 * that do not change. Those lines belong in a file that can be read, diffed, and corrected, not in the
 * habit of whoever is at the keyboard.
 *
 * A plugin is therefore one `.js` file whose program runs unchanged through `runProgram`: the same
 * sandbox, the same bindings, the same failure taxonomy. This module adds a name and a way to find it,
 * and nothing else. There is no second execution path to keep in step, which is the whole point.
 *
 * The metadata is comments
 * ------------------------
 * `// name: ...`, `// description: ...`, `// needs: a, b` at the top of the file, rather than a JSON
 * wrapper with the program inside a string. A JSON file would mean every quote and every newline in
 * the program is escaped, and the thing a reader wants to look at becomes the hardest part to read.
 * The cost is that the loader parses three comment lines; the benefit is that the file is a program
 * that can be pasted somewhere else and still be one.
 *
 * What `needs` is for
 * -------------------
 * A plugin that calls `volcano_quiesce` cannot run unless the server was started with
 * `--allow-quiesce`, and a plugin listed on a page where it cannot work is worse than an absent one:
 * it looks like a bug in the tool rather than a switch somebody did not turn on. So a plugin declares
 * the bindings it needs, and the page only lists it when all of them exist. The check is a name
 * lookup, not an execution -- nothing is run to find out.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const PLUGIN_FORMAT = 'vsep-plugin/1'

/** A plugin's program is passed to `runProgram` untouched, so the same ceiling applies. */
const MAX_PLUGINS = 64
const MAX_PROGRAM_BYTES = 32 * 1024

/**
 * The three directives, read from the comment block at the top of the file.
 *
 * Deliberately not a general front-matter parser: the fields are fixed, they are all on one line, and
 * a plugin that needs more than three lines of metadata is a plugin whose description got away from it.
 */
function parseHeader(source) {
  const meta = { name: null, description: null, needs: [] }
  const lines = source.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('//')) break
    const m = /^\/\/\s*(name|description|needs)\s*:\s*(.+)$/i.exec(trimmed)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim()
    if (key === 'needs') {
      meta.needs = value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    } else {
      meta[key] = value
    }
  }
  return meta
}

/**
 * Read one directory of plugins. A file that cannot be read, is too large, or has no name is reported
 * as a problem and skipped -- one bad file must not hide the others, and a loader that throws on the
 * first one makes a directory of nine plugins into a directory of none.
 */
export function loadPlugins(dir) {
  const plugins = []
  const problems = []
  if (!dir) return { plugins, problems }

  let names
  try {
    names = readdirSync(dir)
  } catch (e) {
    return { plugins, problems: [`cannot read ${dir}: ${e?.message ?? e}`] }
  }

  for (const file of names.sort()) {
    if (!file.endsWith('.js')) continue
    const path = join(dir, file)
    try {
      if (!statSync(path).isFile()) continue
      const source = readFileSync(path, 'utf8')
      if (Buffer.byteLength(source) > MAX_PROGRAM_BYTES) {
        problems.push(`${file}: program exceeds ${MAX_PROGRAM_BYTES} bytes and was skipped`)
        continue
      }
      const meta = parseHeader(source)
      if (!meta.name) {
        problems.push(`${file}: no "// name:" line, so it cannot be listed`)
        continue
      }
      plugins.push({
        id: file.replace(/\.js$/, ''),
        file,
        name: meta.name,
        description: meta.description ?? '',
        needs: meta.needs,
        program: source,
      })
      if (plugins.length > MAX_PLUGINS) {
        problems.push(`more than ${MAX_PLUGINS} plugins in ${dir}; the rest were ignored`)
        break
      }
    } catch (e) {
      problems.push(`${file}: ${e?.message ?? e}`)
    }
  }
  return { plugins, problems }
}

/** The plugin ids, for the discovery endpoint. The program itself is included: this is a local page. */
export function pluginsForPage(plugins, available) {
  const have = new Set(available)
  return plugins.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    needs: p.needs,
    runnable: p.needs.every((n) => have.has(n)),
    missing: p.needs.filter((n) => !have.has(n)),
    program: p.program,
  }))
}
