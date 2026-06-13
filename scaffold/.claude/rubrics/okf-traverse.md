---
kind: rubric
applies_to: okf-traverse
budget: 2
pass: no-must-fails
---
# Rubric — okf-traverse

| ID  | Criterion | Check method | Must |
|-----|-----------|--------------|------|
| OT1 | Every factual claim in the answer cites at least one [S#] marker that maps to a source path that exists in the repo | grounding-read | yes |
| OT2 | The answer directly addresses the question asked — it is not a topic summary or a description of what the repo contains | deterministic | yes |
| OT3 | No admin-tier content (rates, margins, P&L, internal deliberation marked admin) appears in the answer | tier-scan | yes |
| OT4 | Every source listed in sources[] was actually read during traversal (no invented citations) | count-vs-index | yes |
| OT5 | Answer is ≤ 800 words | deterministic | no |
