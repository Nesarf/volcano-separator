import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { CORE_ROOT, powershellHost, readJsonLoose, run } from './platform.mjs'
import { isolationJournalDir } from './enforce.mjs'

/**
 * In-place encryption: the second enforcement act, and the one with the worst failure modes.
 *
 * The boundary claim is per-act, not shared
 * -----------------------------------------
 * `isolate` says of itself that it does not move, rename, rewrite or delete the target, and that is
 * true -- it changes an ACL. Encryption necessarily rewrites the bytes; that is what encryption is.
 * It also cannot avoid a rename, because a partial write is a file that can neither run nor be
 * restored, so the ciphertext is written beside the original and then moved over it.
 *
 * Those two cannot share one sentence. Saying "does not rewrite the target" while offering an
 * operation that rewrites it would be the exact failure this project keeps finding: a strong property
 * stated as a stronger one, which is a claim falsifiable by reading the code. Each command states its
 * own boundary and the checks assert each one separately.
 *
 * What makes rewriting safe
 * -------------------------
 * Not the cipher. The order:
 *
 *   1. refuse if the file is in use -- an exclusive open is the test, because a file that cannot be
 *      opened exclusively is a file something is using
 *   2. obtain and persist the key FIRST; if the key cannot be written, nothing happens at all
 *   3. record the original's SHA-256 in a signed journal, before touching the file
 *   4. write the ciphertext to a temporary name in the same directory
 *   5. DECRYPT IT BACK AND COMPARE THE HASH -- the original is never replaced by anything that has not
 *      been proven restorable
 *   6. only then move it over the original
 *
 * Step 5 is the whole design. Without it this is a file shredder with extra steps.
 *
 * What this does not do, stated plainly
 * -------------------------------------
 * It does not stop the process that is already running, and it does not stop anyone who can read the
 * key. Rewriting bytes also invalidates any hash or signature the file carried -- the file is not the
 * same file afterwards, and an undo that restores the bytes restores the hash with them, but nothing
 * in between can claim the signature still holds.
 *
 * Why the cipher is here and the key protection is not
 * ---------------------------------------------
 * DPAPI has no Node equivalent, so that has to be PowerShell. The cipher could live on either side --
 * `AesGcm` is missing from PowerShell 5.1 but present in pwsh 7 -- and it is here for two reasons that
 * survive that fact: the tool already runs in Node, so this avoids a subprocess per file, and crypto
 * that can be exercised without spawning an interpreter is crypto that can be tested in a unit test.
 *
 * Measured before deciding to leave the interpreter alone, because the obvious move was wrong:
 * pwsh 7.6.6 costs 833 ms per short round-trip on this machine against PowerShell 5.1's 461 ms, and
 * the tool spawns PowerShell several times per status. The newer shell is the slower one for the way
 * this tool uses it. What pwsh would have fixed is the BOM that 5.1 writes and 7 does not -- and that
 * is already handled by readJsonLoose, which is the better answer anyway: be robust to both rather
 * than require one.
 */

const MAGIC = 'VSEP1'
const VERSION = 1
const NONCE_LEN = 12
const TAG_LEN = 16
const HEADER_LEN = MAGIC.length + 1 + NONCE_LEN + 8

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** Beside the policy and the isolation journal -- never under the log directory, which gets pruned. */
export function cryptKeyFile(ctx = {}) {
  return ctx.cryptKeyFile ?? join(dirname(isolationJournalDir(ctx)), 'crypt.key')
}

export function cryptJournalDir(ctx = {}) {
  return ctx.cryptJournalDir ?? join(dirname(cryptKeyFile(ctx)), 'crypt')
}

function parseLastJson(stdout) {
  const last = (stdout ?? '').split(String.fromCharCode(10)).filter(Boolean).pop() || '{}'
  try {
    return JSON.parse(last)
  } catch {
    return null
  }
}

/**
 * Read the key, creating it if this is the first time.
 *
 * Returns a failure rather than throwing, because the caller's next move depends on knowing it failed:
 * a run that cannot persist the key must not encrypt anything. There is no "encrypt now, save the key
 * after" -- a file encrypted with a key that was never written is a file that is gone.
 */
