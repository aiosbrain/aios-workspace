## What & Why

<!-- One paragraph: what changed and why. -->

## Work item

<!-- Reference the brain task so aios-work-sync advances it to Done on merge (brain → Linear).
     No task yet, and this work should be tracked? Create one FIRST in the Team Brain dashboard
     (→ Tasks; it projects to Linear), then put its key here. Don't hand-edit the Linear issue —
     the brain is the source of truth, Linear is a one-way projection. -->
AIOS-Work: <!-- e.g. AIO-72 -->

## Checklist

- [ ] OGR validators pass: `validation/validate-all.sh examples/sample-workspace`
- [ ] Scaffold smoke test passes: `scripts/scaffold-project.sh --context consultant ...` + `validate-all.sh`
- [ ] Both `--context consultant` and `--context employee` still work if scaffold changed
- [ ] `docs/brain-api.md` version bumped if sync protocol changed
- [ ] Secrets validator passes: `validation/check-secrets.sh .`
- [ ] Leak gate passes: `scripts/leak-gate.sh`
- [ ] No secrets or admin-tier content in diff

## Bot review summary

<!-- After Bugbot + CodeRabbit post, paste a one-line summary of their findings here,
     or write "no blocking findings." Helps reviewers scan quickly. -->
