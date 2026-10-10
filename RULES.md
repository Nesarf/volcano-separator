# Detection rules

This tool watches a machine and records what it sees. **Detection rules are the other half**: they say
which of the recorded events are worth a person's attention. There are three, and this file is the
readable copy of the table in `lib/rules.mjs`.

**Why this is a document and a table rather than just code.** A rule that has never fired is the one
question a total cannot answer. A rule waiting for something rare and a rule that cannot fire at all
both read as zero, and those call for different responses — one is patience, the other is a bug. The
promotion gate reports **per rule** (`volcano-separator evidence`), and it can only do that because a
rule is a thing with a name and a stated need rather than a string literal inside a loop.

**The condition itself is deliberately not data.** Deciding that something ran from a scratch
directory means parsing a command line and testing a path, which is code. An expression language that
silently matches nothing would be a worse failure than a rule that has to be written in code — it is
the same defect this project keeps removing, one level up. So each rule states its condition in prose
and names the file it lives in.

**Nothing here is a rule that a third party updates.** No downloaded packs, no feed, no signature
bundle. A watchman that fetches executable rules is a watchman with a supply chain, which is a trade
this tool has not made.

---

## `persist-from-ephemeral` — high

**Detects:** a persistence surface added from a directory that exists to be disposable.

**Why it is worth interrupting someone:** persistence is how something survives a reboot. Registered
from a cache, temp or download directory, it is the shape of an installer that installs itself and then
hides — the surviving part sits in a place that gets cleaned, and the thing it points at sits in one.

**Condition, in code** (`lib/signals.mjs`): a `persist` event whose `action` is not `removed`, whose
value falls under one of the scratch roots.

**Needs before it can fire at all:** a persist event under a scratch root. *As of 2026-10-10 this rule
has never fired on this machine.*

**Calibrated:** no. See "Uncalibrated" below.

---

## `exec-from-ephemeral` — low

**Detects:** an executable that ran from a directory that exists to be disposable.

**Why it is worth recording:** most such executions are innocent — portable tools, builds, installers
unpacking themselves — which is the only reason this is ranked low. It is kept because the innocent
majority is exactly what makes the guilty case easy to miss.

**Condition, in code** (`lib/signals.mjs`): the executable token is parsed out of the command line with
`exeFromCmd` and tested against the scratch roots.

**The argument list is deliberately not examined.** `bash.exe` in `Program Files` carrying a scratch
path as an *argument* is not a program running *from* scratch. Conflating the two was measured to
produce **1,031** false candidates in one five-day window, against zero real ones.

**Needs before it can fire at all:** a process start whose executable token is an absolute path under a
scratch root. *As of 2026-10-10 this rule has never fired on this machine* — measured over 25,544
process starts, 6,454 of which carried an absolute executable path, and **none** of those under a
scratch root.

**Calibrated:** no.

---

## `binary-vanished` — high

**Detects:** a process running from an executable path that no longer exists.

**Why it is worth interrupting someone:** a running process whose image has been deleted is
self-deleting behaviour, or a file removed while it was in use. Either way the machine can no longer
say what that process is, and *"cannot say"* is the thing this tool exists to remove.

**Condition, in code** (`lib/signals.mjs`): the parsed executable is absolute, is not under the system
root, and does not exist on disk now.

**Needs before it can fire at all:** a process start whose executable existed then and does not exist
now. *As of 2026-10-10 this rule has never fired on this machine.*

**Calibrated:** no.

---

## Uncalibrated — what that means

**None of these three has been calibrated, and `calibrated: false` says so per rule.** Calibrating a
detection rule means measuring its false-positive rate against known-good activity, which needs real
traffic. This machine has produced five days of it and none of these conditions has occurred.

The consequence is stated rather than hidden: **a rule that has never fired has no error rate to
quote**, and this tool will not promote one to acting automatically on the strength of a hunch. That is
what the gate in `DESIGN-enforcement.md` §4.2 is for, and the gate reports the per-rule picture
precisely so that "waiting" and "broken" can be told apart.

---

## Adding a rule

1. Add it to `RULES` in `lib/rules.mjs`, with `severity`, `detects`, `intent`, `detectsWhy`, `needs` and
   `calibrated`.
2. Add a section here.
3. Write the detection in `lib/signals.mjs`, attributing the finding to the new id. A finding naming a
   rule that is not in the table **throws** rather than being recorded — a finding filed under
   `undefined` would be counted later as a rule that fired.

**A check fails if this file and the table disagree**, in either direction. Two lists of the same thing
drift, and the direction they drift in is always the same: the code gains a rule and the document does
not.
