---
kind: rubric
applies_to: code-review
pass: no-p1-findings
source: AIOS consolidate-findings (fail-closed multi-reviewer fusion); compound engineering severity triage
am_pattern: D4
---

# Rubric — Code Review Quality & Merge Gate

Two uses: (1) the **merge gate** — what must be true of a change before merge; (2) the
**review-quality bar** — what must be true of a review before its verdict counts.

## Merge gate

A change is mergeable when ALL hold:

| ID | Criterion |
|----|-----------|
| MG1 | The repo's full check (tests/build/lint — `AGENTS.md` Commands) is green, run by the reviewer, not reported by the writer |
| MG2 | Zero open P1 findings across all reviewers (general + security + any specialist) |
| MG3 | P2 findings are fixed or explicitly acknowledged by a human — silence is not acknowledgment |
| MG4 | The change was reviewed by a context that did not write it (fresh session, subagent, or human) |
| MG5 | Tests exercise the changed behavior — they would fail if the change were reverted (no tautological/orphaned tests) |
| MG6 | For agent-authored changes from a non-frontier model lane: a frontier-lane or human review happened (see `models/routing.yaml`) |
| MG7 | The verification claim carries evidence: what was run, what was observed (`skills/verify-change`) |

## Review-quality bar

A review's verdict counts only if:

| ID | Criterion |
|----|-----------|
| RQ1 | Every finding names a **concrete failure scenario** (inputs/state → wrong outcome), not a style opinion dressed as a bug |
| RQ2 | Findings are severity-ranked P1/P2/P3, most severe first, **fail-closed** (unsure between two severities → the higher) |
| RQ3 | The reviewer read enough surrounding code to verify each finding is real (file:line cited) |
| RQ4 | The verdict is explicit: `APPROVE` / `APPROVE-WITH-P2S` / `BLOCK (n × P1)` |
| RQ5 | "No findings" is stated plainly when true — invented nitpicks fail the review, not the code |

## Multi-reviewer fusion (fail-closed)

When multiple reviewers/tools report on the same change: deduplicate by file+line+cause,
and the fused finding **inherits the maximum severity** any reviewer assigned. A
reviewer that errored or returned unparseable output contributes `BLOCK` (fail closed),
never silence.