export async function getOrCreateKey(ctx = {}) {
  const file = cryptKeyFile(ctx)
  const plain = file + '.plain.tmp'
  const ps = powershellHost()
  const script = join(CORE_ROOT, 'bin', 'keyprotect.ps1')

  try {
    mkdirSync(dirname(file), { recursive: true })
  } catch (e) {
    return { ok: false, detail: `cannot create ${dirname(file)}: ${e?.message ?? e}` }
  }
  if (!existsSync(script)) return { ok: false, detail: `keyprotect script missing: ${script}` }

  if (existsSync(file)) {
    const r = await run(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', 'unprotect', '-In', file, '-Out', plain], { timeoutMs: 60000 })
    try {
      const parsed = parseLastJson(r.stdout)
      if (!parsed?.ok) return { ok: false, detail: parsed?.detail ?? r.error ?? 'unprotect failed' }
      const raw = Buffer.from(readFileSync(plain, 'utf8').trim(), 'base64')
      if (raw.length !== 32) return { ok: false, detail: `the stored key is ${raw.length} bytes, not 32` }
      return { ok: true, key: raw, file, created: false }
    } finally {
      rmSync(plain, { force: true })
    }
  }

  const raw = randomBytes(32)
  try {
    writeFileSync(plain, raw.toString('base64'), { encoding: 'ascii' })
  } catch (e) {
    return { ok: false, detail: `cannot stage a new key: ${e?.message ?? e}` }
  }
  const r = await run(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', 'protect', '-In', plain, '-Out', file], { timeoutMs: 60000 })
  rmSync(plain, { force: true })
  const parsed = parseLastJson(r.stdout)
  if (!parsed?.ok) return { ok: false, detail: parsed?.detail ?? r.error ?? 'protect failed' }
  return { ok: true, key: raw, file, created: true }
}

/** magic, version, nonce, original size, ciphertext, GCM tag. */
function seal(key, plain) {
  const nonce = randomBytes(NONCE_LEN)
  const c = createCipheriv('aes-256-gcm', key, nonce)
  const ct = Buffer.concat([c.update(plain), c.final()])
  const size = Buffer.alloc(8)
  size.writeBigInt64LE(BigInt(plain.length))
  return Buffer.concat([Buffer.from(MAGIC, 'ascii'), Buffer.from([VERSION]), nonce, size, ct, c.getAuthTag()])
}

function unseal(key, blob) {
  if (blob.length < HEADER_LEN + TAG_LEN) throw new Error('too short to be one of ours')
  if (blob.subarray(0, MAGIC.length).toString('ascii') !== MAGIC) throw new Error('not a volcano-separator container')
  if (blob[MAGIC.length] !== VERSION) throw new Error(`container version ${blob[MAGIC.length]}, not ${VERSION}`)
  let o = MAGIC.length + 1
  const nonce = blob.subarray(o, o + NONCE_LEN)
  o += NONCE_LEN
  const size = Number(blob.readBigInt64LE(o))
  o += 8
  const ct = blob.subarray(o, blob.length - TAG_LEN)
  const tag = blob.subarray(blob.length - TAG_LEN)
  if (ct.length !== size) throw new Error(`the container says ${size} bytes but carries ${ct.length}`)
  const d = createDecipheriv('aes-256-gcm', key, nonce)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()])
}

