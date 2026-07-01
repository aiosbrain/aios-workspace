The single front-end of the loop: gather local work signals for a given time window into a structured, tier-tagged collection both cadences consume.

**Sources (reuse what's Done, don't build new connectors):**
- Decisions + tasks + hours from `3-log/`
- Deliverables / working docs from `2-work/`
- Inbox summaries + from-brain pulls in `1-inbox/`
- Prior carry-over actions (unresolved items from the last run — see C7)
- Already-landed inputs: Granola decisions (AIO-21), GitHub activity (AIO-32)

**Output:** a normalized `run manifest` — a list of signals, each with `{source_path/row, tier, timestamp, kind, summary}`. Daily uses a 1-day window + a minimal kind filter; weekly uses a 7-day window + the full set.

**Acceptance:**
- One collector, two window configs (daily/weekly), no duplicate code per cadence.
- Every signal carries a resolvable tier; missing tier → excluded (default-deny), logged.
- Manifest is the only input contract the brief/digest steps read (decouples sources from drafting).

This is the narrowest-source-set product question from the roadmap ("what's the smallest set that still feels magical?") — start tight, expand from dogfood.