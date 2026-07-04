# Domain spec — Flywheel / ROI Ledger (HELD, not build-ready)

Governed by [`ENGINEERING-CONSTITUTION.md`](../../ENGINEERING-CONSTITUTION.md). Part of the
**Generative Education** initiative — see [`docs/prd-generative-education.md`](../../prd-generative-education.md)
§13 (Open Questions). **This is a stub, not a build-ready spec — no Linear issue exists for it.**
Filing one now would encode acceptance criteria against gates that haven't cleared, which is worse
than no issue at all.

## Why (the destination, not yet the plan)

The individual half of the Generative Education flywheel already exists in production: the
Maturity Loop (AM1–AM8) captures, feeds forward, observes, and distills at the individual level
today. What doesn't exist is the **org half** — an aggregate view of workflows converted, hours
reclaimed, and competency growth across a team, the artifact the PRD's ROI narrative
(`docs/prd-generative-education.md` §10) says is what actually closes an enterprise sale. This
domain is that aggregate view, brain-side.

## Why this isn't spec'd yet (the actual gates)

1. **Generation Engine (GE3) must be producing real generated units first.** There is no ledger to
   build without automation-proposals and lessons actually being generated and approved — an
   empty table with no writer isn't a spec, it's a guess.
2. **AIO-211's Phase B calibration harness (W5) must return a verdict.** `docs/brain-api.md`'s
   v1.3 `ce_band` field is explicitly "shadow · uncalibrated" until then, and the in-flight brain
   dashboard work under epic AIO-211 (issue B4, "CE beside AM") already defers team-average CE
   trend for exactly this reason. Any ledger that includes a Cognitive-Ergonomics-derived figure
   before that verdict lands would be promoting an unconfirmed signal — the same mistake GE3
   deliberately avoids (see `generation-engine.md`, Deferred).
3. **A `brain-api.md` version bump must be designed**, following the v1.3 `ce_band` section's
   exact shape (additive field, explicit tier statement, explicit compat statement, deploy-before-
   advertise rule) — not invented from scratch once this domain is ready to spec.

## Open questions (to resolve before this becomes a real spec)

- What is the actual aggregation unit — per-team, per-job-family, per-organization? The Company-
  Graph (AIO-141) already has `team_id` scoping; does the ledger reuse that boundary as-is?
- Does "hours reclaimed" ever get calendar-verified (per the PRD's Risk R5, Google Workspace via
  `gog` is realistic near-term, Microsoft 365 is not built), or does v1 ship on
  `time_cost_hours`-estimated figures only, clearly labeled as estimates on the dashboard?
- Is this a new page beside AIO-211's in-flight "CE beside AM" brain dashboard work (issue B4), or
  a section within it? (Leaning: a new page — this ledger's data model, per the gates above,
  doesn't exist yet, and shouldn't block that dashboard's own in-flight release.)
- What's the actual tier-safety posture for cross-person aggregation? Individual `time_cost_hours`
  and `automation_readiness` are team-tier per-actor today (Workflow Inventory, GE1); an
  org-level roll-up is a different exposure than a single `--owns` query and needs its own explicit
  statement, not an inherited one.

**Do not file a Linear issue for this domain** until gate 1 (GE3 shipping real units) is true and
gate 2 (a calibration verdict, of any value) exists. At that point, re-open this file, fill in
Reuse/Contract/Scope/Acceptance/Implementation properly, and it becomes a normal spec.
