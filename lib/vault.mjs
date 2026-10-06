import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { basename, dirname, join, parse, resolve } from 'node:path'

import { CORE_ROOT, powershellHost, readJsonLoose, run } from './platform.mjs'

/**
 * The vault: taking a copy of a file, and putting it back.
 *
 * This is the third kind of act in the tool, and it is deliberately not a variant of the other two:
 *
 *   custody.mjs  acts on a running process   -- freezes it, and asks
 *   enforce.mjs  acts on a file's ACL        -- stops it being launched again
 *   vault.mjs    acts on a file's *location* -- takes a copy into a store, or puts it back
 *
 * **The default is a copy, and the original never moves.** `--move` is what removes it, and that word
 * has to be typed. The reason is not timidity. Copy keeps every failure recoverable and every
 * question answerable: the thing you are worried about is still exactly where it was, so a bug here
 * costs disk space and an apology, not a toolchain and an afternoon. `--move` is the operation that
 * can cost the afternoon, so it is the one that must be asked for by name.
 *
 * ## Where the store lives: one per volume
 *
 * `<volume>\.volcano-separator\vault\`. Not one central store, because a central store turns every
 * vaulting into a cross-volume copy: the file must be written somewhere else, verified, and only then
 * deleted from where it was -- a window in which both copies exist or neither does. That window is
 * precisely the shape of "if this goes wrong, someone loses their file".
 *
 * A store on the target's own volume removes the window. A move within a volume is a rename, which is
 * atomic, and a copy within a volume is the same copy it would otherwise have been with no second
 * volume involved. It also means the store is never somewhere the user did not expect their file to
 * be: it is on the same disk it was already on.
 *
 * ## What makes it safe
 *
 * 1. **The undo does not depend on this tool.** Every entry's manifest names the exact `copy` command
 *    that puts it back. If this tool is deleted, broken, or the machine only boots to a recovery
 *    prompt, the file is still a file in a directory, and `copy` still works. Verified by deleting a
 *    manifest and restoring by hand.
 * 2. **The manifest is signed, and a signed manifest names one file.** Otherwise "put it back" is a
 *    primitive that copies any file to any path on command -- the same privilege-escalation shape the
 *    ACL journal has, and it is answered the same way: HMAC-SHA256 over a canonical string, keyed by
 *    a random 32 bytes that DPAPI binds to this machine and this user.
 * 3. **The copy is verified before the manifest is written.** A vault entry that cannot be read back
 *    byte-for-byte is not an entry, it is a second copy of an unknown thing.
 * 4. **Nothing is overwritten.** Restoring refuses where the original path now holds different
 *    content, rather than replacing it. What is there now may be the user's work.
 * 5. **Room is checked first.** A copy into a full volume leaves a truncated file, and a truncated
 *    copy that then gets trusted is worse than no copy. One of this machine's volumes had 16 GB free.
 */

const NL = String.fromCharCode(10)
const MANIFEST = 'manifest.json'
const VAULT_DIR_NAME = join('.volcano-separator', 'vault')

/** The store for a given volume. One per volume, on purpose -- see the note above. */
export function vaultRootFor(ctx, anywhere) {
  if (ctx?.vaultRoot) return resolve(ctx.vaultRoot)
  const p = resolve(anywhere)
  const { root } = parse(p)
  return join(root, VAULT_DIR_NAME)
}

export function vaultKeyFile(ctx = {}) {
  return ctx.vaultKeyFile ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.volcano-separator', 'vault-key.dat')
}

/**
 * The HMAC key, DPAPI-protected, exactly as the ACL journal does it. Same script, same shape: this is
 * a pattern this project has already paid for once, and a second implementation of it would be a
 * second thing to keep correct.
 */
export async function getVaultKey(ctx = {}) {
  const file = vaultKeyFile(ctx)
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
      // Plain base64, not JSON. crypt.mjs wraps its key file in a JSON object and this file does not,
      // and the first version of this function copied crypt.mjs's reader regardless -- so it handed a
      // base64 string to a JSON parser and the restore path died on its own key. Two files, two
      // formats, and copying the reader across without checking was the entire mistake.
      if (!existsSync(plain)) return { ok: false, detail: r.error ?? 'unprotect produced no key' }
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
  if (!existsSync(file)) return { ok: false, detail: r.error ?? 'could not protect the new key' }
  return { ok: true, key: raw, file, created: true }
}

/**
 * A canonical string, joined by newlines in a fixed order.
 *
 * Not JSON.stringify: key order is not promised for an object built in two places, and an HMAC over a
 * value whose order can change fails at random. The ACL journal states the same rule for the same
 * reason, and this is deliberately the same shape.
 */
