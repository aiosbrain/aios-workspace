---
name: okf-traverse
description: |
  Answer a question by traversing the local OKF bundle — reading index files to
  orient, fanning out to relevant documents, following cross-links for context,
  and synthesizing a cited answer. No brain required; works fully offline.
  Use when the Team Brain is unavailable, when content hasn't been synced yet,
  or when you need to understand the link graph of the current repo.
version: 1.0.0
kind: workflow-harness
workflow: okf-traverse.workflow.js
triggers:
  - answer a question about this repo
  - what does the repo say about
  - find information about
  - search the engagement docs
  - offline query
  - traverse the bundle
  - what do we know about
---

# okf-traverse

A question-driven traversal of the local OKF bundle. Unlike `weekly-synthesis`
(periodic, covers a time window), this skill answers a specific question by
reading only the documents relevant to it and following cross-links for context.

## When to use

| Use okf-traverse when | Use aios query when |
|-----------------------|---------------------|
| Brain is offline or unavailable | Brain is online and indexed |
| Content hasn't been synced yet | Content is up to date in the brain |
| Question spans documents + links | Simple keyword or NL retrieval |
| You need to understand the link graph | You want the full corpus searched |

## How to run

Invoke as a Claude workflow skill (via the skill registry) or directly:

```javascript
Workflow({
  scriptPath: ".claude/skills/okf-traverse/okf-traverse.workflow.js",
  args: {
    repoPath: "/absolute/path/to/engagement-repo",
    question: "What governance decisions were made in Sprint 1?",
    maxDepth: 2,   // optional; default 2
  }
})
```

Returns `{ answered, answer_markdown, sources, grade_report }`.

## Phases

1. **Orient** — read root `index.md` + numbered-dir `index.md` files to map the bundle
2. **Fan-out** — parallel reads of question-relevant documents
3. **Deepen** — follow cross-links from fan-out docs at depth +1
4. **Synthesize** — draft answer with OKF-style citations
5. **Grade → Correct** — rubric self-correction loop (budget: 2, from `okf-traverse.md`)

## Key differences from `weekly-synthesis`

| Dimension | weekly-synthesis | okf-traverse |
|-----------|-----------------|--------------|
| Trigger | Periodic / time-window | A specific question |
| Scope | All decisions, tasks, deliverables | Docs relevant to the question |
| Phase 1 | Collect hardcoded paths | Orient via index.md discovery |
| Output | Digest in fixed sections | Free-form cited answer |
| Cross-links | Not followed | Followed at depth +1 |
| Brain required | No | No |
