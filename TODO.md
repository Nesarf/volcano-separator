# TODO

Work that is agreed, not yet done. Each entry states what is measured, what the real blocker is,
and what would count as finished — because a TODO that only names a wish is a note to feel good
about, not a plan.

---

## Volcano Separator must not be built for one LLM only — DONE

**Added:** 2026-10-06 · **Status:** done, verified 2026-10-11 · **Scope:** large (touched the whole supervisor layer)

### What was built, and what settled it

The seven coupling faces listed below were collected from a measurement and generalised into a
**service descriptor** (`lib/service.mjs`): a service is now a value a caller reads, disagrees with or
replaces, rather than a fact about this repository. Two descriptors exist — Hindsight and the DSH host —
and the second is what proved the shape carried: `resolveContext` derives `serviceId`, `serviceLabel`,
`serviceDescriptor`, `dataDir`, `runtimeModule` and `profile` from it, with **no literal `~/.hindsight`
left anywhere**.

The part that was easy to miss, and which the second descriptor exposed: **the operations were not
general even though the descriptor was.** `warm`, `serve` and `heal` are one service's sequence — a uvx
build, a daemon start and a watch — and the DSH descriptor's own comment claimed *"the CLI refuses them
for this service"* while the CLI ran all three for whatever it was pointed at. **A comment describing an
intention is not an implementation.** The judgement is now declared on the descriptor that has a
sequence (`recovery: { verbs, why }`), so a third service can declare one without the refusal code
moving, and the CLI refuses as a distinct outcome (exit 3) rather than as a failure or a success.

### The original statement, for the record

### The intent

Today this tool supervises one specific stack: `uv` → the **Hindsight** daemon → its embedded
PostgreSQL. It should be able to supervise any comparable local service — another memory/agent
daemon, a different runtime, a different database — without being rewritten.

### What is actually coupled (measured 2026-10-06)

Search across `lib/` and `bin/`: **45 occurrences of `hindsight`, 3 of `coding-agent`**, spread over
seven modules (`core`, `database`, `live`, `mcp`, `resources`, `supervisor`, `cli`).

Counting method, so the next person gets the same number:
`grep -roi hindsight lib/ bin/ | wc -l` and `grep -ro coding-agent lib/ bin/ | wc -l`.
A first attempt used a pattern that accumulated case variants separately and reported 44 — which is
the whole reason this line says how to check it.

Already configurable, so **not** the problem:

| Already parameterised | Where |
| --- | --- |
| profile name (and with it the `.env` / `.log` / `.lock` names) | `DEFAULTS.profile`, `--profile` |
| daemon port | `DEFAULTS.port`, `--port` |
| database port | `DEFAULTS.pgPort` |
| uv cache directory | `DEFAULTS.uvCacheDir` / `UV_CACHE_DIR` |

The real blockers, in rough order of how much they cost:

1. **Paths are hardcoded to Hindsight's layout.** `resolveContext()` builds
   `~/.hindsight`, `~/.hindsight/coding-agent.json`, `~/.hindsight/profiles/`,
   `~/.hindsight/daemon.log` from a literal. A service with its own directory convention cannot be
   pointed at without editing source.
2. **The database instance name is derived from the profile name**, so the embedded database is
   named `hindsight-embed-<profile>` by construction. A different backing store has no say.
3. **`DEFAULTS.withPackages` carries `pg0-embedded`**, which is Hindsight's own embedded-database
   packaging.
4. **The health semantics are Hindsight's.** This is the hard one and the one worth stating plainly:
   `probeDaemon` treats `GET /health` as readiness and `GET /health/live` as liveness, and
   `probePostgres` speaks the PostgreSQL wire protocol. **Making the paths configurable is
   mechanical; making the health model configurable is design.**
5. **The daemon's command line is built for Hindsight** (`daemonArgs`), so "what is being started"
   is not declarative.

Note the shape of what is *not* coupled, because it is most of the tool: the activity recorder, the
signal rules, custody, ACL isolation, in-place encryption, the resource gate, the evidence ledger
and the MCP surface are all **service-agnostic already**. The coupling lives in the supervisor layer
and in `resolveContext`.

### What finished looks like

