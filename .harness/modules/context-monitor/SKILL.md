---
name: context-monitor
description: Context-engineering hygiene audit — contract bloat, context-utilization discipline, skill misfires, MCP tool sprawl. Use on a weekly/monthly cadence, when sessions feel slow or agents "get dumber over time", or before onboarding new engineers onto the harness.
source: Dex Horthy (40-60% utilization discipline); Boris Cherny / AM A1 ("would removing this line cause a mistake?"); oh-my-opencode's defensive-hooks posture (preemptive compaction)
am_pattern: A1, A2
---

You are auditing the *context layer* of this repo's harness — the stuff every session
pays for before any work happens, and the discipline inside sessions. Context rot is
gradual and invisible until agents start missing things they used to catch; this audit
makes it visible.

## Audit 1 — standing context (what every session loads)

```bash
wc -l AGENTS.md CLAUDE.md CONSTITUTION.md 2>/dev/null
```

- **Contracts:** flag `AGENTS.md`/`CLAUDE.md` over ~200 lines. Then apply the Cherny
  test line by line to the worst offender: *would removing this line cause a mistake?*
  Propose the cut list. Look for lines that graduated (a formatter/hook now enforces
  them) — those are pure debt.
- **Error ledger:** entries older than ~3 months that never recurred are candidates to
  prune; recurring entries are candidates to *promote* into a hook or lint
  (`compound-learnings` ladder).
- **Skills:** for each installed skill, when did it last fire usefully? A skill that
  misfires (triggers wrong, or triggers and gets ignored) twice gets rewritten or
  removed — check descriptions first (that's where triggering lives).
- **MCP/tool sprawl:** list configured MCP servers and toolsets. Each unused server is
  schema baggage and attack surface; propose removals.

## Audit 2 — in-session discipline (interview + spot-check)

Ask the engineer (or check recent transcripts if available):

1. **Utilization** — do long tasks stay in the ~40–60% context band, with research
   compacted into notes/plans before implementing? Or do sessions run to the wall and
   auto-compact mid-task (the failure mode: the agent forgets its own plan)?
2. **Fresh starts** — after 2+ corrections on the same misunderstanding, do they
   restart with a sharper prompt, or keep pushing a polluted session?
3. **Subagent isolation** — is bulk file-reading/research pushed into subagents that
   return summaries, or does exploration noise share the window with implementation?
4. **Plan as anchor** — for multi-hour work, is there a durable plan/progress artifact
   on disk that a fresh session could resume from (the session-continuity pattern)?

## Report

One page: standing-context cost (lines loaded per session, before/after the proposed
cuts), the cut/promote/remove lists, and the one in-session habit to fix first. Rank by
leverage — usually the contract cut list pays out immediately, and habit #2 (fresh
starts) is the cheapest behavior change with the biggest quality effect.
