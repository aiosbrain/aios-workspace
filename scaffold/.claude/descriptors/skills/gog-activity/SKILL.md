---
name: gog-activity
description: |
  Pull today's Google Calendar events and unread Gmail inbox threads via the
  `gog` CLI and write them as normalized comms activity records into
  1-inbox/comms/activity.jsonl — the writer the operator loop's comms source
  (src/operator-loop/sources/comms.ts) reads to surface "what's on today" and
  "what's waiting on a reply" in the daily/weekly loop. Use when the user says
  "pull my gog activity", "feed my calendar/email into the loop", "sync gog to
  the operator loop", or before running `aios loop daily`. Requires `gog`
  installed and authenticated (see the gog-workspace skill) — no API key.
kind: skill
version: 1.0.0
access: admin
triggers:
  - pull gog activity
  - sync gog to the loop
  - feed calendar and email into the operator loop
  - gog activity writer
---

# GOG activity writer (AIO-355)

`src/operator-loop/sources/comms.ts` reads a generic connector-written
`<inbox>/comms/activity.jsonl` (one normalized JSON object per line) and turns it
into tier-tagged `comms` signals for the daily/weekly loop. There was no writer
for `gog` (John's Google Workspace CLI — Gmail/Calendar/Drive, OAuth refresh
token, no API key) — this connector is that writer.

## What it pulls

Two `gog` surfaces, both over **documented flags only** (nothing invented):

1. **Today's calendar events** — `gog calendar events --today --json --results-only`
2. **Inbox threads needing a reply** — `gog gmail search "<query>" --json --results-only -z UTC`,
   default query `in:inbox is:unread`. `gog` has no dedicated "needs reply" flag;
   this is the closest honest proxy over its Gmail query-search surface.

## How to run

```bash
node .claude/descriptors/skills/gog-activity/gog-activity-pull.mjs \
  [--repo PATH] [--tier admin|team|external] [--query "gmail search query"] \
  [--max N] [--activity-path PATH] [--dry-run]
```

| Flag | Effect |
|------|--------|
| `--repo` | workspace root (default: walk up from cwd to the `aios.yaml` directory) |
| `--tier` | `access`/`tier` tag on every written record (default `admin` — calendar/email is personal-by-default and never syncs unless you deliberately widen this) |
| `--query` | Gmail search query for "needing reply" threads (default `in:inbox is:unread`) |
| `--max` | cap per-surface (default 25) |
| `--activity-path` | override the target JSONL path (default `1-inbox/comms/activity.jsonl`, or `01-intake/...` on legacy spines) |
| `--dry-run` | print what would be written without touching the file |

Each event/thread becomes one JSON line normalized to the comms activity
contract: `{ source, tier, occurredAt, ref, channel, direction, summary }`.
`ref` is stable (`cal:<eventId>` / `gmail:<threadId>`) so **re-running never
duplicates a record already on disk** — the write is append-only and idempotent
by `ref`.

## Invocation — manual/cron, not auto-wired into `aios loop`

Like `granola-direct`, `aios loop` never calls out to `gog` itself — it only
reads whatever `activity.jsonl` already contains. Run this connector yourself
(or from `cron`/a scheduler) before `aios loop daily`, e.g.:

```bash
# once a day, before your morning loop check:
0 8 * * * cd /path/to/workspace && node .claude/descriptors/skills/gog-activity/gog-activity-pull.mjs
```

## Connect / troubleshoot

- Requires the `gog` binary on `PATH`, authenticated against your Google
  account (`gog auth status`; see the `gog-workspace` skill). No secret is
  managed by AIOS — `gog` holds its own OAuth refresh token.
- If `gog` isn't found, the script exits 1 with a clear message and writes
  nothing (fail-closed, never partial-writes).
- If either the calendar or gmail fetch fails independently, the other still
  runs — a Gmail auth hiccup doesn't block today's calendar signals.
