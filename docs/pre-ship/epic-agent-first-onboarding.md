# EPIC — Agent-first onboarding (copy-paste URL playbook)

Linear epic title: **EPIC: Agent-first onboarding — copy-paste URL playbook**  
Owner: john@john-ellison.com

## Why

Before public ship we need an onboarding path where a **cold-start agent** can execute from one
canonical URL + prompt, scaffold `{handle}-workspace`, wire brain + context, and reach
`aios status` exit **0** — with every human-only step explicitly tagged.

## What

This epic **coordinates** four child specs (each is a well-bounded slice). The epic itself does not
implement code — it tracks child closure + one operator dogfood run.

| Child | Spec path | Deliverable |
|-------|-----------|-------------|
| AF1 | `docs/pre-ship/af1-agent-onboarding-contract.md` | `docs/getting-started/agent-onboarding.md` |
| AF2 | `docs/pre-ship/af2-onboarding-smoke-runbook.md` | Operator smoke runbook (phases 0–8) |
| AF3 | `docs/pre-ship/af3-workspace-naming-context.md` | Scaffold hints + SKILL.md |
| AF4 | `docs/pre-ship/af4-mcp-byoa-quickstart.md` | MCP quickstart section |

## Acceptance criteria

- Each child spec reaches **SPEC_READY** (`npm run aios -- spec eval <child>` exit **0**).
- `docs/getting-started/agent-onboarding.md` exists (AF1 deliverable).
- `docs/pre-ship/af2-onboarding-smoke-runbook.md` exists with phases 0–8 (AF2).
- `scripts/scaffold-project.sh` documents `{handle}-workspace` naming (AF3).
- MCP section references `npm run aios -- mcp` + `node --test scripts/brain-mcp.test.mjs` green (AF4).
- Operator dogfood log at `docs/pre-ship/dogfood/onboarding-run-YYYY-MM-DD.md` with `aios status` exit **0**.
- Every **BLOCKER** in dogfood log has linked PR or Linear child before epic close.
- `npm run aios -- spec eval docs/pre-ship/epic-agent-first-onboarding.md` exits **0**.

## Builder vs operator closure

- **Builder delivers:** AF1–AF4 child PRs; all four child specs `SPEC_READY`.
- **Operator verifies:** one dogfood run logged; `validation/validate-all.sh .` exit **0** on fresh scaffold.

## Optional follow-up (not blocking this epic)

- aios-website Aside link to agent playbook — file separate Linear child if not merged with AF1 PR.

## Integration points

- `scripts/scaffold-project.sh`
- `scripts/aios.mjs`
- `validation/validate-all.sh`
- `scripts/brain-mcp.test.mjs`

## Deps

Deps: none — builds on shipped scaffold flow in `scripts/scaffold-project.sh` and `docs/GUIDE.md`
(Linear **AIO-195** tracks the same work; it is not a repo file path).

## Scope

**In scope:** child spec coordination, dogfood log, naming hints.
**Deferred:** `npx create-aios-workspace` installer; write MCP; AIO-243 client-surface.

## Build-with

Build-with: sonnet / medium — docs + small hint edits.

## Tier-safety

Playbook states: `admin` never syncs; missing `access:` default-deny; brain **422** on admin push.
Smoke uses synthetic `team`-tier fixtures only.

## Testability

Named acceptance tests (epic-level):

```bash
npm run aios -- spec eval docs/pre-ship/af1-agent-onboarding-contract.md
npm run aios -- spec eval docs/pre-ship/af2-onboarding-smoke-runbook.md
npm run aios -- spec eval docs/pre-ship/af3-workspace-naming-context.md
npm run aios -- spec eval docs/pre-ship/af4-mcp-byoa-quickstart.md
node --test scripts/brain-mcp.test.mjs
```

All exit **0** before epic close. Operator dogfood log is manual verification.
