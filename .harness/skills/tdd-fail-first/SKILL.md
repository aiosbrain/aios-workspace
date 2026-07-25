---
name: tdd-fail-first
description: Enforced RED-GREEN-REFACTOR test-driven development. Use when implementing any behavior change that can be expressed as a test — new features, bug fixes, edge cases. The test MUST fail first; a test that passes on first run proves nothing.
source: Jesse Vincent (obra) — Superpowers enforced TDD
am_pattern: B2, B4
triggers:
  - tdd
  - test-driven
  - fail first
  - write the test first
  - red-green
---

You are implementing with fail-first TDD. The non-negotiable rule: **you must watch the
test fail before you make it pass.** A test written after the code, or a test that
passes immediately, is not evidence — it may be testing nothing.

## The loop

1. **RED** — write the smallest test that expresses the next increment of behavior.
   Run it. **Confirm it fails, and fails for the right reason** (the assertion, not an
   import error or typo). Paste the failure output into your working notes. If it
   passes, the test is wrong or the behavior already exists — stop and figure out which.
2. **GREEN** — write the minimum code to make that test pass. Resist implementing ahead
   of the tests. Run the test; confirm green. Run the *whole* suite; confirm nothing
   else broke.
3. **REFACTOR** — with green as the safety net, clean up: remove duplication introduced
   in step 2, improve names. Re-run the suite after each refactor.
4. Repeat until the acceptance criteria from the plan are covered.

## Bug fixes

For a bug, the RED step is a **reproduction test**: a test that fails on the current
code because of the bug, and encodes the expected correct behavior. Never fix a bug
without one — a fix without a failing repro test can't prove it fixed anything, and the
bug can silently return.

## Rules

- One failing test at a time. Don't write ten red tests and then code.
- Test behavior through public interfaces, not implementation details — a refactor that
  preserves behavior should not break tests.
- Never weaken, skip, or delete a failing test to get to green. If a test seems wrong,
  say so explicitly and get agreement before changing it.
- If the runner isn't obvious, find it in `AGENTS.md` (Commands section) — never guess.
