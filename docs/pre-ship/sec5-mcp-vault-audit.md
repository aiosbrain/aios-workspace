# SEC5 — MCP + integrations vault audit

Parent: Pre-release security epic.

## Why

MCP must stay read-only; connector keys encrypted; Firecrawl/onboarding treated as untrusted input.

## What

- Run `node scripts/brain-mcp.test.mjs` (existing suite)
- Add checklist rows in `docs/pre-ship/security-audit-checklist.md`: MCP tool names, no write tools, vault path note

## Acceptance criteria

- `node scripts/brain-mcp.test.mjs` exits **0**.
- Checklist row documents MCP is read-only (no push/pull/write tools).
- `npm run aios -- spec eval docs/pre-ship/sec5-mcp-vault-audit.md` exits **0**.

## Builder vs operator closure

- **Builder delivers:** test run logged in checklist + MCP read-only row.
- **Operator verifies:** optional live `brain_status` with valid key.

## Integration points

- `scripts/brain-mcp.mjs`
- `scripts/brain-mcp.test.mjs`

## Deps

Soft: SEC1 checklist file may land first; can append rows in same PR.

## Scope

Audit documentation. Out of scope: write MCP; new tests.

## Build-with

Build-with: sonnet / low.

## Tier-safety

MCP reuses brain server-side tier filtering; admin-tier never returned. Doc row must state MCP cannot push. No behavior changes.

## Testability

- `node scripts/brain-mcp.test.mjs` exit **0**.
