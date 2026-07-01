# Domain spec — Meetings (Granola ingestion, decisions, stakeholder map)

Governed by [`ENGINEERING-CONSTITUTION.md`](../../ENGINEERING-CONSTITUTION.md). Feeds the [Operator Loop](../README.md).

## Why
Meetings are where decisions get made and where "who owns what" lives. The weekly closeout (C5) must catch unlogged decisions and surface a stakeholder picture; the loop relies on meeting-derived decisions as first-class signals.

## Reuse (shipped, KEEP)
- Granola source connector (`aios-team-brain/ingestion/aios_ingest/sources/granola.py`, 319 LOC) — OAuth, auto transcript pull, webhook/scheduler triggers (brain PR #34).
- `transcript-decisions` harness — multi-agent extraction → decision-log rows with rubric-gated grounding.
- `granola-digest` skill (per-meeting + daily digest).

## Build (net-new clean TS)
- **Stakeholder map surface**: surface the team-brain Company-Graph (people, roles, who-met-whom) as a queryable view; today the graph exists but isn't surfaced in the workspace.
- **Governance-nudge harness**: flag transcripts touching governance/compliance topics and draft a brief — rebuild the prior-build nudge *concept* clean (keyword/topic detection → drafted brief), not the legacy code.
- Normalize meeting decisions into tier-tagged signals for C1.

## Signal contract (emitted to C1)
`{ kind: "meeting", source: "granola", tier, occurredAt, ref: <transcript id / decision row>, payload: { title, participants, decisions[], governanceFlags? } }`

## Acceptance
- Weekly closeout catches an unlogged decision from the week's transcripts.
- Stakeholder map answers "who owns domain X / who attended meeting Y."
- Governance-flagged meeting produces a drafted brief; decisions carry correct tier (consented/sanitized) before any sync.
