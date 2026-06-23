---
title: AIOS product assessment and roadmap
access: team
status: draft
owner: john
created: 2026-06-23
---

# AIOS product assessment and roadmap

## Executive read

AIOS is much more interesting than "AI workspace + dashboard." The strong idea is
that it treats agent work as an operating model: local-first personal workspaces,
explicit information promotion, governed sync, reusable harnesses, and a shared
brain that can answer across the team without turning every private note into
shared state.

My read: **AIOS is a serious project with the shape of something built from real
operating pain, not from a product brainstorm.**

The strongest positioning:

> **AIOS turns individual agent work into trusted team memory.**

Or, in fuller product language:

> **AIOS gives every person a private agent workspace, then lets the team promote
> verified work into one shared brain.**

That sentence captures the architecture, the privacy model, and the reason the
product matters.

---

## What is already strong

### 1. The privacy/share boundary is a product primitive

The private → team → external tier model is not just copy. It appears in
frontmatter, validators, hooks, CLI default-deny behavior, the brain API, and
server-side rejection of admin-tier content. That is the part that makes the
system believable for real teams.

Most AI tools behave like this:

```text
everything goes into the SaaS tool → maybe permissions later
```

AIOS behaves like this:

```text
private by default → explicit promotion → tier-gated sync → auditable shared brain
```

That is much closer to how real teams actually work. People need private scratch
space. Teams need shared memory. Clients and company-wide audiences need a clean
surface. The mistake is collapsing those into one blob.

### 2. The numbered spine is simple enough to survive

The workspace spine is plain files, legible to humans, legible to agents, diffable,
and portable:

```text
0-context/   role, charter, scope, OKRs
1-inbox/     raw inputs, transcripts, pulled brain items
2-work/      working documents and deliverables
3-log/       decisions, tasks, hours
4-shared/    outward-facing company/client artifacts
5-personal/  private scratch
```

That is exactly the kind of boring substrate agent systems need. It gives agents
orientation without hiding the work in a database.

### 3. Harnesses are the real differentiator

The docs are clear that the goal is not simply "chat with your repo." The goal is
repeatable operational workflows:

- decision audit
- scope creep detection
- transcript-to-decisions
- weekly synthesis
- task hygiene
- maturity reporting

The adversarial verification layer is the right instinct. Agent work gets valuable
when output is checked, not when prompts get longer.

### 4. The contract discipline is a moat

Pinning `aios-workspace/docs/brain-api.md` as the shared contract between Workspace
and Team Brain is the kind of practice that keeps an ecosystem from turning into
integration mush.

The contract is not a detail. It is the product boundary.

### 5. The GUI is the bridge

The local cockpit is the right bridge between agent power and team adoption. It
lets non-terminal users chat, review, connect tools, install skills, and push
selected work while the underlying system remains CLI + files + agents.

The cockpit should become the place where people learn the operating model:

```text
capture → run harness → verify → review → promote → query
```

---

## How AIOS works

AIOS has three main product surfaces.

### 1. Individual Workspace

Each person gets a local workspace. It is a structured repo with a numbered spine,
governance rules, validators, skills, integrations, sync client, and local cockpit.

The core motion:

```text
capture locally → refine in the spine → mark access tier → review → push selected content
```

Nothing leaves by default.

### 2. Team Brain

The Team Brain is the shared hub. Multiple workspaces push tier-tagged content to
it through the `aios` CLI/API.

It stores and surfaces:

- synced items and versions
- tasks
- decisions
- projects
- graph entities and relationships
- audit logs
- integrations
- codebase metrics
- maturity metrics
- AI spend/cost records
- PM links to tools like Linear or Plane

The architectural center:

```text
Workspace pushes tier-safe content
        ↓
Team Brain ingests, versions, materializes tasks/decisions
        ↓
Dashboard + query layer retrieve only what the caller is allowed to see
```

### 3. Website, docs, and design system

The public website is the front door. The design system is now a sibling source of
truth, which is smart. It gives all surfaces one token-driven visual language:
dark/light modes, violet/lime identity, Space Grotesk / Plus Jakarta / JetBrains
Mono, and consistent app/marketing primitives.

---

## What the product actually is

AIOS should not be positioned primarily as a knowledge base. That category is too
weak and too crowded.

The stronger category:

> **A local-first operating system for agentic team work.**

More practically:

> **GitHub + Claude Code + knowledge base + governance layer + team memory,
> packaged for AI adoption.**

The strongest wedge is teams that are already trying to use agents seriously but
are stuck with:

