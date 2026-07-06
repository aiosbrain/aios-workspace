# AIOS onboarding marathon — 2026-07-06

**Handle:** john  
**Workspace:** `/Users/iamjohndass/Projects/john-workspace`  
**Agent runtime:** Cursor / Claude  
**Brain URL:** `https://aios-team-brain-production.up.railway.app`

## Summary

| Metric | Value |
|--------|-------|
| Commands attempted | 60+ (all blocks A–I) |
| First push | **yes** — 5 items pushed |
| validate-all | not re-run (pre-existing workspace) |
| Blockers | 2 fixed upstream (council-models); 4 filed as Linear |

## Run log

| Step | Command | Result | Notes | Upstream fix? |
|------|---------|--------|-------|---------------|
| 0 | package.json + scripts/aios.mjs shim | OK | Added locally; scaffold template in PR | yes |
| 0 | status | OK | new 3, modified 2, blocked 61 | teach one promotion |
| 0 | asks drain | OK | Cleared 2 stale blockers | |
| A | loop daily | OK | Changed 0 after drain; 93 excluded | |
| A | mode deep-work / orchestration | OK | Ping toggle works | |
| A | asks list/add/show/resolve | OK | | |
| A | loop daily --as team | OK | Hides Attention section | |
| B | push --dry-run | OK | 5 items eligible | |
| B | push | OK | 5/5 pushed to Railway brain | |
| B | pull | OK | Many items → 1-inbox/from-brain/ | |
| B | query GTM OKRs | OK | Grounded answer with [S2] citation | |
| B | stakeholders --meeting today | OK | No meeting (expected) | |
| B | work done test-key | FRICTION | No --dry-run flag; key not in tasks.md | doc |
| B | push skill --dry-run | OK | aios-sync skill | |
| B | push blueprint --dry-run | FRICTION | No team-blueprint.json | expected |
| C | loop collect --daily/weekly | OK | Manifests written | |
| C | loop manifest --explain --daily | OK | 93 default-deny explained | |
| C | loop weekly --dry-run | OK | PASS · NOT SHIPPABLE (offline) | |
| C | loop verify --smoke | OK | PASS 412 claims | |
| C | loop writeback | FRICTION | Needs closeout from loop weekly first | doc |
| C | loop telemetry | OK | Daily frequency NOT MET (2/11 days) | |
| D | analyze --since 7d | OK | Spine L4, CE orchestration-heavy | |
| D | analyze --report | BLOCKER→FIX | council-models.mjs syntax error | fixed in PR |
| D | analyze --calibrate | OK | HOLD verdict after fix | |
| D | maturity-week | FRICTION | No sessions.ndjson yet | expected |
| D | time report | FRICTION | No capture run yet | expected |
| D | instincts distill --dry-run | OK | 0 observations | |
| E | decisions list/export | OK | 3 steering decisions | |
| E | decisions backfill --dry-run | OK | 78 would append | |
| E | asks harvest --cadence d | FRICTION | Must use `daily` not `d` | doc or alias |
| E | asks wire --dry-run | OK | Already wired | |
| F | export-okf | OK | External tier bundle | |
| F | graph | OK | 3 nodes, 0 broken links | |
| F | assess-codebase | OK | L1 Functional 38.89% | |
| F | rails missing/suggest/apply --dry-run | OK | 6 absent rails listed | |
| F | learn | OK | L4, weakest learning axis | |
| G | skills (bare) | FRICTION | Errors — only `skills export` exists | doc/help |
| G | skills export claude-code | OK | 8 skills exported | |
| G | pull skill aios-sync --dry-run | FRICTION | Not on brain yet | expected |
| G | install-skill --dry-run | FRICTION | Needs pulled skill first | expected |
| G | connect | OK | Lists integrations; granola wired | |
| G | onboard | OK | Prints guided setup header | |
| H | spec eval | FRICTION | spec-readiness rubric missing in IC scaffold | scaffold gap |
| H | relay --dry-run | OK | Plan loop starts | |
| H | build --dry-run | OK | Worktree path shown | |
| H | pr --dry-run | FRICTION | Needs --issue AIO-n | expected |
| H | ship --dry-run | OK | 10-stage plan printed | |
| H | roadmap-run --dry-run | FRICTION | LINEAR_API_KEY unset | env |
| H | consolidate-findings | FRICTION | Missing .claude/agents/code-reviewer.md | scaffold gap |
| I | timeline --dry-run | OK | 1 merged PR, 17 commits | |
| I | council | OK | OpenRouter egress; 3 models queried | |
| I | pull-bundle | OK | 14 nodes | |
| I | pull deliverable | OK | gtm-okr pulled on demand | |

## Blockers → Linear

| ID | Title | Issue |
|----|-------|-------|
| O7 | council-models.mjs syntax corruption | AIO-295 (fixed in this PR) |
| O8 | IC scaffold missing spec-readiness rubric | AIO-292 |
| O9 | IC scaffold missing capture hooks | AIO-293 |
| O10 | consolidate-findings needs code-reviewer agent | AIO-294 |

## Recommended upstream PRs

1. **feat/onboarding-marathon-dogfood** — agent-onboarding.md, smoke runbook, scaffold CLI shim, council-models fix
2. Ship spec-readiness rubric + code-reviewer agent in scaffold (O8/O10)
3. Wire asks-capture + decision-capture hooks in scaffold settings.json (O9)
