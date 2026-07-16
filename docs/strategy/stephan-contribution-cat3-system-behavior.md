---
access: team
type: artifact
status: draft
owner: Stephan
created: 2026-07-15
---

# Stephan's Contribution — Category 3 System Behavior Spec (§5 Addition)

This document is Stephan Ledain's (AdaptAI) contribution to §5 of the product vision — the four-category classification system.

It expands the Category 3 system behavior from a stated intention ("make the human's judgment as effective as possible") into three concrete, specifiable conditions. Intended to replace the current Category 3 system behavior paragraph in §5.

---

## Proposed revision — Category 3 system behavior (expanded)

**System behavior:** These touchpoints should be preserved, not eliminated. The system should flag when a Category 3 touchpoint is being treated as Category 1. The goal is not to remove this touchpoint but to make the human's judgment at this point as effective as possible.

That requires three conditions to hold simultaneously.

**Right context.** The operator needs two things before they can exercise genuine Category 3 judgment. First, the relational and situational layer they hold that the system does not: who this person is, what has been agreed, where the relationship currently stands. Second, the counterfactual: what the agent's output would have been without their involvement. Without the counterfactual, the operator is reviewing an output, not exercising judgment — they have no basis for knowing whether their contribution changes anything. The system should surface both together. A Category 3 item presented without the counterfactual is a Category 1 item in disguise.

**Right timing.** Category 3 judgment is context-sensitive in a way Category 1 approval is not. A relationship decision made three days after the last relevant interaction, in between unrelated tasks, is a qualitatively different act than one made while that context is still live. The system should prefer surfacing Category 3 items at the start of a focus block and avoid batching them at the end of a high-volume inbox session. If the relevant context has aged significantly since the underlying event, the system should flag this before presenting the item.

**Right cognitive state.** A burst of Category 1 approvals primes the operator for speed, not depth — a pattern known as Decision Contamination, where the cognitive mode established by one class of decisions bleeds into the next. A Category 3 item served immediately after ten rapid Category 1 resolutions will be processed in approval mode regardless of how it is labelled. The system should enforce a minimum gap between the last Category 1 resolution and the presentation of a Category 3 item, or defer Category 3 items to the next protected focus block when the operator's session shows a high Category 1 throughput rate.

These three conditions together are what "context-optimized" means in practice. Any one of them missing reduces Category 3 to a slower Category 1.

---

## IP Note

Decision Contamination is AdaptAI IP (Stephan Ledain / AdaptAI LLC). Defined as: the cognitive mode established by one class of decisions bleeding into adjacent decisions — judgment compromised not by the content of what is being decided but by the cognitive state carried in from prior decisions. The right context / right timing / right cognitive state framing is Stephan's behavioral science contribution to Category 3 operationalization.
