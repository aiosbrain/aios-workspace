# AIOS product roadmap — three milestones

Status: draft product definition
Scope: AIOS Workspace + Team Brain product direction

## Product thesis

AIOS wins if it becomes the trusted operating layer for agent-assisted work: local enough to respect private context, structured enough for agents to do real work, and verified enough that humans can safely act on the output.

The roadmap has three compounding milestones:

1. **Solo loop magical** — one person closes their week with a verified operator loop.
2. **Team loop undeniable** — many verified solo loops compound into a shared team operating system.
3. **Harnesses as the product** — verified workflow harnesses become the extensible unit users adopt, share, evaluate, and buy into.

These are not separate products. Each milestone should leave behind artifacts, schemas, and trust mechanisms that the next milestone reuses.

---

## Milestone 1 — Solo loop magical

### Promise

"AIOS helps me run my work every week. It knows what changed, what I decided, what is blocked, what I owe next, and what is safe to share — and it proves its work."

### Primary user

A solo consultant, IC, founder, or operator using a personal AIOS workspace as their day-to-day execution system.

### Product wedge

The **Verified Weekly Operator Loop**: a weekly closeout that collects local work signals, drafts a private brief and shareable digest, verifies both against evidence and tier policy, and lets the user approve local writes, Team Brain sync, and Linear/PM actions. (Detailed PRD not yet landed — this milestone doc is the product definition.)

### Core capabilities

- Local workspace scaffold with reliable tiers, validators, and guard hooks.
- Weekly source collection across decisions, tasks, deliverables, inbox summaries, and prior carry-over actions.
- Evidence ledger that links claims to source paths/rows.
- Private operator brief plus team/external-safe digest.
- Independent verifier and rubric-gated correction loop.
- Human approval before writeback, sync, or PM updates.
- Cockpit experience that feels like a weekly ritual, not a raw agent chat.

### What must feel magical

- The user recognizes their actual week, not a generic summary.
- The output catches something the user would have missed: a stale blocker, unlogged decision, unowned next action, or unsafe-to-share note.
- The user trusts the digest because they can inspect evidence, redactions, and verifier status.
- The user finishes with concrete next actions, not just a recap.

### Exit criteria

- Three consecutive dogfood weekly runs per active user with no private-tier leaks.
- Median weekly closeout time under 20 minutes after initial setup.
- Shareable digest passes must-pass verifier criteria in at least 90% of accepted dogfood runs.
- At least 70% of accepted runs produce approved next-week actions.
- User can run the loop from cockpit and CLI against the same underlying plan/review/approve model.

### Product risks

- If verification is too slow or verbose, users skip the ritual.
- If the source model is too strict, the loop produces thin summaries.
- If privacy behavior is unclear, users will not approve sync or PM writeback.

---

## Milestone 2 — Team loop undeniable

### Promise

"When every operator closes their week in AIOS, the team gets an accurate, tier-safe operating picture without status theater."

### Primary user

Team lead, founder, delivery lead, or manager responsible for coordinating work across multiple AIOS users.

### Product wedge

Team Brain consumes verified weekly artifacts from individual workspaces and turns them into a cross-team view of decisions, blockers, commitments, risks, ownership, and project momentum. The team loop should make the value of individual weekly loops obvious: fewer repeated status meetings, fewer hidden blockers, and better continuity between people.

### Core capabilities

- Stable weekly artifact schema from the solo loop: member, project, window, tier, evidence references, decisions, blockers, commitments, risks, and PM links.
- Team Brain aggregation by project, member, customer/company, and time window.
- Tier-filtered team queries: "what changed this week?", "what is blocked?", "what decisions need follow-up?", "what did we promise externally?"
- Manager/team cockpit view with verifier status and source coverage, not just generated prose.
- Conflict and drift detection across members: duplicated commitments, contradictory decisions, stale blockers, and missing owners.
- Pull-back path: individual workspaces can pull relevant team context into `1-inbox/from-brain/` without auto-promoting it.

### What must feel undeniable

- A lead can answer status questions from verified artifacts instead of chasing people.
- Team synthesis identifies cross-person issues no single workspace could see.
- Team Brain preserves privacy boundaries: admin/private never appears, external users see only external-safe context.
- Individual operators benefit from the team loop because they receive useful pull-backs, not just reporting overhead.

