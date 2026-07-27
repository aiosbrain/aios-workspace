---
kind: rubric
applies_to: spec-readiness
pass: no-must-fails
source: AIOS toolkit spec-readiness rubric (two-layer deterministic + adversarial model), generalized
am_pattern: B3, D3
---

# Rubric — Spec / Plan Readiness

Readiness criteria for a spec or plan **before** a builder — human or agent — picks it
up. The operative test throughout: **an agent with no conversation history can read this
spec and start correctly.**

The pass rule is `no-must-fails`: a spec is `SPEC_READY` only when no `must` criterion
fails. Any numeric score is advisory; the verdict is the only gate.

## Two-layer model

1. **Deterministic layer** — structural checks a script (or a careful reader) can make
   without judgment: sections present, named paths actually exist in the repo tree. A
   deterministic must-fail is a hard blocker — a builder *will* stumble on it.
2. **Adversarial layer** — an independent evaluator (see
   `agents/adversarial-verifier.md`) tries to *refute* the spec: find the underspecified
   corner a cold-start builder guesses wrong. Fail closed: unparseable or ambiguous →
   `NOT_READY`.

## Criteria

| ID | Criterion | Layer | Must |
|----|-----------|-------|------|
| SR1 | **What / why present** — the behavior and the reason it matters are stated | deterministic | yes |
| SR2 | **Acceptance criteria observable** — itemized; each is a command, test name, or visible behavior a builder can self-verify | det + adversarial | yes |
| SR3 | **Integration points are real** — every named file/module/endpoint resolves to something that exists in the repo | deterministic | yes |
| SR4 | **Dependencies declared** — or "none" stated explicitly; no silent gaps | deterministic | yes |
| SR5 | **Scope boundary stated** — what is in, what is deliberately cut | deterministic | yes |
| SR6 | **The check is named** — the single command/procedure that proves the work (the AM B2 check) | deterministic | yes |
| SR7 | **Interface-first** — contracts/types/signatures named before implementation steps | adversarial | yes |
| SR8 | **Testability** — acceptance demonstrable by named (new or existing) tests | adversarial | yes |
| SR9 | **Decidability** — every must-path is decidable by the builder. Bounded design latitude whose output is human-reviewed before merge PASSES (a reviewed PR is recoverable); a blocker is only a decision with no downstream catch (unstated perf target, prerequisite with no "what if missing" branch, ambiguous external contract) | adversarial | yes |
| SR10 | **No ungrounded claims** — "reuses X / extends Y" resolves to real files that do what the spec says they do | det + adversarial | yes |
| SR11 | **Risk/rollback note for irreversible steps** — migrations, data backfills, external calls state their undo story | adversarial | conditional (fires when such steps exist) |
| SR12 | **Right-sized** — the spec fits the change (a one-file fix doesn't need ten sections; a schema change does) | adversarial | advisory |
| SR13 | **Traceability** — spec → plan → tasks link to each other | deterministic | advisory |

## Output format

Per-criterion `PASS`/`FAIL` with one-line evidence, then:

```
VERDICT: SPEC_READY
# or
VERDICT: NOT_READY
BLOCKERS: SR3 (src/billing/refunds.ts does not exist), SR6 (no check named)
```
