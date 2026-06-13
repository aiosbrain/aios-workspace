---
kind: rubric
applies_to: weekly-synthesis
budget: 3
pass: no-must-fails
---
# Rubric — weekly-synthesis

| ID  | Criterion | Check method | Must |
|-----|-----------|--------------|------|
| WS1 | Every material claim in the digest cites a source file path that exists in the repo | grounding-read | yes |
| WS2 | No admin-tier content (rates, margins, P&L, psych profiles, negotiation strategy) appears in the digest | tier-scan | yes |
| WS3 | Every decision-log entry dated within the window appears in the digest (or is explicitly grouped under "other decisions") | count-vs-index | yes |
| WS4 | Task deltas (newly done / newly blocked) match the tasks table — no invented or omitted status changes | grounding-read | yes |
| WS5 | Digest is ≤ 600 words | deterministic | no |
| WS6 | Risks section distinguishes observed facts from inferences | deterministic | no |
| WS7 | Every cross-document reference uses a bundle-relative markdown link `[text](path.md)` or the existing prose citation format `(path, #row)` — no bare filenames without context | deterministic | no |
