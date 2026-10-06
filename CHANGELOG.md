# Changelog

## Unreleased

### Fixed

- **The health probe now asks what the descriptor says to ask, and the first version of that change
  broke the probe it was meant to generalise.** `probeDaemon` had `/health`, `/health/live` and "200
  means ready" written into it -- not wrong for Hindsight, but the only shape the function could
  express. It reads the descriptor now, and two kinds exist because two services need them:
  `http-json` (2xx means ready) and `any-http-answer` (any answer means alive, for a service that
  answers 401 to its guarded endpoints and 404 to everything else).
  - **Verified against both real services on this machine:** Hindsight reports
    `port 9077 is listening and ready (/health -> 200)` unchanged, and the DSH host reports
    `port 3080 is listening and answering (/ -> 401)` -- where the old code called it `NOT HEALTHY`.
  - The failure worth recording is how nearly this shipped. `askProbe` compared against
    `'any-http-answer'` while the DSH descriptor declared `kind: 'http-any'`, and separately the
    implementation enumerated `'http-2xx'` while both descriptors declared `'http-json'`. **Both
    spellings were mine, written an hour apart**, and each mismatch made a live service read as down.
  - The second one is the instructive one: the throw added to make an unknown kind loud was placed
    **inside** the catch that treats everything as a network error, so the Hindsight probe began
    reporting `port 9077 is open but /health did not answer` while `curl` and a raw `fetch` both got
    200. **A loud failure inside a catch that means "the network did not answer" is a silent
    failure.** The kind is now validated before the call, outside the catch.
  - A check now asserts that **every kind any descriptor declares is one something implements**, and
    that an unknown kind is refused rather than falling back to whatever the else branch does.
    Verified to fail on a deliberate misalignment. The two kinds are also asserted to *differ*, since
    a pair that behaves the same means one of them is decoration.

### Added

- **A second service descriptor, and it is a real service rather than one invented to fit.** A
  descriptor written to match the fields proves the fields are self-consistent and nothing else, so
  the second describes the **DSH host**, which is running on this machine and is shaped differently.
  Four things it broke, all found by trying to describe it:
  - **liveness:** the host answers **401** to its guarded endpoints and **404** to everything else, so
    "2xx means up" would report a working host as down. `reachable` is now a declared kind.
  - **readiness:** this service publishes none. `kind: 'none'` with a reason, rather than pointing at
    a 404 and calling the 404 a failure.
  - **runtime:** a plain `node <entry> web`, not uvx -- and its entry point is recorded nowhere this
    tool reads, so the descriptor declares `launchable: false` and refuses instead of guessing a path
    that would resolve on one machine and not the next.
  - **config file format:** its settings are YAML, and `readJsonLoose` **throws** on malformed content
    rather than returning null, which its name invites a caller to assume. The unguarded call crashed
    on the second descriptor and on nothing before it.
  - **What did not break is the finding that matters:** the layout templates, profile naming, log
    declaration, process-identification block and the home-directory environment override all carried
    over unchanged. Seven faces were collected and four needed no new shape.
  - **What it also exposed:** the descriptor is the easy half. `heal` / `warm` / `serve` are
    Hindsight's sequence and nothing about a descriptor makes them general. That they are still one
    service's is the next piece of work, stated in the design rather than left as a footnote.

### Changed

- **A service descriptor: what this tool supervises is now a value rather than a set of literals.**
  Every path in `resolveContext` was built from a literal `~/.hindsight`, the daemon's module name was
  written into four separate `uvx --with` argument lists, and "is it healthy" meant `GET /health`
  because that is what this particular service answers. None of it was wrong -- it was unexamined, and
  that made "what this tool supervises" a fact about the source code instead of something readable,
  disagreeable and replaceable.
  - Seven faces were measured, not assumed: the home directory, the plugin settings file
    (`coding-agent.json`, a constant rather than `<profile>.json`), the profile files, **the runtime
    module name in four separate argument lists**, the database instance name, the health endpoints,
    and the data protocol. All seven are fields of one descriptor now.
  - The descriptor answers five things: how to run it, where its state lives, how to ask whether it is
    alive, how to ask whether it is *ready* (a different question, and the reason `probeDaemon` splits
    liveness from readiness), and what data it depends on.
  - **A descriptor may not weaken a probe into a weaker claim.** `kind: 'sql'` names a statement, not a
    port. A descriptor that could only say "something is listening" would be a way of declaring weaker
    evidence as acceptable, and the database probe asks a real question precisely because `LISTEN` plus
    a data directory plus a failing handshake is a state that exists.
  - **Nor may it opt out of the honesty rules.** `unknown != zero`, "refuse rather than silently fall
    back" and "a record must not claim what did not happen" hold for every descriptor.
  - Equivalence is asserted as a comparison, not as a snapshot: the context the descriptor produces is
    checked field by field against the values the literals produced, recomputed from `homedir()` rather
    than pasted, so the check does not decay into a record of one machine's home directory. An unknown
    service id is refused rather than defaulted to the one that exists -- running the wrong service's
    commands is worse than running none.
  - **Not claimed:** one descriptor exists, so the design is not yet tested by a second. That is the
    next test of it, not a conclusion of it.

### Changed

- **Two switches whose names promised more than they did.** Each was found by reading output, which is
  the one place a claim cannot be caught by checking behaviour.
  - **`neverQuarantine` is gone.** It was a `POLICY_DEFAULTS` field that nothing read -- one grep hit,
    the definition -- so it held nothing back and promised nothing, and by the time it was removed it
    also described the tool inaccurately, since `vault --move` takes a file out of its place. An unread
    field whose name reads like a safeguard is the false signal this project removes, so it went rather
    than being wired up to justify the name. Precedent: the same call on an unread `LEAVE_ALONE` set.
  - **`policy.mode`'s `suspend` and `reject` stay recordable, and every screen now says what they
    are.** They are intent recorded for a gate that has not opened, and recording intent is exactly
    what Stage 0 exists for -- so the values are kept and the claims are fixed. `signals` said
    "enforcement is ON" for a screen after `decide` had already been corrected for the same sentence,
    and `policy show` printed a non-observe mode in red, which reads as an alarm rather than as what
    the file says. All three now call it recorded intent that nothing reads.
  - **The README boundary was restated per operation**, because "it never quarantines" stopped being
    true the moment `vault --move` existed. What is true is narrower and more useful: nothing detected
    is ever acted on by a rule; every act is a command a person types, and each says what it does to
    the target -- `detain` does not touch the file, `isolate` rewrites the ACL, `vault` copies, and
    `vault --move` is the only one that takes the file out of its place.

### Added

- A check that **no screen promises enforcement the tool cannot perform**, asserted over code rather
  than over comments -- the three phrases it looks for all appear in `cli.mjs` as commentary recording
  that they were once printed, and a check that cannot tell those apart fails on the fix it protects.
  Verified to fail on a claim planted in code while the comments naming the same phrase stay legal.

### Fixed

- **Records that could not be read were discarded silently, and every count built on them was a
  lower bound that looked like an answer.** The parse loop ended in an empty `catch`. It threw away
  the row *and the fact of the row*: measured on this machine, **410 records in its own activity
  record did not parse** and nothing anywhere said so. Whatever the cause, the effect was that
  `activity`, `signals`, `decide` and `busy` all under-reported by 0.1% while reading as complete --
  and fewer findings reads as good news, which is the failure this whole layer exists to prevent.
  - Unreadable lines are now counted, and **the two kinds are counted apart** because they mean
    opposite things. A truncated *last* line is the normal state of a file being appended to right
    now: it costs nothing, the next read sees the finished row, and warning about it would train the
    reader to ignore the warning. A line that is **not** the last one is a record that is gone, and
    nothing will bring it back. Only the second is reported.
  - `readActivity` returns `linesSeen`, `unreadableLines`, `unreadableMidFile` and `complete`;
    `analyzeSignals` carries them through, because a finding count computed over a record with holes
    is a lower bound and must say so; `activity` and `signals` print it.
  - Verified to fail: disabling the counters makes four checks fail, one of them reporting a record
    with a hole in it as `complete: true`.