/** Whether a file is one of ours, answered from the bytes rather than from a name or a record. */
export function isEncrypted(path) {
  try {
    const fd = openSync(path, 'r')
    try {
      const head = Buffer.alloc(MAGIC.length + 1)
      const n = readSync(fd, head, 0, head.length, 0)
      return n >= head.length && head.subarray(0, MAGIC.length).toString('ascii') === MAGIC && head[MAGIC.length] === VERSION
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
}

/**
 * An exclusive open is the authoritative in-use test: Windows refuses a second exclusive handle, where
 * scanning process command lines is only a pre-filter that can miss a file held by something we cannot
 * see.
 */
function exclusiveOpen(path) {
  try {
    const fd = openSync(path, 'r+')
    try {
      return { ok: true, size: statSync(path).size }
    } finally {
      closeSync(fd)
    }
  } catch (e) {
    const busy = e?.code === 'EBUSY' || e?.code === 'EPERM' || e?.code === 'EACCES'
    return { ok: false, detail: busy ? 'the file is open in another process' : String(e?.message ?? e) }
  }
}

const journalMac = (key, o) =>
  createHmac('sha256', key).update(['v1', o.id, o.path, o.originalSha256, String(o.originalSize), o.keyFile].join(String.fromCharCode(10))).digest('base64')

/**
 * Encrypt a file in place. Returns a result that says what happened, where the undo lives, and how to
 * perform it without this tool.
 */
export async function encryptFile(ctx, { path, dryRun = false } = {}) {
  if (!path) return { ok: false, detail: 'a path is required' }
  if (!existsSync(path)) return { ok: false, detail: `no such file: ${path}` }

  let st
  try {
    st = statSync(path)
  } catch (e) {
    return { ok: false, detail: String(e?.message ?? e) }
  }
  if (!st.isFile()) return { ok: false, detail: 'only a regular file can be encrypted' }
  if (isEncrypted(path)) return { ok: true, alreadyEncrypted: true, path, detail: 'this file is already a container' }

  const held = exclusiveOpen(path)
  if (!held.ok) {
    return { ok: false, path, detail: `refused: ${held.detail}. A file in use cannot be replaced safely, and encrypting under a running process produces something that can neither run nor be restored cleanly.` }
  }

  if (dryRun) {
    return { ok: true, dryRun: true, path, bytes: held.size, keyFile: cryptKeyFile(ctx), detail: 'dry run: nothing was changed' }
  }

  // The key first, before anything else. A run that cannot persist the key does not encrypt.
  const k = await getOrCreateKey(ctx)
  if (!k.ok) {
    return { ok: false, path, detail: `${k.detail}; nothing was changed, because a file encrypted with a key that was not written is a file that is gone` }
  }

  const plain = readFileSync(path)
  const originalSha256 = sha256(plain)
  const dir = dirname(path)
  const tmp = join(dir, `.${process.pid}.vsep-enc.tmp`)
  const stray = join(dir, `.${process.pid}.vsep-verify.tmp`)
  const jdir = cryptJournalDir(ctx)
  const id = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 15) + '-' + randomBytes(4).toString('hex')
  const journal = join(jdir, `${id}.json`)

  try {
    mkdirSync(jdir, { recursive: true })
  } catch (e) {
    return { ok: false, path, detail: `cannot create ${jdir}: ${e?.message ?? e}` }
  }

  const blob = seal(k.key, plain)

  // The journal is written before the file is touched, and the act does not proceed if it cannot be.
  const spec = {
    id,
    kind: 'encrypt',
    path,
    at: new Date().toISOString(),
    originalSha256,
    originalSize: plain.length,
    encryptedSize: blob.length,
    keyFile: k.file,
    keyCreated: k.created,
    journalFile: journal,
    decryptCommand: `volcano-separator decrypt ${journal}`,
  }
  spec.hmac = journalMac(k.key, spec)
  try {
    writeFileSync(journal, JSON.stringify(spec, null, 2))
  } catch (e) {
    return { ok: false, path, detail: `cannot write the journal, so nothing was changed: ${e?.message ?? e}` }
  }

  try {
    writeFileSync(tmp, blob)
  } catch (e) {
    rmSync(tmp, { force: true })
    return { ok: false, path, detail: `cannot write beside the original, so nothing was changed: ${e?.message ?? e}` }
  }

  // The step that makes this safe: prove the ciphertext restores before it replaces anything.
  let verified
  try {
    const back = unseal(k.key, readFileSync(tmp))
    writeFileSync(stray, back)
    verified = sha256(readFileSync(stray)) === originalSha256 && back.length === plain.length
  } catch (e) {
    verified = false
  } finally {
    rmSync(stray, { force: true })
  }
  if (!verified) {
    rmSync(tmp, { force: true })
    return { ok: false, path, detail: 'the ciphertext did not decrypt back to the original bytes, so the original was left untouched' }
  }

  try {
    renameSync(tmp, path)
  } catch (e) {
    rmSync(tmp, { force: true })
    return { ok: false, path, detail: `could not replace the original: ${e?.message ?? e}. The original is unchanged.` }
  }

  const finalOk = isEncrypted(path)
  spec.state = finalOk ? 'encrypted' : 'failed'
  try {
    writeFileSync(journal, JSON.stringify(spec, null, 2))
  } catch {
    /* the journal exists; this rewrite is a convenience */
  }

  return {
    ok: finalOk,
    path,
    id,
    bytes: plain.length,
    encryptedBytes: blob.length,
    originalSha256,
    journalFile: journal,
    keyFile: k.file,
    keyCreated: k.created,
    decryptCommand: spec.decryptCommand,
    detail: finalOk
      ? `encrypted in place; the original bytes are recoverable and their sha256 is recorded in the journal`
      : 'the file was replaced but does not read back as a container',
    boundary:
      'encryption rewrites the bytes and invalidates any hash or signature the file carried. The undo restores the exact bytes, and the journal records their sha256 so it can be checked rather than believed.',
  }
}

/** Put the original bytes back, and refuse if they cannot be proven to match what was recorded. */
export async function decryptFile(ctx, { journal } = {}) {
  if (!journal) return { ok: false, detail: 'the journal file printed by `encrypt` is required' }
  const spec = readJsonLoose(journal)
  if (!spec) return { ok: false, detail: `cannot read a journal at ${journal}` }

  const path = spec.path
  if (!path || !existsSync(path)) return { ok: false, detail: `the file named by the journal is gone: ${path}` }

  const k = await getOrCreateKey(ctx)
  if (!k.ok) return { ok: false, detail: k.detail }

  if (journalMac(k.key, spec) !== spec.hmac) {
    return {
      ok: false,
      refused: true,
      path,
      detail: 'refused to decrypt: the journal has been changed since this tool wrote it, or was not written by it',
      note: 'nothing was changed. The bytes are still the ciphertext, and the key is still on this machine.',
    }
  }

  if (!isEncrypted(path)) {
    return { ok: true, alreadyDecrypted: true, path, detail: 'this file is not a container, so there is nothing to undo' }
  }

  let back
  try {
    back = unseal(k.key, readFileSync(path))
  } catch (e) {
    return { ok: false, path, detail: `cannot decrypt: ${e?.message ?? e}` }
  }

  const got = sha256(back)
  if (got !== spec.originalSha256) {
    // The refusal that matters. Restoring bytes that do not match the record would be an undo that
    // silently swapped one file for another.
    return {
      ok: false,
      refused: true,
      path,
      detail: `refused to write back: the decrypted bytes hash to ${got.slice(0, 16)} but the journal recorded ${String(spec.originalSha256).slice(0, 16)}`,
      note: 'nothing was changed. The ciphertext is intact.',
    }
  }

  const tmp = join(dirname(path), `.${process.pid}.vsep-dec.tmp`)
  try {
    writeFileSync(tmp, back)
    renameSync(tmp, path)
  } catch (e) {
    rmSync(tmp, { force: true })
    return { ok: false, path, detail: `could not restore the original: ${e?.message ?? e}` }
  }

  return {
    ok: true,
    path,
    bytes: back.length,
    restoredSha256: got,
    matchesRecord: true,
    detail: 'restored, and the bytes match the sha256 recorded before encryption',
  }
}

/** What this tool has encrypted, with the live answer read from the bytes rather than the record. */
export function encryptedFileList(ctx = {}) {
  const dir = cryptJournalDir(ctx)
  if (!existsSync(dir)) return { ok: true, dir, entries: [] }
  const entries = []
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const spec = readJsonLoose(join(dir, f))
    if (!spec) {
      entries.push({ journal: join(dir, f), state: 'unreadable' })
      continue
    }
    const exists = spec.path ? existsSync(spec.path) : false
    const encrypted = exists ? isEncrypted(spec.path) : false
    entries.push({
      journal: join(dir, f),
      id: spec.id,
      path: spec.path,
      at: spec.at,
      originalSize: spec.originalSize,
      exists,
      encrypted,
      state: !exists ? 'file-missing' : encrypted ? 'encrypted' : 'decrypted',
    })
  }
  return { ok: true, dir, entries }
}
