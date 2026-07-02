# V1 - Verified Operator Loop (Milestone 1)

> Canonical V1 hub for the **Milestone 1 ("Solo loop magical")** build from
> [`docs/product-roadmap-three-milestones.md`](../product-roadmap-three-milestones.md).
> This page ties together specs, Linear, implementation surfaces, tests, dogfood evidence,
> docs drift checks, and public-release readiness for Linear epic **AIO-122**.
> Engineering approach is governed by [`docs/ENGINEERING-CONSTITUTION.md`](../ENGINEERING-CONSTITUTION.md).

Last reconciled with Linear/code: 2026-07-01.

## What V1 Is

V1 ships the **Verified Operator Loop**: a daily orientation and weekly closeout that
collect local work signals, preserve the private owner view, draft tier-safe shareable
artifacts, verify every shareable claim against evidence and tier policy, and promote
only explicitly approved output.

**Promise:** "AIOS helps me run my work. It knows what changed, what I decided, what is
blocked, what I owe next, and what is safe to share - and it proves its work."

The five workflow domains that feed the loop have their own specs under [`domains/`](./domains/).

## Component Status

The table below is the human-readable source for release planning. The
`drift:operator-components` block immediately after it is machine-checked against the C1-C8
spec files and Linear issue mapping by `npm run check:docs`; Linear state reconciliation is
checked by the optional `npm run check:v1-linear` release gate when credentials are available.

| # | Linear | Component | Spec | Status | Implementation / Evidence |
|---|---|---|---|---|---|
| C1 | AIO-123 | Source collector + run manifest | [c1-collector.md](./c1-collector.md) | done | `collect`, `DAILY`, `WEEKLY`; `aios loop collect`; `test/operator-loop/collector.test.mjs` |
| C2 | AIO-124 | Evidence ledger | [c2-evidence-ledger.md](./c2-evidence-ledger.md) | done | `assertGrounded`, `redactForTier`; `test/operator-loop/ledger.test.mjs` |
| C3 | AIO-125 | Verifier + rubric-gated correction | [c3-verifier.md](./c3-verifier.md) | done | `aios loop verify`; `test/operator-loop/verifier.test.mjs`; rubric `operator-loop-c3` |
| C4 | AIO-127 | Daily light loop | [c4-daily.md](./c4-daily.md) | done | C1 daily window plus daily orientation path; release dogfood still measures habit adoption |
| C5 | AIO-128 | Weekly closeout | [c5-weekly.md](./c5-weekly.md) | done | `aios loop weekly`; `test/operator-loop/closeout.test.mjs`; `test/operator-loop/weekly-cli.test.mjs`; rubric `operator-loop-c5` |
| C6 | AIO-129 | Approval-gated writeback | [c6-writeback.md](./c6-writeback.md) | done | `aios loop writeback`; `src/operator-loop/writeback.ts`; `test/operator-loop/writeback.test.mjs`; rubric `operator-loop-c6` |
| C7 | AIO-126 | Habit + continuity layer | [c7-habit.md](./c7-habit.md) | done | continuity action store + carry-over source; `test/operator-loop/carryover.test.mjs` |
| C8 | AIO-130 | Loop telemetry + dogfood instrumentation | [c8-telemetry.md](./c8-telemetry.md) | done | `aios loop telemetry`; `src/operator-loop/telemetry.ts`; `test/operator-loop/telemetry.test.mjs`, `telemetry-cli.test.mjs`, `telemetry-nonsync.test.mjs`; rubric `operator-loop-c8` |

<!-- drift:operator-components -->
- `C1|AIO-123|done|c1-collector.md`
- `C2|AIO-124|done|c2-evidence-ledger.md`
- `C3|AIO-125|done|c3-verifier.md`
- `C4|AIO-127|done|c4-daily.md`
- `C5|AIO-128|done|c5-weekly.md`
- `C6|AIO-129|done|c6-writeback.md`
- `C7|AIO-126|done|c7-habit.md`
- `C8|AIO-130|done|c8-telemetry.md`
<!-- /drift:operator-components -->

## Drift-Guarded Surfaces

These inventories are deliberately structural, not prose. `scripts/check-docs-drift.mjs`
derives them from code and compares them with the marker blocks below. If a command,
MCP tool, source, rubric, or C1-C8 spec changes, update the relevant block in the same PR.

### Loop CLI

<!-- drift:loop-commands -->
- `aios loop collect`
- `aios loop daily`
- `aios loop manifest --explain`
- `aios loop verify`
- `aios loop weekly`
- `aios loop writeback`
- `aios loop telemetry`
<!-- /drift:loop-commands -->

### MCP Tool Surface

<!-- drift:mcp-tools -->
- `brain_status`
- `brain_query`
- `brain_list_projects`
- `brain_list_tasks`
- `brain_list_decisions`
- `brain_pull_items`
- `brain_get_item`
- `aios_loop_collect`
<!-- /drift:mcp-tools -->

### Collector Sources

<!-- drift:loop-sources -->
- `decision`
- `task`
- `hours`
- `deliverable`
- `inbox`
- `carryover`
- `github`
- `time`
- `comms`
<!-- /drift:loop-sources -->

