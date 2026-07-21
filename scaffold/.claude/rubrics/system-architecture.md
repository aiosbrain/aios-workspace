---
kind: rubric
applies_to: system-architecture
budget: 2
pass: no-must-fails
---
# Rubric — system-architecture

Assesses whether a workspace's agent infrastructure implements the architectural patterns from Part F of the pattern library (Gulli 2026). Unlike `agentic-maturity` (which assesses the *human's* maturity), this assesses the *system's* architecture — what error handling, memory, guardrails, and monitoring exist in the workspace's harness.

| ID  | Criterion | Check method | Must |
|-----|-----------|--------------|------|
| SA1 | Exception handling exists: the operator loop (or equivalent harness) detects tool/API failures, retries transient errors, and escalates irrecoverable ones with structured context (failure point, attempted recovery, human action needed) — not silent crashes or raw stack traces | grounding-read | yes |
| SA2 | Rollback on partial failure: if an agent modifies multiple files/states and fails mid-sequence, earlier changes are reverted (git worktree discard, staging-before-commit, or compensating transactions) — the system is never left in a half-mutated state | grounding-read | yes |
| SA3 | Episodic memory is written: `.claude/memory/` files (or equivalent) capture what worked, what failed, and what changed after non-trivial sessions — not just at assessment time | file-exists | yes |
| SA4 | Guardrail enforcement goes beyond prompt instructions: validation gates (schemas, leak-gates, tier checks) parse and reject unsafe output before it crosses a boundary (sync, send, external) — not just "don't do X" in the system prompt | grounding-read | yes |
| SA5 | Human-in-the-loop gates are specific: each gate names a concrete trigger (irreversible action, low-confidence output, sensitive content), a concrete human action (review, clarify, approve), and a concrete enforcement mechanism (flag, boundary, rubric) — not vague "use judgment" | deterministic | yes |
| SA6 | Pre-deployment evals exist: at least one rubric or test suite grades agent output against acceptance criteria before the output ships (PR merges, sync fires, content is shared) | file-exists | no |
| SA7 | The assessment honestly identifies which Part F patterns are missing — a workspace scoring 2/7 is stated plainly, not inflated to "partially implements all patterns" | deterministic | no |
| SA8 | Each gap includes a concrete next step mapped to the pattern library (e.g., "F1 rollback: add `aios rollback` that discards the worktree on harness failure") — not just "needs improvement" | deterministic | no |
