# EPIC — Agent-first onboarding (copy-paste URL playbook)

Linear epic title: **EPIC: Agent-first onboarding — copy-paste URL playbook**  
Owner: john@john-ellison.com

## Why

Before public ship we need an onboarding path where a **cold-start agent** can execute from one
canonical URL + prompt, scaffold `{handle}-workspace`, wire brain + context, and reach
`aios status` exit **0** — with every human-only step explicitly tagged.

The canonical onboarding URL is:
`https://raw.githubusercontent.com/john-ellison/aios/main/docs/getting-started/agent-onboarding.md`
— the raw content of the deliverable once merged to `main`. The AF1 playbook must use this URL.

## What

This epic **coordinates** four child specs (each is a well-bounded slice). The epic itself does not
implement code — it tracks child closure + one operator dogfood run.

| Child | Spec path                                              | Deliverable                                      | Purpose                                                                 |
|-------|--------------------------------------------------------|--------------------------------------------------|-------------------------------------------------------------------------|
| AF1   | `docs/pre-ship/af1-agent-onboarding-contract.md`       | `docs/getting-started/agent-onboarding.md`        | The canonical, copy-paste agent onboarding playbook                     |
| AF2   | `docs/pre-ship/af2-onboarding-smoke-runbook.md`        | Operator smoke runbook (phases 0–8)               | A human-executable verification runbook that exercises the playbook     |
| AF3   | `docs/pre-ship/af3-workspace-naming-context.md`        | Scaffold hints + `SKILL.md` (new file)            | Workspace naming convention docs and agent skill hints                  |
| AF4   | `docs/pre-ship/af4-mcp-byoa-quickstart.md`             | MCP quickstart section                            | How to bring-your-own-agent MCP server with brain tests                 |

### Child spec requirements (what the builder must define in each child spec)

* **AF1** must specify the exact sequence of commands an agent executes when given a single URL and prompt, including:
    * The canonical URL: `https://raw.githubusercontent.com/john-ellison/aios/main/docs/getting-started/agent-onboarding.md`
    * The copy-paste block the agent runs (e.g. `curl -sS <URL> | bash` or equivalent)
    * How to scaffold `{handle}-workspace`
    * How to wire the brain and context — using the existing `aios brain` CLI (see the brain subcommands in `scripts/aios.mjs` and the contract exercised by `scripts/brain-mcp.test.mjs`) — and verify the result
    * How to verify `aios status` exit 0
    * A list of every step that requires human intervention, tagged explicitly
* **AF2** must define a smoke runbook with phases 0–8 that an operator can follow after scaffolding, including:
    * Preconditions (fresh clone, dependencies installed)
    * Each phase’s action, expected output, and pass/fail criteria
    * How to collect the `aios status` output
* **AF3** must document the `{handle}-workspace` naming convention as used by `scripts/scaffold-project.sh`, and produce a `SKILL.md` file (placed at the repo root) that agents can use as context hints for generating workspace names
* **AF4** must cover:
    * How to install and configure an MCP server for `aios`
    * How to run the brain MCP test suite: `node --test scripts/brain-mcp.test.mjs`
    * Expected output and green pass criteria

## Acceptance criteria

All of the following are self‑verifiable:

- **Each child spec reaches SPEC_READY** — the local evaluator exits 0:
  ```bash
  npm run aios -- spec eval docs/pre-ship/af1-agent-onboarding-contract.md
  npm run aios -- spec eval docs/pre-ship/af2-onboarding-smoke-runbook.md
  npm run aios -- spec eval docs/pre-ship/af3-workspace-naming-context.md
  npm run aios -- spec eval docs/pre-ship/af4-mcp-byoa-quickstart.md
  ```
- **AF1 deliverable exists:** `docs/getting-started/agent-onboarding.md` is present and contains the copy‑paste playbook block.
- **AF2 deliverable exists:** `docs/pre-ship/af2-onboarding-smoke-runbook.md` contains a table/checklist with exactly phases 0–8, each with a verifiable action and expected result.
- **AF3 deliverable exists:** `scripts/scaffold-project.sh` includes a comment block documenting the `{handle}-workspace` naming convention; the new file `SKILL.md` (repo root) exists with agent workspace‑hint content.
- **AF4 deliverable exists:** `docs/pre-ship/af4-mcp-byoa-quickstart.md` contains a `## MCP Quickstart` section that references `npm run aios -- mcp` and `node --test scripts/brain-mcp.test.mjs` and states the expected pass output.
- **Dogfood run log:** `docs/pre-ship/dogfood/onboarding-run-$(date +%Y-%m-%d).md` is recorded after a real operator executes the AF2 runbook on a fresh scaffold, with `aios status` exit 0 visible in the log.
- **All blockers resolved:** Every BLOCKER line in the dogfood log has a linked PR or Linear issue before epic close.
- **Epic self-evaluation:** `npm run aios -- spec eval docs/pre-ship/epic-agent-first-onboarding.md` exits 0.

## Builder vs operator closure

- **Builder delivers:** AF1–AF4 child PRs; all four child specs `SPEC_READY`; the four deliverables listed above.
- **Operator verifies:** one dogfood run logged; `validation/validate-all.sh .` exit 0 on fresh scaffold.

## Optional follow-up (not blocking this epic)

- aios-website Aside link to agent playbook — file separate Linear child if not merged with AF1 PR.

## Integration points

Existing files this epic touches or references (all resolve to real repo paths):

- `scripts/scaffold-project.sh`
- `scripts/aios.mjs`
- `validation/validate-all.sh`
- `scripts/brain-mcp.test.mjs`

## New files to create

- `docs/pre-ship/af1-agent-onboarding-contract.md`
- `docs/pre-ship/af2-onboarding-smoke-runbook.md`
- `docs/pre-ship/af3-workspace-naming-context.md`
- `docs/pre-ship/af4-mcp-byoa-quickstart.md`
- `docs/getting-started/agent-onboarding.md`
- `SKILL.md` — placed at repo root (`./SKILL.md`)
- `docs/pre-ship/dogfood/onboarding-run-*.md` (date-stamped, one per dogfood run)

## Deps

Deps: none — builds on shipped scaffold flow in `scripts/scaffold-project.sh` and `docs/GUIDE.md`
(Linear **AIO-195** tracks the same work; it is not a repo file path).

## Scope

**In scope:** child spec coordination, dogfood log, naming hints, MCP quickstart guide.
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