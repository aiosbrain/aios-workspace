# Unified inbox UX competition — AIO-398

These are three deliberately different HTML interaction studies for the future Cockpit inbox
surface described in `docs/prd-unified-agent-inbox.md`. They are design artifacts, not a claim
that P2 has been implemented; the shippable AIO-398 code is the light ship-loop work.

## Reference lock

Primary direction: **Command Deck** — a compact operator workspace with a durable split between
attention queue and operational context. Preserve dense neutral typography, square-ish surfaces,
thin dividers, explicit source/tier/state labels, and keyboard-visible selection.

Borrow only: Keyboard Purist's single-key muscle-memory and Focus Stream's thin completion rail.
The accent blue means active selection/focus only; amber means a decision needs attention; red
means a blocker. No color carries access-tier meaning: tier is always written as text.

| Candidate | Best at | Main cost | Verdict |
| --- | --- | --- | --- |
| [A — Keyboard Purist](./a-keyboard-purist.html) | Highest throughput for expert operators | Low situational context; harsh for mixed comms | Preserve shortcuts and row density |
| [B — Focus Stream](./b-focus-stream.html) | One careful decision at a time | Hides backlog shape and source health | Preserve the progress rail and next-item ritual |
| [C — Command Deck](./c-command-deck.html) | Mixed-source operations without obscuring privacy or failure state | Slightly more visual complexity | **Recommended primary direction** |

Decision ledger:

| Decision | Source | Rule | Why |
| --- | --- | --- | --- |
| Split queue/context view | C | Context never displaces the active queue | Operator needs both “what next” and “why now” |
| Adapter-health strip | C | Health is compact, textual, and always visible | A stale/broken source changes trust in the queue |
| Protected partition | C + PRD G6 | Tier boundary is explicit, not color-only | Prevents admin-local content being mistaken for shareable comms |
| `j/k`, `e`, `r`, `?` controls | A | Keyboard routes are discoverable and mirrored by buttons | Fast draining without excluding pointer use |
| `3 of 12` progress rail | B | Progress is thin; it never becomes dashboard chrome | Maintains focus while retaining queue context |

Validation checklist for the eventual Cockpit implementation:

- Every row states source, severity, and tier in text.
- Resolve and reply remain distinct actions; external sends keep their existing approval gate.
- Keyboard focus is visible, and all shortcuts have reachable button equivalents.
- Health failures and inaccessible/protected content cannot be hidden by filters.
- No P3/P4 learning or autonomous resolution control appears in this P2 surface.