`github` is registered as a deferred local source and emits nothing until a local GitHub
activity source exists. This is intentional: the weekly source set can include the kind
without breaking local runs.

### Operator Rubrics

<!-- drift:operator-rubrics -->
- `operator-loop-c1c2`
- `operator-loop-c3`
- `operator-loop-c5`
- `operator-loop-c6`
- `operator-loop-c8`
<!-- /drift:operator-rubrics -->

## Two Cadences

| Cadence | Weight | Job | What it pulls |
|---|---|---|---|
| Daily | Lightweight, low-friction, fast | Keep the owner oriented and build the ritual | Only essential context: what changed, what is blocked, what is owed today |
| Weekly | Heavy, verified, approval-gated | Close the week with proof | Full collect across the week -> private brief + tier-safe digest -> verifier -> approval-gated writeback |

Daily reduces the friction of the weekly. By Friday, carry-over items have already surfaced,
so the weekly closeout is assembly rather than archaeology.

## Cross-Cutting Constraints

- **Runs from CLI and cockpit against the same core.** The CLI is the current canonical flow:
  `collect`, `manifest --explain`, `verify`, `weekly`, and `writeback`. MCP currently exposes
  `aios_loop_collect`; broader cockpit parity remains a release-readiness gap, not an implicit promise.
- **Tier policy is the safety boundary.** No admin/private content reaches a shareable digest or
  brain sync. Default-deny on missing `access:`.
- **Verification is the value.** Every shareable claim is backed by an evidence reference and
  verifier status is visible before approval.
- **Writeback is explicit.** C6 stages local files and task rows only under `--local`, `--sync`,
  and/or `--pm`; network egress remains the user's later `aios push`.

## E2E Dogfood Plan

Run this path before calling V1 release-ready:

1. Scaffold a clean synthetic workspace and validate it.
   - `scripts/scaffold-project.sh --context consultant ...`
   - `validation/validate-all.sh <workspace>`
2. Seed realistic local evidence across `3-log/tasks.md`, `3-log/decision-log.md`, `3-log/hours.md`,
   `2-work/`, `4-shared/`, and `.aios/loop/continuity/actions.json`.
3. Run the local loop substrate.
   - `npm run build:loop`
   - `node scripts/aios.mjs loop collect --daily --repo <workspace>`
   - `node scripts/aios.mjs loop collect --weekly --repo <workspace>`
   - `node scripts/aios.mjs loop manifest --explain --as team --repo <workspace>`
4. Run the verified weekly closeout.
   - `node scripts/aios.mjs loop weekly --repo <workspace>`
   - Inspect `.aios/loop/closeouts/<stamp>/brief.md`, `digest-team.md`, `verifier-team.json`,
     `manifest.json`, and `next-week-actions.json`.
5. Preview and approve writeback by target.
   - `node scripts/aios.mjs loop writeback <stamp> --repo <workspace>`
   - `node scripts/aios.mjs loop writeback <stamp> --local --sync --pm --repo <workspace>`
   - Confirm admin content lands only in local/admin-tier destinations and syncable rows/files are tier-safe.
6. Sync only after review.
   - `node scripts/aios.mjs status --repo <workspace>`
   - `node scripts/aios.mjs push --dry-run --repo <workspace>`
   - Live `aios push` belongs to the dogfood run owner because it moves data to the Team Brain.
7. Record dogfood evidence for C8.
   - Weekly wall-clock time.
   - Verifier `pass` / `corrected` / `failed`.
   - Leak-withheld count and any non-shippable digest.
   - Next-week action count and acceptance.
   - Daily run frequency.

## Exit Criteria

All must hold before V1 can be called done:

- Three consecutive dogfood weekly runs per active user with zero admin/private-tier leaks.
- Daily loop run on the majority of working days across the dogfood window.
- Median weekly closeout under 20 minutes after setup.
- Shareable digest passes must-pass verifier criteria in at least 90% of accepted runs.
- At least 70% of accepted weekly runs produce approved next-week actions.
- Loop runnable from CLI and cockpit against the same plan/review/approve model, or the release
  notes explicitly scope cockpit parity out of the public claim.
- `npm run check:docs` passes.
- `npm run check:v1-linear` passes when Linear credentials are available, or records an intentional skip.

## Release Gates

- Workspace guard suite: `npm run check:docs`, `npm run build:loop`, and `node --test test/operator-loop/*.test.mjs`.
- Full repo gate: `npm test` before merge/release.
- Public-release gate: [`RELEASE-CHECKLIST.md`](../RELEASE-CHECKLIST.md), including strategy-doc removal,
  leak/secret scans, CI, and website doc synchronization.
- Cross-repo docs gate: the website must not document V1 as shipped until this hub is release-ready
  and the release process confirms workspace/website docs are aligned.

## Out Of Scope For V1

Team Brain aggregation of weekly artifacts (M2), harness registry/catalog plus eval telemetry (M3),
and the platform "organs" track (context engine, policy engine, action layer, feedback loop) reuse
V1 artifacts but do not gate this milestone.
