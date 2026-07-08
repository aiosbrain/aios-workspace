# SEC1 — Secrets + leak gate sweep

Owner: john@john-ellison.com
Parent: Pre-release security epic.

## Why

Public release requires clean secret scan and NDA leak gate per `RELEASE-CHECKLIST.md`.

## What

Run on aios-workspace (required):
- `validation/check-secrets.sh .`
- `scripts/leak-gate.sh .` — exit **0** OR waiver row in checklist (see Waiver schema)

## New files to create

- `docs/pre-ship/security-audit-checklist.md` — table with columns: `check`, `command`, `exit_code`, `date`, `owner`, `notes`.

## Waiver schema (when leak-gate ≠ 0)

All checklist rows use `owner=john@john-ellison.com`.

- **secrets row:** `check=check-secrets`, `command=validation/check-secrets.sh .`, `exit_code=<actual>`, `date=$(date +%Y-%m-%d)`, `owner=john@john-ellison.com`, `notes=<summary of findings or "clean">`.
- **leak-gate row (exit 0):** `check=leak-gate`, `command=scripts/leak-gate.sh .`, `exit_code=0`, `date=$(date +%Y-%m-%d)`, `owner=john@john-ellison.com`, `notes=clean`.
- **leak-gate row (waiver, exit ≠ 0):** One row with: `check=leak-gate`, `exit_code=<actual>`, `owner=john@john-ellison.com`, `date=$(date +%Y-%m-%d)` (substituted with the run date at execution time), `notes=<reason for non-zero exit + reference to RELEASE-CHECKLIST.md § NDA leak gate>`.

## Acceptance criteria

- `validation/check-secrets.sh .` exits **0**.
- `scripts/leak-gate.sh .` exits **0**, OR waiver row present per schema above.
- `docs/pre-ship/security-audit-checklist.md` committed with at least two rows (secrets + leak-gate).
- `npm run aios -- spec eval docs/pre-ship/sec1-secrets-leak-gate.md` exits **0**.

## Builder vs operator closure

- **Builder delivers:** checklist file with command output in `notes` column.
- **Operator verifies:** waiver row if leak-gate non-zero; signs off in PR comment.

## Integration points

- `validation/check-secrets.sh`
- `scripts/leak-gate.sh`
- `RELEASE-CHECKLIST.md`

## Deps

Deps: none.

## Scope

Scan + checklist in aios-workspace. Out of scope: key rotation; sibling repo scans (optional follow-up).

## Build-with

Build-with: sonnet / low.

## Tier-safety

No sync surface changes. Checklist must not contain live secrets — paste exit codes and summary lines only.

## Testability

- `validation/check-secrets.sh .` exit **0**.
- `grep -q leak-gate docs/pre-ship/security-audit-checklist.md` after deliverable committed.
