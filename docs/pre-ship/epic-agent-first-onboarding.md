# EPIC — Agent-first onboarding (copy-paste URL playbook)

Linear epic title: **EPIC: Agent-first onboarding — copy-paste URL playbook**

## Why

Before public ship we need an onboarding path where a **cold-start agent** can execute from one
canonical URL + prompt, scaffold `{handle}-workspace`, wire brain + context, and reach
`aios status` exit **0** — with every human-only step explicitly tagged.

## What

Deliver agent contract (AF1), smoke runbook (AF2), naming conventions (AF3), MCP quick path (AF4).
Operator runs one fresh-identity dogfood session; builder ships docs + small scaffold hints.

## Acceptance criteria

- `docs/getting-started/agent-onboarding.md` exists in **this repo** (AF1 deliverable).
- `npm run aios -- spec eval docs/pre-ship/af1-agent-onboarding-contract.md` exits **0** before AF1 closes.
- `docs/pre-ship/af2-onboarding-smoke-runbook.md` exists with phases 0–8 (AF2).
- `scripts/scaffold-project.sh` post-scaffold hints document `--slug {handle}-workspace` (AF3).
- MCP section in playbook links `aios mcp` + `scripts/brain-mcp.test.mjs` green (AF4).
- `npm run aios -- spec eval docs/pre-ship/epic-agent-first-onboarding.md` exits **0**.
- Every **BLOCKER** in dogfood log has linked PR or Linear child before epic close.

## Builder vs operator closure

- **Builder delivers:** AF1 playbook, AF2 runbook + template, AF3 scaffold hints, AF4 MCP doc section;
  all child specs `SPEC_READY`.
- **Operator verifies:** one dogfood run in `docs/pre-ship/dogfood/onboarding-run-YYYY-MM-DD.md`;
  `aios status` exit **0**; `validation/validate-all.sh .` exit **0** on fresh scaffold.

## Optional follow-up (not blocking this epic)

- aios-website Aside link to agent playbook — file separate Linear child if not merged with AF1 PR.

## Edit surface (this repo only)

| Path | Action |
|------|--------|
| `docs/pre-ship/af1-agent-onboarding-contract.md` | Exists — spec gate |
| `docs/getting-started/agent-onboarding.md` | Create (AF1) |
| `docs/pre-ship/af2-onboarding-smoke-runbook.md` | Create (AF2) |
| `scripts/scaffold-project.sh` | Edit hints only (AF3) |
| `docs/GUIDE.md`, `scripts/brain-mcp.mjs` | Read-only reference |

## Integration points

- `scripts/scaffold-project.sh`
- `scripts/aios.mjs`
- `validation/validate-all.sh`
- `scripts/brain-mcp.test.mjs`

## Deps

Deps: none — builds on shipped onboarding (AIO-195 Done).

## Scope

**In scope:** agent docs, runbook, naming hints, one dogfood run.
**Deferred:** `npx create-aios-workspace` installer; write MCP; AIO-243 client-surface.

## Build-with

Build-with: sonnet / medium — docs + small hint edits.

## Tier-safety

Playbook states: `admin` never syncs; missing `access:` default-deny; brain **422** on admin push.
Smoke uses synthetic `team`-tier fixtures only.

## Testability

- `node --test test/spec-eval-cli.test.mjs` exits **0**.
- `node --test scripts/brain-mcp.test.mjs` exits **0**.
- Operator: `aios status` exit **0** and `validation/validate-all.sh .` exit **0** logged in dogfood file.
