# CQ4 — In-progress PR triage

Parent: Pre-release code quality epic. Owner: john@john-ellison.com

## Why

Open PRs blocking ship must be merged, closed, or waived.

## What

Create `docs/pre-ship/cq4-pr-triage-YYYY-MM-DD.md` listing every open PR with decision.

### Ship-blocking PR definition

A PR is **ship-blocking** if any of:

1. GitHub label `ship-blocker` is present, **or**
2. Referenced as required by an open pre-ship epic acceptance criterion, **or**
3. CI on `main` is red because of this PR's merge dependency.

Non-blocking PRs may be deferred with reason `post-ship-debt`.

## New files to create

- `docs/pre-ship/cq4-pr-triage-YYYY-MM-DD.md` — markdown table with columns:
  `PR #`, `title`, `blocking (yes/no)`, `decision (merge|close|waive|defer)`, `owner`, `notes`.

Populate from `gh pr list --state open --json number,title,labels`.

## Acceptance criteria

- Triage log lists all open PRs (one row per PR from `gh pr list --state open`).
- Zero ship-blocking PRs without a `decision` of merge, close, or waive (defer only for non-blocking).
- Named test below exits **0**.
- `npm run aios -- spec eval docs/pre-ship/cq4-pr-triage.md` exits **0**.

## Builder vs operator closure

- **Builder delivers:** triage log file committed.
- **Operator verifies:** ship-blocking PRs merged or waived per log.

## Integration points

- `.github/workflows/`
- `gh` CLI

## Deps

Depends on SEC4 (AIO-157) for ship-hardening PR.

## Scope

PR triage. Out of scope: new features.

## Build-with

Build-with: sonnet / low.

## Testability

Named acceptance test (`TRIAGE=docs/pre-ship/cq4-pr-triage-YYYY-MM-DD.md` with actual date):

```bash
TRIAGE=docs/pre-ship/cq4-pr-triage-$(date +%Y-%m-%d).md
test -f "$TRIAGE" && grep -qE '^\| [0-9]+ \|' "$TRIAGE"
```

Exit **0** proves triage log exists with at least one PR row. Cross-check row count against
`gh pr list --state open --json number | jq length` in operator review.
