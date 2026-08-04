# Domain spec — Codebase health: composed structural scorer + brain reporting (AIO-604)

Governed by [`ENGINEERING-CONSTITUTION.md`](../../ENGINEERING-CONSTITUTION.md). Multi-repo-split
sprint, Wave 2 (epic **AIO-594**, issue **AIO-604**; folds in the unshipped **AIO-531**
coverage-report producer as a prerequisite). **Contract first:** the rubric JSON + CLI JSON v1
shape land before any scorer code.

## Why

**Codebase health = structural maintainability + invariant compliance of the code itself** — one
0–100 score, per-axis bands, and the exact deterministic evidence behind them. The repo already
measures pieces of this in six separate gates, but there is no single composed reading, no
committed baseline to compare a PR against, and nothing the brain can chart per codebase.

Two adjacent scorers already exist; this is deliberately **neither**, and the boundary is sharp:

- **Agent-readiness** (`validation/agent-readiness.rubric.json`, scored by
  `validation/check-agent-readiness.mjs` / OGR10) asks *"is this repo an environment an agent can
  work in?"* — binary file-existence + config-parse signals (README, test runner, guardrails)
  rolled into L1–L5 levels. It measures the **scaffolding around the code**, never the code's
  structural quality: a repo full of 3,000-line tangled files can be fully L3 agent-ready.
- **Context-health** (`scripts/context-health.mjs`, `aios context-health`) scores the
  **agent-facing document layer** — CLAUDE.md/RESOLVER.md coverage, tier frontmatter, decision-log
  recency, toolkit-sync staleness. It reads docs and governance state, not source structure.
- **Codebase-health** (this spec) scores the **code**: module size and coupling, seam and domain
  isolation, test rigor, lint/type debt, docs↔code drift, invariant compliance, and inherited
  ratchet debt.

**The scorer COMPOSES the existing deterministic gates — a third competing implementation is the
rejected default.** It invokes (or reads the machine output of) `scripts/check-file-size.mjs`,
`scripts/check-boundaries.mjs`, `scripts/check-domain-isolation.mjs`, the coverage floors in
`coverage-baseline.json` via the normalized coverage artifact, the calibrated mutation floors of
`scripts/run-mutation.mjs` (reports under `reports/mutation/`), the eslint warning count
(`npm run lint`, `eslint.config.mjs`), the strict TS build (`npm run build:loop`),
`scripts/check-docs-drift.mjs`, and `validation/check-modularity.mjs` (against
`validation/modularity-baseline.json` + `validation/modularity.config.json`). It re-implements
**none** of their logic — every axis is an aggregation over check results that already exist and
already run.

**Revision-number note (resolves the AIO-531 ambiguity):** the unshipped AIO-531 spec
(`docs/v1-operator-loop/domains/test-coverage-brain.md`) claims document revision 1.13, but
`docs/brain-api.md` has since shipped 1.14. Folding the producer in here fixes the rule: each
brain-api change takes the **next free revision number at its own merge time** — the AIO-608
`codebase_health` revision is nominally **1.15**, and AIO-531's `test_coverage` metrics key (not
folded here) renumbers likewise whenever it ships. The producer's local artifact is
revision-agnostic: consumers read the artifact path + schema, never a revision constant.

## Delivery metadata

