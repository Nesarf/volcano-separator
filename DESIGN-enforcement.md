# Enforcement: isolation and in-place encryption

**Status: design only. Nothing here is implemented, and this was written before the code on
purpose.**

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
| `neverQuarantine` | the line the tool has already drawn about itself |

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
| **The target is a system file** | Never. Section 7. |
| **The finding was wrong** | The human undoes it and the policy records the correction. This is why the first promotion is per-rule and not global. |

---

## 7. The never-list

Actions are refused, not warned about, for:

- anything under `%SystemRoot%`, `%ProgramFiles%`, or the Windows installer store
- the running Hindsight daemon, its database, or anything this tool started
- anything this tool is currently executing from, including its own bash and PowerShell children
- files that are not regular files — no devices, no reparse points, no directories
- anything the user has allowlisted, at any depth
- **the undo path itself.** Nothing may act on the journal, the key store, or the policy file. An
  enforcement mechanism that can disable its own reversal is not reversible.

---

## 8. Staged rollout

Each stage ships on its own and is used before the next is written.

**Stage 0 — the trigger, with nothing attached.** Make `wouldAct` something a person can see: the
heartbeat reports when a rule *would* have acted, had `policy.mode` been anything but `observe`,
and does nothing. This costs
nothing to build and produces the data every later decision depends on.

**Stage 1 — a second enforcement path, still manual.** `isolate <pid>` and `encrypt <pid>` as
commands a human types, with the journal and the undo, and no automatic caller. This is how the
undo path gets exercised on real files before anything depends on it.

**Stage 2 — an action becomes reachable per rule.** After the gate in 4.2, and for one rule at a
time, `policy.mode` may be set to something other than `observe`.

**Stage 3 — reconsider.** With measurement in hand, decide whether the daemon should ever act
unattended. The current answer is no, and stage 0 may well show it should stay no.

---

## 9. Open questions

These are the user's to answer, not mine to assume.

1. **ACL isolation or encryption first?** My answer is isolation: it is reversible by anyone, it does
   not depend on a key surviving, and it does not risk a file. Encryption's advantage is that it
   stops a rename-and-relaunch, which an ACL does not.
2. **Where does the key live?** A file next to the journal is honest and weak. DPAPI ties it to the
   machine and the user. A passphrase means a human is present when it matters and is absent when it
   does not. Each of these is a different product.
3. **What is the intended target?** If it is "software that relaunches itself", ACL isolation is
   sufficient and encryption is overkill. If it is "a thing I do not want to be able to run at all,
   even by me", that is encryption, and it needs the passphrase answer first.
4. **May any mode other than `observe` ever be set unattended?** Everything in this document works
   with the answer "no".

---

## 10. What I would build first

**Stage 0, and nothing else.** It is small, it is safe, it produces the evidence that every later
stage is conditional on, and it can be thrown away without loss if the answer turns out to be that
this tool should never act automatically.

The thing I would refuse to build first is encryption with an automatic caller. That combination has
no failure mode that is merely inconvenient.