export function vaultCanonical(spec) {
  return [
    'v1',
    'id', spec.id,
    'original', spec.originalPath,
    'vault', spec.vaultPath,
    'sha256', spec.sha256,
    'size', String(spec.size),
    'disposition', spec.moved ? 'moved' : 'copied',
  ].join(NL)
}

export function signManifest(key, spec) {
  return createHmac('sha256', key).update(vaultCanonical(spec)).digest('base64')
}

export function sha256File(file) {
  const h = createHash('sha256')
  h.update(readFileSync(file))
  return h.digest('hex')
}

/**
 * Take a copy of a file into the store for its own volume, and write a signed manifest beside it.
 *
 * Deliberately not `await`-heavy or multi-file: one call, one file. A batch operation would put a
 * single wrong decision in a position to move every matching file before anyone looks, which is the
 * failure the design gates on -- and this path has no gate in front of it, so it acts on one thing.
 */
export async function vault(ctx, { path = '', move = false, dryRun = false, reason = '' } = {}) {
  const src = resolve(String(path ?? ''))
  if (!path) return { ok: false, detail: 'a path is required' }
  if (!existsSync(src)) return { ok: false, detail: `no such file: ${src}` }
  let st
  try {
    st = statSync(src)
  } catch (e) {
    return { ok: false, detail: `cannot read ${src}: ${e?.message ?? e}` }
  }
  if (!st.isFile()) return { ok: false, detail: `not a regular file: ${src}` }

  const root = vaultRootFor(ctx, src)
  // The store must not be able to swallow itself or the tool's own directory. A vault entry for the
  // vault is not an entry, and a tool that can move its own undo machinery is not reversible.
  if (resolve(src).toLowerCase().startsWith(resolve(root).toLowerCase())) {
    return { ok: false, refused: true, detail: `refused: ${src} is inside the vault itself (${root})` }
  }
  if (resolve(src).toLowerCase().startsWith(resolve(CORE_ROOT).toLowerCase())) {
    return { ok: false, refused: true, detail: `refused: ${src} is inside this tool's own directory, which it must be able to restore` }
  }

  const id = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')}-${randomBytes(4).toString('hex')}`
  const entryDir = join(root, id)
  const vaultPath = join(entryDir, basename(src))

  if (dryRun) {
    return {
      ok: true, dryRun: true, id, path: src, vaultPath, bytes: st.size, move,
      // Carries the undo even in a dry run, so the caller that prints it on success does not print
      // `undefined` here. The first version omitted it and the CLI did exactly that.
      undo: `copy "${vaultPath}" "${src}"`,
      detail: `dry run: nothing was copied. Would put a ${move ? 'move' : 'copy'} of ${st.size} byte(s) at ${vaultPath}`,
    }
  }

  // Room first. A copy into a full volume truncates, and a truncated copy that is then trusted as the
  // only surviving version is the worst outcome this module can produce.
  let free = null
  try {
    const ps = powershellHost()
    const r = await run(ps, ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Item -LiteralPath '${parse(resolve(root)).root.replace(/'/g, "''")}' -Force).PSDrive.Free`], { timeoutMs: 30000 })
    const n = Number(String(r.stdout ?? '').trim())
    if (Number.isFinite(n)) free = n
  } catch {
    /* unknown headroom is reported, not assumed */
  }
  if (free !== null && free - st.size < 1_073_741_824) {
    return {
      ok: false, refused: true, id, path: src, vaultPath,
      detail: `refused: ${Math.round(free / 1e9)} GB free on ${parse(resolve(root)).root} and this file is ${Math.round(st.size / 1e6)} MB; a copy would leave less than 1 GB`,
    }
  }

  const key = await getVaultKey(ctx)

  try {
    mkdirSync(entryDir, { recursive: true })
    copyFileSync(src, vaultPath)
  } catch (e) {
    rmSync(entryDir, { recursive: true, force: true })
    return { ok: false, detail: `the copy failed and nothing was kept: ${e?.message ?? e}` }
  }

  // Verified before the manifest exists. An entry that cannot be read back byte-for-byte is not an
  // entry -- it is a second copy of an unknown thing, and the manifest is what would make it trusted.
  const want = sha256File(src)
  const got = sha256File(vaultPath)
  if (want !== got) {
    rmSync(entryDir, { recursive: true, force: true })
    return { ok: false, detail: `the copy does not match the source (${want.slice(0, 12)} vs ${got.slice(0, 12)}); nothing was kept` }
  }

  const spec = {
    id,
    originalPath: src,
    vaultPath,
    sha256: want,
    size: st.size,
    moved: false,
    at: new Date().toISOString(),
    volume: parse(resolve(root)).root,
    reason: String(reason ?? ''),
  }
  spec.hmac = key.ok ? signManifest(key.key, spec) : null
  spec.signed = key.ok
  if (!key.ok) spec.signatureProblem = key.detail

  try {
    writeFileSync(join(entryDir, MANIFEST), JSON.stringify(spec, null, 1) + String.fromCharCode(10), 'utf8')
  } catch (e) {
    rmSync(entryDir, { recursive: true, force: true })
    return { ok: false, detail: `could not write the manifest, so nothing was kept: ${e?.message ?? e}` }
  }

  // Recorded where the store is, because one store per volume makes an id insufficient on its own.
  // A failure to write the index is not a failure to vault: the entry is on disk with its manifest,
  // and `findEntry` falls back to reading the volumes.
  const indexed = writeIndex(ctx, { ...readIndex(ctx), [id]: root })

  // The only place the original is disturbed, and only when asked for by name.
  if (move) {
    try {
      rmSync(src, { force: true })
    } catch (e) {
      return {
        ok: true, id, path: src, vaultPath, bytes: st.size, move: true, moved: false, signed: spec.signed,
        // The copy is safe, so this is reported as the failure it is rather than as a failed vault:
        // the file is now in two places, which is recoverable; saying "the vault failed" would not be.
        detail: `the copy is in the vault, but the original could not be removed (${e?.message ?? e}). Both copies exist.`,
      }
    }
  }

  return {
    ok: true, id, path: src, vaultPath, bytes: st.size, move: Boolean(move), moved: Boolean(move), signed: spec.signed,
    undo: `copy "${vaultPath}" "${src}"`,
    detail: `${move ? 'moved' : 'copied'} ${st.size} byte(s) into the vault as ${id}` +
      (spec.signed ? '' : ` -- unsigned: ${key.detail}`),
  }
}

