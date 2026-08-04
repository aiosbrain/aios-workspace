# AIOS Code Maintenance Loop

**Status:** Phase 0 implementation boundary (AIO-610)

**North Star:** Background maintenance measurably reduces change risk, agent rework, reviewer
effort, and the cost of future development.

## Why this exists

AI-generated code increases output faster than teams can manually inspect accumulated
maintainability debt. AIOS already has two mature control loops:

1. the **Agentic Loop** guides and checks work while an agent edits;
2. the **CI Verification Loop** independently certifies a proposed change;
3. the **Code Maintenance Loop** must improve the already-merged codebase without weakening
   either of the first two loops.

Sonar's Agent Centric Development Cycle describes the same progression as Guide → Verify →
Solve across agent, CI, and maintenance loops. The useful operational lessons are independent
maker/checker roles, isolated remediation, bounded retries, PR back-pressure, human merge
authority, and a final scan of the merged branch. AIOS extends that model by making evidence
completeness and autonomy admission explicit: rerunning the detector that raised an issue proves
rule closure, not behavioral correctness.

## End-state control flow

```text
detectors → normalized finding ledger → risk/payoff ranking → autonomy admission
    → isolated executor → layered verification → capped PR queue → human review
    → merged-head rescan → rules/codemods/context improve
```

The three loops share one verification vocabulary. Maintenance workers do not define weaker
standards of their own.

## Phases

### Phase 0 — trustworthy evidence and ledger

- Distinguish observed health from evidence completeness and automation eligibility.
- Represent `complete | partial | missing | stale | error` explicitly.
- Keep the quality gate `unknown` unless every repository-required check is complete.
- Declare versioned per-repository capability profiles and baselines.
- Produce stable, redacted finding fingerprints shared by Workspace, Team Brain, CI, and future
  remediation workers.
- Persist snapshots in Team Brain without granting write or remediation authority.

### Phase 1 — report-only patrol

- Schedule daily or weekly scans.
- Deduplicate and age findings across merged heads.
- Rank debt by risk, reachability, churn, recurrence, agent friction, confidence, remediation
  cost, and review cost.
- Backtest rankings against historical changes and incidents.

### Phase 2 — low-risk remediation pilot

- Admit only deterministic, localized repair classes with complete evidence.
- Use disposable worktrees or containers, bounded retries, path/change budgets, and cost caps.
- Require exact-head CI and post-merge rescanning.
- Create PRs only; never write directly to the default branch or auto-merge.

### Phase 3 — evidence-based expansion

- Expand fix classes only after sufficient acceptance and escape evidence.
- Group fixes only when they form one coherent rollback unit.
- Promote recurring successful repairs into deterministic lint rules and codemods.

### Phase 4 — compounding feedback

- Feed maintenance outcomes into agent instructions, skills, architecture guidance, CI ratchets,
  repository profiles, and context augmentation.
- Reduce the proportion of debt that needs an LLM at all.

## Admission tiers

| Tier | Treatment | Examples |
|---|---|---|
| 0 | Report only | architecture, auth, migrations, public APIs, incomplete evidence |
| 1 | Agent-drafted mechanical PR | unused imports, deterministic lint, narrow dependency fixes |
| 2 | Sandboxed agent repair with targeted and regression verification | localized nullability, duplication, complexity with strong tests |
| 3 | Human-planned remediation | cross-domain refactors, schema changes, security semantics |

No tier auto-merges during the initial program.

## Required verification stack

1. The original finding is absent.
2. No equal-or-higher-severity finding is introduced.
3. Compile, format, lint, and type checks pass.
4. Targeted tests pass.
5. The required regression suite passes.
6. Coverage and mutation requirements pass where applicable.
7. Architecture, boundary, security, and invariant checks pass.
8. An independent semantic reviewer clears the change where required.
9. Exact-head CI passes.
10. A scan of merged `main` confirms closure.

## Program metrics

- New debt introduced per 1,000 changed lines.
- Verified debt removed per week and net debt flow.
- Age and SLA of high-risk findings.
- PR acceptance without modification and reviewer time consumed.
- Rollbacks, escaped regressions, false positives, and abandoned runs.
- Cost per merged fix and open remediation-PR saturation.
- Recurrence by issue class and percentage promoted into deterministic rules/codemods.
- Agent token use, failure rate, and rework in cleaned hotspots.

Raw issue count is not the North Star. The program succeeds only when future changes become safer
and cheaper.

## Phase 0 safety boundary

Phase 0 is read-only detection and contract work. It does not schedule agents, modify source in
the background, create remediation PRs, or merge. Missing/stale/error evidence produces an
`unknown` gate and `automation_eligible: false`. Findings contain metadata only; path-level and
source-level evidence remains local/admin-tier.
