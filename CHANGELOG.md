# Changelog

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
