## What & Why

<!-- One paragraph: what changed and why. -->

## Work item

<!-- Reference the brain task so aios-work-sync advances it to Done on merge (brain → Linear).
     No task yet, and this work should be tracked? Create one FIRST in the Team Brain dashboard
     (→ Tasks; it projects to Linear), then put its key here. Don't hand-edit the Linear issue —
     the brain is the source of truth, Linear is a one-way projection.

     Include the Linear identifier (e.g. AIO-130) in this PR's TITLE or body: on open, the
     `PR → Linear In Review` workflow auto-moves that issue to In Review — you never do it by hand.
     Merge then advances it to Done via aios-work-sync. -->
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
- [ ] Exact-head Local Bugbot code + security review is clear
- [ ] If safety-sensitive or explicitly selected: `ready-for-review` is applied and current-head CodeRabbit evidence exists
- [ ] Safety-sensitive PRs use the operator merge gate (never `--auto-merge`)

## Review summary

<!-- Summarize Local Bugbot, GPT-5.5, and CodeRabbit when required. After a fix push,
     CodeRabbit must be refreshed with `@coderabbitai review`. -->
