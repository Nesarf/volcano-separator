# Enforcement: isolation and in-place encryption

**Status: stages 0 and 1 built (`decide` reports the counterfactual; `isolate` / `restore` /
`isolated` and `encrypt` / `decrypt` / `encrypted` exist, and their undo is authenticated).**
Stages 2 and 3 are not built. Of the decisions in section 9, the first three have been acted on and
the fourth still stands (nothing acts unattended).

The tool today records, names and asks. It cannot prevent anything. That gap is real and it is the
last thing standing between what this is and what it was meant to be. It is also the half where a
mistake costs someone their machine, so it is the half that gets a design first.

---

## 1. What this must not become

Everything below is shaped by the failures this project has already had, not by a threat model
invented for the occasion.

**A guard that silently disables what it guards is worse than no guard.** The recorder spent a day
writing nothing — three separate causes, all of them its own changes — and the only symptom was an
empty file. An enforcement path has the same failure available to it and a worse consequence.

**"Cannot determine" must never be reported as a definite answer.** The port check that read a
failed query as "nothing is listening" cost a restart. The warmth probe that called a busy machine
"cold" caused the warm-up it was measuring. Enforcement is where this habit turns destructive: *"I
could not tell whether this is yours, so I stopped it"* is not a sentence this tool is allowed to
say.

**An "up" signal that does not mean "working" is worse than no signal.** The daemon kept `/health`
green while it could not reach its database. An enforcement action that reports success while
leaving the target runnable would be the same lie with higher stakes.

---

## 2. What exists, that this has to fit into

| Piece | What it gives us |
|---|---|
| `signals.mjs` | findings with evidence, and `allowed` |
| `signals.mjs` `decideSignals` | `allow` / `ask` / `note`, and `wouldAct` |
| `custody.mjs` | **the only existing action path** |
| `policy.mjs` | a human's decision, written down and consulted before acting |
| `activity/` | an append-only record that survives everything else being down |
| ~~`neverQuarantine`~~ | **removed 2026-10-06.** It was a `POLICY_DEFAULTS` field that nothing read, so it held nothing back and promised nothing -- and by the time it was removed it also described the tool inaccurately, since `vault --move` takes a file out of its place. An unread field whose name reads like a safeguard is the false signal this project removes, so it went rather than being wired up to justify the name. What it stood for is now stated per operation, in the README and in section 8. |

`custody.mjs` is the template, and it is worth stating its shape because it is the shape everything
new should have:

```
detain.ps1
  -> does the mechanical act (NtSuspendProcess)
  -> writes a machine-readable summary into the activity log
  -> opens a window that ASKS
  -> the human's answer is written to policy, so the same thing does not ask twice
```

**Act, record, ask, remember the answer.** Not one of those four is optional.

---

## 3. The two capabilities

### 3.1 ACL isolation

Deny a binary the right to execute (or to be read), by changing its DACL. Restore by putting the
original ACL back.

**What it actually stops:** a file being launched again. That is it. It is a *door lock*.

**What it does not stop:** the process that is already running — that is custody's job, and the two
are complementary rather than alternatives. Nor a copy, nor a rename, nor an attacker with
administrative rights, who can simply take ownership and put the ACL back.

**The honest summary:** this is a blunt, reversible inconvenience aimed at software that relaunches
itself. It is not a security boundary, and the README must not imply it is.

**Why it is still worth having:** the most common unwanted thing on a workstation is not an
intrusion, it is a program that will not stay closed. An ACL that makes it not-come-back is a
smaller act than deleting it, and a reversible one.

### 3.2 In-place encryption

Encrypt the binary in place, keep the key, and the file can be restored exactly.

**What it actually stops:** the file being usable by anything except us. It is a *safe*, not a lock.

**What it does not stop:** the running process, again. Nor reading the plaintext from memory. Nor an
attacker who can read the key, and the key has to be somewhere.

**The honest summary:** this is the strongest reversible act available and the one with the worst
failure modes. It is only defensible if the undo path is stronger than the act, which is section 6.

