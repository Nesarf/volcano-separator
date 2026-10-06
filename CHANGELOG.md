# Changelog

## Unreleased

### Fixed

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
