# Rule: Hours Logging

Log time so effort can be reconciled. In the **consultant** context this is for
reconciling against scope and billing the client; in the **employee** context
it is lightweight time/effort tracking against your work and OKRs — same format,
no invoicing.

## Format

Your log lives at `3-log/hours-log.md` (one workspace = one person). Markdown
table, newest first:

```
| Date | Activity | Hours | Tag | Task Ref |
|------|----------|-------|-----|----------|
```

## Activity tags
`engineering` · `admin` · `research` · `communication` · `strategy`

## Conventions
- Log after each work block, not from memory at week's end.
- Round to the nearest 0.5 hours.
- Tag every entry; reference the task ID where one exists.
- Reconcile against your time-tracking tool of record (whichever your engagement
  or company uses) at each sprint/period boundary; note discrepancies rather than
  silently overwriting.

## Logged hours vs agent runtime — two distinct lanes

This manual **hours-log** (`kind:"hours"`) is human-entered effort. It is **separate**
from **agent runtime** (`kind:"time"`) — the native, deterministic capture of how long
Claude terminal sessions ran, written to `3-log/time-log.md` by `aios time capture`. Do
not conflate them:

| | Logged hours | Agent runtime |
|---|---|---|
| File | `3-log/hours-log.md` | `3-log/time-log.md` (`access: admin`, never syncs) |
| Kind | `hours` | `time` |
| Source | you (or an agent, at your request) | derived from `~/.claude` session logs |
| Means | attended human effort | agent session wall-clock (parallel sessions **sum** = leverage) |

Agent runtime uses the same tag ontology **plus `meetings`**
(`engineering · strategy · communication · admin · research · meetings`). Human *attended
effort* (vs. agent runtime) is intentionally **not** inferred here — bring it from a
dedicated tracker (e.g. Toggl) later. See `aios time --help` and
`docs/v1-operator-loop/domains/time-tracking.md`.