### Added

- **`vault` / `unvault` / `vaulted` -- the first operation that can take a file out of its place.**
  `vault <path>` copies a file into a store on the file's own volume; `--move` is what removes the
  original, and it has to be typed. `unvault <id>` puts it back. `vaulted` lists every store on the
  machine.
  - **The default is a copy, and the original does not move.** Copy keeps every failure recoverable:
    the thing you are worried about is still exactly where it was, so a bug costs disk space and an
    apology rather than a toolchain and an afternoon. `--move` is the operation that can cost the
    afternoon, so it is the one that must be asked for by name.
  - **One store per volume** (`<volume>\.volcano-separator\vault\`), not one central store. A
    central store makes every vaulting a cross-volume copy: write elsewhere, verify, then delete the
    original -- a window in which both copies exist or neither does, which is exactly the shape of
    "if this goes wrong, someone loses their file". On the same volume, a move is a rename.
  - **The undo does not depend on this tool.** Every result prints the plain `copy` command that puts
    the file back, and the test performs that copy with the filesystem directly and compares hashes,
    rather than checking that a string looks right.
  - **The manifest is signed, and a signed manifest names one file.** Otherwise "restore" is a
    primitive that copies any file to any path on command -- the same privilege-escalation shape the
    ACL journal had, and answered the same way: HMAC-SHA256 over a canonical string, keyed by 32
    random bytes that DPAPI binds to this machine. Verified to fail: disabling the comparison makes
    two tests fail, one of them reporting that a forged path was acted on.
  - **Restores refuse rather than overwrite.** Where the original path now holds different bytes the
    restore stops and says so, because what is there may be the user's newer work. `--force` means it.
  - Room is checked before the copy, not after. One volume on this machine had 16 GB free, and a
    truncated copy that is then trusted as the only surviving version is the worst outcome here.
  - `isolated` and `encrypted` were added to the command-surface check, which had never covered them
    despite both being read-only and runnable with no arguments -- the omission that file exists to
    catch.

### Fixed

- **A command line containing a bare LF made the whole record unparseable.** The recorder escapes
  every value before writing a line, and its pattern was CR-question-LF -- which matches CR+LF or a
  bare CR, and **misses a bare LF**, exactly what a multi-line bash command carries. The raw newline
  landed inside a JSON string and the record failed to parse.
  - Measured over eight days of the live record: **410 unparseable lines out of 403,685 (0.102%)**,
    every one a `proc-start` whose `cmd` spanned multiple lines. All sit mid-file, not at a tail:
    they are not partial writes.
  - **Nothing reported the loss.** `readActivity` counts *file* read failures, not *lines* it could
    not parse. Fewer findings reads as good news, which is the failure this layer exists to prevent.
  - Fixed in `activity-watch.ps1` and `detain.ps1`, which carried the same expression. Asserted
    against every line-break shape (bare LF, bare CR, CRLF, doubled, reversed, and one combined with
    a quote) with a JSON round trip per shape, and **the assertion was verified to fail on the old
    pattern before being kept**.
  - The 410 damaged records were left in place. All fields survive and only `cmd` is truncated, so
    they are recoverable -- but rewriting them is an operation on evidence and should be a decision,
    not a convenience script.

### Added

- **[`TODO.md`](TODO.md)** -- agreed work that is not done, with what is measured and what would count
  as finished. Its second entry records a change of intent: enforcement capability is wanted rather
  than deferred, and the exclusions that were load-bearing are kept while the ones that were fiat are
  not. Against that entry's own framing, the measurement is that **`neverQuarantine` is not the thing
  constraining anything** -- it is a policy field no code reads (`grep` returns one hit, its
  definition), so there is no switch to relax and no quarantine to forbid. What limits the tool is the
  behavioural rule in the commands. The measured blockers are that `policy.mode` accepts `suspend` and
  `reject` and implements neither, that the decision layer's counterfactual has no consumer, that the
  evidence ledger holds 2 rows both reading `actionable: 0`, and that no undo has ever run as part of
  a real decision.

  First entry: the supervisor knows one specific stack (`uv` → Hindsight → its embedded
  PostgreSQL) and should be able to supervise a comparable local service. The coupling was measured
  rather than assumed: 45 occurrences of `hindsight` over seven modules, and the blockers are not the
  ones that look obvious -- the profile name, the ports and the cache directory are already
  configurable, while the directory layout, the derived database instance name, and **the health
  model itself** (`GET /health` as readiness, `/health/live` as liveness, PostgreSQL wire protocol
  for the database) are not.

### Fixed

- **The recorder duplicated its own record, and could not have told anyone.** WMI hands the same
  `Win32_ProcessStartTrace` record back many times (measured on this machine: 3,300 deliveries in
  11 s that were 3 distinct events, and once 10,500 in 31 s that was one). Each copy was written as
  its own row, so a reader counting "how often did this program run" got a number hundreds of times
  the truth -- a record that inflates its own findings is the failure this project exists to remove,
  and the recorder was committing it. Copies are now recognised by `TIME_CREATED`, the kernel's own
  stamp for the event, since every wrapper around one event carries the same value.
  - **The dedupe has to run before the identity test, and that order is the fix.** With the
    self-filter first, every redelivery of one event was counted as a fresh discarding of our own
    process: the snapshot read 105,203 "self" events over five minutes against 9 rows written, which
    looks like a hard-working recorder and was one event repeated. A filter placed before the dedupe
    cannot see how much of the stream is repetition. The ordering is now asserted, and the assertion
    was verified to fail when the two lines are swapped.
  - The process detail lookup is cached per pid, because a process produces at most a start and a
    stop and each lookup is a WMI round trip.
  - **Not fixed, and measured rather than implied:** the stream still arrives at roughly 340
    deliveries/second while it is happening, which costs about two thirds of a core for its
    duration. Discarding repeats in the subscription's `-Action` block would keep them out of the
    queue, and was tried and rejected: PowerShell only delivers an event when the action emits
    something, so a filtering action silently swallowed the events it meant to keep (observed as
    `seen=0` while rows were still being written), and CPU did not improve because the loop was
    driven at the same rate either way. The verifiable filter in the loop is the one that stayed.
- **The test suite wrote into the activity record it exists to protect.** Three test contexts performed
  real work -- freezing and resuming a process, applying and restoring an ACL, encrypting a file --
  while resolving the *default* log directory, so a test run left `detain`, `isolate` and `crypt` rows
  in the machine's own record, including half-written last lines where a process was killed mid-write.
  Measured after the fix: the count of scratch-path rows in the live record no longer changes when the
  suite runs.
  - The deeper cause was found while fixing it: **`detain.ps1` never declared `-ActivityDir`,** so its
    explicit directory was rejected and the summary always went to `%TEMP%\volcano-separator\activity`
    -- which is the same path the Node side derives *only when `logDir` is unset*. With any log
    directory override the summary was written to one place and looked for in another, and a freeze
    that had worked perfectly read as "detain produced no summary". `isolate.ps1` already declared it.
- **The suite leaked two scratch directories per run, and had been for a while.** 248 of them had
  accumulated in the temp tree the tool derives its own state from -- `vsep-both-*` (created and never
  removed; the section deleted the other directory it had made and moved on) and `vsep-junc-tmp-*`
  (the TEMP redirect added when the junction test stopped writing into the live record). Verified
  stable afterwards: the count does not change across runs.
  - Same lesson as the pollution fix, one level down: cleaning up "the paths you remember" is how a
    suite fills a directory nobody is measuring. The three contexts that own three directories now
    remove three.
- **The reader forwarded only some of the counters the recorder publishes.** `eventsAccepted` was
  written by the recorder and dropped by `readRecorderHealth`, so `ps` printed `?` for it -- which
  reads as "this recorder does not publish that field" rather than "the reader lost it", and the
  feature looked unimplemented while it had been working all along. A field the writer emits and the
  reader drops is invisible in the worst direction. Every published counter is now forwarded and a
  test fails if one is not; that test rewrites the snapshot the earlier checks read, so it runs last.
- **A last line with no readable timestamp printed "Infinity min old".** That is not a measurement, it
  is a number-shaped absence. The usual cause is a writer killed mid-line, which the message now says.
- **Everything periodic only ran when something had happened.** The window sampler, the persistence
  comparison and the pruning all sat below the event handling, so on a quiet machine they did not run
  at all: the check that catches a Run key added and removed between two passes was the *last* thing
  to happen once events stopped, and its silence was indistinguishable from calm. Every pass now
  reaches the bottom of the loop.
- **The recorder could not report a failure to write, which is why nobody noticed.** `Write-Event`
  ended in an empty `catch`, so a row that could not be written vanished while its absence said
  nothing. A reader could only ask "is the newest event recent?", and a recorder whose every write is
  failing answers that exactly like a quiet machine -- the events that would make the file look stale
  are the ones that never arrive. Silence read as calm.

### Added

- **The recorder publishes its own counters** to `recorder-health.json` beside the record: events
  seen, written, dropped, discarded as its own, discarded as duplicates, handler errors, passes, and
  the state of both WMI subscriptions. It is rewritten every few seconds with a temp-file-then-rename
  write, so its *staleness* is the honest signal that the recorder is not running, while the numbers
  are the only way to tell "nothing happened" from "nothing was recorded".
  - Written defensively: nothing that reads state for the snapshot may prevent it being written, since
    the snapshot is the only thing that can report a failure. An unguarded `Get-EventSubscriber` did
    prevent it in production -- the recorder went on recording while saying nothing about itself.
  - `volcano-separator ps` now prints the breakdown, and an absent or unreadable snapshot is reported
    as unknown rather than as healthy. A recorder too old to publish one does not read as complete.

- **`cache --apply` carried out a list nobody had reviewed.** `--prune` built a plan and showed it;
  `--apply` threw that away and rescanned, so the removals that actually ran were whatever the cache
  looked like at that moment. A plan reviewed as "remove 40 entries, free 0.07 GB" could execute as
  a different 40 -- or as 60 -- and the output still read like the reviewed one. Both halves were
  individually careful and the pair was not.
  - A plan is now stored under a name derived from its own contents, so the same cache state and the
    same options produce the same id, and a different id means a different set of removals. A random
    name would have made "this is the plan you looked at" unverifiable and "this is a different
    plan" invisible.
  - `--apply` runs that stored plan, not a fresh scan. `--plan-id <id>` runs an older one; with no
    plan at all it refuses and says how to make one, rather than silently rebuilding.
  - **Each entry is revalidated before anything moves: same path, same size.** The rename test
    answers "is anything holding this entry", which is not the same question as "is this still the
    entry that was reviewed" -- and only the second one is what a reviewed plan promises. An entry
    that changed is left alone and named; an entry that vanished is reported as gone.
  - **Nothing outside the reviewed plan is ever removed.** New candidates that appeared in the
    meantime are left for the next plan, where a person sees them before approving them. When the
    cache has moved, the output says so and prints both ids rather than hiding it behind either one.
  - `gone` and `changed` are reported separately from `refused`: "a running process holds this" and
    "this is not the entry that was reviewed" call for different responses from the person reading,
    and folding them together would hide which one happened.
  - `volcano_cache_plan` now stores the plan it shows. An agent that prints a list and a person who
    then runs `--apply` are looking at the same plan only if it was written down.
  - Plans live beside `policy.json` rather than in the cache, for the same reason the isolation
    journal does: a decision about this machine, not an artifact of running the tool. The newest 20
    are kept, because this is a record of decisions and not a log.
  - **The first version of this was caught by the suite on the next run:** the existing prune test
    wrote `bytes: 100` by hand, which the new revalidation refused. That is the check doing its job
    -- a real plan's sizes come from a scan -- so the fixture now measures.

- **Running the test suite deleted the accumulated evidence.** `rollUpEvidence` and `readEvidence`
  hardcoded `~/.volcano-separator/evidence.ndjson` with no override, so the test that covers them had
  nowhere to write except the real file -- and it cleaned up by deleting it. Every green run reset
  exactly the data the suite exists to protect, which would have made the two-week accumulation plan
  fail in a way that looked like the heartbeat not working. There is now an `evidenceFile(ctx)`
  override, the tests write to a scratch path, and the default is asserted separately without
  touching it.

### Fixed

- **The heartbeat's counterfactual could not have been anything but zero.** Stage 0's whole point is
  that a promotion decision gets made from a number, and the number it was about to record was
  built from a hand-written list of fields that omitted `actionable` -- so `would:` would have read
  0 for ever. A count that can only ever say *nothing would be acted on* is not a measurement, and
  it is the most convincing kind of wrong, because it agrees with exactly what a quiet machine looks
  like.
  - The object is now a spread rather than a list, so a field added to `decideSignals` reaches the
    log because nothing has to remember to name it.
  - And `?? 0` is gone. A missing field now logs `would:?`, because defaulting it to zero turns *I do
    not know* into *none*, which is the same failure the daemon's `/health` was fixed to stop
    reporting. **Verified by deleting `actionable` and watching `would:?` appear**, then restoring it
    and watching `would:0` come back -- a guard that has never fired is a hypothesis.

### Fixed

- **`isolated` reported the record instead of the filesystem.** A journal says what was done at the
  time; a file unlocked by hand, by another tool, or by an administrator restoring an ACL still read
  as `applied`. That contradicted the rule the module states in its own comment -- *the ACL is the
  authority, not our record of it* -- and a promise in a comment that nothing implements is the same
  class of thing as a counter that cannot vary. The state is now read from the ACL, in one batched
  PowerShell call rather than one per journal, and it distinguishes `applied`, `not-denied` and
  `file-missing`.

### Added

- **`encrypt` / `decrypt` / `encrypted` -- in-place encryption, and the undo that makes it defensible.**
  AES-256-GCM, key protected by DPAPI for this machine. **The safety is the order, not the cipher:**
  refuse if the file is in use; persist the key FIRST, and encrypt nothing if the key cannot be
  written; record the original's sha256 in a signed journal before touching the file; write the
  ciphertext beside the original; **decrypt it back and compare the hash**; and only then move it over
  the original. Without that fifth step this is a file shredder with extra ceremony.
  - **The boundary claim is per-act, not shared.** `isolate` does not move, rename, rewrite or delete,
    and that stays true -- it changes an ACL. Encryption rewrites the bytes and cannot avoid a rename.
    Those two cannot share one sentence, and the command prints its own boundary rather than borrowing
    the reassuring one.
  - `decrypt` refuses a journal that has been changed since this tool wrote it, and refuses to write
    back bytes that do not match the recorded sha256 -- an undo that silently swaps one file for
    another is not an undo. A refusal changes nothing.
  - Fifteen checks, including the byte-for-byte comparison and that a refusal leaves the ciphertext
    intact.

### Fixed

- **A policy that cannot be read is no longer reported as the default policy.** `catch { raw = {} }`
  turned a corrupt `policy.json` into the built-in defaults, silently. The defaults are the safe
  direction -- observe, empty allowlist -- so nothing dangerous followed, and that is exactly why it
  went unnoticed: a corrupted file produced a working tool with a policy nobody had chosen. The rule
  this project keeps invoking is that unknown is not zero; here unknown was being read as consent.
  - `loadPolicy` now distinguishes `absent` (no file yet, defaults are correct), `ok`, and `invalid`
    (the file exists and could not be parsed), and carries the parse error.
  - `policy show` prints `POLICY UNVERIFIED` with the reason and the sentence that matters: *the
    switch is not to observe because you chose it; it is observe because we could not read your
    choice.*
  - A JSON array is rejected as a policy rather than spread into one, and a policy file cannot claim
    its own integrity.
- **`savePolicy` writes atomically.** It wrote the file in place, so a power loss or a killed process
  could leave a half-written policy -- which is precisely the corrupt state above. It now writes
  beside and renames, and a rename within a directory is atomic.

### Fixed

- **Two recoveries could run at once, and did.** `heal` was written as if only one of it ran at a
  time and nothing enforced that. The heartbeat fires every five minutes; a manual `heal`, a
  `restart`, or an MCP call can start at any moment. **Measured over 514 heartbeats on this machine,
  16 overlapped the previous one -- about three percent -- and the worst ran for thirty minutes while
  the next had already begun.** Two concurrent recoveries can warm the same environment twice, start
  a service one of them is about to stop, and report two different conclusions about one machine.
  - A lock, taken after the fast path rather than around the whole function: the common case is one
    probe that concludes *healthy*, and holding a lock for it would make the cheap question expensive.
  - A holder that died does not block for ever, and the takeover is recorded rather than silent. A
    lock that can never be taken again is worse than no lock -- the heartbeat would stop repairing
    anything and report that it could not get a turn.
  - An unreadable lock file is not treated as evidence that someone holds it.
  - Only the holder releases, so a process that took over a stale lock cannot have its own deleted
    by the process it took over from.
  - **A skipped heartbeat does not look healthy.** The verdict line already prints
    `skipped(reason)`, so standing down reports `skipped(recovery-in-progress)` -- a distinction this
    tool exists to make and the easiest one to lose.
- **`readJsonLoose` documented for what it is.** It tolerates the BOM and nothing else: it throws on
  malformed JSON rather than returning null, which its name invites callers to assume. Found by the
  lock module throwing on a truncated lock file.

### Fixed

- **The database probe now asks the database a question.** It reported a socket that accepts
  connections plus a data directory that exists, and `5432 LISTEN` plus a data directory plus a
  failed SQL handshake is a state that exists: recovery mode, a full connection table, a revoked
  role, a wrong password. All four are invisible to a socket probe, and the daemon then comes up
  answering 503 -- which reads as a daemon fault and is not one.
  - The probe reports **how far it got** (`socket` / `data-dir` / `query`) so a failure names the
    layer that failed rather than one word for four situations.
  - `pg_isready` is deliberately not used even though it is the tool built for the job: it reports
    that the server accepts connections, which is one of the four things that can be wrong. It also
    costs the same as the real query here -- measured at 110-210 ms against `SELECT 1`'s 145-190 ms,
    with `status` at about 1390 ms total.
  - The credentials never leave the module: the URL carries a password, so every message passes
    through this project's own `redactCommandLine` and the raw value is not returned at all.
  - **A psql message that cannot be read is reported as unreadable rather than printed as damage.**
    Its diagnostics arrive in the console code page (cp936 here) and Node decodes them into
    replacement characters, so the reason came out as `psql: ����: ...`. That is the same failure the
    antivirus engine names had -- a scrambled answer to *what is wrong* is still a wrong answer -- so
    the probe says so and falls back to the exit code, which is always legible.
  - `psql` is found by discovery under the pg0 installation rather than a hardcoded version, because
    a machine that upgrades keeps both.

### Fixed

- **Two activity recorders were running at once, holding the same daily file.** The single-instance
  guard opened the lock to test it, disposed what it opened, and only then removed and recreated the
  file -- so two recorders starting together could both pass the check. A boot or a task restart
  produces exactly that. **Found live: this machine had two recorders, pids 9980 and 17244.** Same
  shape as the uv cache prune that scanned and then deleted; check-then-act is a race whenever two of
  the same thing can start at once.
  - The lock is now taken in **one** operation. `FileMode::CreateNew` is the atomic part: exactly one
    caller can create a file that does not exist.
  - What is left is deciding whether an error means *someone is running* or *someone died and left
    this behind*: the first stands down, the second takes over, and an **empty** lock file -- a
    recorder between creating it and writing its pid -- is waited for rather than seized, because
    that instant is precisely the boot race.
  - Failing to take the lock still lets the recorder run. A duplicate is a defect; a recorder that
    does not start at all is a blind spot, and this project already had a day where a guard that
    failed closed wrote nothing and the only symptom was an empty file.
- **The recorder subscribed to process events only after taking its baseline**, leaving a window in
  which a process could start and land in neither the snapshot nor the stream. A process that lives
  for less than that gap is exactly the kind this recorder exists to catch, and it was invisible
  twice over. The subscription now comes first: events cover everything from then on, the baseline
  covers whatever is already running, and together they cover everything. The baseline records
  `subscribed` so the boundary is legible in the record rather than a matter of trust. A process that
  started and exited before either is in neither -- that is stated rather than implied, because
  nothing observes the past.
- Dead code removed: `Test-LockHeld`, the check-then-act guard above, left with a note instead of
  quietly deleted.

### Fixed

- **Two runs in the same second shared a transcript.** The stamp was truncated to the second, so a
  manual `heal` and the heartbeat -- exactly the pair that collides -- wrote to one file and each
  overwrote the other. The symptom is not a missing log but a log mixing two recoveries, which is
  worse: it reads as one confusing run instead of two clear ones. The name now carries milliseconds,
  the pid, and a per-process counter.
  - **The first attempt at the overwrite guard could not work, and the test caught it.** It checked
    the filesystem for a clash, but `newLogPath` returns a *path* and the caller writes it later -- so
    two calls in the same millisecond both see an empty directory and both return the same name.
    Across processes the pid separates them and within one process the counter does; together those
    cover the whole space a collision can happen in, which is why a counter is the right answer here
    rather than more randomness.
- **`heal` now generates a runId and hands it to every step.** The `warm` and `serve` transcripts of
  one repair can be recognised as one repair afterwards. Without it the only link between them was
  the wall clock -- and the reason this tool keeps transcripts at all is to answer *what happened
  during that repair* once it is over.

### Security

- **The never-list could be walked around with a junction.** Every refusal compared the path as
  *written*, using `GetFullPath`, which is lexical: it normalises `..` and slashes and resolves
  nothing else. On a machine with junctions that is not the question *where does this file live*.
  - Demonstrated before the fix, on this machine:
    ```
    mklink /J E:\scratch\innocent-link C:\Windows\System32
    GetFullPath E:\scratch\innocent-link\kernel32.dll -> not under C:\Windows -> NOT refused
    ```
    and `icacls` would then have applied the deny to the real System32 file. A junction needs no
    elevation, this machine already has several, and this is the one rule that was supposed to hold
    even when the caller insists.
  - `bin/resolve-path.ps1` asks the filesystem instead, via `GetFinalPathNameByHandle`, which is the
    operation that actually resolves reparse points. PowerShell 5.1 has no `ResolveLinkTarget`, and
    opening with no access rights means it works on a file the caller could not open to read.
  - Every comparison is made **twice**: against the path as written and against the path the
    filesystem says it really is. Either one hits the never-list and the action is refused.
  - Verified end to end: a file behind a junction into System32 is now refused, a normal scratch file
    still passes, and a direct System32 path is refused as before.

### Fixed

- **`release` now checks who it is releasing.** A pid is not an identity, and the ledger has known
  that since it was written -- `custodyReport` computes `pid-reused` and reports it -- but the release
  path never consulted it. So the tool could correctly show a recycled pid on one screen and resume
  a stranger on the next: Windows hands a number to something else, someone releases it, and an
  unrelated process is unfrozen. `release` now refuses when the pid was reused, when the process is
  gone, and when there is no record to check identity against -- the third because acting on an
  identity that cannot be verified is the same act as resuming a stranger, and `isolate` and
  `decrypt` already refuse on that principle.
- **A failed release no longer records itself as a release.** `detain.ps1` called `NtResumeProcess`,
  discarded the answer and wrote `action = 'released'` unconditionally, then exited 0. The record now
  carries `release-failed` with `requested`/`succeeded`, because a record may not assert something the
  system did not do -- and `running` in the custody report means "a release was recorded and the
  process is still frozen", so the two ways to reach that state were a genuine bug and this line.
- **A release could authorise itself.** `rebuildCustody` created a record for any matching event, so
  releasing a pid that had never been detained wrote a record saying it had -- and the next release
  found that record and proceeded. Only events that establish custody create a record now. Found
  while adding the identity check, because the check kept passing for a pid nothing had ever detained.
- **Dead code removed:** `LEAVE_ALONE` in `lib/uvcache.mjs` named five sub-caches with a comment
  explaining they were not worth removing. Nothing read it, and it did not need to: the plan only
  walks `archive-v0`, so those directories were already untouched -- by not being looked at rather
  than by being excluded. A set with a comment explaining what it protects reads like protection.

### Added

- **`volcano_isolated` and `volcano_evidence` in the MCP surface** (13 tools -> 15). Both read-only.
  `isolate` and `restore` are deliberately still not exposed: an agent should not be able to change
  what can execute on this machine, and that line is not worth crossing for convenience.

### Security

- **`evidence` -- the counterfactual, accumulated where a cache cleaner will not reach it.** This
  came out of checking whether stage 0's data would actually pile up, and it would not have. The
  activity record lives under the log directory, which defaults to the system temp directory, and
  this machine's disk hygiene tooling is configured to remove files there after seven days,
  recursively, with no exclusion list. **Asking a rule to prove itself over a longer window than its
  evidence survives is a plan that fails quietly -- and it fails by showing fewer findings, which
  reads as good news.**
  - The heartbeat now rolls the counterfactual up once a day into `~/.volcano-separator/evidence.ndjson`,
    beside the policy, for the same reason the isolation journal is there: deciding is a decision
    about this machine, not an artifact of running a tool.
  - **The daily line is a running total, not the window's count.** The heartbeat looks at six minutes
    and findings are rare (four in three days), so writing each window's number would have written 0
    nearly every day -- a daily record of zeroes is a counter that cannot vary, reached by a
    different route.
  - `volcano-separator evidence` prints the days and the total.

### Security

- **The trigger, with nothing attached to it** (stage 0 of `DESIGN-enforcement.md`). `wouldAct` has
  been computed by `decideSignals` since that layer was written and read by nothing, which is the
  correct state until a promotion decision has a number to look at -- and an unread count is not
  evidence, so making it readable is the whole of stage 0.
  - `decide` now reports it: *would act 4 of 20 -- that many findings are serious and uncovered; a
    mode other than observe would act on exactly that many, nothing does today*.
  - **`policy mode <m>` reports it at the moment the switch is thrown**, because that is where the
    decision is actually made and a number a person has to go and look up is a number they will not
    look up: *over the last 72 hours this mode would have acted 4 time(s), each time to freeze the
    process*.
  - The heartbeat records it as `would:N`, so the evidence accumulates without anyone asking for it.
  - Nothing acts on any of it. `decide --json` and the MCP `volcano_decide` tool carry `actionable`,
    `wouldDo` and `modeUnimplemented`, so no caller can render a non-observe mode as though it
    worked.

### Fixed

- **`decide` said `enforcement is ON` for any mode other than observe.** Nothing enforces anything:
  `suspend` and `reject` are accepted by the CLI and implemented nowhere. That is the same false
  claim `policy mode reject` was making when it said unpermitted stealth would be terminated, in a
  second place. It now says what the mode would do and that nothing reads it yet.

### Security

- **An isolation journal is only acted on if this tool wrote it.** `restore` runs `icacls /restore`
  with the ACL file the journal names, so a forgeable journal makes *"restore the original ACL"* a
  privilege-escalation primitive: plant a file, wait for someone to restore it, and the tool applies
  whatever DACL the planted file contains.
  - Each journal carries an HMAC over its security-relevant fields **and the SHA-256 of the ACL
    backup**, because signing only the journal would leave the backup swappable -- the same attack
    one step over. The key is 32 random bytes protected by DPAPI for this machine.
  - A journal that fails verification is refused with the reason, never silently applied, and the
    refusal prints the `icacls` command that undoes the lock without this tool. **Refusing does not
    make the undo impossible** -- that is the property the whole design rests on, and it is verified
    by deleting the journal entirely and unlocking with the printed command.
  - **The limit is stated rather than implied:** this raises the bar from *write a JSON file* to *run
    code as this user on this machine*, and it does not stop the second thing. What it stops is the
    cheap versions: a journal copied from elsewhere, a hand-written one, a swapped backup, a
    plausible-looking edit.
  - Eight checks: an edited journal, a swapped backup and an unsigned journal are each refused with
    their own reason, and the untouched journal still restores afterwards.

### Added

- **`isolate` / `restore` / `isolated` -- the first thing this tool can do to a file, and its undo.**
  `isolate <path|pid>` adds one DENY ACE that stops a file being launched again. It is a door lock,
  not a security boundary, and it says so: it does not stop a process already running (that is
  `detain`), a copy, a rename, or anyone with administrative rights.
  - **The undo does not depend on this tool.** The ACL is saved with `icacls /save` and restored
    with `icacls /restore`, and every result prints the exact command. If volcano-separator is
    deleted, broken, or the machine only boots to a recovery prompt, the restore still works.
  - **The journal is not in the cache directory.** A cache is something a person is invited to
    clean, and a cleaned undo is not an undo. It lives beside the policy.
  - **Refused, not warned about:** anything inside `%SystemRoot%` (unless `-IncludeSystemRoot` says
    you mean it), the installer package cache, the isolation journal itself, this tool's own
    directory, and anything that is not a regular file. `%ProgramFiles%` and service binaries are
    ordinary targets -- breaking one is restorable in a way that breaking the boot is not.
  - The rejections are the point, so most of the checks are about them and about the undo rather
    than about the act.

### Security

- **The MCP surface went from 3 tools to 13, and is read-only apart from `heal`.** The observation
  and incident-response layers were reachable from the CLI and from nothing else, so a harness
  could ask whether the service was up and could not ask what the machine had been doing. Now
  exposed: `volcano_resources`, `volcano_activity`, `volcano_busy`, `volcano_ps`, `volcano_redline`,
  `volcano_cache_plan`, `volcano_signals`, `volcano_decide`, `volcano_detained`, `volcano_timeline`.
  - Deliberately absent: `volcano_detain`, `volcano_release`, `volcano_cache_apply`,
    `volcano_policy_allow`. Freezing a process or deleting cache entries are decisions a human
    should make; `cache_plan` exists so an agent can show a person what a prune *would* remove and
    let them run it. `heal` stays because it repairs a service the agent is usually the reason for
    needing, removes nothing, and the worst outcome is a slower path to the same state.
  - Caller-supplied numbers are clamped. An agent asking for `limit: 1e9` gets a bound, not a hang.
  - Every advertised tool is **called** by the suite, not just listed. Writing the surface this way
    found three renderers reading field names that do not exist -- `over undefined min`,
    `? GB across ? file(s) walked` -- which call successfully, return text, and say nothing. A
    handshake or a schema check would have passed all three.

### Changed

- **Warmth is now a question about completeness, not speed, and the probe can no longer make the
  problem it measures.** `probeEnv` ran `uvx ... --help` and called the environment warm if that
  returned inside `warmProbeMs` (15 s). Two things were wrong with it.
  - A warm environment on a loaded machine — busy disk, busy CPU — takes longer than 15 s and was
    reported cold, and every "cold" verdict triggers a full warm-up. The measurement was producing
    the work it exists to avoid.
  - On a genuinely cold environment the probe itself began downloading and was then killed at the
    timeout, leaving a half-populated cache and paying part of the cost on every single call.
  - The probe now resolves with `--offline`. Success proves the environment is complete locally;
    failure proves it is not; and it cannot download, so it cannot leave a partial cache behind or
    make a cold environment look warm by quietly filling it. Measured: a cold probe went from 15 s
    of downloading-then-killed to **75–106 ms**, and the uv cache gained no entries across a run.
  - Elapsed time is reported as context and no longer decides anything. If the probe runs out of
    time it says **undetermined** — `could not determine within 15000 ms -- the environment may be
    warm on a busy machine, or genuinely cold` — because it is not an answer and a guess in that
    direction costs a full warm-up. `warm` still proceeds on an undetermined probe, since a needless
    warm-up is a no-op while a skipped one is an outage, but it says which of the two it is acting on
    rather than reporting an unknown as a cold reading.
  - The failure line is taken from uv's diagnosis rather than its last non-empty line, which is
    usually the tail of a wrapped sentence: `unsatisfiable.` tells a reader nothing.
  - `warmProbeMs` is now documented as a safety timeout rather than the warm/cold test, in both the
    defaults and the README.

### Changed

- **core.mjs was split up.** It had reached 3416 lines and held the whole application: config,
  process execution, the PowerShell bridge, health, lifecycle, the scheduler, activity, signals,
  policy, redline and custody. It is now 428 lines of config, context and re-exports, with the
  layers in their own files:

  ```
  platform, commandline           no outgoing imports
  policy, resources            -> platform (+commandline)
  activity, custody, signals   -> the two leaves plus policy
  redline, live                -> activity (+commandline)
  supervisor                   -> platform, resources, custody
  uvcache                      -> platform
  core                         -> all of the above
  ```

  Nothing changed about what the tool does: the same 74 exports resolve to the same things, and
  the same checks pass before and after. The layering is acyclic and can be read off the import
  lines, which is the point -- a split that leaves modules importing each other is a second
  core.mjs spread across files rather than a smaller one.

### Fixed

- **The database's deployment and its management are now answered separately.** The probe hardcoded
  the embedded layout (`~/.pg0/instances/hindsight-embed-<profile>/data`) while the service it
  started was whatever happened to be named `hindsight-pg`. Those are answers to two different
  questions -- where the data is, and who starts the process -- and conflating them meant a machine
  with a database somewhere else was told its data directory was missing, while a machine with no
  such service was told *the database is not managed here*, which is true only if nothing else is
  managing it.
  - `pgDataLocation` resolves the data directory and labels the deployment: `embedded`, `declared`
    (the caller said where it is) or `unknown`. It respects `ctx.pgDataDir`, which previously did
    not exist as an option.
  - `ensurePgService` states which management model it concluded -- `windows-service`,
    `embed-manager` or `external` -- instead of a skip that reads like a shrug, and its detail names
    both the model and the deployment.
  - `status` now says *embedded data at ...* rather than *data at ...*, so which model is in play is
    visible in the line people actually read.
  - Dead code removed: `const pgReady = join(process.env.ProgramFiles, '..', '.pg0')`, which was
    never referenced and resolved to `C:\.pg0`, a path that does not exist.

### Added

- **[`DESIGN-enforcement.md`](DESIGN-enforcement.md)** -- the design for isolation and in-place
  encryption, written before the code because this is the half where a mistake costs someone their
  machine. It states what each capability actually stops (an ACL is a door lock, encryption is a
  safe, and neither touches a process that is already running), the trigger that does not exist yet,
  the action contract every action must satisfy, the failure modes as required behaviour rather than
  as mitigations, and the never-list. It ends with stage 0 and nothing else: make `wouldAct`
  something a person can see, attach nothing to it, and let the data decide whether later stages are
  worth building.

### Fixed

- **`policy mode reject` claimed it would terminate things, and nothing terminates anything.**
  `suspend` and `reject` are accepted by the CLI and implemented nowhere -- `wouldAct` is computed by
  `decideSignals` and read by no one, and the recorder has no process-control capability at all. So a
  user could set a mode, be told *"unpermitted stealth will be TERMINATED"*, and have nothing happen.
  A setting that promises an action the tool cannot take is the exact failure this project exists to
  remove, and the tool was committing it in the one place a user is most likely to believe it. The
  message now says what actually happens and points at the design.

### Security

- **The daemon collector now identifies the daemon instead of a name.** `stop`'s second level
  walks the port owner's parent chain and kills what it collects, and its whole admission test was
  `@('python.exe','pythonw.exe','hindsight-api.exe','uv.exe','uvx.exe') -contains $p.Name`. Any
  python.exe from anywhere passed, and the anchor is only "something is listening on 9077", which is
  not by itself proof of what it is. A process could be killed for resembling the target.
  - The real chain was measured rather than assumed. Every member names either the daemon or the
    port in its command line — the uv-python launcher carries `hindsight-api.exe` in its arguments,
    the outer `uv.exe` and `uvx.exe` carry `hindsight-api@0.9.2` — so a chain member must now have a
    name the daemon uses **and** a command line that says so.
  - A process failing it stops the walk and is reported with its pid, image, path and the reason,
    rather than being killed for standing near the daemon.
  - `killDaemonTree` grew a `dryRun`. A function that kills processes has to be able to answer
    "which ones, and why" without killing them, and that is also the only way to test this against a
    machine that needs its daemon.
  - `stop` no longer collapses the two outcomes into one string. A refusal used to be reported as
    `service is still running and no collectable process was found`, which hides the only sentence
    that would tell a person what to do next; it now reports the refusal, the image and the path.
  - Verified both directions against the live machine: the real five-process chain is accepted
    (pids 5756 -> 9772 -> 13608 -> 2516 -> 13816, the same chain identified by hand beforehand), and
    a foreign port owner — this host's own DSH process, a `node.exe` on 3080 — is refused with its
    path and reason while remaining alive.

- **Command lines are redacted before they are written.** The recorder stores every process's full
  command line, because a command line is often the only thing that distinguishes an expected
  process from an unexpected one -- and for exactly the same reason it is where secrets travel.
  `app.exe --token abc123`, `mysql -phunter2`, `AWS_SECRET_ACCESS_KEY=...`,
  `curl -H "Authorization: Bearer ..."` all landed in an append-only log that several views read.
  A tool built to make the machine legible must not become the place credentials are archived.
  - Redaction happens at the WRITE point, in `bin/redact.ps1`, before the line reaches disk.
    Redacting only on display would leave the secret in the file and merely hide it from the
    default view -- worse than not redacting, because it looks safe.
  - `redactCommandLine` in `lib/core.mjs` is a second implementation, for rendering records written
    before redaction existed. Two implementations of a security-relevant function is a smell, so
    the smoke suite feeds one fixture to both and checks every expected output, not merely that
    they agree -- two identically-wrong implementations agree perfectly.
  - The rules are deliberately narrow: explicit secret-bearing flags, assignments to
    secret-looking names, Authorization/Bearer headers, and URL credentials. Long random-looking
    strings are NOT redacted. Hashes, GUIDs, build ids and base64 in ordinary arguments are
    common, and a rule that guesses would either bury the log in placeholders or teach people to
    ignore them.
  - The executable token is never touched: `exeFromCmd` parses it out of the same string to decide
    which process ran, and the `binary-vanished` rule depends on it.
  - If `redact.ps1` is missing the recorder falls back to the executable alone rather than
    recording raw command lines, so a missing file degrades transparency instead of leaking.
  - Three bugs were found in the Authorization rule by running it rather than reading it, after
    reading it looked correct twice: consuming only `authorization:` ate the word Bearer and left
    the token in the clear while *looking* redacted; a greedy value swallowed the closing quote of
    the enclosing argument and with it the next argument; and `Authorization: Basic <base64>`
    stopped at the space after the scheme and exposed the credentials.

### Added

- **uv cache hygiene** (`lib/uvcache.mjs`, CLI `cache`). The cache had grown to 8.60 GB across
  three different kinds of waste, which need different handling:
  - *duplicate copies* — the same package and version extracted under two hashes; `torch 2.14.0`
    alone was cached twice (986 MB across 16 entries).
  - *older versions* — a newer version was pulled and the older one stayed (941 MB across 37).
  - *idle environments* — uvx builds a full virtualenv per dependency set and never reaps them.
    Seven were idle at 4088 MB; four of those were over a gigabyte each.
  - `cache` reports, `--prune` lists the exact removals, `--apply` carries them out. Measured:
    60 entries, 5.87 GB, leaving 2.76 GB.
  - In-use detection is the safety argument, not a nicety: a cache entry is reproducible, so
    deleting one costs a re-download -- but deleting the entry a running daemon executes from is
    an outage. Detection scans the executable path of every running process, and a delete that
    fails is reported rather than retried, because an entry that cannot be removed is one in use.
  - `simple-v24`, `interpreter-v4`, `environments-v2`, `git-v0` and `builds-v0` are never
    touched: removing the index cache only forces metadata to be re-fetched.

### Changed

- **The README described a tool that no longer exists.** It called this a supervisor for the
  Hindsight daemon and listed nine commands; there are thirty. Observation (`activity`, `busy`,
  `reveal`, `redline`, `cache`) and incident response (`signals`, `decide`, `policy`, `detain`,
  `timeline`) were absent from it entirely, so the front door of the repository understated the
  project by two thirds. Rewritten around the three roles it actually has, with the command surface
  grouped by role.
  - Two claims in it were false rather than merely stale. It said the smoke suite is "deliberately
    offline: no network, no uv, no running daemon" -- it drives the real CLI fifteen times and
    invokes PowerShell, so on a machine with the service running it reads live state. And it called
    the platform story portable while twenty-three call sites are Win32-specific; the platform
    section now states the split instead, and says what porting would actually involve.
  - `package.json` declared `os: ["win32", "darwin", "linux"]`. That field constrains where a
    package may be installed rather than describing what it supports, so listing three platforms
    while the platform layer is Windows-only stated something untrue in metadata. Removed, with the
    real position documented in the README.
  - `resources` and `defer` were implemented and reachable but absent from `--help`, having missed
    the list when the resource layer landed in 1.1.0.

- **`status` is read-only by default; `--deep` is what measures warmth.** Measuring the uv env
  means running `uvx --with pg0-embedded hindsight-embed@<v> --help`, and uvx builds an ephemeral
  environment in order to run anything at all -- so a status call against a cache with no matching
  environment *creates* one. `status` is the command run most often, by hand and by agents, on the
  understanding that looking changes nothing; it was also feeding itself, because those generated
  environments are the ~5 GB of idle uvx environments `cache --prune` exists to remove.
  - `status --json` now reports `envMeasured`, and `env` is `null` rather than a fabricated
    default, so a caller can tell "not measured" from "cold". Warmth was never part of the chain's
    health, so leaving it unmeasured does not make anything look unhealthy.
  - The MCP `volcano_status` tool gained an optional `deep` input, defaulting to false, and its
    description says plainly that the flag is not read-only.

### Fixed

- **The detector could not fire on this machine, because the rule's own subject was allowlisted.**
  The disk policy redirects TEMP into a directory under an allowlisted volume root, and the built-in
  allow list carries that root (`path:e:/dashaohuo/`). Both rules whose entire subject is "a
  temporary directory" were therefore pre-approved: `ask` was always 0, which reads as "nothing to
  report" and meant "this rule cannot fire". Zero false positives and zero true positives are
  indistinguishable from the outside.
  - Trust propagates down to ordinary paths; it does not propagate into a directory that exists to
    be disposable. A high-severity finding inside a scratch directory is no longer silenced by an
    allow entry that only covers it by covering the volume above it. An entry naming the scratch
    directory itself, or something inside it, is a decision about it and still counts.
  - Only high-severity findings are treated this way, deliberately. `exec-from-ephemeral` is low,
    frequent and often innocent — builds, installers, portable tools — which is exactly what it was
    ranked low for; a broad allow remains a reasonable answer for it. If it started asking, the rule
    would become noise and get ignored.
  - What would have silenced a finding is reported as `suppressedBy` rather than dropped, so
    "detected and suppressed by an inherited allowlist" is visible as itself and not as "no finding".
  - Measured on the machine this was extracted from: `ask` went from 0 to 1 over three days of
    record, and the finding was real — a PyInstaller build that ran from a scratch directory and
    cleaned itself up. That is the expected benign shape, it is rare (188 references to the build
    directory produced one finding), and saying "that was my build" once is the workflow the custody
    design exists for. `mode` remains `observe`, so nothing acts on it.

- **`decideSignals` re-derived what `analyzeSignals` had already decided.** It called `policyAllows`
  again and discarded the `allowed` the analysis had computed, so the suppression rule above was
  implemented, honoured by the analysis, and then ignored by the verdict. Found by a test asserting
  the verdict rather than the analysis — a test of the analysis would have passed.

- **The MCP server reported version `1.0.0`, five releases out of date.** It was hardcoded while
  `package.json` moved on, so a client asking the server what it was got a wrong answer. The
  version is now read from the one place that declares it; the fallback is deliberately not a
  plausible version number, because naming a release that does not exist is worse than saying the
  file could not be read. Checked by actually performing the `initialize` handshake rather than by
  grepping the source, since a grep passes on any rewrite that keeps the same shape.

- **`cache --apply` staged every removal by rename, closing a race the in-use scan could not.**
  The scan of running processes and the `rmSync` that followed were not atomic, so a process that
  started using an entry in between was not protected at all -- and a recursive `rmSync` can delete
  half a tree before failing, leaving a running process with the files it had already mapped and
  missing the ones it had not. The scan is now only a cheap pre-filter; each entry is renamed into
  a staging directory first.
  - Windows refuses to rename a directory while a file inside it is open -- **verified, not
    assumed** -- so a refused rename is the authoritative, atomic in-use answer rather than a
    better guess. An entry that refuses is reported as such and left alone.
  - Checked both ways against the real cache: with a file inside an entry held open, the run
    reported `refused by the filesystem (in use)` and removed nothing; with the lock released, the
    same run removed the entry and left the staging directory empty.

- **The signal layer's two ephemeral rules cannot fire on this machine.** `analyzeSignals` and
  `decideSignals` had no test coverage at all, and `ask` was always 0 — but zero false positives
  and zero true positives are indistinguishable from the outside. Twelve checks now cover the
  three rules, their severities and the allow / note / ask mapping, against a scratch path that is
  *not* allowlisted, and they prove the detector works.
  - Writing them exposed a real defect: this machine's disk policy redirects TEMP to
    `E:\DaShaoHuo\cache\tmp`, and the built-in allow list contains `path:e:/dashaohuo/`. The two
    rules whose entire subject is "something running from a temp directory" are therefore
    pre-approved and can never ask for a human decision. The behaviour is pinned by a check that
    names it a defect.
  - Not fixed yet: the fix is a policy change with a real cost, since exempting temp from the
    volume allow would immediately fire on legitimate work such as uv building in
    `D:\DaShaoHuo\cache\uv\builds-v0\.tmp*\`.

## 1.5.0 — 2026-10-04

### Added

- `timeline [--all] [--days N]` — the life of each custody decision: frozen, what was done, how it
  ended, and what was reported while it was live.
- The open-questions output now says which decisions are still real, rather than listing ones
  already resolved.

## 1.4.0 — 2026-10-04

### Added

- Custody that somebody else ended is now reported as such. A release is not always ours to
  perform, and the record previously could not tell the difference.

## 1.3.0 — 2026-10-04

### Added

- Frozen processes that nothing recorded are now detected. A suspension is persistent, so a
  process frozen by an earlier run — or by something other than this tool — stays frozen, and
  previously nothing would say so.

### Fixed

- A substring match that lied. The check matched a name it should not have, and passed.
- The recorder's lock guard was not guarding: the lock file was held but empty, so reading a pid
  from it threw and the guard treated a live lock as stale.

## 1.2.0 — 2026-10-03

### Fixed

- Custody reconciliation now runs before the service chain, not after. Running it second meant a
  freeze nobody came back for could be reported against a service that had already failed.
- A forgotten freeze now speaks up. Previously a suspension outlived the run that created it in
  silence.

## 1.1.0 — 2026-10-03

The release where the tool stopped being only a service watchdog. Everything below exists
because "the service is up" turned out to be a much smaller claim than "the machine is legible".

### Added

- **Activity transparency** — a system-wide recorder (`activity-watch.ps1`, SYSTEM, boot-triggered,
  event-driven) writing NDJSON, plus `activity [n]` and `busy [minutes]`. Recording is not
  transparency: `busy` shows what has actually been running, grouped by runs, location and
  allowlist membership.
- **`reveal windows | process <pid> | chain <pid>`** — every top-level window (including hidden
  ones, which can be forced visible), everything observable about a live process, and the
  inherited chain recovered from history.
- **Custody** (`detain` / `release` / `detained`, `heal --custody`) — freeze a process, force its
  windows open, and open a custody window that asks a human. It never quarantines: it does not
  move, rename, rewrite or delete the target.
- **`redline`** — the C: rule as a check rather than a habit: what is sitting in user-writable
  space, with `--record` to keep findings. Heavy work is now gated on headroom.
- **Resource layer** (`lib/resources.mjs`, `lib/core.mjs:probeResources`). The uv / daemon /
  hindsight layers kept the service reachable but said nothing about whether the machine could
  afford an unrelated heavy job. A batch decompiler peaking at ~1.8 GB ran against a daemon
  holding ~1.25 GB and the daemon was killed -- twice.
  - `probeResources` reports free memory, CPU load and the largest processes with their command
    lines, so the embedded services (which run as a generic interpreter image) can be recognised.
  - `decideDefer` and `waitForHeadroom` turn that into a go / defer verdict with explicit floors.
  - CLI: `resources [n]` and `defer [--wait]` (exit 0 = go, 3 = not now).
  - `heal` now measures headroom before starting the service and, if the service comes up and
    then dies, records how much memory was left and who held it -- separating "broken" from
    "there was no room".
- **L1 `signals`** — notice stealth, act on nothing. High-severity findings included empty-window
  processes and persistence written from an ephemeral directory.
- **L2 `decide` / `policy`** — what each signal would mean, still acting on none of it. Verdicts
  are `allow` / `ask` / `note`, and `mode` is `observe`.
- **The heartbeat also notices** — the five-minute tick reports rather than only repairing, and
  reconciles custody alongside `probe`.

### Changed

- **"A listening port is not a working service."** The daemon kept `/health` green while it could
  not reach Postgres, and `status` reported the whole chain healthy throughout. Probing was split
  into readiness and liveness, so a daemon that cannot reach its database now reads as unhealthy.
- The tree is publishable: English, no machine traces, neutral wording.

### Fixed

- **The recorder had been writing nothing**, and three of the changes made here caused it: the
  portable default for `$env:TEMP` resolves to machine temp under SYSTEM; the guard ran before
  the log directory existed, so `CreateNew` threw and was read as "lock held"; and the guard
  failed closed. The task now passes `-LogDir` explicitly, creates it first, and fails open.
- Two recorder instances locked the record away from its readers — `readActivity` returned
  "0 events, no recorder" while the recorder was alive, writing, and holding a 2.2 MB file.
  A tool that cannot read its own output has reproduced the problem it exists to remove.
- A BOM was eating the custody summary. PowerShell's `Set-Content -Encoding UTF8` writes one, and
  `JSON.parse` rejected the file — which surfaced as "no summary was written".
- A bare `--flag` no longer eats the next argument. `--no-custody` was left undefined, so custody
  ran when it had been switched off by hand.
- The custody window is handed to the OS rather than kept as our child, so it survives us.
- Two smoke checks were corrected to accept degradation that is in fact correct.

## 1.0.1 — 2026-09-30

Found the same day, by the tool failing to notice its own service misbehaving.

**"The port answers" is not the same as "it works".** The daemon kept `/health` green while it
could not reach Postgres: a saturated disk (a background file purge of mine) made the asyncpg
connection handshake time out 48 times, and every memory write stalled with no visible reason.
`status` reported the whole chain healthy throughout. The lesson is exactly the one this tool
exists for -- an "up" signal that does not mean "working" is worse than no signal.

**Added**

- `probePostgres` — TCP probe of the daemon's Postgres port plus a check that the embedded
  instance's data directory exists.
- `probeDaemonLog` — scans the daemon's own log for `db-timeout` / `refused` / `error` lines.
  It reads only the tail (these logs rotate at ~100 MB) and uses **two windows**: errors in the
  last `logErrorWindowMinutes` (default 5) mean the service is failing *now* and drive health,
  while the older `logWindowMinutes` (default 30) window is reported as context. An incident that
  has already recovered shows up as `quiet for 5 min; N earlier (recovered)` and does **not** keep
  the chain marked unhealthy -- otherwise the signal becomes noise.
- `status` now fails when the daemon is up but its database is unreachable, and prints the most
  recent daemon-log errors with a note that a saturated disk is enough to cause it.

**Changed**

- `status --json` gained `postgres` and `log` sections; `database` now also reports `listening`.

## 1.0.0 — 2026-09-30

First release. Extracted from a real failure on a machine where the Hindsight daemon
was dying silently, and the cause turned out to be structural rather than incidental.

**The measurement that started it** (`volcano-separator doctor`, from the host plugin's log):

```
12 start attempts, 7 failed on timeout, 1 succeeded
```

Every failure was a ~180 s watchdog timeout with `Downloaded botocore` /
`Built claude-agent-sdk==0.2.16x` on the start path — a build racing a watchdog.

**Added**

- Staged recovery: `warm` (no watchdog) → `serve` (seconds once warm) → `watch` (heartbeat).
- `heal` with a fast path: a single TCP probe when healthy, so it costs ~0.9 s.
- `status` whole-chain check: uv toolchain, env warmth (measured by a dry run, not guessed),
  daemon port + `/health`, Postgres instance, watchdog task state. Junctions are resolved
  so the reported cache path is the real one.
- `doctor`: historical start-failure analysis straight from the host plugin log.
- `guard <op>`: refuses unsafe `uv cache clean|prune` while the daemon is running, and
  prints the safe order (`stop → uv cache <op> → heal`).
- `install-service` / `uninstall-service` / `service`: watchdog via the OS scheduler —
  at logon plus a repetition interval. No resident supervisor process.
- MCP server exposing `volcano_status`, `volcano_heal`, `volcano_doctor`.
- Two-level `stop`: the official embed-manager path first, then a port-owner process-tree
  fallback for daemons the host plugin spawned itself (the embed manager reports
  `Could not find PID for port 9077` and refuses to touch those).

**Notes**

- Zero third-party dependencies. Node >= 20.12.
- Scheduled-task integration is Windows-only for now; the staging model is portable.
