# PRD — Verified Weekly Operator Loop

Status: draft for Linear planning
Owner: Product
Related milestone: [Solo loop magical](./product-roadmap-three-milestones.md#milestone-1--solo-loop-magical)

## Summary

The Verified Weekly Operator Loop turns AIOS from a governed workspace with useful harnesses into a weekly operating ritual an individual can trust. Once per week, AIOS collects the operator's decisions, tasks, deliverables, inbox inputs, and relevant integration summaries; drafts a concise weekly brief and next-week plan; verifies every material claim against source evidence and access-tier policy; then asks the human to approve what is written locally, promoted, pushed to Team Brain, or mirrored into a project-management system such as Linear.

This is not just a digest. The product outcome is: **"I can close my week in under 20 minutes, know what happened, know what matters next, and safely share the right slice with my team."**

## Problem

AI-assisted work creates more artifacts, decisions, and partial outputs than a solo operator can reliably review at week end. Current weekly summaries are either manual and time-consuming, or automated and untrusted. The most dangerous failures are subtle: invented progress, omitted blockers, private content leaking into team-facing updates, and tasks created without evidence.

AIOS already has the right primitives: a local workspace spine, access tiers, validators, a Team Brain sync boundary, and verifier-backed harness patterns. What is missing is an opinionated product loop that combines those primitives into one repeatable weekly closeout.

## Target users

Primary:

- **Solo consultant / fractional operator** managing client work from an AIOS workspace and needing a trustworthy weekly client/team update.
- **Individual contributor inside a company** who wants a weekly operating review across goals, decisions, blockers, and next actions without sharing private notes.
- **Founder/operator** using AIOS as a personal execution system and needing continuity between weekly plans.

Secondary:

- **Team lead / manager** consuming approved team-tier digests pushed from multiple individual workspaces.
- **AIOS maintainer / harness author** using the loop as the reference implementation for verifier-backed product harnesses.

## Core workflow

1. **Configure the loop.** User chooses weekly window, source paths, optional integrations, default output locations, team/project slug, PM provider, and sharing defaults.
2. **Collect source index.** AIOS reads only configured local workspace sources by default: decision log, task log, work artifacts, shared artifacts, inbox summaries, prior weekly brief, and harness outputs. Optional integrations must land as local inbox artifacts before synthesis.
3. **Normalize work signals.** The loop extracts decisions, commitments, task deltas, blockers, risks, shipped artifacts, unresolved inbox items, and carry-over actions into a small structured evidence ledger.
4. **Draft private operator brief.** AIOS creates a private/admin-tier brief with candid notes, risks, unresolved questions, and next-week recommendations.
5. **Draft shareable digest.** AIOS derives a team-tier or external-tier version from approved material only, with source citations and redactions applied before verification.
6. **Verify and correct.** An independent verifier grades the draft against the weekly-loop rubric. Must-fail criteria trigger targeted correction; the loop stops when the rubric passes or budget is exhausted.
7. **Human review.** The user sees the private brief, shareable digest, evidence ledger, verifier report, proposed task/Linear changes, and any redactions. Nothing is written, promoted, pushed, or mirrored until approved.
8. **Write locally.** Approved artifacts are written into the numbered spine with frontmatter and provenance: private review to `3-log` or `5-personal`, team digest to `2-work` or `4-shared` depending on tier, evidence ledger to a machine-readable sidecar.
9. **Optional sync/publish.** User can push approved team/external artifacts to Team Brain and optionally create/update Linear issues from approved next actions.
10. **Learn from failures.** If the verifier fails after budget exhaustion or the human rejects a class of output, AIOS records a small incident/memory note so future weekly loops improve.

## Success criteria

Product success:

- A first-time user can run the loop from cockpit or CLI with sample data in <10 minutes.
- A real operator can complete weekly closeout in <20 minutes after sources are configured.
- At least 90% of material claims in accepted digests have valid source citations in dogfood review.
- Zero known admin/private-tier leaks in approved shareable outputs during dogfood.
- At least 70% of weekly runs produce one or more approved next-week actions.
- Users choose to run the loop at least three consecutive weeks in dogfood before team aggregation is introduced.

Quality gates:

- Rubric must pass all must-fail criteria before an output is marked "verified".
- Failed verification is visible and preserved; the UI/CLI must not silently publish a failed digest.
- PM writeback proposals are evidence-linked and idempotent; no duplicate Linear issues for the same action in the same window.

## Non-goals

- Fully autonomous weekly reporting without human approval.
- Reading arbitrary cloud tools directly during synthesis before their content is represented as local, tiered artifacts.
- Replacing Linear/Jira/Plane as the system of record for engineering execution.
- Team-wide analytics or manager dashboards; those belong to the Team Brain milestone.
- Perfect semantic deduplication across all work artifacts in v1.
- Generating polished client-ready narratives without source-backed operator review.

## Functional requirements

### FR1 — Loop configuration

- Define a local config block for weekly loop settings: cadence, window, source globs, excluded paths, output paths, default tiers, project slug, PM provider, and verification budget.
- Provide sensible defaults for consultant and employee contexts.
- Support one-off overrides from CLI/cockpit without mutating defaults unless the user confirms.

### FR2 — Source collection and evidence ledger

- Build a deterministic source index before drafting.
- Record every source path read, its inferred tier, source kind, timestamp/window relevance, and content hash where cheap.
- Extract structured signals: decisions, task deltas, commitments, blockers, shipped artifacts, scope moves, risks, inbox items, and prior carry-over actions.
- Preserve enough evidence snippets for review without copying whole private documents into shareable outputs.

### FR3 — Synthesis outputs

- Produce two distinct artifacts:
  - **Private operator brief** — candid admin/private-tier closeout and next-week plan.
  - **Shareable digest** — team/external-tier update derived only from allowed sources.
- Include required sections: highlights, decisions, shipped/changed work, blockers, risks, next-week commitments, open questions, and proposed PM updates.
- Every material claim in the shareable digest must cite a source path or evidence-row identifier.

### FR4 — Verification and correction loop

- Use an independent verifier context that receives the candidate output, rubric, source index, and source paths, not the drafter's reasoning.
- Check grounding, completeness, tier safety, task/decision fidelity, actionability, and format.
- Run targeted correction for must-fail criteria until pass or budget exhaustion.
- Return `passed`, `loops_used`, `budget`, `grade_report`, output paths/proposals, and any unresolved failures.

### FR5 — Human approval

- Show a review screen/command with: private brief, shareable digest, verifier report, source list, redactions, proposed writes, proposed sync, and proposed PM changes.
- Allow approve/reject/edit per artifact and per PM action.
- Persist rejection reasons or corrections as optional incidents/memory rules.

### FR6 — Local writeback

- Write approved artifacts with valid frontmatter: title, date/window, access, source window, generated-by, verification status, and provenance.
- Never overwrite a human-edited weekly brief without an explicit new version or confirmation.
- Store evidence ledger as JSON or Markdown sidecar linked from the brief.

### FR7 — Team Brain and PM sync

- Reuse existing `aios push` tier filtering; admin/private outputs never sync.
- PM proposals may create/update Linear issues only after human approval.
- Every PM issue created from the loop should include source links, originating weekly window, AIOS path, and an idempotency key.
- If Team Brain or PM sync is unavailable, the loop still completes locally and reports pending actions.

### FR8 — Cockpit and CLI surfaces

- CLI: `aios weekly run`, `aios weekly review`, and `aios weekly approve` or equivalent.
- Cockpit: guided weekly closeout with source coverage, verifier status, redaction preview, and publish buttons.
- Both surfaces call the same underlying plan/review/approve model.

## Verifier and rubric requirements

The weekly operator loop should ship with a concise rubric using the same pattern as existing AIOS rubrics: frontmatter budget, `pass: no-must-fails`, and a small table of checkable criteria.

Suggested must-pass criteria:

| ID | Criterion | Check method | Must |
|----|-----------|--------------|------|
| WL1 | Every material claim in the shareable digest cites a source path or evidence ID that exists in the source index. | grounding-read | yes |
| WL2 | No admin/private-tier content appears in team/external outputs. | tier-scan | yes |
| WL3 | All decision-log entries in the weekly window are represented or explicitly grouped as omitted/low-signal. | count-vs-index | yes |
| WL4 | Task deltas and blocker states match the task source of record; no invented status changes. | grounding-read | yes |
| WL5 | Proposed Linear/PM actions map to an explicit commitment, blocker, or next action in the evidence ledger. | grounding-read | yes |
| WL6 | The digest distinguishes observed facts from inferences/recommendations. | deterministic | yes |
| WL7 | Output includes required sections and stays within the configured length budget. | deterministic | no |
| WL8 | Redactions are explained without revealing the redacted private content. | tier-scan | no |

Verifier behavior:

- Verification must be adversarial and independent, not self-critique in the drafting context.
- Verification should re-open source paths for grounding checks instead of trusting collected excerpts when feasible.
- Must-fail correction should be surgical: fix failing criteria without regenerating already-passing sections.
- A failed verification is a valid run result and should block the "verified" badge.

## Privacy and tier requirements

- **Local-first by default.** The loop reads local workspace files; cloud integrations feed the loop only through explicit local imports or connected adapters with user consent.
- **Two-artifact model.** Private operator brief and shareable digest are separate files with separate tiers.
- **Default deny.** Missing or ambiguous `access` frontmatter means a source cannot contribute to a shareable output unless the user explicitly classifies it.
- **Admin/private never syncs.** Private brief, raw inbox, sensitive strategy, rates, P&L, negotiation notes, and personal notes cannot be pushed to Team Brain or PM tools.
- **Tier-aware derivation.** A team/external digest may summarize allowed facts but must not quote or paraphrase private-only details.
- **Redaction log.** The review screen should show that content was excluded and why, without exposing sensitive text in the shareable artifact.
- **Auditability.** Approved writes and syncs include provenance: source window, source paths/evidence IDs, verifier status, approver, and timestamp.
- **No silent writeback.** Linear/PM changes require per-action approval.

## Milestones / epics

### M1 — Local verified loop (solo magic)

Goal: one operator can run a weekly closeout locally and get a verified private brief plus shareable digest.

Scope:

- Config defaults and source index.
- Evidence ledger extraction.
- Private and shareable draft generation.
- Weekly-loop rubric and independent verifier.
- CLI review/approve path.
- Local writeback with provenance.

Exit criteria:

- Sample workspace weekly run passes verifier.
- Dogfood run on a real workspace produces no tier leaks.
- User can reject or approve writes without manual file surgery.

### M2 — Publish and PM handoff

Goal: approved weekly output safely creates team-visible context and actionable PM updates.

Scope:

- Cockpit review experience.
- Team Brain push of approved team/external digest.
- Linear issue proposal/create/update path.
- Idempotency and duplicate detection for PM actions.
- Pending-sync state when remote services are unavailable.

Exit criteria:

- Approved digest appears in Team Brain with tier filtering intact.
- Approved Linear issues contain source/provenance links.
- Re-running the same weekly window does not duplicate issues.

### M3 — Loop learning and team readiness

Goal: repeated solo loops become reliable inputs for team-level synthesis.

Scope:

- Incident capture from failed verification and human rejection.
- Carry-over action tracking from prior weekly briefs.
- Metrics: run completion, verification pass rate, correction loops, approval rate, PM action acceptance.
- Stable artifact schema for Team Brain aggregation.

Exit criteria:

- Three consecutive dogfood weeks produce comparable weekly artifacts.
- Team Brain can query weekly digests by member/project/window.
- Product has enough telemetry to decide what belongs in the team-loop milestone.

## Suggested Linear epics and first issues

### Epic: VWO-1 — Weekly loop configuration and source index

Objective: make the weekly run deterministic and inspectable before any model drafts content.

First issues:

1. **Define weekly loop config schema**
   - Acceptance: supports cadence/window, source globs, excluded paths, output paths, tiers, project slug, PM provider, and verifier budget.
2. **Implement source index builder**
   - Acceptance: lists candidate files, inferred/access tier, kind, relevance, and read status; excludes ambiguous-tier files from shareable synthesis.
3. **Add sample workspace weekly fixture**
   - Acceptance: fixture contains decisions, tasks, inbox notes, and expected source-index snapshot.

### Epic: VWO-2 — Evidence ledger extraction

Objective: convert weekly source material into small, reviewable, evidence-linked records.

First issues:

1. **Extract decisions and task deltas for a weekly window**
   - Acceptance: all rows in window represented with source path/row key.
2. **Extract commitments, blockers, risks, and shipped artifacts**
   - Acceptance: each record has `kind`, `claim`, `source`, `tier`, and `confidence`.
3. **Persist evidence ledger sidecar**
   - Acceptance: JSON/Markdown sidecar links to generated brief and can be re-used by verifier.

### Epic: VWO-3 — Verified synthesis harness

Objective: produce briefs that earn trust through independent verification.

First issues:

1. **Create weekly-operator-loop rubric**
   - Acceptance: rubric validates under existing rubric validator and covers grounding, tiers, decisions, tasks, PM actions, and inference labeling.
2. **Build draft → grade → correct workflow**
   - Acceptance: returns `passed`, `loops_used`, `grade_report`, private brief, shareable digest, and unresolved failures.
3. **Add failed-verification fixture**
   - Acceptance: intentionally bad digest fails expected must-pass rubric criteria.

### Epic: VWO-4 — Human review and local writeback

Objective: keep the human in control of every artifact and action.

First issues:

1. **Design CLI review output**
   - Acceptance: displays outputs, verifier status, source coverage, redactions, and proposed writes.
2. **Implement per-artifact approve/reject/edit flow**
   - Acceptance: user can approve private brief and reject shareable digest independently.
3. **Write approved artifacts with provenance frontmatter**
   - Acceptance: generated files pass frontmatter validation and never overwrite human edits silently.

### Epic: VWO-5 — Publish, Linear handoff, and idempotency

Objective: turn approved weekly outputs into safe team context and actionable work.

First issues:

1. **Create PM action proposal format**
   - Acceptance: every proposed Linear action has title, body, evidence ID, source path, owner, due date if known, and idempotency key.
2. **Implement approved Linear create/update path**
   - Acceptance: no PM write occurs before approval; duplicate window/action re-runs update or no-op.
3. **Add Team Brain publish path for weekly digest**
   - Acceptance: uses existing tier-filtered `aios push`; admin/private artifacts are blocked.

### Epic: VWO-6 — Cockpit weekly closeout

Objective: make the loop feel like a product, not a script.

First issues:

1. **Add weekly closeout entry point in cockpit**
   - Acceptance: user can choose window, inspect source coverage, and start a run.
2. **Build verifier/redaction review panel**
   - Acceptance: must-fail criteria and redacted categories are visible before approval.
3. **Add publish confirmation step**
   - Acceptance: push and Linear actions are separate explicit confirmations.

## Open questions

- Should the private operator brief live under `3-log/weekly/`, `5-personal/weekly/`, or a new conventional path?
- Should the shareable digest default to `team` or context-specific outward tier (`client`/`company`) for consultant/employee workspaces?
- What is the minimum source set for v1: decision log + tasks only, or include inbox/work artifacts by default?
- How should ambiguous-tier source files be resolved in cockpit: block run, exclude from shareable output, or prompt user to classify?
- Should Linear writeback happen from the individual workspace directly or through Team Brain once a digest is pushed?
- What is the canonical idempotency key for PM actions: evidence hash, weekly window + normalized title, or generated stable action ID?
- How much of the evidence ledger should be pushed to Team Brain for team-level synthesis?
- Should verifier failures automatically create memory incidents, or only after human confirmation?
- What dogfood threshold earns the "verified" badge in the UI: one pass, repeated pass rate, or pass plus human acceptance?
