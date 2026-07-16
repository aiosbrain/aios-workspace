---
access: team
type: artifact
status: draft
owner: Stephan
created: 2026-07-15
---

# Stephan's Contribution — The Effort Heuristic as Role Drift Accelerator (§7 Addition)

This document is Stephan Ledain's (AdaptAI) contribution to §7 of the product vision — Role Drift: the silent erosion problem.

It proposes adding the Effort Heuristic as a named mechanism that explains *why* Role Drift accelerates in agentic systems specifically, sitting before the four existing detection behaviors and providing their conceptual foundation.

Intended location: §7, after the six-step failure sequence, before "The system's job is to detect and prevent this."

---

## Proposed addition

**Why Role Drift accelerates in agentic systems: the Effort Heuristic**

Role Drift is not unique to agentic systems. But agentic systems create a specific condition that makes it accelerate faster than in prior generations of automation.

There is a cognitive pattern — the Effort Heuristic — by which people read polished, fluent, well-structured output as the product of genuine effort and sound reasoning. A rough draft signals that work remains. A clean, confident output signals that it is done. This heuristic is generally adaptive: in human-produced work, surface quality and underlying rigor are correlated. AI breaks that correlation. It produces polished output regardless of whether the underlying logic is correct, the context is complete, or the judgment call is sound.

In agentic workflows, as agent capability improves, the surface quality of outputs rises consistently. The Effort Heuristic means the human's implicit threshold for "this needs my scrutiny" rises with it — not because they have decided to stop checking, but because the environmental signal that checking was warranted has been suppressed. The approval step remains. The judgment it was meant to require does not.

This is why the four detection mechanisms below are necessary but not sufficient on their own. Speed-of-resolution signals and drift ratios catch Role Drift after it has taken hold. The Effort Heuristic explains why it takes hold in the first place — and why classification-aware routing, distinct presentation, and cognitive-state gating are the countermeasures, not reminders to try harder.

The system's job is to reintroduce the signal that the operator's cognitive environment has removed.

---

## IP Note

The Effort Heuristic is AdaptAI IP (Stephan Ledain / AdaptAI LLC). Defined as: polished, well-structured output mistaken for genuine effort and rigor — AI produces exactly this kind of output regardless of whether the underlying logic is sound. Published in AdaptAI thought leadership (intelligence brief, June 2026). Attribution consistent with existing product vision treatment of Role Drift and the four-category framework.
