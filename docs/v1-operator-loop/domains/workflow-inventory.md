# Domain spec — Workflow Inventory (automation-candidate scoring on the Company-Graph)

Governed by [`ENGINEERING-CONSTITUTION.md`](../../ENGINEERING-CONSTITUTION.md). Part of the
**Generative Education** initiative (epic **AIO-257**, issue **AIO-258 / GE1**) — see
[`docs/prd-generative-education.md`](../../prd-generative-education.md). First of two gating
epics; the Generation Engine (`generation-engine.md`, GE3) cannot start build until this schema
and its query surface are frozen.

## Why

The Generation Engine needs to know, for a given person, which of their real workflows are worth
automating instead of teaching — that's the wedge of the whole Generative Education thesis
(`docs/prd-generative-education.md` §2, G2). AIOS already ships exactly the right substrate for
this: `aios stakeholders` (AIO-141, `docs/v1-operator-loop/domains/meetings.md` §"Stakeholder map
surface") surfaces the brain's Company-Graph — actors, roles, and `OWNS`/`TOUCHES`/`PRODUCES`
edges over named workflows — but that graph is **ownership-only** today. It answers "who owns
Month-End Financial Close" but nothing about whether that workflow is worth automating, how much
time it costs, or which goal it serves. This domain adds exactly those three facts to the
`workflow`-type entities that already exist in the graph, and nothing else — it is an *extension*
of AIO-141's shipped surface, not a new schema.

**Explicit IP-boundary note:** a client-engagement schema this initiative's own vision doc drew
inspiration from uses the field names `ai_readiness_score`/`ai_candidate`. That schema and its
data are confidential and not portable (`docs/prd-generative-education.md` §12, Risk R1). This
domain deliberately uses different field names (`automation_readiness`, `automation_candidate`,
`time_cost_hours`) precisely so no reader can mistake this for a port of that schema — it is an
independent, clean-room design that happens to solve the same product problem.

## Reuse (shipped, KEEP)

- **`graph_entities` / `graph_relationships`** (`aios-team-brain/postgres/schema.sql:463-491`,
  migration `aios-team-brain/supabase/migrations/20260610104918_entities_graph.sql`) — the
  `entity_type` check constraint **already includes `'workflow'`**, and every entity carries a
  freeform `attrs jsonb` column. No new table, no new migration for the schema itself — this
  domain is additive keys inside an existing jsonb column, exactly the pattern `graph_commitment_status_idx`
  already uses for `commitment`-type entities (a partial index on an `attrs->>'...'` expression).
- **`GET /api/v1/company-graph`** (`docs/brain-api.md`, v1.5, AIO-141) — the additive, team-tier
  endpoint that projects `graph_entities`/`graph_relationships` as `people[]` + `ownership[]`.
  This domain extends its projection, not its auth/tier model.
- **`aios stakeholders --owns <domain>`** (`cmdStakeholders`, `scripts/aios.mjs:1459`) — the
  existing CLI query surface for "who owns X." This domain adds a query mode to the same command,
  not a new command.
- **`scripts/brain-client.mjs`** — the shared HTTP client both `cmdStakeholders` and the MCP tool
  (`scripts/brain-mcp.mjs`, `brain_stakeholders`) already build on.

## Contract

### `attrs` keys added to `workflow`-type `graph_entities` rows

```json
{
  "entity_type": "workflow",
  "attrs": {
    "automation_readiness": 7,
    "automation_candidate": true,
    "time_cost_hours": 3.5,
    "time_cost_confidence": "estimated"
  }
}
```

- `automation_readiness` — integer `0`–`10`. How ready this specific workflow is for AI/automation
  augmentation. Absent/`null` means "not yet scored."
- `automation_candidate` — boolean. Derived from `automation_readiness` crossing a documented
  threshold (default: `>= 6`), never hand-set independently of the score, so the two fields can't
  silently disagree.
- `time_cost_hours` — number. Estimated recurring hours/week this workflow currently costs the
  owning actor. `null` when not yet estimated.
- `time_cost_confidence` — `"estimated" | "measured"`. `"measured"` is reserved for a future slice
  that cross-references calendar data (`docs/prd-generative-education.md` §10, ROI section) —
  **v1 only ever writes `"estimated"`**; `"measured"` is declared but not produced yet (stated
  explicitly so a reader doesn't assume calendar verification exists — it doesn't, per the PRD's
  Risk R5).

### Scoring source (v1: deterministic, not LLM-guessed)

`automation_readiness` for v1 is computed from signals **already in the C1 collector manifest**
(`docs/v1-operator-loop/c1-collector.md`) for the workflow's owning actor — task/PM signal
repetition count, time-tracking recurrence, and (where available) the existing Agentic Maturity
placement's per-axis scores (`scripts/analyze/aem.mjs`) as a *modifier*, never the sole input.
This is a **new sibling scorer module**, `src/operator-loop/workflow-inventory/score.ts`, following
the exact `computeSignals` → `band()`-style shape of `scripts/analyze/metrics.mjs` /
`scripts/analyze/aem.mjs` — it does **not** modify `scripts/analyze/aem.mjs` itself (that module is
owned by the in-flight AM/CE rollout, epic AIO-211; Constitution §4 forbids reaching into a
sibling domain).

### Query surface

- CLI: `aios stakeholders --owns <domain> --automation` — same command, an added flag that
  includes `automation_readiness`/`automation_candidate`/`time_cost_hours` in the printed row when
  present.
- MCP: `brain_stakeholders` (`scripts/brain-mcp.mjs`) gains the same fields in its existing
  response shape — additive, no new tool.
- Wire: `GET /api/v1/company-graph` response's `ownership[]` rows gain the three `attrs` keys when
  present on the underlying `workflow` entity — a `brain-api.md` **v1.6** addition (additive field,
  same shape as the v1.3 `ce_band` addition), documented with the same tier statement.

## Scope

**In scope (v1):** the three `attrs` keys, the deterministic scorer module, CLI/MCP/wire
projection of the new fields, a partial index on `automation_candidate` (mirroring
`graph_commitment_status_idx`).

**Deferred (explicitly, matching AIO-141's own deferred-list convention):**
- `time_cost_confidence: "measured"` (calendar-verified time cost) — depends on a calendar
  connector that does not exist yet (`docs/prd-generative-education.md` §10, Risk R5).
- OKR-alignment linkage. `graph_relationships` already has a `COMMITTED_TO` relationship type and
  a `commitment` entity type that are structurally *candidates* for expressing "this workflow
  serves that goal" — but whether `commitment` entities are semantically OKRs or something else
  (e.g. decision-log commitments) has not been verified against how they're actually seeded/used
  today. This is named as an **open question** in the PRD (§13), not resolved here, and is not a
  dependency of this domain's own acceptance criteria.
- Automated re-scoring cadence (v1 is scored on-demand via a CLI/harness invocation, not a
  background job).
- A GUI view (CLI + MCP ship first, matching every other Company-Graph slice to date).

## Build with

opus / high — touches a pinned wire contract (`brain-api.md`) and a cross-repo surface
(workspace CLI + MCP + brain endpoint), the same tier AIO-141 itself was built at.

## Dependencies

- **AIO-141** (Company-Graph stakeholder-map surface) must be deployed brain-side — it already is,
  as of `docs/brain-api.md` v1.5.
- **None** on the in-flight AM/CE rollout (AIO-211) or the Maturity Loop (AM1–AM8) — this domain
  reads Agentic Maturity's *existing, already-shipped* per-axis scores as one scoring input, it
  does not depend on AIO-211's rename or CE-calibration work landing first.

## Tier-safety posture

Same posture as AIO-141: **team-tier only**. `graph_entities`/`graph_relationships` carry
`team_id` but no per-row tier column and no RLS backstop, so tier is an app-code gate — the wire
endpoint rejects an `external`-tier key with `403 forbidden_tier`, and the CLI probes `GET /me`
before any mode runs, exactly like `cmdStakeholders` does today. No new tier surface is
introduced; this domain inherits AIO-141's gate verbatim.

## Acceptance

- `aios stakeholders --owns "Month-End Financial Close" --automation` prints the owning actor's
  name plus `automation_readiness`, `automation_candidate`, and `time_cost_hours` when the
  underlying `workflow` entity has been scored; prints nothing extra when unscored (no crash, no
  `null` leakage as a literal string).
- The scorer module (`src/operator-loop/workflow-inventory/score.ts`) is callable standalone
  against a fixture manifest and returns a stable `{automation_readiness, automation_candidate}`
  pair for a given signal set — demonstrated by a new test,
  `test/operator-loop/workflow-inventory-score.test.mjs`.
- `GET /api/v1/company-graph` against a brain running v1.6 includes the three `attrs` keys in
  `ownership[]` rows that have them; an older (v1.5) brain omits them and the CLI/MCP degrade
  cleanly (no crash), matching AIO-141's own 404/older-brain tolerance pattern.
- An `external`-tier key gets `403 forbidden_tier` from every mode that surfaces automation data,
  identical to AIO-141's existing tier probe.
- `node scripts/brain-mcp.test.mjs` passes with the extended `brain_stakeholders` fixture
  including the new fields.

## Implementation

New: `src/operator-loop/workflow-inventory/score.ts` (scorer), extension of `cmdStakeholders`
(`scripts/aios.mjs:1459`) for the `--automation` flag, extension of `brain_stakeholders`
(`scripts/brain-mcp.mjs`), a `docs/brain-api.md` v1.6 section (brain-side endpoint change is a
separate `aios-team-brain` PR, deploy-before-advertise, same rule AIO-141's own deps section
states), and a Postgres partial index migration mirroring `graph_commitment_status_idx`
(`postgres/schema.sql:475-476`) for `automation_candidate`.
