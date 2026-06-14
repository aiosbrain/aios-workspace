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
