# ADR 0001 — Graph-engineering provenance guardrail

- **Status:** accepted
- **Date:** 2026-07-26
- **Related:** AIO-530

## Context

A viral X claim circulated in July 2026: "two Anthropic seniors dropped an 11-page PDF on Graph
Engineering." It was investigated as part of a 2026-07-25 research pass (see
`2026-07-25-ai-codebase-quality-and-graph-engineering.md` in the sibling `john-workspace` repo,
`2-work/research/`) and found to be fabricated attribution — the underlying PDF's own title page
states it is "independently compiled... not affiliated with or endorsed by Anthropic," and a
cluster of X growth accounts stripped that disclaimer from their posts and re-captioned it as an
official Anthropic drop, reusing a template they had already run for a different topic ("Loop
Engineering") weeks earlier. No ADR or decision-log entry existed anywhere in this repo or
`john-workspace` recording this before this document.

## Decision

1. **The "Anthropic graph engineering" PDF is not an Anthropic publication.** Its statistics
   (agent counts, throughput claims, "1000x" framing) are unverified and should not be cited as
   fact in AIOS docs, specs, or marketing material.
2. **The real, citable Anthropic precedent is "How we built our multi-agent research system"**
   (anthropic.com/engineering, published June 2025) — a genuine orchestrator-worker architecture:
   a lead agent spawns parallel subagents, each an intelligent filter that distills findings back
   to the orchestrator, with a dedicated CitationAgent processing the final report. This is
   **not** a persistent typed-graph store — it's context/summary passing between an orchestrator
   and its workers.
3. **If AIOS ever needs cross-session or cross-worker shared memory** (e.g. multiple agents
   working the same codebase over time and needing to share findings without re-deriving them
   each session), build it on:
   - This repo's own Workflow tool primitives (`agent()`, `parallel()`, `pipeline()`) for
     execution coordination, and
   - Anthropic's real, documented orchestrator-worker / evaluator-optimizer patterns for how
     workers report back to a coordinator,

   rather than on the fabricated PDF's "graph engineering" framing.

## Consequences

- Any future spec or proposal that cites "Anthropic's graph engineering paper" as justification
  should be treated as a red flag and traced back to this ADR before being trusted.
- This does not prohibit building an actual typed-graph shared-memory system if a real need
  arises — it only prohibits citing the fabricated PDF as the reason to build it, or as prior art
  for its design. The underlying pattern (typed nodes/edges, provenance-tracked claims,
  entity resolution) is legitimate, well-precedented information-extraction engineering on its
  own technical merits — it just isn't something Anthropic published.
