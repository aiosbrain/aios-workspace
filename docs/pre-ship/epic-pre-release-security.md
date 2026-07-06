# EPIC — Pre-release security audit

Linear epic title: **EPIC: Pre-release security audit**

## Why

Tier boundaries, secret handling, and ship-pipeline isolation are product-ending if wrong.

## What

Execute checklist across workspace (+ optional sibling repos); children SEC1–SEC5; AIO-157 for SEC4.

## Acceptance criteria

- `docs/pre-ship/security-audit-checklist.md` committed with pass/fail/waived per row.
- `validation/check-secrets.sh .` exits **0** on aios-workspace.
- `scripts/leak-gate.sh .` exits **0**, or waiver row per `RELEASE-CHECKLIST.md`.
- SEC2: admin push returns **422** logged in checklist.
- SEC3: `hooks/team-ops-guard.sh` wired; `validation/check-frontmatter.sh examples/synthetic-consultant` exit **0**.
- SEC4: `node --test test/build-fence.test.mjs` exit **0** after AIO-157 merge.
- SEC5: `node --test scripts/brain-mcp.test.mjs` exit **0**.
- `npm run aios -- spec eval docs/pre-ship/epic-pre-release-security.md` exits **0**.

## Builder vs operator closure

- **Builder delivers:** checklist artifact + child spec PRs; automated tests green.
- **Operator verifies:** pen-test rows (SEC2), waiver sign-off if leak-gate waived, AIO-157 merge confirmed.

## Optional follow-up (not blocking epic)

- Sibling repo scans when `../aios-team-brain` / `../aios-website` absent → checklist row **skipped**.

## Integration points

- `validation/check-secrets.sh`
- `scripts/leak-gate.sh`
- `hooks/team-ops-guard.sh`
- `test/build-fence.test.mjs`
- `scripts/brain-mcp.test.mjs`

## Deps

Depends on AIO-157 for SEC4.

## Scope

In scope: audit + checklist + critical fixes. Out of scope: third-party pentest; SOC2.

## Build-with

Build-with: sonnet / medium.

## Tier-safety

Validates admin never syncs; default-deny; **422** at brain boundary.

## Testability

- `validation/check-secrets.sh .` exit **0**.
- `node --test test/build-fence.test.mjs` exit **0**.
- `node --test scripts/brain-mcp.test.mjs` exit **0**.
