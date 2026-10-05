# Volcano Separator

[![CI](https://github.com/Nesarf/volcano-separator/actions/workflows/ci.yml/badge.svg)](https://github.com/Nesarf/volcano-separator/actions/workflows/ci.yml)

**A Windows workstation supervisor: it keeps a service reachable, and it makes the machine say what
it is doing.**

It started as one thing and grew into three, because the first job kept failing for reasons the
second and third exist to explain.

| Role | Question it answers | Commands |
|---|---|---|
| **Supervisor** | why did my memory service go away, and can it come back? | `status` `heal` `warm` `serve` `stop` `restart` `doctor` `guard` `install-service` |
| **Observer** | what is actually running on this machine? | `activity` `busy` `ps` `reveal` `resources` `redline` `cache` |
| **Incident response** | something is hiding — what do I do about it? | `signals` `decide` `policy` `detain` `release` `detained` `timeline` |

## The problem it was extracted from

```
uvx (the package installer)
 └─ an ephemeral env inside the uv cache   ← the daemon's own code lives here
     └─ the hindsight daemon               ← spawned on demand by a host plugin,
         └─ Postgres (pg0)                    only at session start / on retain
             ← the data lives here
```

The state of a *package installer* decided whether the *service* could start, and the service's
lifetime was decided by the *host's session timing*. When any link caught a cold, memory went away
— **silently**.

Measured on the machine this was extracted from (`volcano-separator doctor`):

```
12 start attempts, 7 failed on timeout, 1 succeeded
```

Every failure log showed `Downloaded botocore` / `Built claude-agent-sdk==0.2.16x` on the start
path. **A build and a watchdog were racing each other** — the plugin's watchdog allows ~180 s,
while a cold-cache uvx run on a spinning disk needs far more. It loses every time.

## The fix: stage the work so no watchdog ever races a build

| Stage | What it does | Watchdog |
|---|---|---|
| **warm** | make sure the uv env is complete (idempotent) | **none** — it may take minutes; it runs to completion |
| **serve** | start the daemon only once the env is hot | yes, but this is seconds now, so it cannot trip |
| **watch** | health probe and repair on demand | heartbeat, near-zero cost when healthy |

The property that makes this work: **`heal` costs about a second when healthy** (one TCP probe), so
it can run every few minutes without a resident supervisor process — **the scheduler does the
watching**.

The other half of the fix is upstream of this tool: point `UV_CACHE_DIR` at an SSD, so even a cold
start is fast.

## Install

```bash
git clone https://github.com/Nesarf/volcano-separator.git
cd volcano-separator
node bin/cli.mjs status          # no install step: zero dependencies
```

Optionally put it on PATH:

```bash
npm link            # provides `volcano-separator` and `vsep`
```

## Commands

**Service**

```bash
volcano-separator status [--deep]   # whole-chain check; see the note on --deep below
volcano-separator heal [--custody]  # intelligent repair: warm -> serve -> watch
volcano-separator warm [--force]    # warm the env only (no watchdog)
volcano-separator serve             # start the service only
volcano-separator stop | restart
volcano-separator doctor            # count historical start failures from the plugin log
volcano-separator guard clean       # is a uv cache operation safe right now?
volcano-separator install-service   # register the watchdog task (at logon + every N minutes)
volcano-separator service           # watchdog task state
volcano-separator resources [n]     # free memory, CPU load, largest processes
volcano-separator defer [--wait]    # exit 0 = go ahead, 3 = not now
```

`status` is read-only. The one probe that is not is the uv warmth measurement — it runs
`uvx --with ... --help`, and uvx builds an environment to run anything — so it is behind `--deep`
and reported as unmeasured otherwise.

**Activity**

```bash
volcano-separator activity [n]      # the system-wide process/window/persistence record
volcano-separator busy [minutes]    # what has actually been running, grouped
volcano-separator ps                # what is running now, with ages (spots a wedged process)
volcano-separator reveal windows    # every top-level window; --show forces hidden ones visible
volcano-separator reveal process <pid>
volcano-separator reveal chain <pid>  # inherited chain, recovered from history
volcano-separator redline [seconds]   # what is sitting on C: in user-writable space
volcano-separator cache [--prune] [--apply]   # uv cache: duplicates, old versions, idle envs
```

**Incident response**

```bash
volcano-separator signals [minutes]   # what looks like stealth, with evidence (observe-only)
volcano-separator decide [minutes]    # what would be done about each signal (acts on nothing)
volcano-separator policy show|allow|deny|mode
volcano-separator detain <pid>        # freeze it, force its windows open, open a custody window
volcano-separator release <pid>       # resume a detained process
volcano-separator detained            # what is under custody, reconciled against the live system
volcano-separator timeline            # the life of each custody decision
```

Options: `--profile <name>` (default `coding-agent`), `--port <n>` (default `9077`), `--json`,
`--quiet`, `--force`, `--dry-run`.

## Interfaces

| Form | Entry point | For |
|---|---|---|
| CLI | `bin/cli.mjs` | humans, scripts, the scheduled task |
| Library | `lib/core.mjs` | other tools (pure Node, zero dependencies) |
| MCP | `lib/mcp.mjs` | any harness — 13 tools, listed below |

The MCP surface is **read-only apart from `heal`**, and that is the design rather than a stage of
completion.

| Read-only | |
|---|---|
| service | `volcano_status` `volcano_doctor` |
| machine | `volcano_resources` `volcano_ps` `volcano_redline` |
| record | `volcano_activity` `volcano_busy` |
| detection | `volcano_signals` `volcano_decide` |
| custody | `volcano_detained` `volcano_timeline` |
| cache | `volcano_cache_plan` |

`volcano_heal` is the one that changes state: it repairs a service the agent is usually the reason
for needing, removes nothing, and the worst outcome is a slower path to the same place.

There is no `volcano_detain`, `volcano_release`, `volcano_cache_apply` or `volcano_policy_allow`.
Freezing a process or deleting cache entries are decisions a human should make, and `cache_plan`
exists so an agent can show a person exactly what a prune would remove and let them run it. An
agent that can act on its own is a worse failure than one that has to ask.

MCP client config:

```json
{
  "mcpServers": {
    "volcano-separator": {
      "command": "node",
      "args": ["/path/to/volcano-separator/lib/mcp.mjs"]
    }
  }
}
```

## Real traps it handles for you

**1. The daemon's code lives inside the uv cache.**
So `uv cache clean` / `prune` is blocked by the running daemon's in-use lock, and `--force` deletes
the running daemon's own files out from under it.
`volcano-separator guard <op>` checks first and prints the safe order:
`stop -> uv cache <op> -> heal`.

**2. A daemon started by the host plugin is not recognised by the embed manager.**
`hindsight-embed daemon stop` tracks its own PIDs; a daemon the host plugin spawned itself is not in
that record, so:

```
WARNING - Could not find PID for port 9077
WARNING - Port 9077 is bound but no hindsight daemon could be identified on it
Failed to stop daemon
```

`stop` therefore has two levels: the official path first, then **find the port owner and collect its
process tree**. Without that layer, one plugin-spawned daemon would make the supervisor permanently
unable to stop it.

Collecting a process tree is the most destructive thing here, so the identity check is not "the
image is called python.exe". That matches a python from anywhere, and the anchor is only "something
is listening on 9077" — which is not by itself proof of what it is. A chain member has to be a name
the daemon uses **and** name the daemon or the port in its command line, which every member of the
real chain does. Anything else stops the walk and is reported with its path and the reason:
`refused to kill pid 5136 (node.exe): image name 'node.exe' is not one of the daemon's`. A refusal
is reported as a refusal, never as "no collectable process was found" — those mean different things
and only one of them tells you what to do next.

**3. "The port answers" is not the same as "it works".**
A daemon can keep `/health` green while being unable to reach its database. Observed in the wild: a
saturated disk made the daemon's Postgres connection handshake time out 48 times, the port never
blinked, and every memory write stalled with no visible reason. That is why `status` also probes
Postgres *and* scans the daemon's own log — using **two windows**: errors in the last 5 minutes mean
it is failing *now*, while anything older is reported as context (`recovered`) so a past incident
does not keep the chain marked unhealthy forever.

**4. Command lines carry secrets.**
The activity recorder stores full command lines, because that is often the only thing distinguishing
an expected process from an unexpected one — and for the same reason it is where credentials travel.
`--token`, `--password`, `AWS_SECRET_ACCESS_KEY=`, `Authorization: Bearer ...` and URL credentials
are redacted **before the line is written**, because the log is append-only: redacting only on
display would hide the secret from the default view while leaving it in the file.

**5. An idle cache is not a small one.**
After months the uv cache held 8.6 GB, of which 5.3 GB was eight uvx environments built by earlier
runs and never reaped, and a further 1.9 GB was duplicate copies and superseded versions.
`cache` reports that, `--prune` lists the removals, `--apply` carries them out. Each removal is
staged by renaming the entry first: Windows refuses to rename a directory while a file inside it is
open, so a refused rename *is* the answer that something is using it — and it is one atomic
operation, where scanning running processes and then deleting is not.

## Boundaries — what it deliberately does not do

- **It records; it does not block.** The activity recorder gives attribution and a timeline, not
  prevention. Blocking a write needs a filter driver, and claiming otherwise would be the exact kind
  of false signal this tool was built to remove.
- **It never quarantines.** `detain` freezes a process and asks a human. It does not move, rename,
  rewrite or delete the target. A suspension is persistent and loud, because a suspension nobody
  comes back for is worse than one that was never applied.
- **Detection does not act.** `signals` reports and `decide` says what it *would* do; the mode
  defaults to `observe` and nothing enforces. An enforcement path would first need a measured
  false-positive rate, and the detectors have to be shown to fire at all before that number means
  anything.
- **It does not patch the host plugin.** The plugin's `ensureDaemon()` starts with
  `if (await isServerHealthy(...)) return;` — once the service is healthy it returns immediately and
  the fragile path is never entered. That is "no longer traversed", not "patched".
- **No extra resident process.** Watching is delegated to the OS scheduler.
- **It only reads the service's logs**; it never touches hindsight's own data.

## Platform

**The platform layer is Windows-only; the staging model is not.**

Everything that touches the machine — process enumeration, windows, the registry, service and
scheduled-task control, `NtSuspendProcess` — goes through PowerShell and Win32. The activity
recorder, `resources`, `reveal`, `detain` and `install-service` do not work anywhere else today.

What is portable is the supervisor's shape: staged recovery, the health model, and the CLI. Porting
means replacing the platform layer — a launchd plist or systemd timer in place of the scheduled
task — not rewriting the logic. `package.json` therefore declares no `os` restriction, because that
field constrains where a package may be installed rather than what it supports, and this package
installs and runs its portable parts anywhere Node does.

## Configuration

Everything is discovered, not hardcoded: `uvx` comes from `PATH`, the cache dir from
`UV_CACHE_DIR` (with junctions resolved to their real target), the embed version from the host
config.

Tune behaviour in `DEFAULTS` at the top of `lib/core.mjs`, or in the policy file at
`~/.volcano-separator/policy.json`:

```js
profile: 'coding-agent',
port: 9077,
withPackages: ['pg0-embedded'],
warmProbeMs: 15000,               // a dry run slower than this means the env is cold
warmBudgetMs: 15 * 60 * 1000,
serveBudgetMs: 5 * 60 * 1000,
taskName: 'Volcano-Separator',
taskIntervalMinutes: 5,
```

## Requirements

Node >= 20.12. Zero third-party dependencies. PowerShell for the platform layer.

## Tests

```bash
node test/smoke.mjs      # or: npm test
```

About 170 checks. They are behaviour-level rather than unit-level, and they are **not offline**: the
suite drives the real CLI, so on a machine with the service running it reads live state (and on one
without, it asserts the degradation instead — every probe has to say "unavailable" rather than
throw). It also invokes PowerShell, and spawns the MCP server to read its handshake back.

Two habits worth knowing if you add to it:

- **A test that cannot fail is not a test.** A detector that reports zero findings and a detector
  that cannot fire look identical from the outside, so the signal rules are checked against
  synthetic positive cases, and the redaction rules are checked against a fixture with the expected
  output written out — agreement between two implementations is not enough, since two
  identically-wrong implementations agree perfectly.
- **Assert the observation, not the method.** Where a check would otherwise match on a process name,
  it matches on the file growing instead; a name match finds the shell that is running the check.

CI runs it on Node 20 and 22, on Linux and Windows.

## License

MIT