- A **managed-service descriptor** — a declarative value describing: the command that runs it, the
  directory convention it uses, how to ask whether it is alive, how to ask whether it is *ready*,
  and what data store (if any) it depends on.
- A **Hindsight descriptor** that reproduces today's behaviour exactly, so the default path is
  provably unchanged: the existing suite is the evidence.
- `resolveContext()` no longer contains Hindsight's directory names; it reads them from the
  descriptor.
- **The health model becomes pluggable the same way the database model already is.** `pgMode` and
  `deployment` were made explicit as two orthogonal questions (`windows-service` / `embed-manager` /
  `external`, and `embedded` / `declared` / `unknown`) and that pattern is the precedent to follow,
  not a new one to invent.
- A second descriptor exists and is exercised by at least one test — because a pluggable design with
  one implementation is a design nobody has tested.

### What must NOT be generalised

Two temptations to refuse explicitly:

- **The database probe must not be weakened into "is the port open".** It currently performs a real
  `SELECT 1`, deliberately: `LISTEN` plus a data directory plus a failing handshake is a state that
  exists, and a socket probe cannot see it. A generic version must let a descriptor declare *how to
  ask a real question*, not drop the question.
- **The honesty rules are not per-service.** `unknown ≠ zero`, "a record must not claim what did not
  happen", and "refuse rather than silently fall back" hold for every descriptor. A pluggable health
  model must not become a way to declare weaker evidence as acceptable.

### Why this is worth doing at all

Not for reach. The reason is the one this project already applies to `pgMode`: **an assumption that
is never named cannot be checked.** Hindsight being the only shape the code can express is exactly
the kind of implicit assumption that made the earlier bug possible — where `ensurePgService` and
`probePostgres` each held half of a two-part answer and both reported the wrong one for the other's
machine. Naming the service as a descriptor is what makes "what is being supervised" a value someone
can read, disagree with, and replace.

---

## The tool must gain real enforcement capability (nothing forbids it; the wiring is missing)

**Added:** 2026-10-06 · **Status:** BLOCKED on the promotion gate in DESIGN 4.2 · **Scope:** the decision and action layers

> **2026-10-11 — this is the only item left, and it is not blocked on code.**
> The gate has four requirements and three are unmet. All three wait on the first: no `ask` has ever
> fired on real traffic, because `exec-from-ephemeral` is looking for an executable that runs from a
> scratch directory and **over five days and 25,544 process starts, none of the 6,454 with an absolute
> executable path did**. The other two are not missing chores either — `human` is *structurally*
> unanswerable until an ask has a path to a person (`ask` is a computed verdict and nothing waits on
> it), and `quiet` has nothing to measure between because `recordDecisions` writes nothing while the
> mode is `observe`. See `promotionGate` in `lib/signals.mjs` for the measurements.

### Framing: this is not a permission problem

The distinction matters, because the two are fixed in completely different places.

**Nothing in this codebase forbids acting.** There is no gate that returns before an action, no
refusal path keyed on a mode, no policy value consulted before doing something. Grepping for a
prohibition finds one thing, and it is not a prohibition: `POLICY_DEFAULTS.neverQuarantine`, a comment
plus a field that `loadPolicy` spreads into its result and **no code ever consults**. One hit, the
definition. `policyAllows` reads only the `allow` array. It is not in `policy show`. It cannot be set,
and it cannot be wrong.

So the target of this entry is not "stop forbidding" -- it is **"finish the wiring"**. The four gaps
are all the same shape: the thing exists, the wire is missing.

| | State |
| --- | --- |
| `policy.mode`'s `suspend` / `reject` | **declared, zero implementation** |
| `wouldAct` / `actionable` | **computed, read by nobody** |
| `encrypt` / `decrypt` | **written, zero callers** |
| `isolate` / `detain` | **work, but only when a human types the command** -- no rule engine can invoke them |

The last row is the one that matters most, and it is easy to miss: **even the capabilities that work
have no automatic caller.** The MCP surface deliberately does not expose them, and says why --
"isolating and restoring are deliberately NOT exposed here, because an agent should not be able to
change what can execute on this machine". So a capability being built is not the same as a capability
being reachable from a decision.

