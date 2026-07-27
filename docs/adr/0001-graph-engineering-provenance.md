# ADR 0001 — Graph-engineering provenance guardrail

- **Status:** accepted
- **Date:** 2026-07-27
- **Related:** AIO-530

## Context

A viral X claim circulated in July 2026: "two Anthropic seniors dropped an 11-page PDF on Graph
Engineering." It was investigated as part of a 2026-07-25 research pass (see
`2-work/research/2026-07-25-ai-codebase-quality-and-graph-engineering.md` in the sibling
`john-workspace` repo — private; the public primary sources are linked below) and found to be
fabricated attribution. The underlying PDF's own title page reads:

> "Based on Anthropic Knowledge Graph Construction Cookbook and Andrej Karpathy courses...
> Independently compiled, July 2026 — not affiliated with Andrej Karpathy and Anthropic — and not
> endorsed."

So the compiler disclosed the provenance honestly. The deception was added downstream: a cluster of
X growth accounts dropped that disclaimer from their posts and re-captioned the PDF as an official
Anthropic drop (the cover's Anthropic-style logo helped), reusing a template they had already run
for a different topic ("Loop Engineering") weeks earlier. No ADR or decision-log entry existed
anywhere in this repo or `john-workspace` recording this before this document.

## Decision

1. **The "Anthropic graph engineering" PDF is not an Anthropic publication.** Neither the PDF's own
   figures nor the far louder numbers the viral posts wrapped around it (the "graph engineering
   replaced RAG", "1000x" framing — which does not appear in the PDF's technical content at all)
   may be cited as fact in AIOS docs, specs, or marketing material.
2. **The real, citable Anthropic precedent is "How we built our multi-agent research system"**
   ([anthropic.com/engineering/multi-agent-research-system](https://www.anthropic.com/engineering/multi-agent-research-system),
   published 2025-06-13) — a genuine orchestrator-worker architecture: a lead agent spawns parallel
   subagents, each an intelligent filter that distills findings back to the orchestrator, with a
   dedicated CitationAgent processing the final report. That post *does* document real persistence:
   the lead agent saves its plan to Memory so it survives context-window truncation, and subagents
   write outputs to an external artifact store and hand back lightweight references rather than
   piping everything through the coordinator. What it is **not** is a persistent typed-graph store
   with entity resolution — the persistence is plans and artifacts, not a queryable graph.
3. **If AIOS ever needs cross-session or cross-worker shared memory** (e.g. multiple agents
   working the same codebase over time and needing to share findings without re-deriving them
   each session), build it on:
   - Claude Code's built-in Workflow tool primitives (`agent()`, `parallel()`, `pipeline()`) —
     which this repo's `.workflow.js` harnesses under `scaffold/.claude/skills/` already use — for
     execution coordination, and
   - Anthropic's real, documented patterns for how workers report back to a coordinator: the
     orchestrator-worker plus Memory/artifact patterns in the post above, and the
     orchestrator-workers and evaluator-optimizer workflow patterns in "Building Effective Agents"
     ([anthropic.com/engineering/building-effective-agents](https://www.anthropic.com/engineering/building-effective-agents),
     Schluntz & Zhang, published 2024-12-19),

   rather than on the fabricated PDF's "graph engineering" framing. Note that the Workflow
   primitives supply only the execution half; no typed-graph persistence layer ships with them.

## Consequences

- Any future spec or proposal that cites "Anthropic's graph engineering paper" as justification
  should be treated as a red flag and traced back to this ADR before being trusted.
- This does not prohibit building an actual typed-graph shared-memory system if a real need
  arises — it only prohibits citing the fabricated PDF as the reason to build it, or as prior art
  for its design. The underlying pattern (typed nodes/edges, provenance-tracked claims,
  entity resolution) is legitimate, well-precedented information-extraction engineering on its
  own technical merits — it just isn't something Anthropic published.
- This is ADR 0001 and the first entry in `docs/adr/`. Later ADRs should follow the same shape
  (`NNNN-slug.md`; Status / Date / Related header, then Context, Decision, Consequences). A
  `docs/adr/README.md` index and template are worth adding when a second ADR lands.
