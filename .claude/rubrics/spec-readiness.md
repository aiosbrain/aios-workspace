---
kind: rubric
applies_to: spec-readiness
budget: 2
pass: no-must-fails
---

# Rubric — Spec / Plan Readiness (EE5 / AIO-171)

Machine-checkable readiness criteria for a spec or plan **before** it is handed to a builder.
This file is BOTH the deterministic must-pass contract the `aios spec` command encodes AND the
adversarial grading sheet the LLM evaluator scores a spec against. It operationalizes the
Engineering Constitution §1 (spec → plan → tasks → implement) and the Build Paradigm's
"pick-up-able issue" test: *an agent with no conversation history can read the spec and start
correctly.*

`budget:` is the fix loop's correction budget (`aios spec fix`, default 2). The pass rule is
`no-must-fails` — a spec is `SPEC_READY` only when no `must` criterion fails.

## Two-layer model

1. **Deterministic layer** (zero-LLM, fast, offline): structural presence/shape checks + real-path
   resolution against the repo tree. A deterministic `must` failure is a hard blocker — a builder
   would stumble on it with certainty. Drives exit code **1**.
2. **Adversarial layer** (LLM, opt-in): an independent evaluator *refutes* the spec — finds the
   underspecified corner a cold-start builder trips on. Emits a single verdict
   (`SPEC_READY` | `NOT_READY`) plus per-criterion findings. A blocker drives exit code **2**.

The **verdict is the only gate**; the 0–100 score is advisory/reporting and never derives an exit
code. See `docs/agentic-ergonomics/spec-readiness.md` for the command, exit codes, and full model.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | `SPEC_READY` — no must-fails |
| 1 | deterministic must-fail (structural blocker) |
| 2 | adversarial blocker (LLM refutation) |
| 3 | `NOT_EVALUATED` — deterministic clean, LLM layer not run (`--no-llm`) |
| 4 | usage / IO error (missing file, unreadable/malformed rubric) |

`eval_tier: deterministic` is an explicit mechanical-spec exemption from the adversarial layer:
the deterministic checks remain mandatory and a clean result exits 0. The default `full` tier
runs both layers; `--no-llm` remains an incomplete (`NOT_EVALUATED`) full-tier check.

## Criteria

`Check method` names the layer(s): **deterministic**, **llm-read**, or **det+llm**. `Must` is
`yes` (hard), `conditional` (must, only when its trigger fires), or `advisory` (reported, never
gates). Every deterministic `must` / `conditional` row is backed by an implemented check (enforced
by the rubric↔code drift test).

| ID   | Criterion | Check method | Must |
|------|-----------|--------------|------|
| SR1  | What / why is present — the behavior and the reason it matters are stated | deterministic | yes |
| SR2  | Acceptance criteria exist and are observable — itemized, self-verifiable (presence/shape checked deterministically; quality llm-read) | deterministic + llm-read | yes |
| SR3  | Integration points are real — named existing-code paths resolve to files in the repo tree | deterministic | yes |
| SR4  | Dependencies are declared, or "none" is stated explicitly (no silent gaps) | deterministic | yes |
| SR5  | Scope and deferred work are stated — what is in, what is cut | deterministic | yes |
| SR6  | Build-with tier is present — the model/effort the work deserves | deterministic | yes |
| SR7  | Tier-safety posture is stated when sync/brain surfaces are touched (trigger deterministic; adequacy llm-read) | deterministic + llm-read | conditional |
| SR8  | Well-bounded module — one narrow public surface, no reach into sibling domains (Constitution §4) | llm-read | yes |
| SR9  | Interface-first — contracts/types are named before implementation steps | llm-read | yes |
| SR10 | Signal-contract conformance when signals are emitted — the tier-tagged signal shape is referenced (trigger deterministic; shape llm-read) | det+llm | conditional |
| SR11 | Testability — acceptance is demonstrable by named tests | llm-read | yes |
| SR12 | spec → plan → tasks traceability | llm-read | advisory |
| SR13 | Deterministic-before-model-driven — structural signals captured with zero-LLM code | llm-read | advisory |
| SR14 | Durable-state discipline — append-only stores, writer-honored locks where state persists | llm-read | advisory |
| SR15 | Decidability — every must-path is decidable. Bounded design latitude whose output is human-reviewed before merge is a PASS (a reviewed PR is recoverable); a blocker is only a decision with no downstream catch (unstated perf/SLA target, prerequisite with no "what if missing" branch, ambiguous external contract) | llm-read | yes |
| SR16 | No ungrounded architecture claims — "reuses X / extends Y / builds on Z" resolves to real files (path resolution deterministic; claim adequacy llm-read) | det+llm | yes |
