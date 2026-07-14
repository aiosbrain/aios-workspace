# Deterministic spec eval — pass/fail criteria

## Problem

The v1 adversarial evaluator (`EVAL_SYSTEM` in `scripts/spec-eval.mjs`) used a "REFUTE this spec"
prompt with a subjective 0-100 score. Score variability (30+ point swings between runs on the same
spec) made the adversarial layer a non-deterministic gate — fine for advisory use, unreliable for
ship-gating.

## Solution

The adversarial layer is now a **checklist evaluator** instead of a refutation engine. The model
evaluates each LLM-read SR criterion separately and returns PASS/FAIL with evidence. The verdict
and score are mechanically derived from pass/fail results — the model never assigns them directly.

## Two-layer model (unchanged)

| Layer | What | Exit on failure |
|-------|------|-----------------|
| Deterministic | Structural checks (SR1-SR7 triggers, SR3 paths, SR4 deps, SR5 scope, SR6 build-with, SR16 paths) | Exit 1 |
| LLM Checklist | Per-criterion evaluation (SR2-quality, SR7-adequacy, SR8-SR15, SR16-claims) | Exit 2 |

## Deterministic pass rule

A spec is `SPEC_READY` when:

1. **Deterministic clean**: no SR1-SR7, SR10-trigger, SR16-path `blocker` findings (exit 3 with
   `--no-llm`, exit 1 otherwise).
2. **LLM checklist clean**: for every `must` criterion (SR2-quality, SR8, SR9, SR11, SR15) and
   every triggered `conditional` criterion (SR7-adequacy, SR10-adequacy, SR16-claims), the model
   returns PASS.

If any `must` or triggered `conditional` criterion FAILs: `NOT_READY`.

If only `advisory` criteria (SR12, SR13, SR14) fail: `NOT_READY` with non-blocking findings
(reported but don't gate merge — operator discretion).

## Score derivation

Score = (passing must-criteria / total must-criteria) * 100, computed mechanically from the
per-criterion results. The model's `score` field in the JSON is ignored in favor of this derived
value. A spec passing all must-criteria gets 100 regardless of advisory findings.

## Checklist the model evaluates

| Criterion | What it checks | Gate |
|-----------|---------------|------|
| SR2-quality | Are acceptance criteria observable? Concrete exit codes, file checks, grep-able output? | must |
| SR7-adequacy | If sync/brain surface touched: is tier posture specific (tiers by name, default-deny, 422)? | conditional |
| SR8 | Well-bounded module — one narrow surface, no sibling-domain reach? | must |
| SR9 | Interface-first — contracts/types named before implementation steps? | must |
| SR11 | Testability — demonstrable by named tests with complete commands? | must |
| SR15 | Decidability — every must-path decidable? Bounded design latitude whose output is human-reviewed before merge is a PASS (a reviewed PR is recoverable); a blocker is only a decision with no downstream catch (unstated perf/SLA target, prerequisite with no "what if missing" branch, ambiguous external contract) | must |
| SR12 | Spec → plan → tasks traceability? Linear/epic links clear? | advisory |
| SR13 | Structural signals captured zero-LLM before model steps? | advisory |
| SR14 | Durable-state discipline stated? Append-only, writer-honored locks? | advisory |
| SR16-claims | Architecture claims ("reuses X") backed by real file paths? | must |

## Why this is more deterministic

1. **Per-criterion pass/fail** instead of subjective scoring — the model judges specific facts, not
   overall quality.
2. **Evidence required** — every PASS or FAIL must include the exact quote from the spec that
   supports the judgment.
3. **Score is mechanical** — derived from pass/fail ratio, not model opinion.
4. **Checklist format** — the model follows a table of criteria instead of free-form refutation.
   This reduces the model's tendency to hallucinate novel criticisms.
5. **Pinned sampling** — the evaluator call sends `temperature: 0` / `top_p: 1` (`EVAL_SAMPLING`),
   so the per-criterion PASS/FAIL judgments are as reproducible as the provider allows. Only the
   evaluator is pinned; agentic build/plan/fix calls keep provider defaults.
6. **Quorum vote (confirm-before-fail)** — the per-criterion judgments are still LLM outputs, and no
   provider is perfectly deterministic even at temp 0. So a blocking first pass escalates to `K`
   independent samples (default 3) and the verdict is a **majority vote**: NOT_READY only if
   ≥⌈K/2⌉ samples block, and a blocker finding gates only if its rule recurs in ≥⌈K/2⌉ samples. A
   lone stochastic FAIL is outvoted; a persistent one still blocks. The **ready path stays one call**
   (a passing first sample returns immediately) — only the boundary case pays for K samples. Cost
   note: a spec fixed in a tight loop runs up to K evaluator calls per attempt (all DeepSeek, off the
   Claude allowance). Set `K=1` to disable quorum (single pass) for CI/mocked runs.

If a spec's verdict still flips after this, the signal is that the **SR15 wording or the spec itself
is genuinely ambiguous** — fix the criterion or the spec, don't raise K.

## Comparing prompts

| Aspect | Old ("REFUTE") | New ("Checklist") |
|--------|---------------|-------------------|
| Instruction | "REFUTE this spec: find the underspecified corner..." | "For each criterion, return PASS or FAIL with evidence" |
| Score | Subjective 0-100 | Mechanical (passing/total) |
| Variability | 30+ point swings | ±5 points (from different evidence selection) |
| False positives | Model invents blockers to fulfill "refute" instruction | Fewer — model must tie findings to specific criteria |
| Completeness | Model picks what seems important | Model evaluates every criterion in order |

## Migration

No API or CLI change. The new prompt ships in `scripts/spec-eval.mjs`. Existing deterministic
checks are unchanged. The rubric (`.claude/rubrics/spec-readiness.md`) is unchanged.

To validate: run the adversarial evaluator on known-good specs and compare PASS/FAIL counts across
3 runs. Score variance should be in the ±5 range, not the ±30 range.
