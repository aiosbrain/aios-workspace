---
kind: rubric
applies_to: transcript-decisions
budget: 2
pass: no-must-fails
---
# Rubric — transcript-decisions

| ID  | Criterion | Check method | Must |
|-----|-----------|--------------|------|
| TD1 | Every output row's source_quote appears verbatim (or near-verbatim) in its named transcript | grounding-read | yes |
| TD2 | Every row expresses an actual decision or commitment, not discussion or an open question | grounding-read | yes |
| TD3 | No output row duplicates an entry already in the decision log (match on substance) | count-vs-index | yes |
| TD4 | rows_markdown column count and order match the decision-log table header | deterministic | yes |
| TD5 | Attribution (Decided By) is a named person present in the transcript | grounding-read | no |