`neverQuarantine` still deserves a disposition, on its own terms: a field whose name suggests a live
switch, sitting next to fields that *are* live, is a false signal of the kind this project exists to
remove. Either it becomes a real switch, or it goes.

### What actually blocks enforcement (measured)

Not ceremony. These are the four concrete blockers, and the first two are the whole story:

1. **`policy.mode` accepts `suspend` and `reject` and implements neither.** The CLI validates the
   values and honestly reports that nothing enforces them. The decision layer has no action path.
2. **The decision layer's counterfactual has no consumer.** Per finding, `analyzeSignals` sets
   `wouldAct`; per window, `decideSignals` counts `actionable` — the findings a mode other than
   `observe` would have acted on. That count is written to `~/.volcano-separator/evidence.ndjson` on
   every heartbeat and shown as `would act N of M`. **Nothing acts on it.** The module says so
   itself: *"`wouldAct` has been computed here since this layer was written and read by nothing. That
   is the right state until the promotion gate has a number to look at, and this is that number:
   how many findings are serious enough and uncovered, and therefore how many times a mode other than
   observe would have done something."* The number now exists; the promotion is what this entry is
   about.
3. **No measured false-positive rate exists.** `DESIGN-enforcement.md` §4.2 gates Stage 2 on "`ask`
   fired at least N times on real traffic", because a rule that has never fired has no error rate to
   quote. Measured today: `~/.volcano-separator/evidence.ndjson` holds **2 rows**, and every one of
   them reads `actionable: 0, total: 0`. The ledger is working and the sample is empty — which is a
   statement about how quiet or how blind the detectors are, and nobody knows which yet.
4. **No undo has ever been exercised in production.** The design also gates on "the action was undone
   at least once, successfully", on the grounds that an undo path which has never run is a
   hypothesis. `isolate`'s restore path *is* exercised, by tests and by hand — but never as part of a
   real enforcement decision.

### What "executable capability" should mean here

The rule to relax is narrow, and it is worth stating which operations never needed it relaxed:

| Operation | Does it need the rule relaxed? |
| --- | --- |
| suspend / resume a process (`detain`) | no — already built, already permanent |
| isolate by ACL (`isolate`) | no — already built, already reversible |
| encrypt in place (`crypt`) | no — already built; the README already scopes the promise per action |
| **refuse, record, escalate, notify** | no — this is what it does today |
| **move a file to a vault** | **yes** |
| **delete a file, or hold it unreachable** | **yes** |
| **block a launch before it happens** | **yes** (needs a filter driver; a scheduler is too late) |

So the entry is not "abandon the promise". It is: **add the operations that were excluded by fiat,
and keep the exclusions that are load-bearing.** The load-bearing ones are `%SystemRoot%`, the
installation caches, the isolation journal, and the tool's own directory — a refusal there leaves
everything exactly as it was, whereas a quarantine there is an act whose cost falls on the user and
whose certainty does not.

### Safety requirements, built in the same change rather than after it

These are not aspirations; each is a condition of shipping the action:

- **Every action ships with an undo that does not depend on this tool running.** The precedent is
  already in the codebase: `isolate` stores its ACL with `icacls /save` and prints the `icacls
  /restore` command on every result, verified by deleting the journal entirely and restoring by hand.
- **A measured false-positive rate before anything acts unattended.** The evidence ledger exists for
  this and its numbers are still single digits.
- **Reason-bearing decisions.** The refusal messages in this codebase already name *why* they refused.
  An action that can disturb a user's files must carry the same property, because "it acted" without
  "here is what it thought it saw" cannot be argued with after the fact.
- **The journal must stay tamper-evident.** Moving and deleting raise the stakes on the one file that
  authorises undo.
- **A cap on what an unattended run may do in one window.** The failure to design against is not one
  wrong action; it is a wrong rule acting on every matching file before anyone looks.

### What this entry supersedes