Build-with: **sonnet / medium** — composition plumbing over shipped gates, mirroring the
`context_health` pattern (producer + non-axis shadow card + scalars-only push) plus the
rubric-as-data pattern already proven by `validation/agent-readiness.rubric.json`. Dependencies:
**AIO-531 producer is folded in as step 1** (prerequisite, built here); **AIO-598** (ts-eslint
lane, in flight) sharpens the `lint_type` axis but the axis works today off `npm run lint` +
`npm run build:loop`; **AIO-607** (invariant registry, in flight) upgrades the `invariants` axis
input — until it lands the axis reads the gate list enumerated in the rubric JSON (see Contract);
**AIO-608** (brain-api 1.15, in flight) governs the push, which stays **OFF** until the brain
ingest is verified. Rollout: **three sequential shadow-first PRs — each increment is one PR, one
reviewable increment; anything beyond them is deferred to a sibling spec** — PR1 producer +
rubric + scorer + CLI (read-only, nothing leaves the machine), PR2 analyze card + advisory CI vs
committed baseline, PR3 push wiring (default-off). Operator-loop source + weekly monitor agent are **follow-on work, AIO-610** — out
of scope here by design (epic sacrifice-list #1).

## Reuse (shipped, KEEP)

- `scripts/check-file-size.mjs` + `scripts/size-caps.json` — default-deny size gate with the
  ratchet-only-down `grandfathered` ceiling list (feeds `modularity` + `contributor_friction`).
- `scripts/check-boundaries.mjs` + `scripts/boundaries.json` — repo-seam import rules R1–R5 with
  measured grandfathered couplings (feeds `boundaries` + `contributor_friction`).
- `scripts/check-domain-isolation.mjs` — Constitution §4 peer-domain value-import guard (feeds
  `boundaries`).
- `validation/check-modularity.mjs` + `validation/modularity-baseline.json` +
  `validation/modularity.config.json` — OGR13 advisory architecture metrics; its
  advisory-then-ratchet ("observe first, then lock") pattern is exactly the CI posture PR2 copies.
- `coverage-baseline.json` + `scripts/check-coverage.mjs` — committed coverage floors and the
  existing floor-enforcement semantics (feeds `test_rigor`).
- `scripts/run-mutation.mjs` — per-group calibrated mutation break floors; group reports under
  `reports/mutation/` (feeds `test_rigor`; staleness disclosed via report dates, never filtered).
- `scripts/check-docs-drift.mjs` — docs↔code drift check (feeds `docs_parity`).
- `eslint.config.mjs` + `package.json` `lint` / `build:loop` scripts (feeds `lint_type`).
- `validation/agent-readiness.rubric.json` + `validation/agent-readiness-lib.mjs` — the
  rubric-as-data conventions (`id`/`version`/`title`/`description` header, machine-readable
  criteria, thresholds in data) the new rubric follows.
- `scripts/context-health.mjs` — the `computeX(repoPath)` / `renderX` / `runXCli(repo, args)`
  export shape and `--json` behavior the scorer mirrors.
- `scripts/cli/registry.mjs` + `scripts/cli/usage.mjs` + `test/cli-registry.test.mjs` — the
  declarative command table (lazy `loader`, `resolution: "offline"`, usage lines) that lets a new
  subcommand ship with **zero lines added to `scripts/aios.mjs`** (pinned at its 2354-line
  grandfathered size-cap ceiling in `scripts/size-caps.json`).
- `scripts/analyze/aem.mjs` (`attentionCard` + `contextHealthCard`, the non-axis shadow-card
  pattern), `scripts/analyze/report.mjs`, `scripts/analyze/index.mjs` (lazy fail-soft `gatherX`,
  scalars-only push-field derivation) — the card + push plumbing PR2/PR3 mirror.
- `.github/workflows/ci.yml` (advisory-step host) and `.github/workflows/scan-on-merge.yml`
  (the metrics-source, never-a-gate lane the push rides).
- `docs/brain-api.md` — the pinned contract; the 1.15 `codebase_health` object is specced there
  by AIO-608, not here.

## Build (net-new)

- **New file** `scripts/coverage-report.mjs` — the **folded AIO-531 producer**, built exactly per
  `docs/v1-operator-loop/domains/test-coverage-brain.md` §Build: zero-dep Node ESM, detection
  precedence (1) pre-normalized `coverage/coverage-report.json`, (2) istanbul
  `coverage/coverage-summary.json`, (3) `coverage/lcov.info` parse; prints one normalized JSON
  object, `null` + exit 0 when no artifact exists. **Both features read this ONE normalized
  artifact** — the `test_rigor` axis consumes the producer's output; the scorer contains **no
  second coverage/lcov parser**. (AIO-531's member-day `POST /api/v1/metrics` key and shadow card
  are *not* folded in — they remain AIO-531's own scope, renumbered per the note above.)
- **New file** `validation/codebase-health.rubric.json` — rubric-as-data, following the
  `agent-readiness.rubric.json` conventions (`id: "aios.codebase-health"`, `version`, axis list,
  machine-readable criteria). **Seven axes**: `modularity`, `boundaries`, `test_rigor`,
  `lint_type`, `docs_parity`, `invariants`, `contributor_friction`. Each axis defines **0–4
  bands** whose numeric thresholds live **in the JSON, never in scorer code** — changing a band
  edge is a data PR with no code change. Axis weights and the `status` cut-points
  (`healthy`/`degraded`/`critical`) are also rubric data. The `invariants` axis enumerates, by
  id, the deterministic gates that must pass (initially the shipped gate set above; when AIO-607's
  invariant registry lands, the axis input switches to the registry in a rubric `version` bump).
- **New file** `scripts/codebase-health.mjs` — the composed, **read-only** scorer:
  `computeCodebaseHealth(repoPath, opts)`, `renderCodebaseHealth(result, target, colors)`,
  `runCodebaseHealthCli(repo, args, colors)` (mirrors `scripts/context-health.mjs`). It shells or
  imports the reused gates, maps their scalar outputs onto the rubric bands, and never mutates the
  tree, baselines, or git state. Text mode may print local evidence (file:line) for the human;
  `--json` emits the redacted v1 object only (see Contract).
- **New descriptor** in `scripts/cli/registry.mjs` (+ usage lines in `scripts/cli/usage.mjs`):
  `name: "codebase-health"`, `resolution: "offline"`, lazy
  `loader: () => import("../codebase-health.mjs")` — **zero lines added to `scripts/aios.mjs`**;
  `test/cli-registry.test.mjs` parity keeps holding.
- **New export (PR2)** `codebaseHealthCard()` in `scripts/analyze/aem.mjs` — a non-axis shadow
  card beside `contextHealthCard`; never touches `AXIS_LABELS`/`scoreAxes`/`spineLevel`/
  `placement` (pinned baseline placement stays byte-stable); rendered by
  `scripts/analyze/report.mjs` via a lazy fail-soft `gatherCodebaseHealth` in
  `scripts/analyze/index.mjs`.
- **New file (PR2)** `validation/codebase-health-baseline.json` — the committed baseline
  (score, per-axis bands, key counts) plus a new **advisory** step in `.github/workflows/ci.yml`
  that runs the scorer, prints deltas vs the baseline, and **always exits 0 in v0.9.0** — it
  cannot fail the release; flipping advisory→ratchet is a separate later decision (the
  `check-modularity.mjs` Hashimoto pattern, mode flag in the rubric JSON).
- **New plumbing (PR3, default-OFF)** — attach the brain-api **1.15 `codebase_health` scalars
  object** (specced by AIO-608 in `docs/brain-api.md`; **not respecified here**) to the codebase
  push. Because `POST /api/v1/codebases` requires the **full raw-metrics block** (sparse pushes
  are rejected 422 — see the 2026-06-19 revision note in `docs/brain-api.md`), the object rides
  the existing scanner lane in `.github/workflows/scan-on-merge.yml`, never a sparse standalone
  push. The wiring ships behind an opt-in flag and stays **OFF until the brain-side 1.15 ingest
  is deployed and verified**.

## Contract

**CLI:** `aios codebase-health [path] [--json]` — offline, **read-only**, exit 0 on any
successful scoring (health is a reading, not a gate; the gates themselves keep gating). `path`
defaults to the repo root, matching `aios context-health`.

**JSON v1** (`--json`, one object; this exact field set is the schema):

- `schema_version` (`1`) · `rubric_version` (from `validation/codebase-health.rubric.json`) ·
  `head_sha` (join key to the brain's codebase lane) · `measured_at` (`YYYY-MM-DD`, UTC).
- `score_pct` (0–100) · `status` (`healthy` | `degraded` | `critical`, cut-points from rubric
  data).
- `axes` — per-axis `{ band, passed, total }` for the seven axes (`passed`/`total` count the
  axis's deterministic criteria).
- `failed_invariant_ids` — string ids from the rubric's `invariants` enumeration (ids only).
- `checks` — per underlying deterministic check: `{ id, ok, value }` where `value` is a single
  number/boolean (a count, a pct) — **scalar summaries only**.

**Redaction invariant (hard):** the JSON contains **no source text, no filenames or paths, no
contributor identity, no secrets, and no raw evidence** — file:line evidence exists only in local
text mode. This makes the JSON safe to store, diff against the baseline, and (PR3) derive the
push scalars from.

**Brain reporting:** the wire shape is the **already-specced brain-api 1.15 `codebase_health`
object on `POST /api/v1/codebases`** (AIO-608) — additive within v1, scalars only, subject to the
full-raw-metrics-block rule. This spec defers entirely to `docs/brain-api.md` for its fields and
adds only the producer-side derivation (from the JSON v1 object) and the default-OFF wiring.

### Phase 0 maintenance-loop amendment (AIO-610, 2026-08-04)

JSON v1 remains a historical, accepted wire shape. JSON **v2** is now the producer shape used
for maintenance admission. It closes an epistemic hole in v1: a high observed score could coexist
with missing lint, coverage, mutation, or other evidence and appear safe to an automated consumer.

V2 separates three decisions that must never be conflated:

- `status` is the health reading derived from evidence that actually ran;
- `evidence_status` is `complete | partial | missing | stale | error` over the repository
  profile's required checks;
- `quality_gate` is `pass | fail | unknown`, and remains `unknown` unless required evidence is
  complete. `automation_eligible` can be true only for a full-mode run with a passing gate and a
  non-critical health reading.

Each repository declares its current capability boundary in
`validation/codebase-health.profile.json`. This prevents a Workspace-shaped rubric from treating
missing Team Brain or shell/Python rails as healthy, while keeping the rubric and check ids shared.
Profiles are versioned data and name required checks plus evidence-staleness limits.

The redacted v2 payload adds `profile_id`, `profile_version`, epistemic state on every check and
dimension, and a normalized `findings` array. Findings contain only a stable SHA-256 fingerprint,
check/axis ids, kind, severity, evidence state, and remediation tier. They contain no paths,
source, explanatory text, contributor identity, or secrets. The canonical machine schema is
[`contract/codebase-health-v2.schema.json`](../../contract/codebase-health-v2.schema.json).

V2 is the Phase 0 Finding Ledger boundary, not an autonomous repair implementation. Every
finding ships with `remediation_tier: 0` (report-only). Scheduling, prioritization, sandboxed
writers, PR generation, and auto-merge remain later phases.

## Scope

**In:** coverage-report producer (folded AIO-531 prerequisite), rubric JSON, composed scorer +
CLI registry descriptor, analyze shadow card, committed baseline + advisory CI step, default-OFF
push wiring per brain-api 1.15.
**Deferred:** the operator-loop source (`src/operator-loop/sources/`) + weekly
codebase-health-monitor agent + closeout hook — **follow-on AIO-610**; AIO-531's own
`POST /api/v1/metrics` member-day key + card; flipping the CI step advisory→ratchet; any
per-file or per-contributor breakdown (rejected — violates the redaction invariant);
cross-repo rubric distribution to split repos (rides the AIO-594 bootstrap CI skeleton later).

## Tier safety

- **Read-only, local-first:** the CLI and the CI step read the tree and print; nothing leaves the
  machine in PR1/PR2. Raw evidence (paths, file:line, source excerpts) is **admin-tier and stays
  local** — it never enters the JSON, the committed baseline, or any payload.
- **Scalars-only across the boundary:** the eventual push carries only the 1.15 scalar object —
  score, bands, counts, ids, `rubric_version`, `head_sha` — per `docs/brain-api.md`; no paths, no
  file lists, no contributor identity.
- **Default-deny / default-OFF:** push wiring ships disabled and is enabled only after the
  brain-side 1.15 ingest is deployed and verified (AIO-608 acceptance); an unverifiable ingest
  means the flag stays off — **omitted, never a null placeholder**.
- **`POST /api/v1/codebases` stays team-tier** with brain-side schema validation at the boundary
  (422 on malformed payloads — the same never-persisted invariant as the 422-on-admin item
  boundary).
- The feature emits **no operator-loop signals** in this spec; the tier-tagged
  `{kind, source, tier, occurredAt, ref, payload}` signal is AIO-610's contract.

## Acceptance

- After `npm run test:coverage`, `node scripts/coverage-report.mjs` prints one normalized JSON
  object; with no coverage artifact it exits 0 and prints `null`. `grep -rn "lcov" scripts/codebase-health.mjs`
  finds nothing — the scorer has no coverage parser of its own (one-artifact rule, asserted by a
  unit test on the `test_rigor` input path).
- `validation/codebase-health.rubric.json` declares exactly the seven axes above with 0–4 bands;
  a unit test loads the rubric, perturbs one threshold in a fixture copy, and asserts the band
  output changes **with no scorer-code change** (thresholds-in-data proof).
- `node scripts/aios.mjs codebase-health --json` on this repo exits 0 and prints one JSON object
  with exactly the v1 fields; a redaction test asserts no value anywhere in the object matches a
  repo-relative path, and that no key carries raw evidence text.
- `git diff --stat` for PR1 shows **`scripts/aios.mjs` unchanged (zero lines)**;
  `test/cli-registry.test.mjs` and `npm run check:size` stay green.
- (PR2) `aios analyze --json` shows a `codebase_health` card when a scoring succeeds, omits it
  otherwise, and the pinned-baseline `placement`/`spine` output is byte-identical either way; the
  new CI step exits 0 even when the score regresses vs `validation/codebase-health-baseline.json`
  (advisory proof — the delta is printed, the job stays green).
- (PR3) with the flag off (default), the scan-on-merge push payload has **no `codebase_health`
  key** (asserted in a unit test on the payload builder); with the flag on, the attached object
  validates against the AIO-608 schema in `docs/contract/` and rides only the full-metrics push.

## Implementation

1. `scripts/coverage-report.mjs` producer (precedence 1→2→3, per the folded AIO-531 build
   section) + unit tests — the prerequisite artifact.
2. `validation/codebase-health.rubric.json` (7 axes, bands, weights, status cut-points,
   invariants enumeration) + the thresholds-in-data test.
3. `scripts/codebase-health.mjs` composed scorer + `runCodebaseHealthCli` + the registry/usage
   descriptor + redaction test. — end of PR1.
4. `codebaseHealthCard()` in `scripts/analyze/aem.mjs` + `gatherCodebaseHealth` wiring in
   `scripts/analyze/index.mjs` / `scripts/analyze/report.mjs`.
5. `validation/codebase-health-baseline.json` + the advisory `.github/workflows/ci.yml` step. —
   end of PR2.
6. Default-OFF push wiring onto `.github/workflows/scan-on-merge.yml` per `docs/brain-api.md`
   revision 1.15 (after AIO-608 merges and the brain ingest is verified). — PR3.
