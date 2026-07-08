# EPIC — Pre-release security audit

Linear epic title: **EPIC: Pre-release security audit**  
Owner: john@john-ellison.com

## Why

Tier boundaries, secret handling, and ship-pipeline isolation are product-ending if wrong.

## What

Execute checklist across workspace (+ optional sibling repos); five child specs:

| Child | Spec path |
|-------|-----------|
| SEC1 | `docs/pre-ship/sec1-secrets-leak-gate.md` |
| SEC2 | `docs/pre-ship/sec2-tier-boundary-pentest.md` |
| SEC3 | `docs/pre-ship/sec3-hooks-guards-audit.md` |
| SEC4 | `docs/pre-ship/sec4-ship-pipeline-isolation.md` |
| SEC5 | `docs/pre-ship/sec5-mcp-vault-audit.md` |

Shared artifact: `docs/pre-ship/security-audit-checklist.md` (created by SEC1, extended by SEC2–SEC5).

## Acceptance criteria

- SEC1: `validation/check-secrets.sh .` exit **0**; `scripts/leak-gate.sh .` exit **0** or waiver row; checklist committed with ≥2 rows.
- SEC2: admin push **422** or CLI withhold logged in checklist; `tier-boundary` row present.
- SEC3: hooks exist (`hooks/team-ops-guard.sh`, `hooks/aios-sync-nudge.sh`); `validation/check-frontmatter.sh examples/synthetic-consultant` exit **0**.
- SEC4: `node --test test/build-fence.test.mjs` exit **0** after AIO-157 merge; checklist row with PR link.
- SEC5: `node --test scripts/brain-mcp.test.mjs` exit **0**; MCP read-only row in checklist.
- `docs/pre-ship/security-audit-checklist.md` committed with pass/fail/waived per row.
- `validation/check-secrets.sh .` exits **0** on aios-workspace (SEC1).
- `scripts/leak-gate.sh .` exits **0**, or waiver row per `RELEASE-CHECKLIST.md` (SEC1).
- SEC2: admin push returns **422** logged in checklist.
- SEC3: `hooks/team-ops-guard.sh` wired; `validation/check-frontmatter.sh examples/synthetic-consultant` exit **0**.
- SEC4: `node --test test/build-fence.test.mjs` exit **0** after AIO-157 merge.
- SEC5: `node --test scripts/brain-mcp.test.mjs` exit **0**.

## Builder vs operator closure

- **Builder delivers:** checklist artifact + SEC1–SEC5 child PRs; all child deliverables confirmed.
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

Named acceptance tests:

```bash
validation/check-secrets.sh .
node --test test/build-fence.test.mjs
node --test scripts/brain-mcp.test.mjs
grep -q 'leak-gate' docs/pre-ship/security-audit-checklist.md
grep -q 'tier-boundary' docs/pre-ship/security-audit-checklist.md
```

All exit **0** before epic close.
