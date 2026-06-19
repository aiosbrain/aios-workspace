---
kind: rubric
applies_to: agentic-maturity
budget: 2
pass: no-must-fails
---
# Rubric — agentic-maturity

| ID  | Criterion | Check method | Must |
|-----|-----------|--------------|------|
| AM1 | The verification cap was applied: if the Verification axis ≤ 1, the Spine level is held at L3 or below | deterministic | yes |
| AM2 | Each of the five axis scores is one of {0,2,4} (or an explicitly justified odd value) and traces to an answer or a signal — no scores invented without basis | grounding-read | yes |
| AM3 | The prescription targets the **weakest** axis (or the highest-priority `patternMap` entry for the placement), not a random pattern | deterministic | yes |
| AM4 | `.claude/memory/MATURITY.md` was actually written: Current placement updated AND a History row appended | file-exists | yes |
| AM5 | The placement states whether it was driven by `aios analyze` signals, the interview, or both | deterministic | yes |
| AM6 | Each prescribed pattern names a concrete first action the owner can take this week | deterministic | no |
| AM7 | Tone is honest and non-inflating — a low placement is stated plainly, not softened into meaninglessness | deterministic | no |
