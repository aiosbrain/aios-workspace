---
access: team
type: artifact
status: draft
owner: Stephan
created: 2026-07-15
---

# Stéphane's Contribution — Bootstrapping the Classification Rules (Open Question #1)

This document is Stephan Ledain's (AdaptAI) contribution addressing Open Question #1 from the product vision: *How do we bootstrap the classification rules?*

It proposes a three-stage methodology — Governance Culture Discovery — grounded in AdaptAI's behavioral science IP and consulting practice. It is intended to be incorporated into the product vision and referenced in the Linear PRD for the classification layer.

---

## The Core Argument

The classification framework provides the structure. It does not provide the rules.

What falls into Category 3 at a law firm is not what falls into Category 3 at a pharmaceutical company or a trading desk — not because the category definition changes, but because the human contribution that is genuinely irreducible is culturally embedded. It reflects professional identity, organizational norms, accountability history, and the specific ways this team has learned to work. No regulatory text specifies it. No configuration panel surfaces it. It has to be discovered.

This is where behavioral science earns its place. The bootstrapping process is not product onboarding. It is a structured inquiry into where an organization's judgment actually lives — distinct from where it is assumed to live, and distinct from where a policy document says it should live. The output is a classification corpus that is genuinely bespoke: a legible map of this organization's governance culture, built from evidence rather than assumption. That corpus is also a compliance artifact — documented proof that the governance posture was deliberately designed, not inherited by default.

This is the thing well-funded competitors cannot replicate by hiring more engineers. The expertise required is not technical. It is the ability to study a complex human system rigorously and surface what is otherwise invisible.

---

## Three-Stage Bootstrapping Process

### Stage 1 — Governance Culture Discovery

The first stage is a structured inquiry, not a labeling exercise. It runs in one of two tracks depending on organizational context and buyer profile.

**Track A — Facilitated session (consulting engagement, premium)**

Key stakeholders from across functions — legal, engineering, product, compliance — in the same room for 90 minutes. A facilitator walks the group through 8–12 recent resolved decisions as case studies, chosen to span the range: decisions that went well, decisions that surprised people, decisions where someone flagged uncertainty.

For each case, a structured sequence of questions:
- What did you contribute that was not in the AI output?
- Who else on this team could have made the same call the same way you did?
- If you had approved this in ten seconds, what was the risk?
- Should the system ever auto-resolve something like this?

The group format is not incidental. People often cannot articulate the nature of their own contribution in isolation — the vocabulary develops through comparison and peer challenge. When one person says "I just approved it" and another says "but you changed the framing entirely," the distinction between Category 1 and Category 3 becomes concrete for the first time.

The session produces two outputs: a labeled corpus of the case studies, and a shared vocabulary document that names the decision types the team now agrees require judgment. That vocabulary document is an organizational artifact — it persists beyond the platform and is usable as a compliance exhibit.

This track is the consulting practice made concrete. It is not abstract EU AI Act advice — it is a specific, facilitated session that produces a documented, bespoke governance corpus. This is the Red Hat model in practice: consulting creates the initial deployment, the platform subscription sustains it.

**Track B — Survey-based (platform-native, Tier 2)**

Stakeholders complete a structured case-review survey asynchronously, working through the same question sequence against cases they nominate or the platform surfaces. The platform collates responses, flags disagreements between stakeholders on the same case, and synthesizes candidate classification rules for team review.

Lower initial fidelity than Track A, but sufficient to seed the feedback loop and improve from real usage. Suited to technical teams, Tier 2 buyers, and organizations that want to start quickly without a consulting engagement.

**Behavioral design constraints — both tracks**

*The Effort Heuristic* — polished, well-structured AI output suppresses the scrutiny signal. People read surface quality as evidence that judgment is not needed. Case studies in Track A, and survey prompts in Track B, must be anchored on decision context and what was at stake — not on the quality of the finished output. The question is never "was the output good?" It is "was your contribution to this decision irreducible?"

*The Default Effect* — whatever the platform pre-selects as the classification will dominate the corpus. The default must be "uncertain," requiring the operator to actively classify downward into "no contribution needed," not upward into "judgment required." A corpus built on an opt-in default systematically under-identifies Category 3 and 4 items.

---

### Stage 2 — Passive Feedback Loop

As real decisions arise after Stage 1, the platform surfaces suggested classifications based on the corpus. Operators confirm or correct with a single interaction — no dedicated labeling task. Each correction refines the model. Stage 1 established the vocabulary; Stage 2 trains the classifier against live decisions without adding burden to busy people.

---

### Stage 3 — Pattern Surfacing and Rule Formalization

Once sufficient feedback has accumulated, the platform identifies structural features of decisions the operator consistently upgrades from Category 1 handling — the decision types, domains, counterparties, or contexts where contribution is reliably non-reducible. These become candidate Category 3/4 classification rules, proposed for review and locked in as versioned, configurable governance rules.

---

## How This Connects to the Revenue Model

| Track | Tier | Who buys | What they get |
|-------|------|----------|---------------|
| Track A | Consulting (ancillary) + Tier 3 | Compliance officer / CISO | Facilitated session, labeled corpus, vocabulary document, configured enterprise governance layer |
| Track B | Tier 2 | Team lead / EM | Platform-native survey, synthesized candidate rules, passive feedback loop |

Track A is not optional for Tier 3 enterprise customers — it is the mechanism by which the behavioral science gets applied to their specific organizational context. That is what justifies the consulting premium and what no competing tool can provide.

---

## IP Note

The Effort Heuristic, Default Effect framing, and the core argument that governance rules are cultural artifacts are AdaptAI IP (Stéphane Ledain / AdaptAI LLC). Attribution consistent with existing product vision treatment of Role Drift and the four-category framework.
