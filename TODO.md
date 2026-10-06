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
