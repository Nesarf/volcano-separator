#!/usr/bin/env node
/**
 * Syntax-check every module.
 *
 * The npm script this replaces named three files -- lib/core.mjs, lib/mcp.mjs, bin/cli.mjs --
 * which was all there was when it was written. By the time the split was finished there were
 * thirteen modules in lib/ alone, and the script had quietly become a check on a fifth of the
 * codebase while still reporting success. A check that names its subjects by hand goes stale the
 * first time a file is added, and it goes stale silently.
 *
 * So this discovers them instead.
 *
 * Run:  node test/syntax.mjs      (npm run syntax)
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const files = []
for (const dir of ['lib', 'bin', 'test']) {
  for (const f of readdirSync(join(root, dir))) {
    if (f.endsWith('.mjs')) files.push(join(dir, f))
  }
}
files.sort()

let failed = 0
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', join(root, f)], { encoding: 'utf8' })
  if (r.status !== 0) {
    failed++
    console.log(`  FAIL ${f}`)
    console.log((r.stderr ?? '').split(/\r?\n/).slice(0, 4).map((l) => '       ' + l).join('\n'))
  }
}

console.log(failed === 0 ? `  ${files.length} module(s) parse` : `  ${failed} of ${files.length} module(s) do not parse`)
process.exit(failed === 0 ? 0 : 1)
