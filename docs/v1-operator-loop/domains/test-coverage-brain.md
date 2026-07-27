# Domain spec — Test-coverage reporting to the brain (brain-api 1.13)

Governed by [`ENGINEERING-CONSTITUTION.md`](../../ENGINEERING-CONSTITUTION.md). Operator Loop
side-channel metric (issue **AIO-531**). **Contract first:** the plan sequences the
`docs/brain-api.md` document-revision **1.13** entry + JSON Schema before any producer code.

## Why
The brain already sees coverage at **codebase scope**: the merge-time scanner lane
(`.github/workflows/scan-on-merge.yml` lines 38–52, **unchanged** by this spec) generates coverage
and the scanner pushes `test_coverage_pct` via `POST /api/v1/codebases`. What's missing is the
**member-day** view — coverage inside a member's daily maturity aggregate, beside `context_health`.
This spec adds an optional `test_coverage` object to `POST /api/v1/metrics` (sibling of
`context_health`; document revision 1.13) plus the local producer and shadow card that feed it.
Normatively, `test_coverage.lines_pct` ≡ the codebases `test_coverage_pct` **in definition**
(total-lines pct of the merged coverage summary); they differ only in scope (member-day vs
codebase-commit), with `head_sha` as the join key between the two lanes.

## Delivery metadata
Build-with: **sonnet / medium** — this is the twice-shipped plumbing pattern (`ce_band`, then
`context_health` in revision 1.11): schema + zero-dep producer + non-axis shadow card +
scalars-only push, mirrored line-for-line. Dependencies: build starts after PR #412 (mutation-lane
calibration, AIO-523) merges; the matching brain-side 1.13 ingest is a separate `aios-team-brain`
change against the same schema. Rollout: **two sequential shadow-first PRs — each one PR, one
reviewable increment; anything beyond them is deferred** — PR1 contract + producer + card (nothing
leaves the machine), PR2 push wiring.

## Reuse (shipped, KEEP)
- `scripts/context-health.mjs` — the zero-dep Node ESM producer precedent this mirrors.
- `scripts/analyze/aem.mjs` — `attentionCard` + `contextHealthCard`, the two existing **non-axis**
  shadow cards; the new card reuses the contextHealthCard comment template (lines 329–336) verbatim.
- `scripts/analyze/report.mjs` — `contextHealthPushFields` (scalars-only derivation) and
  `buildPushPayload` (attach-if-truthy), the pattern PR2 mirrors.
- `scripts/analyze/index.mjs` — `gatherContextHealth` (lazy, fail-soft import) and `pushDays`
  (latest-day-only attachment).
- `coverage-baseline.json` — committed floors (`minimum.lines/statements/functions/branches`,
  `changedLines`) the card's `reading` is derived against.
- `test/item-payload-schema-parity.test.mjs` + `docs/contract/item-payload-1.12.schema.json` —
  the schema↔validator parity pattern (`verify-schema-validator-parity`) the new artifacts follow.

## Build (net-new)
- **New file** `scripts/coverage-report.mjs` — zero-dep Node ESM producer. Detection precedence:
  (1) a pre-normalized `coverage/coverage-report.json` already matching the schema — the
  pluggability escape hatch ANY stack (pytest-cov, tarpaulin, JaCoCo) satisfies with a tiny
  converter or by emitting lcov; (2) istanbul's `coverage/coverage-summary.json`; (3) a
  `coverage/lcov.info` parse (LF/LH, FNF/FNH, BRF/BRH). **No adapters directory until a second
  in-tree stack exists** — the schema + precedence order IS the seam; this is deliberate.
- **New files** `docs/contract/test-coverage-1.13.schema.json` +
  `docs/contract/test-coverage-1.13-fixtures.json` (valid + invalid cases). The **same schema
  governs the wire key AND the local artifact** (input 1 above).
