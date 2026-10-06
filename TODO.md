# TODO

Work that is agreed, not yet done. Each entry states what is measured, what the real blocker is,
and what would count as finished — because a TODO that only names a wish is a note to feel good
about, not a plan.

---

## Volcano Separator must not be built for one LLM only

**Added:** 2026-10-06 · **Status:** not started · **Scope:** large (touches the whole supervisor layer)

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

## `neverQuarantine` must stop constraining the engineering, and the tool must gain real enforcement

**Added:** 2026-10-06 · **Status:** not started · **Scope:** the decision and action layers

### First, a measurement that changes what this entry means

**`neverQuarantine` is not constraining anything, because nothing reads it.**

`POLICY_DEFAULTS.neverQuarantine` is a comment plus a field that `loadPolicy` spreads into its result
and no code ever consults. `grep -rn neverQuarantine lib/ bin/` returns exactly one hit: the
definition. `policyAllows` reads only the `allow` array. It is not surfaced in `policy show`. It
cannot be set, and it cannot be wrong.

So the intention behind this entry is right and the target needs naming more precisely: **the thing
that limits what this tool can do is not `neverQuarantine` the policy field — it is the behavioural
rule stated in the README** ("it does not move, rename, rewrite or delete the target"), implemented
in the commands rather than enforced by a switch. `detain` suspends. `isolate` re-writes an ACL.
`crypt` rewrites the bytes and renames. **There is no quarantine to forbid, because there is no
quarantine to call.**

That is worth fixing on its own terms: a policy field whose name suggests a live switch, sitting
next to fields that *are* live, is a false signal of exactly the kind this project exists to remove.
Either it becomes a real switch, or it goes.

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