/**
 * An index of entry id -> the volume's store, because "one store per volume" makes an id insufficient.
 *
 * This is the cost of the per-volume design and it is paid here rather than by asking the user which
 * drive their file was on. The index is a convenience, never an authority: it lives beside the policy
 * and the keys, and every restore still verifies the manifest it finds. A missing or stale index
 * costs a lookup, not a correct answer -- and `vaulted --all` reads the volumes directly, so the
 * entries are discoverable without it. It is recorded rather than derived because enumerating four
 * volumes to answer one id would be a scan on every restore.
 */
export function vaultIndexFile(ctx = {}) {
  return ctx.vaultIndexFile ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.volcano-separator', 'vault-index.json')
}

function readIndex(ctx) {
  const file = vaultIndexFile(ctx)
  if (!existsSync(file)) return {}
  const raw = readJsonLoose(file)
  return raw && typeof raw === 'object' ? raw : {}
}

function writeIndex(ctx, index) {
  const file = vaultIndexFile(ctx)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(index, null, 1) + NL, 'utf8')
    return { ok: true, file }
  } catch (e) {
    return { ok: false, file, detail: `could not write ${file}: ${e?.message ?? e}` }
  }
}

/** Locate an entry by id, using the index first and falling back to reading the volumes. */
export function findEntry(ctx, id) {
  const anywhere = ctx?.vaultRoot ?? process.env.USERPROFILE ?? '.'
  const index = readIndex(ctx)
  const known = index[id]
  if (known && existsSync(join(known, id, MANIFEST))) {
    const spec = readJsonLoose(join(known, id, MANIFEST))
    return { root: known, spec, dir: join(known, id), from: 'index' }
  }
  // Not in the index (or the index is stale): read the volumes that have a store. The tool never
  // needs this to be fast, and it does need it to be right.
  for (const root of vaultRootsOnThisMachine()) {
    const file = join(root, id, MANIFEST)
    if (!existsSync(file)) continue
    const spec = readJsonLoose(file)
    writeIndex(ctx, { ...readIndex(ctx), [id]: root })
    return { root, spec, dir: join(root, id), from: 'volume' }
  }
  void anywhere
  return { root: null, spec: null, dir: null, from: null }
}

/** Every store that exists on this machine, one per volume that has been used. */
export function vaultRootsOnThisMachine() {
  const roots = []
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = join(letter + ':', VAULT_DIR_NAME)
    if (existsSync(root)) roots.push(root)
  }
  return roots
}

/** Every entry in the store for the volume holding `anywhere`. */
export function vaultEntries(ctx, anywhere, { all = false } = {}) {
  const root = vaultRootFor(ctx, anywhere)
  const roots = all ? vaultRootsOnThisMachine() : [root]
  const rows = []
  for (const r of roots) {
    const part = entriesIn(r)
    for (const row of part) rows.push({ ...row, root: r })
  }
  return { root, rootCount: roots.length, rows }
}

