# EPIC — Pre-release UX audit

Linear epic title: **EPIC: Pre-release UX audit**  
Owner: john@john-ellison.com

## Why

Critical cockpit flows untested at intent level before external users.

## What

Pilot UX on five flows; output `docs/pre-ship/ux-audit-YYYY-MM-DD.md`; three child specs:

| Child | Spec path | Flow ID |
|-------|-----------|---------|
| UX1 | `docs/pre-ship/ux1-onboarding-empty-state.md` | flow-1 |
| UX2 | `docs/pre-ship/ux2-integrations-wizard.md` | flow-2 |
| UX3 | `docs/pre-ship/ux3-cli-onboard-token-auth.md` | flow-3, flow-4 |

### Audit doc schema

`docs/pre-ship/ux-audit-YYYY-MM-DD.md` table columns: `flow_id`, `pass/fail`, `session_note`, `owner`.

Five flows: flow-1 (empty state), flow-2 (connect wizard), flow-3 (CLI onboard help),
flow-4 (token URL auth), flow-5 (reserved — mark N/A or skip with reason).

## Acceptance criteria

- All three child specs **SPEC_READY**.
- Audit doc covers five flows with pass/fail per flow ID.
- `node --test test/ux/flows/onboarding-draft-from-link.mjs` exits **0** (UX1).
- P0 bugs filed as Linear children before epic close.
- `npm run aios -- spec eval docs/pre-ship/epic-pre-release-ux.md` exits **0**.

## Builder vs operator closure

- **Builder delivers:** audit doc + UX1–UX3 child PRs; all child specs `SPEC_READY`.
- **Operator verifies:** one manual/agent-browser session logged with token URL in audit doc.

## Integration points

- `gui/client/src/App.tsx`
- `gui/server/index.mjs`
- `test/ux/flows/onboarding-draft-from-link.mjs`
- `scripts/aios.mjs`

## Deps

Soft dependency on AF3 for realistic onboarding state.

## Scope

Pilot audit + P0 filing. Out of scope: nightly agentic CI; Tauri shell.

## Build-with

Build-with: sonnet / medium.

## Tier-safety

Synthetic profile URLs only; no production secrets in logs.

## Testability

Named acceptance tests:

```bash
npm run aios -- spec eval docs/pre-ship/ux1-onboarding-empty-state.md
npm run aios -- spec eval docs/pre-ship/ux2-integrations-wizard.md
npm run aios -- spec eval docs/pre-ship/ux3-cli-onboard-token-auth.md
node --test test/ux/flows/onboarding-draft-from-link.mjs
AUDIT=docs/pre-ship/ux-audit-$(date +%Y-%m-%d).md
test -f "$AUDIT" && grep -q 'flow-1' "$AUDIT"
```

All exit **0** before epic close.
