# Volcano Separator

**Separates the three things that were welded together.**

`volcano-separator` is a supervisor for the Hindsight memory daemon. It does not fix a bug — it fixes a **structural fragility**:

```
uvx (the package installer)
 └─ an ephemeral env inside the uv cache   ← the daemon's own code lives here
     └─ the hindsight daemon               ← spawned on demand by a host plugin,
         └─ Postgres (pg0)                    only at session start / on retain
             ← the data lives here
```

The state of a *package installer* decides whether the *service* can start, and the service's lifetime is decided by the *host's session timing*. When any link catches a cold, memory goes away — **silently**.

## What it actually treats

Measured on the machine this was extracted from (`volcano-separator doctor`):

```
12 start attempts, 7 failed on timeout, 1 succeeded
```

Every failure log shows `Downloaded botocore` / `Built claude-agent-sdk==0.2.16x` on the start path.
**A build and a watchdog were racing each other** — the plugin's watchdog allows ~180 s, while a cold-cache uvx run on a spinning disk needs far more. It loses every time.

## The fix: stage the work so no watchdog ever races a build

| Stage | What it does | Watchdog |
|---|---|---|
| **warm** | Make sure the uv env is complete (idempotent) | **none** — it may take minutes; it runs to completion |
| **serve** | Start the daemon only when the env is hot | yes, but this is now seconds — it can never trip |
| **watch** | Health probe and repair on demand | heartbeat, near-zero cost when healthy |

The property that makes this work: **`heal` costs ~0.9 s when healthy** (one TCP probe). So it can be called every few minutes without keeping a resident supervisor process — **scheduling does the watching**.

The other half of the fix is upstream of this tool: point `UV_CACHE_DIR` at an SSD and make the old path a junction, so even a cold start is fast.

## Install

```bash
git clone https://github.com/<you>/volcano-separator.git
cd volcano-separator
node bin/cli.mjs status          # no install step: zero dependencies
```

Optionally put it on PATH:

```bash
npm link            # provides `volcano-separator` and `vsep`
```

## Usage

```bash
volcano-separator status            # whole-chain check (uv / env warmth / daemon / db / watchdog task)
volcano-separator heal              # intelligent repair: warm -> serve -> watch
volcano-separator warm [--force]    # warm the env only (no watchdog)
volcano-separator serve             # start the service only
volcano-separator stop | restart
volcano-separator doctor            # count historical start failures from the plugin log
volcano-separator guard clean       # check whether a uv cache operation is safe right now
volcano-separator install-service   # register the watchdog task (at logon + every N minutes)
volcano-separator service           # watchdog task state
```

Options: `--profile <name>` (default `coding-agent`), `--port <n>` (default `9077`), `--json`, `--quiet`, `--force`, `--dry-run`.

## Three interfaces

| Form | Entry point | For |
|---|---|---|
| CLI | `bin/cli.mjs` | humans, scripts, the scheduled task |
| MCP | `lib/mcp.mjs` | any harness — `volcano_status` / `volcano_heal` / `volcano_doctor` |
| Library | `lib/core.mjs` | other tools (pure Node, zero dependencies) |

MCP client config:

```json
{
  "mcpServers": {
    "volcano-separator": { "command": "node", "args": ["/path/to/volcano-separator/lib/mcp.mjs"] }
  }
}
```

## Two real traps it handles for you

**1. The daemon's code lives inside the uv cache.**
So `uv cache clean` / `prune` is blocked by the running daemon's in-use lock, and `--force` deletes the running daemon's own files out from under it. Worse, while it is alive the cache directory cannot even be renamed (access denied).
`volcano-separator guard <op>` checks first and prints the safe order: `stop -> uv cache <op> -> heal`.

**2. A daemon started by the host plugin is not recognised by the embed manager.**
`hindsight-embed daemon stop` tracks its own PIDs; a daemon the host plugin spawned itself is not in that record, so:

```
WARNING - Could not find PID for port 9077
WARNING - Port 9077 is bound but no hindsight daemon could be identified on it
Failed to stop daemon
```

`stop` therefore has two levels: the official path first, then **find the port owner and collect its process tree** (only `uv`/`uvx`/`python`/`hindsight` processes — never anything else). Without that layer, one plugin-spawned daemon would make the supervisor permanently unable to stop it.

## Design boundaries

- **It does not patch the host plugin.** The plugin's `ensureDaemon()` starts with `if (await isServerHealthy(...)) return;` — once the service is already healthy it returns immediately and the fragile path is **never entered**. That is "no longer traversed", not "patched".
- **No extra resident process.** Watching is delegated to the OS scheduler.
- **It only reads logs**; it never touches hindsight's own data.

## Porting

Everything is discovered, not hardcoded: `uvx` comes from `PATH`, the cache dir from `UV_CACHE_DIR` (with junctions resolved to their real target), the embed version from the host config.

Tune behaviour in `DEFAULTS` at the top of `lib/core.mjs`:

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

Platform note: the scheduled-task integration is Windows-only today (`schtasks` / `New-ScheduledTask`). The staging model itself is portable — on macOS/Linux, swap `installService()` for a launchd plist or a systemd timer.

## Requirements

Node >= 20.12. Zero third-party dependencies.

## License

MIT