### Exit criteria

- At least three operators push verified weekly digests for the same project over two consecutive weeks.
- Team Brain can produce a tier-safe project weekly brief with citations to member artifacts.
- Cross-member blocker/commitment detection finds at least one real coordination issue in dogfood.
- External-tier query path returns only external-safe artifacts.
- Team loop does not require operators to abandon their local workspace flow.

### Product risks

- If team value feels extractive, operators will stop running solo loops.
- If aggregation loses provenance, team leads will not trust it.
- If tier semantics differ between workspace and brain, privacy bugs become product-ending.

---

## Milestone 3 — Harnesses as the product

### Promise

"AIOS is where teams install, run, evaluate, and improve verified agent workflows — not just where they chat with an agent."

### Primary user

AIOS power user, team operator, solutions engineer, or maintainer who wants repeatable agent workflows for real operational jobs.

### Product wedge

The harness becomes the atomic product unit: a packaged workflow with source expectations, rubrics, verifier behavior, sample fixtures, tier policy, output schemas, and dogfood/evaluation history. Users should be able to discover a harness, understand when to use it, run it safely, trust its verifier, adapt it to their workspace, and share it through Team Brain.

### Core capabilities

- Harness registry/catalog with metadata: job-to-be-done, required sources, outputs, tiers, verifier rubric, cost profile, and sample run.
- Harness SDK/conventions: collect, draft/extract, verify, correct, review, writeback; plus guidance for when single-pass is better.
- Rubric validator and fixture/eval harness for regression testing outputs.
- Share/pull/install flow for harnesses and supporting artifacts through Team Brain.
- Versioning, provenance, and compatibility checks for harnesses installed into workspaces.
- Cost/quality telemetry: pass rate, correction loops, false-positive patterns, human rejection reasons.
- Starter harness families beyond weekly loop: ticket hygiene, decision audit, scope drift, transcript decisions, stakeholder update, incident review.

### What must feel like a product

- A harness has a visible contract and quality bar, not just a prompt file.
- Users can inspect why a harness output is verified.
- Teams can improve harnesses through incidents, rubrics, fixtures, and versioned releases.
- The marketplace/catalog reinforces AIOS's differentiation: **verification is the value, not parallelism.**

### Exit criteria

- At least five harnesses follow the same package shape and pass validation.
- A user can install/pull a harness and run it against a sample fixture without reading implementation internals.
- Harness outputs expose verifier status consistently across CLI, cockpit, and Team Brain artifacts.
- Maintainers can compare harness versions on fixture outputs before release.
- Dogfood telemetry identifies which harnesses are trusted, rejected, or too expensive.

### Product risks

- Harnesses become a loose prompt library instead of reliable product units.
- Too much SDK ceremony discourages creation.
- Without evaluations, users cannot tell high-trust harnesses from demos.

---

## Roadmap dependency chain

| Foundation | Feeds | Why it matters |
|------------|-------|----------------|
| Access tiers + default-deny sync | All milestones | Privacy is the adoption gate. |
| Weekly evidence ledger | Team aggregation + harness SDK | Structured evidence turns summaries into queryable product data. |
| Rubric-gated verifier loop | Solo trust + harness product | Verification is AIOS's core differentiator. |
| Human review/approval | PM sync + Team Brain sharing | Keeps AI useful without making it autonomous in unsafe places. |
| Stable artifact schemas | Team Brain and catalog | Lets individual runs compound across people and harnesses. |

## Sequencing recommendation

1. Ship the Verified Weekly Operator Loop locally before expanding team surfaces.
2. Add Team Brain aggregation only after solo weekly artifacts are stable and repeatedly dogfooded.
3. Generalize harness packaging from the weekly loop implementation rather than designing an abstract SDK first.

## Open product questions

- What is the narrowest weekly source set that still feels magical?
- Should the weekly loop be the default cockpit home screen?
- Which PM system should be treated as the reference implementation for writeback: Linear, Plane, or provider-neutral first?
- How much verifier telemetry can be collected locally without violating AIOS's privacy posture?
- Should harnesses be distributed as plain workspace files, signed packages, or Team Brain-managed artifacts?
- What is the pricing/adoption unit later: workspace, team brain seat, harness catalog, or managed harness packs?
