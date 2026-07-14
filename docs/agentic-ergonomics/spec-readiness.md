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
aios spec eval <file|dir|glob> [--tier full|deterministic] [--concurrency N] [--json] [--no-llm] [--rubric <path>]
aios spec fix  <file> [--tier full|deterministic] [--budget N] [--write | --out <path>] [--no-llm] [--rubric <path>]
aios spec author <plan> --slices <dir> [--out <dir>] [--concurrency N] [--model <id>] [--effort <level>] [--json]
```

- **eval** grades the spec. `--no-llm` runs the deterministic layer only (offline, no key).
- A spec may declare `eval_tier: deterministic` in frontmatter (or receive `--tier deterministic`).
  Its mandatory deterministic check is the complete evaluation, so a clean result is `SPEC_READY`
  (exit 0) and never makes a model call. The default tier is `full`.
- **Enforcement is separate from evaluation.** `eval_tier` chooses *which layers run*; `spec_gate`
  chooses *whether a `NOT_READY` verdict blocks a build*. `aios ship` reads it (flag `--spec-gate
  <block|advisory|off>` > spec frontmatter `spec_gate:` > config default `block`):
  - `block` (default) — a `NOT_READY` verdict stops the ship at the gate.
  - `advisory` — run the eval, print + record the findings, then **proceed to build anyway** (warn,
    don't block). Allowed under `--loop light` because it still runs and records the gate.
  - `off` — don't run the adversarial gate at all (the named form of `--skip-spec-gate`; **not**
    allowed under `--loop light`, whose entry contract is a real gate result).
  `aios spec eval` itself is unaffected by `spec_gate` — it always reports the true verdict/exit
  code; only the *ship* enforcement changes.
- A directory or glob is evaluated concurrently (default 6, bounded to 8) and prints one
  file/verdict/exit/score table. Every file still runs the deterministic layer.
- Set `eval_provenance: adversarial-reviewed` (or `parent_plan_reviewed: true`) only when the
  parent plan received adversarial review. In `spec fix`, that runs the LLM once before revisions,
  deterministic checks on each revision, and one final LLM confirmation.
- **author** fans one independent Opus author call per Markdown issue slice (default pool 6,
  bounded to 8). Each call receives the shared plan, rubric, and only its assigned slice. After
  fan-out it runs deterministic per-spec gates plus title/path collision checks; semantic drift is
  deliberately a separate optional review concern, never a substitute for those checks.
  `--model` and `--effort` override `spec_author_*` for that batch only.
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

The evaluator and reviser are per-step model config (`loop-models.mjs`): `spec_eval` remains
**`deepseek-v4-pro`** while `spec_fix` defaults to **`claude-opus-4-8`** at high effort. This
keeps the author/reviser and adversarial refuter in distinct model families.
It is tunable via `.aios/loop-models.yaml`; keep those two steps cross-family when overriding.
Both route through `callPromptModel`.
