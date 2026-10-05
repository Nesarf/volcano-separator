/**
 * Command lines: reading the executable out of one, and removing secrets from one.
 *
 * Extracted from core.mjs. These are opposite halves of the same problem -- a command line is
 * often the only thing that distinguishes an expected process from an unexpected one, and for
 * that same reason it is where credentials travel. They are also the only code here that
 * understands how a Windows command line is escaped, so they belong together rather than beside
 * the rules that consume them.
 *
 * The build notes below moved across unchanged. They are the record of what each rule got wrong
 * before it was right, which is the only reason to keep them.
 */
/**
 * Redact secrets from a command line.
 *
 * The recorder stores full command lines, because a command line is often the only thing that
 * distinguishes an expected process from an unexpected one. But it is also where secrets travel,
 * and the log is append-only: a token written once is written for good.
 *
 * The authoritative redaction happens at the WRITE point, in bin/redact.ps1, before the line
 * reaches disk. Redacting only on display would leave the secret in the file and merely hide it
 * from the default view -- worse than not redacting, because it looks safe. This function exists
 * for the two jobs that leaves: rendering records written before redaction existed, and giving the
 * rules a second implementation to be checked against. The smoke suite feeds identical input to
 * both and fails if they disagree, so adding a flag name here means adding it there too.
 *
 * The rules are deliberately narrow. Only values following an explicit secret-bearing flag, an
 * assignment to a secret-looking name, an Authorization/Bearer header, or URL credentials. Long
 * random-looking strings are NOT redacted: hashes, GUIDs, build ids and base64 in ordinary
 * arguments are common, and a rule that guesses would either bury the log in placeholders or teach
 * people to ignore them.
 *
 * The executable token is never touched -- exeFromCmd below parses it out of this same string.
 */
export const REDACTED = '<redacted>'

const SECRET_FLAG_NAMES = [
  'token', 'password', 'passwd', 'pwd', 'secret', 'passphrase',
  'apikey', 'api-key', 'api_key',
  'auth', 'authorization', 'credential', 'credentials',
  'accesskey', 'access-key', 'access_key',
  'privatekey', 'private-key', 'private_key',
  'clientsecret', 'client-secret', 'client_secret',
  'bearer', 'sessionkey', 'session-key', 'session_key',
]

const FLAG_ALT = SECRET_FLAG_NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
const RE_SECRET_FLAG = new RegExp(`(--?(?:${FLAG_ALT}))(\\s*=\\s*| +)("[^"]*"|'[^']*'|\\S+)`, 'gi')
const RE_SECRET_ASSIGN = /\b([A-Za-z_][A-Za-z0-9_-]*(?:TOKEN|PASSWORD|PASSWD|SECRET|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)[A-Za-z0-9_-]*)=(\S+)/gi
// An optional scheme word, then a value ending at a quote or whitespace. Three bugs were found
// here by running it rather than reading it, and this shape is what survived: consuming only
// `authorization:` ate the word Bearer and left the token in the clear; a greedy \S+ swallowed the
// closing quote of the enclosing argument; and `Authorization: Basic <base64>` stopped at the space
// after the scheme and left the credentials exposed. The quote belongs to the enclosing argument,
// so the value class excludes it rather than the replacement re-adding it.
const RE_AUTHORIZATION = /(authorization\s*:\s*)(?:[A-Za-z][A-Za-z0-9-]*\s+)?[^"\s']*/gi
const RE_BEARER = /\b(bearer\s+)([A-Za-z0-9._~+/-]+=*)/gi
const RE_URL_CREDENTIALS = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:/\s@]+:)([^@/\s]+)(@)/g
// mysql-style -pSECRET, concatenated only: `-p 5432` is a port and must survive.
const RE_ATTACHED_P = /(\s-p)([A-Za-z_][A-Za-z0-9_!@#%^&*.-]{2,})/gi

export function redactCommandLine(cmd) {
  if (cmd === null || cmd === undefined) return cmd
  let s = String(cmd)
  if (!s) return s

  s = s.replace(RE_SECRET_FLAG, (m, flag, sep, val) => {
    const quoted = val.length > 1 && (val[0] === '"' || val[0] === "'") ? val[0] : ''
    return flag + sep + quoted + REDACTED + quoted
  })
  s = s.replace(RE_SECRET_ASSIGN, (m, name) => name + '=' + REDACTED)
  s = s.replace(RE_AUTHORIZATION, (m, head) => head + REDACTED)
  s = s.replace(RE_BEARER, (m, head) => head + REDACTED)
  s = s.replace(RE_URL_CREDENTIALS, (m, head, secret, at) => head + REDACTED + at)
  s = s.replace(RE_ATTACHED_P, (m, head) => head + REDACTED)
  return s
}

/**
 * The executable from a captured command line, normalised, or null if we cannot be sure.
 *
 * Returning null matters more than it looks. The first version of the `binary-vanished` rule
 * used the raw first token and fired 48 times in an hour, almost all of it wrong:
 *   \??\C:\Windows\system32\conhost.exe   an NT-prefixed path that no filesystem call accepts
 *   ssh                                   a bare command name with no path at all
 *   a path the user had since renamed     a true statement about a file, and useless as a signal
 * A rule that cannot be checked must decline to fire.
 */

const BS = String.fromCharCode(92)
const NT_PREFIX = BS + BS + '?' + '?' + BS
const UNC_PREFIX = BS + BS
const ABS_PATH = new RegExp('^[a-zA-Z]:[' + BS + BS + '/]')

const SYS_ROOT = new RegExp('^[a-zA-Z]:[' + BS + BS + '/](windows|program files)', 'i')

/**
 * Is this path inside a system directory, where the rules should not be judging? Boundary
 * detail (which directories, which slash) stays on this side of the module line -- callers ask
 * the question, they do not get the regex.
 */
export function isSystemRoot(p) {
  return !!p && SYS_ROOT.test(p)
}

export function exeFromCmd(cmd) {
  if (!cmd) return null
  const s = String(cmd).trim()
  let tok
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1)
    if (end <= 0) return null
    tok = s.slice(1, end)
  } else {
    const sp = s.indexOf(' ')
    tok = sp === -1 ? s : s.slice(0, sp)
  }
  if (!tok) return null
  // Backslashes are built from their code point on purpose: this file has been through enough
  // escaping layers that a literal one does not reliably survive being written.
  if (tok.startsWith(NT_PREFIX)) tok = tok.slice(NT_PREFIX.length)
  if (!ABS_PATH.test(tok) && !tok.startsWith(UNC_PREFIX)) return null
  return tok
}
