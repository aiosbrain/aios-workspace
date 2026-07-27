---
name: code-review
description: Fresh-context review of a diff with severity-triaged findings (P1/P2/P3). Use when the user asks to "review" a change/PR/diff, or as the standard gate on any agent-authored change before merge. The reviewer must NOT be the session that wrote the code.
source: Kieran Klaassen (compound engineering — parallel specialized review); AM C3 writer/reviewer split; AIOS consolidate-findings (fail-closed severity)
am_pattern: C3, D4
triggers:
  - review this
  - code review
  - review the pr
  - review the diff
  - review my changes
---

You are reviewing a diff you did not write. If you *did* write it in this session, say
so and recommend a fresh session or the `code-reviewer` subagent instead — a reviewer
biased toward code it just wrote catches materially less.

## Scope

Review the actual diff (`git diff <base>...HEAD` or the PR), plus enough surrounding
code to judge each change in context. Read the plan/spec if one exists — the first
question is whether the diff *does what the plan says*, not whether the code is pretty.

## What to look for, in priority order

1. **Correctness** — concrete failure scenarios only: inputs/state under which this
   change produces a wrong result, crash, or regression. Modern agent errors are subtle
   conceptual mistakes (wrong boundary, wrong assumption about caller behavior, missed
   edge case), not syntax errors — review like you're hunting a hasty junior's plausible
   bug.
2. **Safety** — secrets in the diff, injection paths, authz gaps, destructive operations
   without guards, data loss on the error path.
3. **Verification honesty** — do the tests actually exercise the changed behavior? Would
   they fail if the change were reverted? (An orphaned or tautological test is a P2
   finding — see `test-ci-wiring-audit`.)
4. **Context-mining** — "is there something we should have known but didn't?" Before
   trusting the diff in isolation, check the archaeology: `git log`/`git blame` on the
   touched lines (was this code the way it is *on purpose* — a past fix this change
   quietly reverts?), the linked issue/PR history, and any `TODO`/`FIXME`/prior-revert
   the change walks past. A change that re-introduces a previously-fixed bug is a finding
   the diff alone can't show — grade it through the normal severity rubric (impact,
   exploitability, scope); the prior fix is evidence, not an automatic P1. (Security
   lives in Safety, #2.)
5. **Simplification** — dead code, needless indirection, premature abstraction
   (candidates for `simplify-pass`, not blockers).

## Output format

One finding per row, most severe first. For every finding give the **failure scenario**
(concrete inputs/state → wrong outcome), not just an opinion:

```
P1  src/billing/invoice.ts:142  Refund path drops currency conversion — a EUR refund
    against a USD invoice credits the raw number. Repro: refund invoice with
    currency != account currency.
P2  api/webhooks.php:88         Retry loop has no backoff cap; a permanently failing
    webhook retries forever and pins a worker.
P3  lib/util.py:12              `parse_date` duplicates existing `dates.parse_iso`.
```

- **P1** — must fix before merge (correctness/safety).
- **P2** — should fix; merge only with explicit acknowledgment.
- **P3** — improvement; fine to defer.

**Fail closed:** when you're unsure whether something is P1 or P2, it's P1. End with an
explicit verdict: `APPROVE`, `APPROVE-WITH-P2S`, or `BLOCK (n × P1)`. If there are no
findings, say so plainly — do not invent findings to seem thorough.
