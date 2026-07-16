---
access: team
type: artifact
status: draft
owner: Stephan
created: 2026-07-16
---

# Stephan's Contribution — Generalization Beyond Software Engineering (Open Question #4)

This document is Stephan Ledain's (AdaptAI) contribution addressing Open Question #4 from the product vision: *Does the four-category model generalize beyond software engineering?*

It provides two live examples from professional engagements outside software engineering, and proposes two operational tests for identifying Category 3 vs Category 4 decisions in any domain.

Intended location: §13, Open Question #4.

---

## Proposed addition

It does. The category definitions are domain-agnostic. What falls into each category is domain-specific. This is not a limitation of the model — it is the argument for why the governance layer must be an interface rather than a hardcoded stack. The classification rules are the configurable layer; the categories themselves hold across contexts.

Two live examples from engagements outside software engineering illustrate where the boundary sits.

**Category 3 in legal practice.** In a vehicle emissions litigation matter, an AI tool drafted the response letter effectively. The human judgment that improved the outcome was not in the draft — it was in the decision not to upload 400 pages of expert reports to the tool, and to supply the legal answer directly instead. Knowing what context to give the tool and what to retain entirely is task framing — and task framing in legal work requires the lawyer's substantive knowledge of which facts are material, which sources carry weight, and which details create exposure. Remove that touchpoint and the output becomes technically adequate and substantively weaker in ways a quality review of the letter itself would not catch.

More broadly, legal judgment in an agentic workflow belongs at three points: task framing, risk spotting, and source evaluation. Not at the drafting stage. Category 3 in legal practice is not "the lawyer reviews the output." It is "the lawyer determines what the task actually is, what risks it carries, and whether the sources are being used correctly." The AI writes. The lawyer decides what to ask it to write and whether what it drew on was appropriate.

**Category 4 in organizational contexts.** In a large regulated organization mid-AI rollout, a senior leader makes judgment calls about how to position AI-produced work within her team — not because the output quality is in question, but because the team's relationship to the work is. When AI contributes significantly to a deliverable, the question of who gets credit, who feels displaced, and how to frame the contribution so the team feels seen and rewarded for their expertise is a political and relational judgment with real organizational consequences. That read — who needs to feel ownership at this moment, who is at risk, what framing holds the team together — is irreducibly personal. It requires knowing these specific people, their histories, and the cultural moment inside this organization. The value is not the judgment itself. The value is that this specific person, with this specific relational knowledge, made it.

These two examples suggest a consistent pattern across domains. Category 3 is identifiable by asking: would a competent professional with the same training but no relationship knowledge make the same call? If yes, it may be Category 1. If not, it is Category 3. Category 4 is identifiable by asking: could this judgment be transferred by writing better instructions? If not — if the value is the specific person at this specific moment — it is Category 4.

The classification rules will look different in a law firm, a hospital, and a trading desk. The test for which category a decision falls into does not.

---

## Sources

- Legal practice example: AdaptAI coaching engagement, senior solicitor, UK litigation firm (anonymized). Session notes at `accounts/gesa-leigh-day/deliverables/`.
- Organizational context example: AdaptAI advisory engagement, senior leader, regulated manufacturing organization (anonymized). Session notes at `accounts/menexia-tsoubeli-dsm-firmenich/`.

## IP Note

The two operational tests (Category 3: "would a competent professional with the same training but no relationship knowledge make the same call?" / Category 4: "could this judgment be transferred by writing better instructions?") are AdaptAI IP (Stephan Ledain / AdaptAI LLC). The framing that category definitions are domain-agnostic while classification rules are domain-specific is consistent with and extends the governance-as-interface argument in §6.
