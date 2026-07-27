---
name: protect-transcript-data
description: Change transcript ingestion, extraction, redaction, provenance, decision or task derivation, or audience-tier output. Use to enforce source allowlisting, grounding, redaction-before-egress, tier boundaries, containment, replay safety, and extraction evaluations.
---

# Protect transcript data

1. Enumerate allowed sources, roots, formats, audience tiers, trust boundaries, and egress paths.
2. Resolve and realpath every source; reject symlinks, traversal, and paths outside allowlisted
   roots before reading.
3. Require source-span provenance for extracted facts, decisions, tasks, people, and summaries.
   Treat partial or conflicting evidence explicitly.
4. Redact before any model, network, or external-tier egress. Preserve admin-only raw evidence
   locally and default-deny missing or unknown access tiers.
5. Make ingestion and derivation idempotent across retries, replay, malformed input, duplicate
   evidence, partial writes, and migrations.
6. Add deterministic contract tests and live extraction evaluations without leaking expected
   answers into the evaluated prompt.
7. Return the data-flow boundary map, failure cases, fixtures, and verification evidence.

Do not become a generic privacy review or duplicate canonical transcript schemas in this skill.