**Why the review's instinct to do this last is right:** "temporarily encrypt a suspicious program" is
one bug away from "permanently destroy a file the user needed", and the bug does not have to be in
the encryption. It can be in the journal, the power supply, or the key store.

---

## 4. The prerequisite: a trigger

Today `wouldAct` is computed by `decideSignals` and **read by nothing**, and the recorder has **no
process-control capability at all**. That is not an oversight to fix by wiring things up; it is the
correct state until the trigger is defined.

### 4.1 The two axes that already exist

The temptation is to invent a mode scale — observe, ask, enforce — and it is wrong, because the code
already separates the two questions and this document's first draft conflated them:

| Axis | Where | Values | Question |
|---|---|---|---|
| action | `policy.mode` | `observe` / `suspend` / `reject` | what to **do** |
| escalation | `decideSignals` | `allow` / `ask` / `note` | whether a **human** is needed |

A new capability adds a value to the first axis. It does not add a third.

So `isolate` and `encrypt` are additions to `policy.mode`, beside `observe`, `suspend` and `reject` —
and `reject` is worth reading twice, because it is declared, it is documented as *"the 'refuse' mode;
it is opt-in and it is destructive"*, and it is **unimplemented**. Terminating a process is the least
reversible act in the set, and it is already the one that was decided against by not writing it.

### 4.2 The gate before an action becomes automatic

A mode may not be promoted until its rule has been measured, and the measurement is a number rather
than an impression:

| Requirement | Why |
|---|---|
| `ask` fired at least N times on real traffic | a rule that has never fired has no error rate to quote |
| the human allowed it every time, or the disagreements are understood | a rule the user keeps overriding is a rule that is wrong |
| zero findings on a longer, quieter window | an action taken during a quiet period is the one nobody is watching for |
| the action was undone at least once, successfully | an undo path that has never run is a hypothesis |

**Where the evidence lives matters as much as collecting it.** The activity record is under the log
directory, which defaults to the system temp directory, and this machine's disk hygiene tooling
removes files there after seven days. A rule asked to prove itself over fourteen days, with its
evidence deleted on the seventh, fails by reporting *fewer* findings -- which reads as good news.
The heartbeat therefore rolls a daily running total into `~/.volcano-separator/evidence.ndjson`,
beside the policy, and `volcano-separator evidence` prints it.

The thresholds are deliberately not fixed here. They should be chosen after the first month of `ask`
data, and **the current traffic is far too thin to choose them now**: over the 72 hours on record,
`decide` reports 4 asks against 16 allows. Four is not a sample.

---

## 5. The action contract

Every action, without exception:

1. **Reversible, and the undo is written down first.** The journal entry exists before the act does.
   If the process dies between them, the journal describes an action that did not happen — which is
   recoverable. The reverse is not.
2. **Crash-safe and idempotent.** Running it twice is the same as running it once, and an
   interrupted run leaves a state the next run can finish or reverse.
3. **Never on the never-list** (section 7).
4. **Never automatic until promoted** (section 4.2).
5. **Always in the activity log**, in the same append-only record everything else uses, with enough
   detail to reconstruct what happened from the log alone.
6. **Always with a stated way back**, printed in the output, not buried in a document.

---

## 6. Failure modes, and what each one does

This is the section that decides whether the feature is safe, so it is written as behaviour rather
than as mitigation.

| Failure | Required behaviour |
|---|---|
| **The tool dies mid-action** | The journal entry was written first, so the next run finds an action with no confirmation and **reverses it** rather than repeating it. An act that cannot be confirmed is treated as not having happened. |
| **The key is lost** | The file is gone. Therefore: the key is written to the same durable place before the file is touched, and a run that cannot write the key **does not encrypt**. There is no "encrypt now, save the key after". |
| **The file is in use** | Do nothing, and say so. A file that cannot be opened for exclusive write is a file something is using, and encrypting under a running process produces a file that can neither run nor be restored cleanly. |
| **Antivirus reacts** | Possible, and not preventable. The mitigation is only that the act is reversible and the journal says what the file was. This is a reason to prefer ACL isolation, which antivirus ignores, over encryption. |
| **Power is lost mid-write** | Write to a temporary name in the same directory, flush, then rename over the original. A rename within a directory is atomic; a partial write is not, and a half-encrypted binary is neither runnable nor restorable. |