An earlier decision in this session held enforcement back until the other work was finished ("Stage 2
— you said to discuss it after the rest is done"). **This entry records that the intent has changed:**
enforcement capability is wanted, not deferred. The measured blockers above are the reason it is not
a small change, not a reason to keep deferring it.

### What finished looks like

- `policy.mode`'s `suspend` and `reject` either do something or stop being accepted. A mode a user
  can set while nothing reads it is the failure this project keeps finding.
- `wouldAct` acquires a consumer: an action path reachable from a decision, gated on the measured
  evidence rather than on a hardcoded mode.
- At least one destructive-class operation exists — vault, delete, or launch interception — with its
  undo demonstrated end to end, including with this tool deleted.
- `neverQuarantine` is gone as a false switch, replaced by the explicit per-operation scoping that
  `crypt.mjs` already had to adopt.

---

## One detector rule has never had any input, and the gate's sample is measured at 3 — ANSWERED

**Added:** 2026-10-06, **answered in the same pass** · **Scope:** small · **Outcome:** see below

### What the ledger could not tell apart, and what the answer is

`evidence.ndjson` held 2 rows both reading `actionable: 0`, and that emptiness had two possible
causes the ledger cannot separate: a quiet machine, or a blind detector. This project has produced a
counter that could only ever read zero twice before, and both looked exactly like a quiet machine.

**The rules are not blind.** Their firing is already asserted in the test suite (a crafted record
that trips all three at once, an ordinary system process producing nothing, and the chain on to
`ask`). What had never been done is replaying the **real** record through the real detector. Done:

```
3 days of the live activity record, read-only:
  findings            16
  by rule             exec-from-ephemeral 11, binary-vanished 5
  decisions           16  ->  allow 13, ask 3
  actionable          3
```

So the detector works on real traffic, and the first gate row ("`ask` fired at least N times on real
traffic") has a measured answer: **N is currently 3.**

### The finding that matters: one rule has no input at all

`persist-from-ephemeral` returned 0, and the reason is not that the machine is clean. Counted by kind
over the same record, 128,096 lines:

```
proc-start   63,548     proc-stop  63,548     isolate  848
watcher          14     baseline       14     detain   112
custody-alert     5     persist         0   <- the rule's only input
```

**The recorder has never recorded a single persistence change.** `persist-from-ephemeral` fires on
`kind === 'persist'` records, and there are none -- so that rule cannot fire in production, no matter
how long the evidence is collected. It is not a detector problem; it is an input problem, one layer
below, and the two look identical from the ledger.

This is exactly the failure mode this project keeps finding, in a new place: **a rule whose input
never arrives reports the same zero as a rule that looked and found nothing.** Waiting a month for
data would have produced a month of zeros for this rule and no explanation.

### The second thing the same count exposes: **410 unreadable records, and a real bug behind them**

Counted properly -- parsing every line, not just the one day's 128k-line file:

```
8 files, 403,685 records, 410 unparseable (0.102%)
```

**Not partial tails.** Every one sits mid-file, and every one is a `proc-start` whose `cmd` spans
multiple lines. The cause is in the recorder's own escaping:

```powershell
-replace "`r?`n", ' '     # matches CR+LF, or a bare CR -- and MISSES a bare LF
```

A command line carrying a bare LF -- which is what a multi-line bash command produces -- escaped the
pattern untouched, so a raw newline landed inside a JSON string and the whole record failed to parse.
Fixed in `activity-watch.ps1` and `detain.ps1` (both had the same expression), now asserted against
every line-break shape with a JSON round trip, and **the assertion was verified to fail on the old
pattern before being kept**.

Two things worth stating plainly:

- **The record loses these silently.** `readActivity` counts *file* read failures, not *lines* it
  could not parse, so 410 records vanish with nothing reporting it. Since the run-through above
  shows 16 findings over the same record, **0.1% of unreadable records is 0.1% of findings**, and
  fewer findings reads as good news.
- **Every damaged record is recoverable and none was recovered.** All fields survive -- `kind`, `t`,
  `pid`, `name`, `user` -- and only the `cmd` string is truncated at the newline. The repair is to
  re-escape the raw control character inside the string and parse again; it has not been run, and
  should be a deliberate decision rather than a convenience, because rewriting the record is itself
  an operation on evidence.

The same class of mistake has now appeared four times in this project, always in the layer that
translates between shells: `readJsonLoose` and the BOM, `exeFromCmd`'s regex literal blinding the
import lint, the audit scanner repeating that bug, and now an escape pattern that misses one
character. It is recorded here because the pattern is the finding, not the individual bug.

### What finished looks like

- **Decide what `persist-from-ephemeral` is for.** Either the recorder's persistence comparison is
  broken and should be fixed (the surfaces are enumerated every 30 passes and compared -- the
  mechanism exists and has simply never produced a difference), or Run keys and Startup folders
  genuinely do not change on this machine and the rule is noise that should be deleted rather than
  carried. Both are legitimate answers; carrying a rule that structurally cannot fire is not.
- **Report unreadable lines.** `readActivity` counts *file* read failures already; a line that
  parses as neither JSON nor a partial write should reach the same surface, because "fewer findings"
  reads as good news and that is the failure this whole layer exists to prevent. This one is now
  urgent rather than tidy: the recorder produced 410 of them, and nothing anywhere said so.
- **Decide what to do with the 410 damaged records.** They are recoverable (only `cmd` is truncated
  at the newline) and they were left untouched deliberately -- rewriting them is an operation on the
  evidence, and it should be a decision rather than a cleanup script someone runs while passing.
- **Record the outcome in `DESIGN-enforcement.md`** beside the gate table, which currently states the
  gate's first row as a requirement rather than as a measured number. It is now measured: 3.

---

## Isolation restore rejected a journal that isolation just wrote — FIXED

**Added:** 2026-10-10 · **Status:** fixed and verified · **Scope:** small, but it was the undo path

`npm test` was **6 of 473 FAILED on a clean `c662dd3`** with no local modifications, all isolate-section,
all reading `refused to restore: this journal carries no signature`.

### Root cause: `Get-FileHash` does not exist on this host

```
PS> Get-Command Get-FileHash
(nothing)
```

`Get-FileHash` lives in `Microsoft.PowerShell.Utility`, and **its presence cannot be assumed**. Measured
here it is absent, so `(Get-FileHash ...).Hash` evaluated to `$null` — and the script runs with
`$ErrorActionPreference = 'SilentlyContinue'`, which turned a missing cmdlet into a missing value with
nothing said.

That one fact produced three separate symptoms:

1. **The writer proceeded with an unverifiable journal.** `$backupSha` was null, the journal was written
   with `"backupSha256": null` beside a perfectly valid `hmac`, and **the ACL was denied anyway**. An act
   that cannot be undone had been performed.
2. **The restore path failed its comparison** for the same reason — `$actual` was null there too, so the
   hash check could never pass. That is the actual mechanism behind the six failures.
3. **The refusal named the wrong field.** One guard covered both conditions and always said "no
   signature", while the journal that triggered it had a valid signature and a null backup hash. The
   wording sent the reader to the field that was fine.

### The fix

- `Get-FileSha256` computes it with `[System.Security.Cryptography.SHA256]` over a `FileStream` — the
  framework hasher, which does not depend on which cmdlets are loaded. **One helper, both call sites.**
- **The order changed in the writer.** The hash is computed and checked *before* the key is fetched, so a
  failure there leaves nothing half-done. If the hash cannot be computed, **nothing is changed** and the
  refusal says so. This is the same rule the file already stated about the journal — an act that cannot
  be undone must not be performed — applied one step earlier.
- **The refusal names the missing field**, and distinguishes signature from backup hash.
- The restore path gained its own explicit case for "the backup exists but could not be hashed".

### Verified

```
isolate -> restore round trip:  ok: true   "the DENY entry is gone and the original ACL is back"
npm test:                       all 488 checks passed   (was 6 of 473 FAILED)
```

Two checks added for the distinction specifically: an unsigned journal is refused **and** the refusal
names the signature, and a signed journal missing only its backup hash is refused **and** named that
way. The second one is the case that actually occurred.

### What made this take a while

The guard's message pointed at the signature, and the same run's other assertion printed a field list
that **contained** `hmac`. Both readings were true; they were readings of different things. What ended
it was printing `$Spec` **inside the guard** rather than comparing JSON in the test: one instrumented
run showed `hmac=String` and `backupSha256=NULL` side by side, and the answer was in that line.

Worth keeping: a missing cmdlet quietly becoming `$null` is the same class of defect this tool exists to
remove. `SilentlyContinue` is right for most of this script and wrong for anything whose absence makes
an undo impossible.