- context scattered across chat, docs, tickets, and local files
- no durable way to share agent-produced work
- no trust boundary between private thinking and team memory
- no repeatable agent workflows
- no way for non-engineers to participate in agent workflows safely
- no visibility into whether AI work is improving the team

AIOS has credible answers to all of those.

---

## Biggest risk

The biggest risk is **surface area**.

AIOS already includes or points toward:

- workspace scaffolding
- cockpit GUI
- sync client
- Team Brain dashboard
- natural-language query
- Slack ingestion
- Linear/Plane PM sync
- skills marketplace/library
- BYOA runtime adapters
- MCP bridge
- codebase analytics
- AI spend analytics
- maturity scoring
- agent relay/build loops
- website/docs/design system

All of it fits the vision, but it can overwhelm a new user. The product needs one
killer first-run journey.

The first 10 minutes should be almost painfully simple:

1. Create a workspace.
2. Add one profile/context source.
3. Drop in one transcript or working note.
4. Run one harness.
5. Review what would sync.
6. Push one item.
7. Ask the Team Brain one question.

That single loop should be immaculate.

---

## The most exciting product primitive: the verified weekly operator loop

The feature I would most want to build is the **verified weekly operator loop**.

It reads across the week:

- workspace logs
- tasks
- decisions
- transcripts
- Slack/Linear/GitHub context
- previous weekly summaries

It produces:

- what changed
- decisions made
- open risks
- blocked work
- stale commitments
- owner-by-owner next actions
- suggested pushes to Team Brain

The important part: it is verifier-gated.

The workflow should produce a useful weekly operator brief, then run adversarial
checks:

- Is every claim grounded in a source?
- Are any tasks invented?
- Are blockers still current?
- Did it miss decisions?
- Did it accidentally include private/admin-tier material?
- Are next actions traceable to real commitments?

This could become the first "wow" moment:

> AIOS read my week, found the real state of play, caught stale promises, and
> prepared the team update without leaking private notes.

That is powerful.

---

## Three product milestones

### Milestone 1 — Make the solo loop magical

One user, one workspace, one cockpit.

The user should be able to:

```text
create workspace → chat → draft profile → connect one source → run one harness → review → push/query
```

Success looks like:

- a non-expert can understand the spine
- onboarding writes useful memory/context with confirmation
- the cockpit explains what is private, team, and external
- one harness produces a grounded artifact
- Review & Push makes the promotion model obvious
- the user can ask the brain a useful first question

### Milestone 2 — Make the team loop undeniable

Two or three users push into one Team Brain.

The brain should answer:

- What changed this week?
- What decisions did we make?
- What is blocked?
- What should I read before the next meeting?
- What work is ready to share externally?

Success looks like:

- each member can push safely
- the Team Brain homepage explains what changed since last visit
- decisions and tasks materialize reliably
- natural-language query returns grounded answers
- private/admin-tier content is visibly blocked before sync
- the team can run one weekly operating ritual from AIOS

### Milestone 3 — Make harnesses the product

Package the top repeatable workflows so they feel like product features, not scripts.

Priority harnesses:

- Decision Audit
- Transcript → Decisions
- Weekly Operator Brief
- Scope Creep Review
- Task/PM Hygiene

Each should have:

- required inputs
- output schema
- verifier strategy
- tier behavior
- sample data
- rubric
- install provenance
- safe-to-run disclosure
- UI entry point

Success looks like:

- users discover harnesses from the cockpit
- each harness has a clear "when to use this" moment
- outputs are verified and source-grounded
- useful outputs can be promoted into the brain
- teams can create and share their own harnesses safely

---

## What to build next

If this were my product ecosystem, I would sequence the next work like this:

1. **Promotion inbox** — turn Review & Push into a real publishing workflow.
2. **Verified weekly operator loop** — make weekly synthesis the flagship harness.
3. **Team Brain "What changed?" home** — make the shared dashboard useful before
   anyone asks a question.
4. **Agent run ledger** — make every harness/agent run auditable.
5. **Harness library** — package verified workflows as first-class product features.
6. **AI adoption maturity dashboard** — measure context hygiene, verification, and
   durable team practice, not just token usage.

---

## Final product thesis

AIOS is exciting because it does three hard things at once:

1. **It gives agents structure** through the workspace spine and harnesses.
2. **It gives teams trust boundaries** through access tiers and default-deny sync.
3. **It gives organizations shared memory** through the Team Brain.

The homepage, docs, cockpit, and roadmap should all point at the same sentence:

> **Turn individual agent work into trusted team memory.**
