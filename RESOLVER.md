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
| Reading or writing the AIOS Linear board (AIO-nnn issues) from this repo, or from any sibling repo under `~/Projects/aios/` that has no Linear tooling of its own | `.claude/skills/aios-linear/SKILL.md` — the canonical, maintained CLI (`.claude/skills/aios-linear/linear.mjs`), run with `dotenvx run --quiet -f .env -- node .claude/skills/aios-linear/linear.mjs <cmd>` from this repo's root (`LINEAR_API_KEY` lives in this repo's own `.env`). From a sibling repo without its own copy, point `-f`/the script path at this checkout instead of improvising GraphQL or reaching for the retired Plane MCP. `scaffold/.claude/skills/aios-linear/` is the same content vendored into every scaffolded AIOS workspace via `aios update` — fix bugs/add commands in ONE place and let it propagate; never hand-patch a local fork |
| Workflow-layer (operator loop) code | `docs/ENGINEERING-CONSTITUTION.md` — all-TypeScript, spec→plan→tasks→implement |
| Secrets anywhere | `validation/check-secrets.sh` + `scripts/leak-gate.sh` + team-ops-guard are hard gates; never weaken to pass a commit |
| Any harness change | Keep its rubric honest (`scaffold/.claude/rubrics/`) — the rubric is what makes output trustworthy |
| Merging any PR in this repo | `docs/pr-review-evidence.md` — the `review-evidence` status must be green: something on the PR, posted by someone with write access, names the **current** head SHA. A push makes everything prior stale, on purpose. An exemption is the same binding with a different token (`REVIEW_EXEMPT`), so it cannot go stale either |
| Any change to `scripts/review-evidence.mjs` | It is a recorded copy of the hub's `scripts/validate-adversarial-review.mjs`. Port the change both ways by hand — `npm run check:review-evidence-parity -- --hub <hub checkout>` is a spot check that catches one copy moving, **not** drift protection (it never runs in CI and cannot see a defect both copies share). Read the threat model in that file's header before assuming the gate stops forged evidence: it does not, by design |
| Any `packages/foundation/` change, or GUI work (now in `aiosbrain/aios-workspace-gui`) | Repo topology (below) + seam contract `docs/gui-toolkit-contract.md`; `npm run check:boundaries` enforces the seams |

## Repo Topology (multi-repo split, AIO-597 — in transition)

Referenced by `scripts/check-boundaries.mjs`; the fuller table is `CLAUDE.md` §2c.

- **Core toolkit** — this repo. Authoritative.
- **`@aiosbrain/foundation`** — `packages/foundation/` (npm workspace), **published to
  npm** (public, 0.1.0). Hubs: runtimes, workspace-parse, brain-config, linear-client,
  brain-client, git-files, constitution. `scripts/` paths are one-line re-export shims.
- **GUI** — cut (filtered history, freeze `cut/gui-freeze` = `d6dcdeb`) to
  `github.com/aiosbrain/aios-workspace-gui`. **`gui/` + `src-tauri/` are DELETED from this
  repo (AIO-612); that repo is the only copy.** Toolkit location:
  `--toolkit-dir` → `AIOS_TOOLKIT_DIR` → actionable error. The pre-split relative fallback
  (`gui/server/../../`) can no longer reach a toolkit, so one of the two must be set.
- **Desktop (Tauri)** — adjacent-checkout mode only; **do-not-demo** for v0.9.0;
  bundling = AIO-581 (GUI repo).
- **Devtools** (`aiosbrain/aios-devtools`) — **cut and removed** (AIO-662). `ship`, `build`,
  `roadmap-run`, `spec-eval`, `spec-publish`, `consolidate-findings` no longer live here. Core
  dispatches via `scripts/devtools-dispatch.mjs`; `@aiosbrain/aios-devtools` is a dependency, so
  the commands still work on a plain install. Changing one of them means a PR in that repo.

## Functional Areas

| Trigger | Skill |
|---|---|
| Branches diverged / reconcile a fork | `.claude/skills/branch-reconciliation/SKILL.md` |
| "Will the demo build actually run" | `.claude/skills/demo-preflight-buildcheck/SKILL.md` |
| "Are these tests actually wired into CI" | `.claude/skills/test-ci-wiring-audit/SKILL.md` |
| What skills are used or missed / audit skill routing or diversity / compound session learnings | `.claude/skills/evolve/SKILL.md` |
| Shipped workspace skills (19) — decision/scope/maturity/sync/review | `scaffold/.claude/skills/INDEX.md` (generated catalog; edit skills there, they propagate via `aios update`) |
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
