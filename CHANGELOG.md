# Changelog

## Unreleased

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
    deleting one costs a re-download — but deleting the entry a running daemon executes from is
    an outage. Detection scans the executable path of every running process, and a delete that
    fails is reported rather than retried, because an entry that cannot be removed is one in use.
  - `simple-v24`, `interpreter-v4`, `environments-v2`, `git-v0` and `builds-v0` are never
    touched: removing the index cache only forces metadata to be re-fetched.

### Fixed

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
