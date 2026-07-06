# AF4 — MCP/BYOA onboarding quick-start path

Owner: john@john-ellison.com
Parent epic: Agent-first onboarding. Linear: **AF4 — MCP/BYOA onboarding quick-start path**

## Why

New contributors may use OpenCode, Claude Desktop, or other shell-less agents. Onboarding must
document read-only brain access via `aios mcp` and BYOA export — without conflating
`agent_runtime: opencode` (OpenCode's loop) with client-surface mode (AIO-243, deferred).

## What

Add **Optional: shell-less agent / MCP** to `docs/getting-started/agent-onboarding.md` (AF1 deliverable):

1. **`npm run aios -- mcp`** — stdio MCP; env `AIOS_BRAIN_URL`, `AIOS_API_KEY`.
2. **Read-only** — push/pull remain CLI-only; MCP reuses brain server-side tier filtering.
3. **BYOA** — link `docs/byoa.md`; `aios skills export --runtime opencode` after skills exist.
4. **Verify** — `node scripts/brain-mcp.test.mjs` (existing suite, no network).

## Acceptance criteria

- Agent onboarding doc contains MCP stdio snippet and read-only disclaimer.
- `node scripts/brain-mcp.test.mjs` exits **0** (existing test, unchanged).
- `grep -q "aios mcp" docs/getting-started/agent-onboarding.md` succeeds after AF1+AF4 land.
- `npm run aios -- spec eval docs/pre-ship/af4-mcp-byoa-quickstart.md` exits **0**.

## Builder vs operator closure

- **Builder delivers:** MCP/BYOA section in `docs/getting-started/agent-onboarding.md`.
- **Operator verifies:** optional manual `brain_status` via MCP with real key (logged in AF2 dogfood).

## Integration points (existing)

- `scripts/brain-mcp.mjs` — MCP server implementation.
- `scripts/brain-mcp.test.mjs` — existing protocol/tier tests (run directly, not via `node --test`).
- `scripts/aios.mjs` — `mcp`, `skills export` subcommands.
- `docs/byoa.md` — runtime axis reference.
- `docs/prd-team-brain-mcp-connector.md` — phased rollout (read-only shipped).

## Deps

Depends on AF1 (`docs/getting-started/agent-onboarding.md` file exists). Soft: AF2 phase 4 brain-connected.

## Scope

In scope: documentation section in agent onboarding doc. Out of scope: new MCP tests, `.mcpb` bundle,
AIO-243, write MCP, GUI runtime changes.

## Build-with

Build-with: sonnet / low — documentation only.

## Tier-safety

MCP is read-only; brain server-side tier filtering applies. Doc must state: admin-tier never returned
via MCP; MCP cannot push. No sync behavior changes; no tier-tagged signals emitted (SR10 N/A).

## Testability

- `node scripts/brain-mcp.test.mjs` exit **0** (existing).
- Doc grep for `aios mcp` after merge.
