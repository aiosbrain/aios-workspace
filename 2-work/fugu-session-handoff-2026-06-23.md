---
title: Fugu session handoff — AIOS positioning and roadmap
access: team
status: draft
owner: john
created: 2026-06-23
---

# Fugu session handoff — AIOS positioning and roadmap

This file preserves the current AIOS product/copy workstream so it can be resumed
from a fresh Fugu/subscription session if the current API/prepaid-credit path stops.

The work now lives on dedicated worktrees/branches instead of the `main` worktrees:

- Workspace/product docs: `/Users/iamjohndass/Projects/aios/aios-workspace-positioning` on `docs/positioning-roadmap`
- Website copy: `/Users/iamjohndass/Projects/aios/aios-website-positioning` on `docs/positioning-copy`

## Current positioning

Primary sentence:

> **Turn individual agent work into trusted team memory.**

Expanded sentence:

> **AIOS gives every person a private agent workspace, then helps the team promote
> verified work into one shared brain.**

Core product thesis:

1. **Private workspaces** give agents structure without forcing raw work into a SaaS.
2. **Verified harnesses** turn prompts into repeatable, grounded operational workflows.
3. **Promotion before sharing** protects private work while building team memory.
4. **Team Brain** makes promoted work queryable across the team.

Avoid positioning AIOS as merely a knowledge base. The stronger category is:

> **A local-first operating system for agentic team work.**

## Work completed in this session

### Product report saved

Saved the full assessment and product thesis here:

- `aios-workspace-positioning/2-work/aios-product-assessment-and-roadmap.md`

This file includes:

- what AIOS is
- how it works
- product strengths
- biggest risk
- recommended positioning
- the verified weekly operator loop
- three product milestones
- recommended next product moves

### Roadmap/PRD drafted

Created product planning docs:

- `aios-workspace-positioning/docs/product-roadmap-three-milestones.md`
- `aios-workspace-positioning/docs/prd-verified-weekly-operator-loop.md`

Updated the existing roadmap index:

- `aios-workspace-positioning/docs/roadmap.md`

The three roadmap milestones are:

1. **Solo loop magical** — one person closes their week with a verified operator loop.
2. **Team loop undeniable** — many verified solo loops compound into a shared team operating system.
3. **Harnesses as the product** — verified workflow harnesses become the extensible unit users adopt, share, evaluate, and improve.

### Website copy rewritten

Rewrote the AIOS website homepage copy around the new positioning.

Changed files:

- `aios-website-positioning/src/pages/index.astro`
- `aios-website-positioning/src/layouts/Landing.astro`
- `aios-website-positioning/src/components/landing/Hero.astro`
- `aios-website-positioning/src/components/landing/StatStrip.astro`
- `aios-website-positioning/src/components/landing/FeatureGrid.astro`
- `aios-website-positioning/src/components/landing/Comparison.astro`
- `aios-website-positioning/src/components/landing/HowItWorks.astro`
- `aios-website-positioning/src/components/landing/QuickStart.astro`
- `aios-website-positioning/src/components/landing/FooterCta.astro`
- `aios-website-positioning/src/components/landing/Footer.astro`
- `aios-website-positioning/src/content/docs/index.mdx`
- `aios-website-positioning/src/content/docs/contributing.mdx`

Also updated the product marketing context file with the new one-liner and
language:

- `aios-website-positioning/.agents/product-marketing-context.md`

Note: `.agents/` may be ignored by git, but it is still updated locally.

## Verified Weekly Operator Loop summary

The flagship proposed primitive:

> AIOS reads the week, finds the real state of play, catches stale promises,
> drafts a private operator brief and shareable team digest, verifies every
> material claim against sources, blocks private-tier leakage, and asks the human
> what to write, push, or mirror into Linear.

The PRD breaks this into suggested Linear epics:

1. `VWO-1` — Weekly loop configuration and source index
2. `VWO-2` — Evidence ledger extraction
3. `VWO-3` — Verified synthesis harness
4. `VWO-4` — Human review and local writeback
5. `VWO-5` — Publish, Linear handoff, and idempotency
6. `VWO-6` — Cockpit weekly closeout

## Suggested resume prompt

If starting a fresh Fugu/subscription session, paste this:

```text
We are working in /Users/iamjohndass/Projects/aios. The relevant worktrees are aios-workspace-positioning and aios-website-positioning.

Please resume the AIOS positioning/product roadmap workstream. First read:
- CLAUDE.md
- aios-workspace-positioning/2-work/fugu-session-handoff-2026-06-23.md
- aios-workspace-positioning/2-work/aios-product-assessment-and-roadmap.md
- aios-workspace-positioning/docs/product-roadmap-three-milestones.md
- aios-workspace-positioning/docs/prd-verified-weekly-operator-loop.md

Then inspect the website copy changes in aios-website-positioning/src/components/landing and
aios-website-positioning/src/content/docs/index.mdx. Continue by validating the website build,
polishing copy if needed, and helping convert the Verified Weekly Operator Loop PRD
into Linear epics/issues.
```

## Billing/session note

The prior sub-agent attempt failed with:

```text
You've hit your usage limit. Prepaid credit balance is exhausted, or try again later.
```

I cannot inspect or change account billing/routing from inside the workspace. To
avoid losing work, this handoff file and the product docs above preserve the
session state locally. If Fugu continues to route to prepaid/API credits instead of
subscription entitlements, start a fresh session using the resume prompt above and
confirm which billing surface the client is using.

## Next recommended steps

1. Run the website build and fix any copy/markup regressions.
2. Review the homepage in-browser for line breaks and section rhythm.
3. Decide whether the new homepage should explicitly mention "open source" in the hero or keep it as a secondary proof point.
4. Convert `VWO-*` epics into Linear manually or via an AIOS/Linear integration.
5. Start implementation with `VWO-1`: config schema + source index + sample weekly fixture.
