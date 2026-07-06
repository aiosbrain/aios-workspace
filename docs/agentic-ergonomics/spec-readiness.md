# Spec Readiness — the `aios spec` harness (EE5 / AIO-171)

**Status:** the machine check for Engineering Constitution §1 ("spec → plan → tasks → implement")
and the Build Paradigm's *pick-up-able issue* test — *an agent with no conversation history can
read the spec and start correctly.* Before a builder (human or agent) picks up a spec, run it
through `aios spec eval`; if it fails, `aios spec fix` iterates it to ready.

Sibling contracts: [`ENGINEERING-CONSTITUTION.md`](../ENGINEERING-CONSTITUTION.md) (spec-before-code),
[`build-paradigm.md`](./build-paradigm.md) (how a slice ships), and the rubric it enforces,
[`.claude/rubrics/spec-readiness.md`](../../.claude/rubrics/spec-readiness.md) (SR1–SR16).

---

## The two-layer model

Readiness is graded in two layers, both gated by the rubric:

1. **Deterministic** (zero-LLM, offline, fast). Structural presence/shape checks and real-path
   resolution against the repo tree: is there a what/why, observable acceptance criteria, declared
   deps, stated scope, a build-with tier, a tier-safety posture when a sync/brain surface is
   touched, and do the named integration paths actually resolve to files? A deterministic
   `must`-fail is a hard blocker — a builder would stumble on it with certainty.
2. **Adversarial** (LLM, opt-in). An independent evaluator *refutes* the spec — it hunts the
   underspecified corner a cold-start builder trips on, grades each rubric criterion pass/fail with
   a quoted span, and emits a single verdict plus findings. Its output is parsed defensively:
   unparseable output becomes one synthetic blocker (fail closed, never open).

The **verdict is the only gate**. The 0–100 score is advisory/reporting and never derives an exit
code. The deterministic layer runs first and its findings are handed to the evaluator in-context so
it does not duplicate them. A light read of the recent operator-decision corpus (EE4) is included
as soft context; it never blocks (empty on any error).

## Command

```
aios spec eval <file> [--json] [--no-llm] [--rubric <path>]
aios spec fix  <file> [--budget N] [--write | --out <path>] [--no-llm] [--rubric <path>]
```

- **eval** grades the spec. `--no-llm` runs the deterministic layer only (offline, no key).
- **fix** runs the bounded fix loop (`evaluate → revise → re-evaluate`, budget from the rubric,
  default 2) until the spec is ready or the budget is spent. `--write` overwrites in place; `--out`
  writes an explicit path; the default writes `<name>.improved.md` (the original is never touched
  unless `--write`). `--write` is the confirmation — there is no interactive prompt (agents drive
  this non-interactively).
- `--json` output always includes `exitCode`; `fix --json` also includes the `outputPath`.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | `SPEC_READY` — no must-fails |
| 1 | deterministic must-fail (structural blocker) |
| 2 | adversarial blocker (LLM refutation) |
| 3 | `NOT_EVALUATED` — deterministic clean, LLM layer not run (`--no-llm`) |
| 4 | usage / IO error (missing file, unreadable/malformed rubric, missing provider API key without `--no-llm`) |

A deterministic must-fail (1) takes precedence over an adversarial blocker (2): if the structure is
broken, that is reported first.

## Relay gate

`aios relay "task" --spec <file>` evaluates the spec **before** planning and refuses (exit 1/2) if
it is `NOT_READY`, so a planning loop is never spent on an unready spec. The gate is **eval-only** —
it never auto-fixes; fix the spec with `aios spec fix <file>` and re-run.

## Models

The evaluator and reviser are per-step model config (`loop-models.mjs`): `spec_eval` and
`spec_fix` (default **`deepseek-v4-pro`**, same prompt-only backend as `plan_review` /
`code_review`), tunable via `.aios/loop-models.yaml`. Both route through `callPromptModel` —
there is **no diversity pair**: spec eval is a single adversarial pass, and prompt-discipline
(refute, quote, per-criterion), not model-family independence, is what makes it trustworthy.
