# Pre-ship spec-eval matrix

Generated: 2026-07-06 (adversarial model: deepseek-v4-pro)
Deterministic exit **3** = clean (`--no-llm`). Adversarial exit **0** = SPEC_READY.

| file | deterministic (exit) | adversarial verdict | score | date |
|------|----------------------|---------------------|-------|------|
| af1-agent-onboarding-contract.md | 3 | SPEC_READY | 100 | 2026-07-06 |
| af2-onboarding-smoke-runbook.md | 3 | SPEC_READY | 95 | 2026-07-06 |
| af3-workspace-naming-context.md | 3 | SPEC_READY | 90 | 2026-07-06 |
| af4-mcp-byoa-quickstart.md | 3 | SPEC_READY | 100 | 2026-07-06 |
| arch1-sync-contract-drift.md | 3 | SPEC_READY | 92 | 2026-07-06 |
| arch2-operator-loop-ship-coupling.md | 3 | NOT_READY | 55 | 2026-07-06 |
| arch3-cross-repo-seams.md | 3 | SPEC_READY | 90 | 2026-07-06 |
| cq1-test-matrix.md | 3 | NOT_READY | 45 | 2026-07-06 |
| cq2-ship-review-loop.md | 3 | NOT_READY | 50 | 2026-07-06 |
| cq3-v1-linear-drift.md | 3 | NOT_READY | 50 | 2026-07-06 |
| cq4-pr-triage.md | 3 | NOT_READY | 30 | 2026-07-06 |
| epic-agent-first-onboarding.md | 3 | SPEC_READY | 95 | 2026-07-06 |
| epic-pre-release-architecture.md | 3 | NOT_READY | 45 | 2026-07-06 |
| epic-pre-release-code-quality.md | 3 | NOT_READY | 30 | 2026-07-06 |
| epic-pre-release-security.md | 3 | NOT_READY | 55 | 2026-07-06 |
| epic-pre-release-ux.md | 3 | NOT_READY | 65 | 2026-07-06 |
| sec1-secrets-leak-gate.md | 3 | SPEC_READY | 80 | 2026-07-06 |
| sec2-tier-boundary-pentest.md | 3 | NOT_READY | 55 | 2026-07-06 |
| sec3-hooks-guards-audit.md | 3 | NOT_READY | 20 | 2026-07-06 |
| sec4-ship-pipeline-isolation.md | 3 | NOT_READY | 30 | 2026-07-06 |
| sec5-mcp-vault-audit.md | 3 | NOT_READY | 40 | 2026-07-06 |
| ux1-onboarding-empty-state.md | 3 | NOT_READY | 35 | 2026-07-06 |
| ux2-integrations-wizard.md | 3 | NOT_READY | 40 | 2026-07-06 |
| ux3-cli-onboard-token-auth.md | 3 | NOT_READY | 60 | 2026-07-06 |

## Pass summary

- **Deterministic:** 24/24 clean (exit 3)
- **Adversarial SPEC_READY:** 8/24 (prior run; scores above from pre-hardening adversarial eval)

## Manual hardening pass (2026-07-06, post matrix)

All 16 NOT_READY specs were manually hardened against the adversarial themes:

| Pattern fixed | Specs affected |
|---------------|---------------|
| Spec-eval self-reference removed from acceptance criteria | cq1, cq3, cq4, epic-pre-release-architecture, epic-pre-release-code-quality, epic-pre-release-security, epic-pre-release-ux, sec2, sec3, sec4, sec5, ux1, ux2, ux3 |
| ````markdown` wrapper fences removed | cq1, cq2 |
| Prerequisites / dependency checks added | cq2, cq3, cq4, sec3, sec4, sec5, ux1, ux2, ux3, arch2 |
| Edge-case handling (missing fixtures, files, brain deploy) | cq1, sec2, sec3, sec4, sec5 |
| Checklist row schemas defined (table format) | sec2, sec5 |
| Flow row schemas defined (field-level) | ux2, ux3 |
| Child spec `SPEC_READY` replaced with concrete deliverables | epic-pre-release-architecture, epic-pre-release-code-quality, epic-pre-release-security, epic-pre-release-ux |
| Testability sections use concrete commands, not spec-eval | epic-pre-release-code-quality, epic-pre-release-security, epic-pre-release-ux |

### File-by-file hardening detail

| File | Fixes applied |
|------|--------------|
| arch2 | Added prerequisites for source directories; enhanced operator verification |
| cq1 | Removed markdown fences; removed spec-eval from AC; fixture handling in prerequisites |
| cq2 | Removed markdown fences; converted pre-flight checks to prerequisites section; dotenvx install instructions |
| cq3 | Removed spec-eval from AC; added prerequisites (linear CLI, dotenvx, .env); C1-C8 reference |
| cq4 | Removed spec-eval from AC; added `gh` CLI prerequisite with authentication check |
| epic-pre-release-architecture | Removed spec-eval; concrete child deliverables instead of SPEC_READY |
| epic-pre-release-code-quality | Removed spec-eval (self + children); concrete child deliverables |
| epic-pre-release-security | Removed spec-eval (self + children); concrete child deliverables; inline AC per child |
| epic-pre-release-ux | Removed spec-eval (self + children); concrete child deliverables |
| sec2 | Removed spec-eval; brain deploy edge case; checklist row schema (3 rows) |
| sec3 | Removed spec-eval; prerequisites for hooks/fixtures/settings with absent handling |
| sec4 | Removed spec-eval; AIO-157 not-merged branch handling |
| sec5 | Removed spec-eval; checklist row schema; SEC1 dependency handling |
| ux1 | Removed spec-eval; test file prerequisite |
| ux2 | Removed spec-eval; ConnectWizard prerequisite; flow-2 row schema |
| ux3 | Removed spec-eval; CLI/server prerequisites; flow-3/flow-4 row schemas |

### Note on adversarial scores

The scores in the table above are from the pre-hardening adversarial run. A re-run against the hardened specs was not completed due to API availability constraints (deepseek-v4-pro flakiness). The structural fixes address the specific adversarial findings from that run, but scores should be considered baseline estimates pending a fresh adversarial pass.

## Score variability note

The adversarial model (deepseek-v4-pro) produces non-deterministic scores. Several specs showed score ranges of 30+ points between runs (e.g., af1 ranged 40–100, cq1 ranged 35–100). Scores of 0 were treated as API flakes and retried per the handover protocol.
