## What & Why

<!-- One paragraph: what changed and why. -->

## Work item

<!-- Link this PR to a Plane item so aios-work-sync closes it on merge. -->
AIOS-Work: <!-- e.g. AIOS-123 -->

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
