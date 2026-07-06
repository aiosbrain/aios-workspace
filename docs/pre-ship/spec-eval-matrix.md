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
- **Adversarial SPEC_READY:** 8/24
- **Adversarial NOT_READY:** 16/24

## Blockers

The adversarial model (deepseek-v4-pro) flags remaining gaps in 16 specs. Scores range from 20–65. Common themes:

| Approx count | Theme |
|--------------|-------|
| 6 | Acceptance criteria embed spec-eval self-reference (SR2/SR15 — the spec requires `spec eval` to exit 0) |
| 5 | Missing edge-case handling (file missing, multiple matches, script execution failures) |
| 3 | Prerequisites or fixtures not declared (SR15 — cold-start builder cannot resolve must-paths) |
| 2 | Interface/contract not named before implementation steps (SR9) |

### Notable

- **af1-agent-onboarding-contract.md** (score 100) — fully hardened spec; served as the reference pattern after 144cfc1 hardening pass.
- **cq4-pr-triage.md** (score 30) — flagged for `gh` CLI prerequisite not declared; low score may include API flake.
- **sec3-hooks-guards-audit.md** (score 20) — lowest score; spec fix tool degraded it (reverted via git checkout). Needs manual hardening.
- **ux3-cli-onboard-token-auth.md** (score 60) — closest NOT_READY to green; minor edge-case gaps.

### Note on score variability

The adversarial model (deepseek-v4-pro) produces non-deterministic scores. Several specs showed score ranges of 30+ points between runs (e.g., af1 ranged 40–100, cq1 ranged 35–100). The scores above reflect the most recent stable evaluation. Scores of 0 were treated as API flakes and retried per the handover protocol.
