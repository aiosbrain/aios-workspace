---
name: systematic-debugging
description: Four-phase root-cause debugging loop for anything broken, throwing, failing, flaky, or slow. Use whenever the user reports a bug or a test fails unexpectedly — BEFORE proposing any fix. Root cause first; a fix without a diagnosis is a guess.
source: Jesse Vincent (obra) — Superpowers systematic debugging
am_pattern: B4
triggers:
  - debug
  - debugging
  - failing test
  - root cause
  - diagnose
  - stack trace
  - flaky test
  - throws an error
  - regression
  - keeps failing
---

You are debugging systematically. The failure mode to avoid: pattern-matching the
symptom to a familiar cause and "fixing" that. Diagnose first; the fix is the easy part.

## Phase 1 — Reproduce

Get a deterministic reproduction, as small and fast as you can make it: a failing test,
a curl command, a script. If you cannot reproduce it, you are not debugging yet — you
are gathering evidence (logs, timestamps, environment diffs, recent commits). Say so
honestly rather than guessing.

## Phase 2 — Localize

Shrink the search space with evidence, not intuition:

- **Bisect the input** — cut the reproduction in half repeatedly.
- **Bisect time** — `git bisect` against the reproduction when it used to work.
- **Bisect the stack** — is the bad value produced, transformed, or consumed wrong?
  Trace the data flow and find the first place reality diverges from expectation.
  Add temporary instrumentation (prints/logs) freely; remove it after.

State your current hypothesis explicitly at each step, and what observation would
falsify it. If an experiment result surprises you, that surprise is signal — follow it.

Before you trust a *null* result (a breakpoint that never fires, a log that never prints,
an error that vanishes), read `references/silent-failures.md` for your runtime — some
tooling lies silently (e.g. tsx + `node inspect`, `except: pass`). When you genuinely
cannot run the real operation (paid API, missing device, prod-only creds), read
`references/partial-runtime-evidence.md`: partial runtime evidence is still evidence, and
that page tells you which partial signals combine into a defensible conclusion.

## Phase 3 — Root cause

You have the root cause when you can answer all three:
1. **Mechanism** — the precise chain from cause to symptom.
2. **Trigger** — why it happens under these conditions and not others.
3. **History** — why it worked before / how it got introduced (if it regressed).

If you can't answer these, you have a correlation, not a cause. Keep going.

## Phase 4 — Fix, prove, harden

1. Write the failing test that encodes the root cause (see `tdd-fail-first`).
2. Apply the smallest fix that addresses the *mechanism*, not the symptom.
3. Prove: repro test green, full suite green.
4. Harden (the compound step): could a lint rule, type, assertion, or hook have caught
   this class of bug? Add it, or record it via `compound-learnings`. Check for the same
   pattern elsewhere in the codebase while the mechanism is fresh.
5. Leave no trace: journal every temporary instrumentation you added and confirm the
   final `git diff` shows only the fix and its test — nothing else.
