---
kind: rubric
applies_to: operator-loop-c1c2
budget: 3
pass: no-must-fails
---

# Rubric — Operator Loop C1 (collector + manifest) + C2 (evidence ledger)

Machine-checkable success criteria for the C1/C2 substrate. Constitution §2: success criteria
live here, never invented ad-hoc inline. The independent validator grades the diff + tests
against these, receiving only this rubric + the diff + the C1/C2 acceptance criteria.

| ID  | Criterion | Check method | Must |
|-----|-----------|--------------|------|
| CL1 | One collector engine drives both cadences; daily/weekly differ only by a config object (window + kind filter), no duplicated per-cadence code path | code-read | yes |
| CL2 | Default-deny excludes ONLY missing/unresolvable tier → `excluded[]`; admin-tier signals are RETAINED in `signals[]` (collector does not reuse sync's admin-dropping `buildPlan`) | grounding-read | yes |
| CL3 | Manifest is the sole typed contract downstream reads (`RunManifest.signals[]` + `excluded[]` + `window`) | code-read | yes |
| CL4 | Sources cover decisions, tasks, hours (BOTH `\| Date \| …` and `\| Member \| Date \| …` header shapes), deliverables, inbox; carryover + github are explicit stubs; github not required by acceptance | grounding-read | yes |
| CL5 | Spine-agnostic: collector resolves current (`0-context/1-inbox/2-work/3-log`) and legacy (`00/01/02/03`) layouts | grounding-read | yes |
| CL6 | Manifests written to `.aios/loop/` (outside `sync_include`); a test proves sync/`buildPlan` never picks them up | grounding-read | yes |
| EV1 | `assertGrounded` makes a zero-evidence claim a hard fail; a claim with no evidence ref cannot be emitted | grounding-read | yes |
| EV2 | `redactForTier`: admin-only evidence ⇒ no claim text emitted, only a content-free placeholder; mixed ⇒ emit + `requiresIndependentSupport` + withheld counts; all-allowed ⇒ emit | grounding-read | yes |
| EV3 | `visibleTiers` lattice: external→{external}, team→{external,team}, owner→{external,team,admin}; team-tier source is withheld from an external digest | code-read | yes |
| EV4 | Redactions are visible (count + tier), never silent drops | grounding-read | yes |
| IO1 | `tsc` compiles clean; `dist/` gitignored; dynamic import only inside the `loop` command; clear "run npm run build:loop" error when unbuilt; no broad `prepare` hook | code-read | yes |
| IO2 | Parser refactor is behavior-preserving (`sync-plan` + `tasks-table` tests green); tier normalization stays single-sourced | test-run | yes |
| IO3 | MCP `aios_loop_collect` returns a manifest identical to the CLI path; prefix + exact-list tests updated intentionally; startup degrades to local-capable only when a workspace resolves | test-run | yes |
| EX1 | `aios loop manifest --explain` is inspectable (expand line → sources + tiers); `--as team\|external` simulates audience | code-read | no |
| EX2 | Signals tolerate unknown future `kind` values (forward-compat) | code-read | no |