function entriesIn(root) {
  const rows = []
  if (!existsSync(root)) return rows
  for (const name of readdirSync(root)) {
    const dir = join(root, name)
    const file = join(dir, MANIFEST)
    if (!existsSync(file)) continue
    const spec = readJsonLoose(file)
    // A manifest that cannot be read is reported as an entry with a problem, not skipped: an entry
    // silently missing from the list is the "no record" that reads as "nothing happened".
    rows.push(spec ? { ...spec, dir, problem: null } : { id: name, dir, problem: 'the manifest could not be read' })
  }
  return rows
}

/** Verify one entry against its signature and the bytes actually on disk. */
export async function verifyEntry(ctx, spec) {
  if (!spec?.vaultPath) return { ok: false, why: 'the manifest names no vault path' }
  if (!existsSync(spec.vaultPath)) return { ok: false, why: `the vault copy is gone: ${spec.vaultPath}` }
  const actual = sha256File(spec.vaultPath)
  if (String(actual).toLowerCase() !== String(spec.sha256).toLowerCase()) {
    return { ok: false, why: 'the vault copy does not match the hash the manifest records for it' }
  }
  if (!spec.hmac) {
    return { ok: false, why: 'this manifest carries no signature, so this tool cannot vouch for it', unsigned: true }
  }
  const key = await getVaultKey(ctx)
  if (!key.ok) return { ok: false, why: key.detail }
  const expect = signManifest(key.key, spec)
  if (expect !== spec.hmac) {
    return { ok: false, why: 'the manifest has been changed since this tool wrote it, or was not written by it' }
  }
  return { ok: true }
}

/**
 * Put an entry back where it came from.
 *
 * Refuses in three cases, and says which -- a refusal that gives the wrong reason is barely better
 * than no check. The third is the one that matters most: what is at the original path now may be the
 * user's newer work, and a restore that overwrites it is a vault that destroys files.
 */
export async function restoreVault(ctx, { id = '', force = false, dryRun = false } = {}) {
  if (!id) return { ok: false, detail: 'an entry id is required' }
  const found = findEntry(ctx, id)
  const spec = found.spec
  if (!spec) {
    return {
      ok: false,
      detail: `no vault entry ${id} in any store on this machine`,
      searched: vaultRootsOnThisMachine(),
    }
  }

  const undo = `copy "${spec.vaultPath}" "${spec.originalPath}"`
  const kept = { id, undo, note: `the vault copy is still there. Without this tool: ${undo}` }

  if (spec.problem) return { ok: false, ...kept, detail: `${id}: ${spec.problem}` }

  const v = await verifyEntry(ctx, spec)
  if (!v.ok) {
    // The undo line above is built FROM the manifest, so on an unverified manifest it repeats what
    // the manifest claims -- including any path someone edited into it. Printing it unqualified next
    // to a refusal to trust that same manifest is a contradiction the reader would have to notice on
    // their own, so it is said out loud instead.
    return {
      ok: false, id, vaultPath: spec.vaultPath,
      note: `no restore was performed. The line above is quoted from the manifest, which failed verification -- ` +
        `so treat its paths as claims, not as instructions. The vault file itself is at ${spec.vaultPath}.`,
      detail: `refused to restore: ${v.why}`,
    }
  }

  if (existsSync(spec.originalPath)) {
    let same = false
    try {
      same = sha256File(spec.originalPath) === String(spec.sha256).toLowerCase()
    } catch {
      same = false
    }
    if (!same && !force) {
      return {
        ok: false, refused: true, ...kept,
        detail: `refused: ${spec.originalPath} exists and is not the file this entry holds. ` +
          `Restoring would replace whatever is there now. Pass force to mean it.`,
      }
    }
  }

  if (dryRun) {
    return { ok: true, dryRun: true, id, detail: `dry run: nothing was restored. Would put ${spec.vaultPath} back at ${spec.originalPath}`, undo }
  }

  try {
    copyFileSync(spec.vaultPath, spec.originalPath)
  } catch (e) {
    return { ok: false, ...kept, detail: `the restore failed: ${e?.message ?? e}` }
  }
  const back = sha256File(spec.originalPath)
  if (back !== String(spec.sha256).toLowerCase()) {
    return {
      ok: false, ...kept,
      detail: `the bytes at ${spec.originalPath} do not match what this entry recorded (${back.slice(0, 12)} vs ${String(spec.sha256).slice(0, 12)}); the vault copy is untouched`,
    }
  }
  return { ok: true, id, path: spec.originalPath, bytes: spec.size, detail: `restored ${spec.size} byte(s) to ${spec.originalPath}`, undo }
}
