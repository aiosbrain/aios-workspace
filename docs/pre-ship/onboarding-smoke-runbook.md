# Onboarding smoke test runbook

Operator runbook for a **fresh agent session** + **fresh or dogfood identity**. Copy
[`dogfood/onboarding-run-TEMPLATE.md`](dogfood/onboarding-run-TEMPLATE.md) to a dated file
per run.

---

## Phase 0 — Prep

- [ ] Note handle `{handle}` and workspace path
- [ ] Brain admin issued `AIOS_API_KEY` (or self-serve path documented)
- [ ] Toolkit clone: `aios-workspace` on disk
- [ ] Agent gets only the marathon prompt from [`agent-onboarding.md`](../getting-started/agent-onboarding.md)

## Phase 1 — Agent handoff

- [ ] Paste marathon system prompt — **no extra coaching**
- [ ] Agent sets `{{WORKSPACE_PATH}}`, `{{AIOS_INVOKE}}`, `{{DATE}}`

## Phase 2 — Scaffold (new users only)

- [ ] `scripts/scaffold-project.sh --context employee --slug {handle}-workspace --owner {handle} …`
- [ ] Workspace contains `package.json` + `scripts/aios.mjs` shim

## Phase 3 — Validate

- [ ] `validation/validate-all.sh <workspace>` exit **0**

## Phase 4 — Brain

- [ ] `.env` has `AIOS_API_KEY`; `aios.yaml` has `brain_url` + `team_id`
- [ ] `npm run aios -- status` shows connected brain

## Phase 5 — Profile

- [ ] `npm run aios -- onboard` or GUI profile setup
- [ ] `0-context/` + `.claude/memory/USER.md` populated

## Phase 6 — Optional MCP

- [ ] Configure `aios mcp` for shell-less brain read
- [ ] One `brain_status` call succeeds

## Phase 7 — First push

- [ ] Create or pick one `access: team` file
- [ ] `npm run aios -- push --dry-run` then `push`
- [ ] `pull` + `query` verify on brain

## Phase 8 — Marathon debrief

- [ ] Every block A–I attempted (run, dry-run, or SKIP with reason)
- [ ] Journal complete with OK/FRICTION/BLOCKER rows
- [ ] Each BLOCKER → Linear issue or inline PR

---

## Pass/fail log columns

| Step | Command | OK / FRICTION / BLOCKER | Notes | Upstream fix? |

---

## Tier safety

Smoke push uses a synthetic team-tier stub in `2-work/` (e.g. `onboarding-smoke.md`).
No admin-tier or client NDA content in the public log. Delete test artifact after verify.
