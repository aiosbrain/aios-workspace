# Workflow policy (AIO-1135)

The static checker reads candidate YAML as data. It follows local reusable workflow calls and
workflow-run dependencies with the strongest reachable origin. Ordinary PR testing still executes
candidate code in unprivileged jobs. Privileged origins reject local step actions because recursive
composite execution analysis is outside this bounded checker.

Privileged checkout selectors, recognized acquisition commands, interpolated `run`/`with.script`
bodies, and action/reusable-workflow input mappings require proven-safe expression values. The
recognizer consumes a complete literal scalar or dot/literal-bracket path. Its trusted context fields
are `github.event.pull_request.base.sha`, `.base.ref`,
`github.event.repository.default_branch`, and `github.event_name`. Environment references resolve
through scope snapshots with shadowing and chains; missing definitions and cycles are unknown.

Functions, operators, computed indexing, matrix values, reconstructed contexts, opaque inputs and
outputs, incomplete parsing and unsupported syntax are unknown. Even a function over trusted values
is rejected. This is an explicit conservative policy rejection, not evidence that every rejected
expression is a working Actions exploit. Double-quoted bracket keys are recognized for compatibility
with the existing checker corpus; this does not assert that GitHub accepts every checker input.
Diagnostics distinguish known PR-controlled or secret references from values the checker cannot
prove safe. Case variants and whole contexts cannot evade enforcement.

Each PR-reachable job needs an explicit effective permissions declaration. Job permissions replace
workflow permissions; `{}` is valid. This declaration must appear on the job or its containing
workflow, including reusable workflow jobs. GitHub can restrict a callee's token through its caller;
this bounded policy still requires the callee to declare its own limit. Caller permission propagation
is not modeled. A rejection for a missing callee declaration is a policy requirement, not a claim
that GitHub grants that callee additional authority. Invalid declarations fail a separate policy-input rule.
Expression-valued permission levels are not demonstrated escalation paths: GitHub's
[workflow schema](https://raw.githubusercontent.com/actions/languageservices/main/workflow-parser/src/workflow-v1.0.json)
defines literal levels. Elevation remains independently rejected when effective permissions grant
checks/statuses write access.

The CLI exits 0 for compliant audits, 1 for policy violations and 2 for invalid directory/invocation
inputs. Missing, unreadable and non-directory workflow paths fail. Directories with no workflows
also fail unless a deliberate standalone audit supplies `--allow-empty`; that option still requires
an existing readable directory and explicitly reports zero workflows. CI must never supply it.

The bootstrap manifest ships the recognizer and all policy modules as managed files. Existing
repository-owned CI workflows remain create-only seeds and are never overwritten by bootstrap.

## Retained waivers

The preparation PR removed fifteen measured pinning waivers: CI jobs `changes`, `docs-drift`,
`context-health`, `constitution`, `guard`, `clean-container`, `lint`, `node-tests`, `coverage-shard`,
`coverage`, `pack-golden`, `publish-npm-parity`, `mutation`, `scrubbed-env-connectors`, and
`pr-review-evidence.yml` job `evidence`. Existing v7 tags resolved to their current commit SHAs;
the real audit confirmed all fifteen entries unused before removal.

Eight scoped, owner-documented entries remain in `scripts/workflow-policy-allowlist.json`:
three leak-gate entries; the CI scanner secret entry; three trusted-automation secret entries;
and the review-evidence workflow's status-write entry. Removing these depends on the separate
Security App and credential workstream. No new waiver is introduced by expression hardening.

## Verification

`test/check-workflow-policy-hardening.test.mjs` pairs rejected probes with trusted controls across
privileged channels, environment resolution, local calls, permissions and directory handling.
`test/workflow-policy-mutations.test.mjs` restores seventeen exact defects in disposable checker copies,
requires assertion failures for every mutant, and reruns the restored controls. The existing bypass
fixtures and slow-pipe test remain active; the latter still requires all 300 diagnostic records.

The boundary checker also prepares `--allow-stale` for trusted-base hygiene execution. Local runs
remain strict about unused waivers. When a candidate removes a coupling, a base-owned waiver may
legitimately be unused; this option reports it as a note while still rejecting new violations.
Without it, removing an old coupling and its waiver would have no passing migration path once CI
loads the rules from the base.
