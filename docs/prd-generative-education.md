# PRD — Generative Education

**Status:** Proposed — three epics ready to build, one epic deliberately held.
**Last updated:** 2026-07-04 · **Owner:** John
**Inspiration:** the "Generative Education" product-vision document (private strategy doc in
`john-workspace/research/product-strategy/`, not part of this repo) — the product thesis that
workplace AI training should be generated at runtime from a live picture of a person and their
org, rather than pre-authored, and that the unit of generated value can be a lesson **or** a
shipped workflow automation.
**Precedent in this repo:** the Maturity Loop (`docs/v1-operator-loop/domains/maturity-loop.md`,
epics AM1–AM8) already runs a real Assess→Place→Prescribe→Re-assess cycle for one payload type (a
maturity tip); the Company-Graph (`docs/v1-operator-loop/domains/meetings.md` §"Stakeholder map
surface", AIO-141) already models actors, roles, and ownership edges over named workflows.

---

## 1. Summary

Three net-new domains — **Workflow Inventory**, **Competency Taxonomy**, and **Generation
Engine** — extend AIOS's existing operator-loop substrate so it can generate a day's single
highest-value unit of learning (a lesson) or automation (a shipped-workflow proposal) for an
individual, instead of only the maturity coaching tip it generates today. A fourth domain,
**Flywheel/ROI Ledger**, is named and gated but deliberately not spec'd or epic'd yet.

This PRD is scoped narrowly on purpose: a large amount of what the vision doc imagined as new
infrastructure — a maturity spine, an attention/cognitive-load signal, a queryable org graph of
people and workflow ownership, a human-in-the-loop decision corpus — already exists in this
codebase, shipped or actively shipping under other epics (§5). The actual net-new surface is
smaller than the vision doc's seven-pillar framing suggested, and this PRD is scoped to exactly
that surface.

## 2. Goals / Non-goals

**Goals**
- **G1.** Extend the Company-Graph's existing `workflow` entities with automation-readiness
  scoring, so "which of this person's real workflows should be automated instead of taught" is a
  queryable fact, not a guess (Workflow Inventory).
- **G2.** Add a role-specific AI-working competency map alongside (never merged into) the Agentic
  Maturity spine, explicitly naming the boundary between the two as unresolved rather than
  quietly deciding it (Competency Taxonomy).
- **G3.** Widen the Maturity Loop's shipped `SessionStart` feed-forward mechanism so its single
  payload type — a maturity tip — becomes one of three: `{tip, lesson, automation-proposal}`,
  chosen by a fully deterministic precedence rule, with automation-proposals routed through the
  existing `AskUserQuestion`/Decision Capture approval pipeline (Generation Engine).
- **G4.** Do all of the above as pure extensions of shipped surfaces (Company-Graph, Maturity
  Loop, Decision Capture) — no new hook, no new approval mechanism, no parallel schema.

**Non-goals (this PRD)**
- **N1.** Not a rebuild of Agentic Maturity or Cognitive Ergonomics. Epic AIO-211 (AM rename + CE
  shadow-band rollout + Phase B calibration) and the Maturity Loop (AM1–AM8) own that surface and
  are actively shipping; this PRD treats their outputs as inputs, never re-specifies them.
- **N2.** Not an org-level ROI dashboard. That's the held Flywheel/ROI Ledger domain (§8, §13) —
  named, gated, explicitly not built here.
- **N3.** Not a port of any client-engagement schema. The confidential company-graph schema this
  initiative's vision doc drew inspiration from (field names `ai_readiness_score`/`ai_candidate`)
  is not portable; this PRD's Workflow Inventory is an independent, differently-named, clean-room
  design (§9, §12 Risk R1).
- **N4.** Not auto-shipping code. An approved automation-proposal produces a reviewed plan handed
  to the operator, not an autonomously-merged PR (that would reuse `aios ship` in a later slice).

## 3. Users & motivating scenarios

| Persona | Today | With Generative Education |
|---|---|---|
| Individual contributor starting a session | Gets a 3-line Agentic Maturity placement + coaching tip at `SessionStart` (AM2, shipped) | Sometimes gets that tip, sometimes a short lesson pitched at a real competency gap, sometimes an automation-proposal for a recurring workflow that's ready to hand off |
| Workspace maintainer scoping the next quarter | Sees Agentic Maturity and Cognitive Ergonomics placements per person, no view of which of their actual workflows are automation-ready | Runs `aios stakeholders --owns <domain> --automation` and sees automation-readiness + estimated time cost against real, owned workflows |
| Org buyer (CFO/CHRO/CIO) evaluating the AIOS pitch | Sees engagement/completion-style training metrics only | Not yet served by this PRD — this persona is the Flywheel/ROI Ledger's audience, explicitly held (§8) until Generation Engine ships real units and AIO-211's calibration verdict lands |

## 4. Architecture

```
SessionStart (hooks/maturity-brief.mjs, AM2 — shipped, this PRD widens its output only)
   │
   ▼
Assess  ── reads: Agentic Maturity placement (aem.mjs, unchanged, owned by AIO-211)
        ── reads: Workflow Inventory (workflow-inventory.md, GE1 — new)
        ── reads: Competency Taxonomy (competency-taxonomy.md, GE2 — new)
        ── does NOT read: ce_band (excluded until AIO-211's calibration verdict lands)
   │
   ▼
Place   ── unchanged: Agentic Maturity's existing Spine/Axis placement
   │
   ▼
Prescribe (generation-engine.md, GE3 — new, deterministic precedence, see PRD §9 AC-GE3)
   │
   ├─ automation_candidate present, not surfaced in 7d ──▶ automation-proposal line
   │                                                          │
   │                                                          ▼
   │                                              `aios learn --propose <workflow>`
   │                                                          │
   │                                                          ▼
   │                                          generation-engine skill (Draft→Grade→Correct)
   │                                                          │
   │                                                          ▼
   │                                    AskUserQuestion (existing) ──▶ Decision Capture (existing, AIO-170)
   │
   ├─ competency weak-area present, not surfaced in 3d ──▶ lesson line
   │
   └─ neither ──▶ today's maturity tip (unchanged floor behavior)
   │
   ▼
Re-assess ── unchanged: Maturity Loop's existing observe/distill (AM5/AM6)
```

## 5. Foundation — link, don't rebuild

The following are **shipped or actively in-flight, own their own scope, and are inputs to this
PRD, never rebuilt by it**:

| Foundation | State as of 2026-07-04 | What this PRD does with it |
|---|---|---|
| Agentic Ergonomics (epic AIO-166) — Tasks & PM, Time Tracking, Agentic Maturity, Communication, Meetings domains | Production / shipping | Reads their signals from the existing C1 collector manifest; does not modify any of them |
| Asks Queue (AIO-167), Attention Mode (AIO-168), Sanity Metrics (AIO-169), Decision Capture (AIO-170) | Shipped | Decision Capture is directly reused for automation-proposal approval (§9); the others are untouched |
| Agentic Maturity (AM) rename + Cognitive Ergonomics shadow-band rollout (epic **AIO-211**) | **Running now** — brain-api v1.3 `ce_band` shipped (2026-07-04), AEM→"Agentic Maturity" display rename merged (AIO-212), Phase B calibration harness (AIO-216/W5) mid-build | CE is explicitly **excluded** from this PRD's Assess step until W5 returns a verdict (§9, Deferred) |
| Maturity Loop (epics AM1–AM8) | AM1 (capture) and AM2 (`SessionStart` feed-forward, `hooks/maturity-brief.mjs`) shipped; AM5/AM6 in progress | AM2's hook is the exact extension point Generation Engine widens (§9) |
| Company-Graph stakeholder-map surface (**AIO-141**) | Shipped 2026-07-04 — `graph_entities`/`graph_relationships` (Postgres), `GET /api/v1/company-graph` (brain-api **v1.5**), `aios stakeholders` CLI, `brain_stakeholders` MCP tool | Workflow Inventory and Competency Taxonomy are additive `attrs` keys on its existing `workflow`/`actor` entity types — no new table |

## 6. Context Inventory → foundation mapping

Of the vision doc's seven "Context Inventory" pillars: **Agentic Maturity**, **Cognitive
Ergonomics**, **Tooling & Integration Surface**, and **Conversational Context** already have
production or near-production homes under AIO-166/AIO-211 (§5) — this PRD does not re-specify
them. **Goals & OKRs** remains genuinely ungrounded (no OKR-platform integration exists anywhere
in this codebase); this PRD does not attempt to build one, and notes the `COMMITTED_TO` graph
relationship type as a structurally-plausible-but-unverified future substrate (§13). **Workflow
Inventory** and **Competency Taxonomy** are this PRD's two new pillars (§9). Field-level schema
detail lives in the domain specs, not here, per this repo's own convention of keeping PRDs at the
product/architecture level and domain specs at the implementation level.

## 7. Skill/tool surface

Two new workflow-harness skills, matching the existing `scaffold/.claude/skills/` schema
(`decision-audit`, `weekly-synthesis`):

```yaml
---
name: workflow-inventory-scan
description: |
  Scans a person's real workflows (from tasks/PM, time-tracking, and communication signals
  already in the operator-loop manifest) and scores each for automation readiness.
  Use when Workflow Inventory data is stale or missing for an actor.
version: 0.1.0
kind: workflow-harness
workflow: workflow-inventory-scan.workflow.js
triggers:
  - "scan my workflows"
  - "score automation readiness"
---
```

```yaml
---
name: generation-engine
description: |
  Drafts a lesson or a workflow-automation proposal for one person, grades it against the
  generation-engine rubric, and corrects until it passes or the budget is spent.
  Invoked by `aios learn --propose <workflow>`; not run standalone by a human.
version: 0.1.0
kind: workflow-harness
workflow: generation-engine.workflow.js
triggers:
  - "propose an automation for"
  - "generate today's lesson"
---
```

No new hook. Automation-proposal approval reuses the existing `AskUserQuestion` +
`hooks/decision-capture.mjs` pipeline (AIO-170) verbatim (§9, and see `generation-engine.md` Why).

## 8. Epics & phasing

| Epic | Linear | Spec | Status | Depends on |
|---|---|---|---|---|
| Generative Education (parent epic) | [AIO-257](https://linear.app/je4light/issue/AIO-257/generative-education) | this PRD | Backlog | — |
| GE1 — Workflow Inventory | [AIO-258](https://linear.app/je4light/issue/AIO-258/ge1-workflow-inventory) | [workflow-inventory.md](./v1-operator-loop/domains/workflow-inventory.md) | Ready to build | AIO-141 (shipped) |
| GE2 — Competency Taxonomy | [AIO-259](https://linear.app/je4light/issue/AIO-259/ge2-competency-taxonomy) | [competency-taxonomy.md](./v1-operator-loop/domains/competency-taxonomy.md) | Ready to build | AIO-141 (shipped) |
| GE3 — Generation Engine | [AIO-260](https://linear.app/je4light/issue/AIO-260/ge3-generation-engine) | [generation-engine.md](./v1-operator-loop/domains/generation-engine.md) | Blocked | GE1 + GE2 schemas frozen (Linear: AIO-258, AIO-259 block AIO-260); CE input scope-limited by AIO-211's verdict |
| GE4 — Flywheel / ROI Ledger | **Not filed** | [flywheel-roi-ledger.md](./v1-operator-loop/domains/flywheel-roi-ledger.md) (stub only) | Held | GE3 producing real units + AIO-211 verdict + a `brain-api.md` version design |

## 9. Acceptance criteria

**GE1 — Workflow Inventory**
- **AC-GE1.1.** `aios stakeholders --owns "<domain>" --automation` prints
  `automation_readiness`/`automation_candidate`/`time_cost_hours` for a scored workflow entity,
  and nothing extra for an unscored one.
- **AC-GE1.2.** The scorer (`src/operator-loop/workflow-inventory/score.ts`) is unit-testable
  standalone against a fixture manifest.
- **AC-GE1.3.** `GET /api/v1/company-graph` against a v1.6 brain includes the new `attrs` keys;
  against a v1.5 (current) brain, they're simply absent — no crash, no partial payload.
- **AC-GE1.4.** An `external`-tier key gets `403 forbidden_tier` on every mode that surfaces
  automation data.

**GE2 — Competency Taxonomy**
- **AC-GE2.1.** `aios competency assess --job-family <family>` writes
  `competency_scores`/`competency_weak_areas`/`competency_assessed_at` to the invoking actor.
- **AC-GE2.2.** `aios stakeholders --who "<person>"` includes the new fields when present, omits
  cleanly when absent.
- **AC-GE2.3.** `competency_weak_areas` never contains a key without a corresponding
  `competency_scores` entry `<= 1`.
- **AC-GE2.4.** Adding a 4th job-family category set requires only a registry entry, no code-path
  change.

**GE3 — Generation Engine**
- **AC-GE3.1.** With no qualifying Workflow Inventory or Competency Taxonomy signal, `SessionStart`
  output is byte-identical to today's shipped AM2 behavior (hard regression guard).
- **AC-GE3.2.** A qualifying `automation_candidate: true` entry produces the `automation-proposal:`
  line at most once per 7-day window per workflow.
- **AC-GE3.3.** `aios learn --propose <workflow>` drafts a plan, grades it against
  `.claude/rubrics/generation-engine.md`, presents it via `AskUserQuestion`, and any decision is
  captured in the existing Decision Capture store with no new store introduced.
- **AC-GE3.4.** The Assess step never reads `ce_band` (verified by a fixture test asserting the
  field is absent from every input passed to `prescribe.ts`) until this AC is explicitly revised
  once AIO-211's verdict lands.

## 10. Evaluation & KPIs

**Rubric.** `.claude/rubrics/generation-engine.md` (product-repo rubric, mirrors
`.claude/rubrics/operator-loop-c5.md`'s table shape: `ID | Criterion | Check method | Must`).
Draft criteria: generated content cites the real Workflow Inventory/Competency Taxonomy fact it's
grounded in (`grounding-read`); a lesson is never generated when an automation-candidate exists
for the same gap (`deterministic`); an automation-proposal never auto-ships (`deterministic`);
tier-safety — no admin-tier signal appears in a generated unit's text (`tier-scan`).

**KPIs.** A new sibling scorer module, `src/operator-loop/generation-engine/metrics.ts`, follows
the exact `computeSignals` → `band()` shape of `scripts/analyze/metrics.mjs`/`aem.mjs` — a
**separate module**, not an edit to `aem.mjs` itself (Constitution §4; `aem.mjs` is owned by
AIO-211). Raw counters: lessons generated/week, automation-proposals surfaced/week,
automation-proposals approved/week, `time_cost_hours` represented by approved proposals/week (an
*estimate*, not calendar-verified — see Risk R5). These are local, `aios analyze`-style signals
first; whether/how they ever cross the tier boundary is explicitly the Flywheel/ROI Ledger's
question (§8), not this PRD's.

## 11. CI/CD

GE1–GE3 are TypeScript workflow-layer modules under `ENGINEERING-CONSTITUTION.md` §3 and slot into
`aios-workspace`'s existing CI job matrix (`.github/workflows/ci.yml`: `docs-drift`, `guard`,
`lint`, `tests`) exactly the way AIO-166's domains did — no new CI philosophy, new test files
under `test/operator-loop/` picked up by the existing `tests` job. GE1's brain-side extension
(`GET /api/v1/company-graph` v1.6) is a separate `aios-team-brain` PR following that repo's
existing tiered model (`docs/CI-ARCHITECTURE.md`: `docs-drift` → `static-checks` → `brain-tests`
→ `datamechanics-tests`, real-Postgres) — same deploy-before-advertise rule AIO-141 itself
followed. GE4 (held) would use the same brain-side tiers once it's real; not applicable yet.

## 12. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **R1 — IP/naming collision.** The confidential company-graph schema this initiative's vision doc was inspired by uses `ai_readiness_score`/`ai_candidate`. | Workflow Inventory uses distinct names (`automation_readiness`, `automation_candidate`, `time_cost_hours`) throughout — stated explicitly in `workflow-inventory.md`'s Why section, not left implicit |
| **R2 — Duplicating in-flight AM/CE work.** AIO-211 and AM1–AM8 are shipping right now. | This PRD's Foundation section (§5) cites both by real issue/epic id and current state; GE3 explicitly excludes `ce_band` as an input until a calibration verdict exists (AC-GE3.4) |
| **R3 — Agentic-Maturity-vs-Competency-Taxonomy boundary.** Real conceptual overlap, unresolved. | Named as an explicit open question (§13), not silently merged; `competency-taxonomy.md` defers entirely to Agentic Maturity for the `engineering` job family rather than guessing a boundary |
| **R4 — Premature promotion of an uncalibrated signal.** Including `ce_band` in a new decision path before AIO-211's verdict lands would repeat the mistake CE's own shadow-badging exists to prevent. | Hard dependency, not a nice-to-have (§9 AC-GE3.4, §5) |
| **R5 — ROI/time-cost figures read as measured when they're estimated.** `time_cost_hours` is self-reported/derived, not calendar-verified (no calendar connector exists in this codebase). | `time_cost_confidence` field defaults to `"estimated"`; `"measured"` is declared but never produced in this PRD's scope (`workflow-inventory.md` Contract) |
| **R6 — Scope creep into a second approval mechanism.** Temptation to build a bespoke automation-approval UI. | Explicitly reuses `AskUserQuestion` + the existing Decision Capture store (AIO-170); no new hook (§7, N4) |

## 13. Open questions

1. Where exactly does the Agentic Maturity / Competency Taxonomy boundary get resolved — two
   separate scored axes that both feed Place, one subsuming the other, or two views over one
   underlying score model? Not answered here; `competency-taxonomy.md` ships the schema without
   answering it.
2. Is `graph_relationships`' existing `COMMITTED_TO` relationship type (and `commitment` entity
   type) semantically an OKR, or something else (e.g. a decision-log commitment)? Unverified
   against how those entities are actually seeded/used today — a real candidate substrate for
   "Goals & OKRs," not yet confirmed as fit-for-purpose.
3. What are GE4's precise gating conditions in practice — does AIO-211 returning a `HOLD` verdict
   (not just `MERGE`/`PROMOTE`) still count as "the gate cleared, CE just stays excluded," or does
   `HOLD` push GE4 out indefinitely? Leaning toward the former (a `HOLD` is itself an answer), but
   not decided here.
4. Should `time_cost_confidence: "measured"` be designed now (schema only, unpopulated) or left
   entirely out of the schema until a calendar connector exists? This PRD chose to declare the
   field now (`workflow-inventory.md`) so the eventual calendar work doesn't require a schema
   migration — worth revisiting if that judgment turns out wrong.

## 14. References

- Generative Education vision doc — `john-workspace/research/product-strategy/aios-learning-generative-education-vision.md` (private, separate repo)
- `docs/v1-operator-loop/domains/maturity-loop.md` (AM1–AM8)
- `docs/v1-operator-loop/domains/agentic-maturity.md`
- `docs/v1-operator-loop/domains/meetings.md` §"Stakeholder map surface (AIO-141)"
- `docs/brain-api.md` (v1.5 as of this PRD; company-graph endpoint + `ce_band`)
- `docs/ENGINEERING-CONSTITUTION.md`
- `docs/prd-council-harness.md` (PRD template this document follows)
- `2-work/am-ce-epic/epic.md` (AIO-211 build plan — local/untracked planning notes in the primary
  checkout as of this writing, cited for context only, not a resolvable repo path)
