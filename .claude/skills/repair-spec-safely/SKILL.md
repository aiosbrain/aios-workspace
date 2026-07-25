---
name: repair-spec-safely
description: Repair a candidate spec only after concrete readiness findings exist or the user explicitly requests repair. Convert findings into bounded edits while preserving fixed decisions, capability truth, scope, and intent; do not publish or claim readiness without reevaluation.
---

# Repair a spec safely

Produce a revised local candidate, a finding-resolution map, and an original-to-revised diff.

1. Pin the original candidate hash, repository SHA, findings, fixed decisions, recent operator
   decisions, and declared skills.
2. Map every actionable finding to the smallest sufficient edit. Mark duplicates, unsupported
   findings, and decision-blocked findings explicitly rather than rewriting around them.
3. Preserve scope, compatibility posture, capability truth, and user intent. Never invent an
   architecture, existing path, runtime feature, or external contract to satisfy the rubric.
4. Compare original and revised claims. Stop if the repair changes a fixed decision, expands scope,
   weakens a safety boundary, or requires a product/architecture choice.
5. Stay within the configured correction budget. Do not recursively self-approve.
6. Emit the full revised Markdown, the finding-to-edit resolution map, and a diff artifact.
7. Run the normal evaluator afresh; only its new evidence may claim readiness.

Do not publish, loop past budget, or treat the absence of remaining prose findings as
`SPEC_READY`.