> **What the implementation actually guarantees today, stated precisely.** The ordering above is
> real: the journal is written before the file is touched, the ciphertext is written to a
> temporary name, and the original is only replaced after the round trip verifies byte for byte.
> That makes the failure mode **logically** correct — a crash, a kill, or a power loss leaves
> either the original or a complete container, never a half-written one.
>
> It does **not** yet make it **durable**. Nothing in this codebase calls `fsync` (verified: zero
> occurrences), so what is on the platter when a write returns is the filesystem's decision and
> not ours. A power loss can therefore lose a journal entry that "was written", or leave a rename
> that "happened" undone. The consequence is bounded by the ordering — a missing journal entry
> means the file is not restored automatically, and the `icacls`/decrypt escape hatch still exists
> — but "crash-safe" and "power-loss durable" are two different claims and only the first one is
> true today. Stated here rather than left to be inferred, because a design document that
> overstates this is the exact class of false signal this project exists to remove.
| **The target is a system file** | Never. Section 7. |
| **The finding was wrong** | The human undoes it and the policy records the correction. This is why the first promotion is per-rule and not global. |

---

## 7. The never-list

Refused, not warned about. What the implementation actually enforces today:

| Refused | Why |
|---|---|
| anything inside `%SystemRoot%` | a bad ACL on something Windows loads can cost the boot, and the machine may only be recoverable from outside it. `-IncludeSystemRoot` says you mean it. |
| the installer package cache | same shape of risk, and nothing legitimate needs it |
| **the isolation journal** | nothing may act on the undo path. A mechanism that can disable its own reversal is not reversible, and this rule holds even when a caller insists. |
| **this tool's own directory** | it has to be able to undo its own work |
| anything that is not a regular file | no devices, no directories, no reparse points |
| anything without a stated target | a lock with no subject is a guess |

**`%ProgramFiles%` is not on the list.** That is the decision above: service binaries and installed
applications are ordinary targets, and breaking one is restorable in a way that breaking the boot
is not.

Earlier drafts also listed the running Hindsight daemon and its database. They are not enforced
separately because they do not need to be: the daemon runs from the uv cache and the database from
a pg0 instance, and neither is a target anyone has a reason to name. Adding a rule for a case that
cannot arise makes the list harder to trust, not safer.
## 8. Staged rollout

Each stage ships on its own and is used before the next is written.

**Stage 0 — the trigger, with nothing attached. BUILT.** Make `wouldAct` something a person can see: the
heartbeat reports when a rule *would* have acted, had `policy.mode` been anything but `observe`,
and does nothing. This costs
nothing to build and produces the data every later decision depends on.

**Stage 1 — enforcement paths that a human types. BUILT: two of them.** Every command here is typed
by a person, has a journal and an undo, and has **no automatic caller**:

| Action | Commands | Touches the target how |
|---|---|---|
| ACL isolation | `isolate <path\|pid>`, `restore <journal>`, `isolated` | rewrites the ACL; bytes untouched |
| In-place encryption | `encrypt <path>`, `decrypt <journal>`, `encrypted` | rewrites the bytes, in place |
| The vault | `vault <path>` (`--move`), `unvault <id>`, `vaulted` | copies it, or with `--move` takes it out of its place |

Correction (2026-10-06): this section used to say "BUILT, for isolation only. `encrypt` is not
built." That was true when it was written and stopped being true when `crypt.mjs` landed. It is
recorded as a correction rather than quietly edited because the sentence is the kind a reader acts
on -- someone deciding whether encryption exists would have read it and concluded it did not.

The undo path has been exercised on real files for both actions, which is what this stage exists for.

