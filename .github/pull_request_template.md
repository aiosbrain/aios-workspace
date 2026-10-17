## What & Why

<!-- One paragraph: what changed and why. -->

## Work item

<!-- The issue this PR implements. On merge, aios-work-sync posts a "merged"
     event ONLY for the key selected by these rules (priority order):

     1. Explicit trailer below  →  highest priority, supports multiple keys
     2. Key in the branch name  →  strongest signal (set by `aios worktree add`)
     3. Key in the PR title     →  fallback

     Body mentions (context, "see also", "blocked by") do NOT close issues.
     To close multiple issues from one PR, add one trailer per issue.

     No task yet? Create one FIRST in the Team Brain dashboard (→ Tasks; it
     projects to Linear), then put its key here. Don't hand-edit Linear —
     the brain is the source of truth. -->
AIOS-Work: <!-- e.g. AIO-72 -->

## Checklist

- [ ] OGR validators pass: `validation/validate-all.sh examples/sample-workspace`
- [ ] Scaffold smoke test passes: `scripts/scaffold-project.sh --context consultant ...` + `validate-all.sh`
- [ ] Both `--context consultant` and `--context employee` still work if scaffold changed
- [ ] `docs/brain-api.md` version bumped if sync protocol changed
- [ ] Docs drift guard passes: `npm run check:docs`
- [ ] Secrets validator passes: `validation/check-secrets.sh .`
- [ ] Leak gate passes: `scripts/leak-gate.sh`
- [ ] No secrets or admin-tier content in diff
- [ ] At least one substantive current-head cloud Bugbot or CodeRabbit review has no unresolved findings (Local Bugbot is optional)
- [ ] If safety-sensitive or explicitly selected: `ready-for-review` is applied and current-head CodeRabbit evidence exists
- [ ] Safety-sensitive PRs use the operator merge gate (never `--auto-merge`)

## Review summary

<!-- Summarize current-head cloud Bugbot or CodeRabbit evidence, plus optional Local Bugbot /
     GPT-5.5 evidence when available. After a fix push, refresh the cloud review. -->
