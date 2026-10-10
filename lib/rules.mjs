import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The detection rules, as data rather than as three `add({ rule: '...' })` literals spread through a
 * loop.
 *
 * **What this is for, and what it is not.** The detections themselves cannot become data: deciding that
 * something ran from a scratch directory means parsing a command line and testing a path, which is
 * code. What becomes data is each rule's *identity and intent* — and that turns out to be the part the
 * promotion gate needs.
 *
 * The gate could previously say "no ask has fired" and nothing more, because the only record was a
 * total. A total cannot answer the question that matters when nothing has fired: **which rule is
 * silent?** A rule that has never once fired on this machine may be waiting for something rare, or may
 * be unable to fire at all, and those look identical from a count of zero.
 *
 * The idea is borrowed deliberately and cheaply: YARA's contribution is not its scanner, it is that a
 * detection rule is a *thing with a name, a version and a declared intent*, which can be listed,
 * diffed and explained. Nothing here is a new dependency.
 *
 * **What is honestly still missing.** The conditions are declared as prose in `detectsWhy`, not as
 * data. Making them loadable would mean an expression language, and an expression language that
 * silently matches nothing is a worse failure than a rule that has to be written in code — it is the
 * same defect this project keeps removing, one level up. So the condition stayed in code and *says so*.
 */
export const RULES = {
  'persist-from-ephemeral': {
    severity: 'high',
    /** What it looks for, in one line. */
    detects: 'a persistence surface added from a directory that exists to be disposable',
    /** Why that is worth interrupting somebody for. */
    intent:
      'Persistence is how something survives a reboot. Persistence registered from a cache, temp or ' +
      'download directory is the shape of an installer that installs itself and then hides: the ' +
      'surviving part may be in a place that gets cleaned, and the thing it points at is in one.',
    /** The condition, in prose, because it lives in code -- and saying so is the point. */
    detectsWhy:
      'code: signals.mjs checks `kind === "persist"`, skips removals, and tests the value against the ' +
      'scratch roots',
    /** What has to be true for this rule to be able to fire at all. */
    needs: 'a persist event whose value sits under a scratch root',
    calibrated: false,
  },

  'exec-from-ephemeral': {
    severity: 'low',
    detects: 'an executable that ran from a directory that exists to be disposable',
    intent:
      'Programs that run from a download or temp directory are usually innocent -- portable tools, ' +
      'builds, installers unpacking themselves -- which is why this is the only rule ranked low. It is ' +
      'kept because the innocent majority is exactly what makes the guilty case easy to miss.',
    detectsWhy:
      'code: signals.mjs parses the executable token out of the command line with `exeFromCmd` and ' +
      'tests that path against the scratch roots. The argument list is deliberately not examined: ' +
      '`bash.exe` in Program Files carrying a scratch path as an argument is not a program running ' +
      'from scratch, and conflating the two was measured to produce 1,031 false candidates.',
    needs: 'a process start whose executable token is an absolute path under a scratch root',
    calibrated: false,
  },

  'binary-vanished': {
    severity: 'high',
    detects: 'a process running from an executable path that no longer exists',
    intent:
      'A running process whose image has been deleted is self-deleting behaviour, or a file removed ' +
      'while it was in use. Either way the machine can no longer say what that process is, and ' +
      '"cannot say" is the thing this tool exists to remove.',
    detectsWhy:
      'code: signals.mjs checks that the parsed executable is absolute, is not under the system root, ' +
      'and does not exist on disk now',
    needs: 'a process start whose executable existed then and does not exist now',
    calibrated: false,
  },
}

export const RULE_IDS = Object.keys(RULES)

/**
 * One rule, or a refusal.
 *
 * A caller asking for a rule that is not in the table asked a question with no answer, and returning
 * `undefined` would let a finding be recorded with no rule attached -- which reads, later, as a rule
 * named `undefined` that fired. Refusing is the same rule this project applies to an unknown service
 * descriptor: an answer the caller has to see.
 */
export function rule(id) {
  const r = RULES[id]
  if (!r) {
    return {
      ok: false,
      detail: `no detection rule named '${id}' (have: ${RULE_IDS.join(', ')})`,
    }
  }
  return { ok: true, id, severity: r.severity, rule: r }
}

/**
 * The rules file that an operator can read, and that a test asserts matches this table.
 *
 * Kept in step by a check rather than by discipline, because two lists of the same thing drift, and
 * the direction they drift in is always the same: the code gains a rule and the document does not.
 */
export const RULES_DOC = join(dirname(fileURLToPath(import.meta.url)), '..', 'RULES.md')

export function rulesDocText() {
  try {
    return readFileSync(RULES_DOC, 'utf8')
  } catch {
    return null
  }
}