**Stage 2 — an action becomes reachable per rule.** After the gate in 4.2, and for one rule at a
time, `policy.mode` may be set to something other than `observe`.

**Stage 3 — reconsider.** With measurement in hand, decide whether the daemon should ever act
unattended. The current answer is no, and stage 0 may well show it should stay no.

---

## 9. Decisions taken (2026-10-05)

The four questions this section used to ask have answers, and they are recorded here because the
code that follows is shaped by them.

| Question | Decision | Consequence |
|---|---|---|
| Which capability first? | **ACL isolation** | built, and encryption was built after it -- see the correction in section 8 |
| Where does the key live? | **bound to the machine and the user** (DPAPI) | applies to the journal today, and to encryption when it exists |
| What is the intended target? | **as system-level as possible** | `%ProgramFiles%` and service binaries are reachable; `%SystemRoot%` needs an explicit acknowledgement |
| Is any non-`observe` mode ever unattended? | **deferred** | nothing reads `policy.mode` yet, and that stays true |

### What "system-level" changed, and what it did not

It widened the reach rather than lowering the guard. `%ProgramFiles%`, service binaries and the
files that Run keys and scheduled tasks point at are now ordinary targets. **`%SystemRoot%` still
refuses by default**, and needs `-IncludeSystemRoot` to mean it, because a bad ACL on something
Windows itself loads can cost the boot -- and the machine may then only be recoverable from outside
it. That is a different kind of failure from breaking an application, and it earns a different
kind of confirmation.

Three protections were added because system-level reach is what makes them necessary:

1. **The undo must not depend on this tool.** The backup is written with `icacls /save` and restored
   with `icacls /restore`, and every result prints the exact command. If volcano-separator is
   deleted, broken, or the machine only boots to a recovery prompt, the restore still works.
2. **The undo journal must not live anywhere prunable.** It sits beside the policy, not under the
   cache, because a cache is something a person is invited to clean and a cleaned undo is not an
   undo.
3. **The journal is tamper-evident. BUILT.** Otherwise "restore the original ACL" is itself a
   privilege-escalation primitive: forge a journal and the tool applies whatever DACL it names.
   Each journal now carries an HMAC over its security-relevant fields **and the hash of the ACL
   backup**, keyed by a random 32-byte key that DPAPI protects for this machine. Signing only the
   journal would have left the ACL file itself swappable, which is the same attack one step over.
   A journal that fails verification is refused with the reason, and the restore command is printed
   either way.

   **What this stops, precisely.** It raises the bar from "write a JSON file into a directory" to
   "run code as this user on this machine". It does not stop the second thing -- anyone who can do
   that can call DPAPI too. What it does stop is the cheap versions: a journal copied from
   elsewhere, a hand-written one, a backup swapped for another, a plausible-looking edit.

## 10. What to build first

This section used to say "**Stage 0, and nothing else**". Stage 0 and Stage 1 have since been built, so
the sentence had become a description of the past rather than a plan -- and it read as though nothing
beyond Stage 0 were permitted, which was never the intent. The sequencing rule it was reaching for is
narrower and still holds:

**Capability is built as far as a human typing it, and no further, until 4.2 is satisfied.** Stage 1
may grow new operations -- vault, hold, whatever the next one is -- because a person typing a command
is the human in the loop, and the gate in 4.2 governs **promotion to automatic**, not the existence of
the operation. What may not happen without the gate is a rule invoking it.

The thing to refuse to build, and the reason 4.2 exists, is **any action with an automatic caller
before there is a measured rate**: an automatic caller turns one wrong judgement into every matching
file, before anyone looks.

Two things a new Stage 1 operation must carry, both of which the existing two have:

1. **An undo that does not depend on this tool.** `isolate` stores its ACL with `icacls /save` and
   prints the `/restore` command on every result. Its restore was verified by deleting the journal
   entirely and restoring by hand.
2. **A boundary statement scoped to what it actually does.** `isolate` does not rewrite bytes;
   `encrypt` does. They cannot share a sentence, and a new operation that moves a file cannot share
   either of theirs.