- **New export** `testCoverageCard()` in `scripts/analyze/aem.mjs` — the THIRD non-axis shadow
  card; it never touches `AXIS_LABELS`/`scoreAxes`/`spineLevel`/`placement` (pinned baseline
  placement stays stable); `reading` compares against the `coverage-baseline.json` floors.
- **New plumbing (PR2)**: `gatherTestCoverage` (`scripts/analyze/index.mjs`, lazy fail-soft) →
  `testCoveragePushFields` (`scripts/analyze/report.mjs`, scalars only) → `buildPushPayload`
  attach-if-truthy → `pushDays` latest-day-only.

## Contract
Optional `test_coverage` object on `POST /api/v1/metrics` (document revision **1.13**), all
scalars, stack-agnostic — no paths, group names, or tool names cross the boundary:
- `lines_pct` (**required**), `statements_pct`, `functions_pct`, `branches_pct`,
  `changed_lines_pct`, `baseline_lines_pct` — percentages.
- `measured_at` (**required**, `YYYY-MM-DD`, UTC) · `head_sha` (join key to the codebase lane).
- `mutation_score_pct` + `mutation_measured_at` (required **iff** the score is present) — overall
  killed/total across the reports present under `reports/mutation/` (one JSON per group, written by
  `scripts/run-mutation.mjs`); staleness is **disclosed via the date, never filtered or carried
  forward**.

History lives brain-side (daily keyed pushes); there is **no local history file**. The feature
emits **no operator-loop signals**; a future coverage-drop tier-tagged signal (typed
`{kind, source, tier, occurredAt, ref, payload}` shape) is explicitly Deferred.

## Scope
**In:** 1.13 revision entry + schema/fixtures + parity test, producer, shadow card, push wiring.
**Deferred:** per-group anonymized mutation scalars (rejected default — overall only); brain-sidecar
convergence on the same schema (cross-repo); brain-side staleness display guidance; the
coverage-drop signal above.

## Tier safety
- `POST /api/v1/metrics` stays **team-tier-only** — external/admin keys get `403 forbidden_tier`;
  a payload whose `test_coverage` object fails the 1.13 schema is rejected `422` at the boundary
  (the same brain-side validation invariant as the 422-on-admin item boundary — never persisted).
- **Scalars-only** across the boundary (the fields in Contract are the entire privacy surface).
- **Default-deny:** the `test_coverage` key is attached only when a coverage artifact exists AND
  parses; **omitted ≠ null** — no artifact means no key, never a null placeholder.
- **Provenance-only:** the brain persists what the member pushed; it never recomputes coverage.

## Acceptance
- `docs/brain-api.md` header shows document revision **1.13** with a dated `test_coverage` revision
  entry, landing in the same commit as the schema and before any producer code (contract-first).
- After `npm run test:coverage`, `node scripts/coverage-report.mjs` prints one JSON object that
  validates against `docs/contract/test-coverage-1.13.schema.json`; with no coverage artifact it
  exits 0 and prints `null` (the default-deny observable).
- The new parity test accepts every valid fixture and rejects every invalid fixture in
  `docs/contract/test-coverage-1.13-fixtures.json` (same ajv harness as the 1.12 parity test).
- `aios analyze --json` shows a `test_coverage` card when an artifact exists, omits it otherwise,
  and the pinned-baseline `placement`/`spine` output is byte-identical either way.
- (PR2) the built push payload carries `test_coverage` on the latest day only, scalars only, key
  absent when no artifact resolves — asserted in `test/analyze.test.mjs`.

## Implementation
1. brain-api 1.13 revision entry + `test-coverage-1.13.schema.json` + fixtures + parity test.
2. `scripts/coverage-report.mjs` producer (precedence 1→2→3) + unit tests.
3. `testCoverageCard()` in `scripts/analyze/aem.mjs`, rendered by `scripts/analyze/report.mjs`
   (text + `toJson`). — end of PR1.
4. `gatherTestCoverage` + `testCoveragePushFields` + `buildPushPayload`/`pushDays` wiring +
   `test/analyze.test.mjs` coverage. — PR2, after the brain's 1.13 ingest ships.
