# Domain spec — Competency Taxonomy (role-specific AI-working skill map)

Governed by [`ENGINEERING-CONSTITUTION.md`](../../ENGINEERING-CONSTITUTION.md). Part of the
**Generative Education** initiative (epic **AIO-257**, issue **AIO-259 / GE2**) — see
[`docs/prd-generative-education.md`](../../prd-generative-education.md). Parallelizable with
Workflow Inventory (`workflow-inventory.md`, GE1); both must land before the Generation Engine
(`generation-engine.md`, GE3) can implement its Assess step.

## Why

The Agentic Maturity spine (`docs/v1-operator-loop/domains/agentic-maturity.md`) places someone on
a single cross-cutting ladder — how well they delegate, verify, and orchestrate agentic work,
regardless of role. It deliberately does **not** ask "does this specific marketing lead know how
to write a good brand-voice prompt" or "does this specific finance analyst know how to verify a
model's numbers" — role-specific, department-specific AI-working skills. That gap is real: the
vision doc's own worked example (a growth/marketing department's AI-native competencies) is not
something Agentic Maturity's five axes can express, and forcing it in would violate that domain's
own well-bounded-module contract. This domain adds the role-specific layer, explicitly as a
**second axis alongside** Agentic Maturity, not a replacement or a silent merge.

**This is the one domain in this initiative that ships an intentionally unresolved design
question, by design (`docs/prd-generative-education.md` §13, Open Questions):** exactly where the
line sits between "how agentically mature is this person in general" (Agentic Maturity) and "how
good is this person at their department's specific AI-relevant competencies" (this domain) is not
settled here. This spec ships the schema and the assessment-intake flow; the boundary question is
explicitly out of scope and must not be quietly resolved by implementation accident.

## Reuse (shipped, KEEP)

- **Assessment-instrument pattern.** The existing readiness-assessment shape (question →
  scoring-category → composite score, seen in this initiative's vision doc's research on the
  prior Learning Journeys product) is the reference pattern for the intake flow — a lightweight,
  short-form questionnaire per job family, not a new UI framework.
- **`graph_entities` (`entity_type = 'actor'`)** (`aios-team-brain/postgres/schema.sql:463-468`) —
  the existing Actor entity already carries `job_family`-shaped data via its `attrs jsonb` column
  per AIO-141's Company-Graph model. This domain's per-actor competency scores are additional
  `attrs` keys on the same `actor` entities Workflow Inventory's `--owns`/`--who` queries already
  resolve — not a new entity type.
- **C1 collector manifest** (`docs/v1-operator-loop/c1-collector.md`) — the tier-tagged signal
  shape (`{kind, source, tier, occurredAt, ref, payload}`) this domain's intake events conform to.

## Contract

### `attrs` keys added to `actor`-type `graph_entities` rows

```json
{
  "entity_type": "actor",
  "attrs": {
    "job_family": "marketing",
    "competency_scores": {
      "prompt_craft": 3,
      "context_curation": 2,
      "output_verification": 4
    },
    "competency_weak_areas": ["context_curation"],
    "competency_assessed_at": "2026-07-04T00:00:00.000Z"
  }
}
```

- `competency_scores` — an object keyed by a **per-job-family category set** (see below), each
  value `0`–`4` (matching Agentic Maturity's own axis scale for consistency of reading, not
  because the two are the same measurement).
- `competency_weak_areas` — derived list of category keys scoring `<= 1`; never hand-edited
  independently of `competency_scores` (same "derived, not independently settable" discipline as
  Workflow Inventory's `automation_candidate`).
- `competency_assessed_at` — ISO timestamp of the last intake; a re-assessment overwrites in
  place (this is a current-state snapshot, not an append-only log — distinct from Workflow
  Inventory and Decision Capture, which are append-only; stated explicitly because this is a
  deliberate, not accidental, choice).

### Per-job-family category sets (v1 scope: 3 families)

A **small, versioned** category list per `job_family`, not a sprawling universal taxonomy:
`marketing` (`prompt_craft`, `context_curation`, `output_verification`), `engineering` (already
covered by Agentic Maturity's axes — **this domain does not duplicate a category set for
`engineering`**, it defers to Agentic Maturity entirely for that job family, which is itself part
of the unresolved-boundary open question), `finance` (`numeric_verification`, `model_scrutiny`,
`report_synthesis`). Additional job families are additive category-set entries, not a schema
change — matching the "one registry entry" extensibility pattern already established for the
brain's ingestion `Source` protocol (`aios-team-brain/ingestion/aios_ingest/sources/base.py`).

## Scope

**In scope (v1):** the `attrs` schema, category sets for 3 job families, a CLI intake flow
(`aios competency assess`), read access via the existing `aios stakeholders --who <person>` query
extended to print `competency_scores`/`competency_weak_areas` when present.

**Deferred:**
- Resolving the Agentic-Maturity-vs-Competency-Taxonomy boundary (explicitly out of scope, per
  Why above — tracked as an open question, not a deferred build item, because it's a design
  decision, not missing code).
- Category sets beyond the 3 seeded job families.
- Any automated re-scoring (v1 is explicit, human-answered intake only — no session-signal-derived
  scoring, unlike Workflow Inventory's deterministic scorer, because self-reported competency and
  observed workflow automation-readiness are different kinds of claims and conflating them would
  be exactly the kind of ungrounded-architecture-claim SR16 exists to catch).

## Build with

sonnet / medium — additive `attrs` keys + a CLI intake flow on an existing entity type, no wire
contract change, no cross-repo coordination (unlike Workflow Inventory, this domain doesn't touch
`docs/brain-api.md` since it reuses the existing `actor` projection AIO-141 already ships).

## Dependencies

None. Does not depend on Workflow Inventory or the Generation Engine; parallelizable with both.
Does not depend on the in-flight AM/CE rollout (AIO-211) — reads Agentic Maturity's placement only
as *context* in the intake flow's summary output, never as a required input.

## Tier-safety posture

Team-tier only, inherited from the existing `actor` entity projection's tier gate (AIO-141) — no
new tier surface introduced. Individual competency scores are visible at the same tier a person's
name and role already are today; this domain does not change who can see what, only what's visible.

## Acceptance

- `aios competency assess --job-family marketing` runs the intake flow and writes
  `competency_scores`/`competency_weak_areas`/`competency_assessed_at` to the invoking actor's
  `graph_entities` row.
- `aios stakeholders --who "<person>"` includes `competency_scores` and `competency_weak_areas` in
  its output when present, and omits the fields cleanly (no crash) when absent.
- A `competency_weak_areas` entry never appears without a corresponding `competency_scores` entry
  `<= 1` for the same key — demonstrated by a new test,
  `test/operator-loop/competency-taxonomy.test.mjs`.
- Adding a 4th job-family category set requires only a new entry in the category-set registry, not
  a schema or code-path change — demonstrated by the same test adding a synthetic 4th family.

## Implementation

New: `src/operator-loop/competency-taxonomy/categories.ts` (the per-job-family category-set
registry), `src/operator-loop/competency-taxonomy/intake.ts` (the derive-weak-areas logic), a
`cmdCompetency` command in `scripts/aios.mjs` (registered alongside `cmdStakeholders`), and an
extension of `cmdStakeholders`'s `--who` output to include the new `attrs` keys when present.
