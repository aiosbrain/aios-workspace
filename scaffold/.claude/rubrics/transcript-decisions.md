---
kind: rubric
applies_to: transcript-decisions
budget: 2
pass: no-must-fails
---
# Rubric — transcript-decisions

In this rubric, a **candidate** is either a decision proposal destined for
`3-log/decision-log.md` or a task proposal destined for `3-log/tasks-team.md`. The grader
receives every supplied transcript in full, both candidate collections, and both matching
live-log indexes.

| ID | Criterion | Check method | Must |
|---|---|---|---|
| TD1 | Every decision and task candidate's `sourceQuote` occurs verbatim or near-verbatim in its named transcript. | grounding-read | yes |
| TD2 | Every decision candidate is a genuine decision and every task candidate is an explicit commitment; discussion, suggestions, open questions, and inferred work are excluded. | grounding-read | yes |
| TD3 | Every candidate is novel within its own proposal kind and against its matching live log, by substance rather than exact wording. | semantic-dedup | yes |
| TD4 | Every candidate has the required typed fields and losslessly renders to the current header and column order of its matching destination log. | schema-and-render | yes |
| TD5 | Decision attribution or task assignee is a named person present in the transcript. Findings are retained for owner review but never block the batch. | grounding-read | no |
| TD6 | Across the full text of every supplied transcript, every genuine decision and explicit task commitment is represented by a candidate or is substantively present in the matching live log. An empty proposal passes only when this transcript-wide check certifies no novel decisions and no novel tasks. | transcript-wide-completeness | yes |
