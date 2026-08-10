---
name: evaluate-spec-readiness
description: Audit whether a candidate spec is ready against an immutable repository baseline and the AIOs readiness rubric. Use for “is this spec ready,” readiness evaluation, or repository-backed spec audits; never revise or publish the candidate.
---

# Evaluate spec readiness

Return `SPEC_READY`, `NOT_READY`, or `NOT_EVALUATED` without editing the candidate.

1. Resolve and record the repository path, clean/dirty state, evaluated tree SHA, candidate SHA-256,
   rubric version/hash, model, tier, and exit status.
2. Refuse to claim evaluation against one SHA while inspecting another. Use a clean immutable
   snapshot or report `NOT_EVALUATED`.
3. Run deterministic evaluation first. Preserve its findings and exit-code ownership unchanged.
4. Run adversarial evaluation only after deterministic evidence exists. Verify architecture and
   capability claims against the pinned tree; absence of evidence is not support.
5. Apply must-fail findings without waivers. Distinguish readiness verdict from numeric score and
   preserve parse/network failures as fail-closed evidence.
6. Validate declared `skills:` through the suite manifest. Unknown, conflicting, oversized, or
   stage-incompatible declarations are readiness failures before model evaluation.
7. Return the verdict and evidence bundle with findings separated by deterministic/adversarial
   source. Never suggest that a green score overrides a blocking verdict.

If `aios spec eval` cannot run at all because no `aios-devtools` checkout resolves
(`--devtools-dir` → `AIOS_DEVTOOLS_DIR` → the `@aiosbrain/aios-devtools` package — see
`docs/devtools-toolkit-contract.md`), report `NOT_EVALUATED` and name that as the reason. An
unrunnable grader is neither a pass nor a fail, and hand-grading is not a substitute unless the
verdict says so explicitly.

Do not revise the spec, write to Linear, waive blockers, or evaluate a dirty/mismatched tree while
reporting a clean baseline.
