# Report-only debt patrol operations

**Issue:** AIO-787

**Owner:** AIOS Workspace managed workflow

**Contract:** `docs/contract/debt-patrol-report-v1.schema.json`

**Policy:** `config/debt-patrol.v1.json`

## Boundary

The Phase 1 patrol reads exact merged heads for the explicitly listed Workspace and Team Brain
repositories. It computes the existing redacted codebase-health v2 object and sends the existing
full `POST /api/v1/codebases` payload to Team Brain. The Team Brain wire contract is unchanged.

The workflow cannot modify source, create issues or pull requests, call Linear, or merge. Its only
writes are the existing Team Brain metrics ingestion and GitHub Actions report artifacts. Manual
and onboarding-style invocations are provisional and never satisfy calibration or automatic-filing
eligibility.

## Activation and pause

The committed targets are opted in individually, but the producer defaults stopped until both
repository variables have exact values:

| Variable | Required value | Any other value |
|---|---:|---|
| `AIOS_DEBT_PATROL_ENABLED` | `1` | `producer_opt_in_missing` |
| `AIOS_DEBT_PATROL_PAUSED` | `0` | `producer_pause_not_explicitly_disabled` |

This two-switch rule makes absence fail closed and leaves a one-variable emergency pause. Change
variables only after AIO-785 and AIO-786 are merged, the stacked consumer is reverified on main,
and the AIO-787 pull request is current-head green. Pausing does not delete artifacts or ledger
history.

## Cadence and budgets

- Workspace: daily Monday–Saturday at 03:17 UTC, 30-minute budget.
- Team Brain: weekly Sunday at 03:17 UTC, 30-minute budget.
- Both targets stop when observed open pull requests exceed 12.
- Manual dispatch can select either repository or both, but every manual artifact is provisional.

Cron strings are declared in policy data and repeated in the workflow `on: schedule` block, which
GitHub Actions requires. A test asserts the two copies match byte-for-byte, so a schedule change
must edit both files.
Budget, target opt-in, coverage command, default branch, and open-PR cap are closed validated
fields. Invalid or unknown configuration prevents plan creation.

## Exact-head sequence

1. Resolve the repository default branch, exact 40-character commit SHA, and open-PR count through
   the read-only GitHub API.
2. Checkout the target detached at that SHA with credentials disabled.
3. Generate coverage evidence and the redacted codebase-health v2 contract object.
4. Resolve the remote default branch again and compare it with the planned SHA.
5. Check elapsed time against the target budget.
6. Upload only if the default branch has not moved, the budget remains, and the analyzer and
   health object both match the planned SHA.
7. Preserve the redacted report with a unique run/attempt/target/SHA artifact name and overwrite
   disabled.

A branch that advances during analysis produces a stopped artifact with
`moving_head_detected`; its evidence is not uploaded and cannot count toward calibration. A later
scheduled run analyzes the new head.

## Artifact interpretation

The plan artifact records every target decision, including targets stopped before checkout. A
per-target report contains only:

- repository identity, exact SHAs, schedule/provisional state, and policy reason codes;
- rubric/profile versions and aggregate evidence state;
- normalized finding fingerprints and bounded categorical metadata;
- delivery status and explicit false writer capabilities.

It contains no file paths, source text, diagnostics, contributor identity, secrets, or raw scan
payload. `finding_set_fingerprint` is stable for the same sorted fingerprint set. The overall
`report_fingerprint` covers the immutable report, including run metadata.

A report is calibration-eligible only when all of these hold:

- trigger is scheduled, not manual;
- policy decision is `run`;
- exact head revalidation succeeds;
- health SHA equals the resolved target SHA;
- evidence status is `complete`;
- Team Brain delivery succeeds.

`automatic_filing_eligible` remains false in every Phase 1 artifact regardless of the scanner's
historical `automation_eligible` health field.

## Stop drills

The unit suite exercises opt-in missing, pause engaged, target disabled, unknown/mismatched
schedule, invalid budget, branch mismatch, unavailable head, open-PR-cap breach, moving head,
budget exhaustion, missing health, and failed delivery. Run the focused evidence with:

```bash
node --test \
  test/debt-patrol-policy.test.mjs \
  test/debt-patrol-report.test.mjs \
  test/debt-patrol-workflow.test.mjs
```

For an operational pause drill, set `AIOS_DEBT_PATROL_PAUSED=1`, dispatch the workflow, verify the
plan artifact contains `producer_pause_not_explicitly_disabled` and no target job, then restore
the variable to `0`. Do not use a manual artifact as one of the four trusted cycles.

## Recovery

- Moving head: allow the next scheduled run to resolve the new commit; never reuse the stale
  artifact.
- Budget exceeded: keep the stopped artifact, inspect which evidence producer consumed the
  budget, and change policy only through a reviewed versioned configuration change.
- Team Brain unavailable: keep the failed-delivery artifact and retry through a later scheduled
  run; do not fall back to a sparse or health-less upload.
- Suspected sensitive artifact: pause immediately, restrict/delete the GitHub artifact under the
  incident process, and treat the redaction contract as a security defect.

Phase 2 remains blocked until AIO-788 preserves four trusted scheduled cycles for every opted-in
repository and records an explicit admit, narrow, continue-report-only, or stop decision.
