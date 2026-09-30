# Changelog

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
