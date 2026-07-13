---
description: Pull today's Google Calendar events and unread Gmail inbox threads into the
status: active
---

Pull today's Google Calendar events and unread Gmail inbox threads into the
operator loop's comms activity log.

**Arguments:** $ARGUMENTS (optional flags passed straight through, e.g. `--dry-run`)

Use the `gog-activity` skill when `gog` is connected (`gog auth status`). It
writes normalized records to `1-inbox/comms/activity.jsonl` — the file
`src/operator-loop/sources/comms.ts` reads for the daily/weekly loop — with
`access: admin` by default (owner-private; never syncs unless you widen the
tier explicitly).

If `gog` is not configured, explain how to connect it via the `gog-workspace`
skill (`gog login <email>`) or `.claude/INTEGRATIONS.md`.
