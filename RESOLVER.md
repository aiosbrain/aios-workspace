---
resolver: v1
scope: aios-workspace
parent: ../RESOLVER.md
skills_roots: [.claude/skills]
fixtures: .claude/resolver-fixtures.yaml
---

# aios-workspace (toolkit) — Resolver

Canonical router for the **toolkit product repo** (not a personal workspace —
stamped workspaces get their own resolver from `scaffold/RESOLVER.md.tmpl`).
`CLAUDE.md` is the entrypoint; this file decides which skill, rule, or doc to
load. Gates always apply. Parent gates (AIOS hub, Tessera root) apply in
addition.

## Always-On Gates

| Trigger | Load |
|---|---|
| Any task that will create commits | Worktree REQUIRED (`aios worktree add feat/<task>`) — never branch in the primary checkout. (Stamped personal workspaces have the opposite rule) |
| Any change to product behavior | **Edit the template, not a stamped copy** — behavior lives in `scaffold/`; keep `scripts/toolkit-manifest.mjs` in lockstep with `scripts/scaffold-project.sh` |
| Any change to the sync protocol | Pinned contract `docs/brain-api.md` — versioned bump FIRST, matching brain change; clients must ignore unknown item kinds |
| Any tier/access language | `../docs/tier-vocabulary.md` (hub canonical) — the scaffold's self-contained copy is `scaffold/.claude/rules/frontmatter.md`; change both together |
| Scaffold/template change claimed done | `validation/validate-all.sh <workspace>` must pass for ALL THREE `--context consultant`, `--context employee`, and `--context business-owner` |
| Any spec or Linear issue body before build | `aios spec eval` must return SPEC_READY before `aios ship` (`docs/agent-build.md`) |
| Workflow-layer (operator loop) code | `docs/ENGINEERING-CONSTITUTION.md` — all-TypeScript, spec→plan→tasks→implement |
| Secrets anywhere | `validation/check-secrets.sh` + `scripts/leak-gate.sh` + team-ops-guard are hard gates; never weaken to pass a commit |
| Any harness change | Keep its rubric honest (`scaffold/.claude/rubrics/`) — the rubric is what makes output trustworthy |

## Functional Areas

| Trigger | Skill |
|---|---|
| Branches diverged / reconcile a fork | `.claude/skills/branch-reconciliation/SKILL.md` |
| "Will the demo build actually run" | `.claude/skills/demo-preflight-buildcheck/SKILL.md` |
| "Are these tests actually wired into CI" | `.claude/skills/test-ci-wiring-audit/SKILL.md` |
| Shipped workspace skills (16) — decision/scope/maturity/sync/review | `scaffold/.claude/skills/INDEX.md` (generated catalog; edit skills there, they propagate via `aios update`) |
| Unified Inbox domain (aios inbox CLI, journal, ranker, capability/reply-policy, Fly host, host ops) | Build contract: `docs/v1-operator-loop/domains/unified-inbox.md` (AIO-382/I-01). Orientation: `docs/v1-operator-loop/domains/unified-inbox-overview.md`. Host provisioning: `docs/v1-operator-loop/host/provisioning-runbook.md`. Data governance (retention/audit/redaction): `docs/v1-operator-loop/domains/inbox-governance/`. **Gate:** any change to inbox journal schema, tiers, or capability/reply-policy surfaces must respect the governance package + run `scripts/inbox-redaction-lint.mjs`. |

## Agent Roles

| Need | Agent |
|---|---|
| (never auto-selected) | `.claude/agents/code-reviewer.md` — pending retirement decision; plain diffs → built-in `code-review`, claim verification → `scaffold/.claude/skills/ai-code-review/SKILL.md` |

## Disambiguation — review/audit arbitration (route by artifact under review)

1. Implementation **plan** → `review-plan` (scaffold skill).
2. Plain local **diff/PR**, human- or AI-authored → built-in `code-review`.
3. Agent **wrap-up with checkable claims** ("CI green", "tests added", "mergeable") → `ai-code-review`.
4. **Linear status vs code footprint** ("is AIO-NN actually done") → `spec-status-reconciler` (hub skill, read-only).
5. **Pre-demo** → `demo-preflight-buildcheck`; add 4 if the demo makes status claims.
6. "Is this **test actually running**" / coverage trust → `test-ci-wiring-audit`.
7. **Decision-log governance** → `decision-audit` (scaffold harness).
8. **Deliverables vs scope baseline** → `scope-creep` (scaffold harness).
9. **Weekly digest** → `weekly-synthesis` (consumes 7/8 outputs; never re-derives them).
10. Most-specific scope wins; ties break project local > global > plugin > built-in.
