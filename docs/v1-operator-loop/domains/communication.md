# Domain spec — Communication (Slack, email, calendar, gog-cli)

Governed by [`ENGINEERING-CONSTITUTION.md`](../../ENGINEERING-CONSTITUTION.md). Feeds the [Operator Loop](../README.md).

## Why
The loop needs to know what the operator communicated and what's waiting on someone ("what's blocked"). It also needs an outbound path: surface loop events (decisions logged, scope moves, task assignments) into the channels the team already uses. Today this layer is thin — connectors exist but there's no unified notification surface.

## Reuse (shipped, KEEP)
- Slack one-click OAuth (workspace PR #102, brain PR #107), native TS Slack connector (brain PR #27), per-member token store (brain PR #105).
- `gog-workspace` skill (Gmail / Calendar / Drive via `gog`), `slack-cli` skill.
- Brain-side Slack/Gmail/Calendar ingestion readers.

## Build (net-new clean TS — the keystone gap)
- **Unified notification layer**: rebuild the prior-build notification-engine *pattern* (a set of detectors → typed events → channel sender) in clean, well-bounded TS. Detectors include: decision-log Type 2/3, scope change, task assignment, stale inbox, deliverable status. **Do not port the legacy code** — rebuild from the pattern only.
- **Signal emission**: normalize Slack/email/calendar activity into tier-tagged comms signals for C1.
- Swappable sender (Slack first); tier-gated — never emit admin content outward.

## Signal contract (emitted to C1)
`{ kind: "comms", source: "slack|email|calendar", tier, occurredAt, ref: <message/event id>, payload: { channel, direction, summary, waitingOn?, dueAt? } }`

## Acceptance
- Daily loop's "what's blocked / waiting on someone" is populated from comms signals.
- Notification layer fires a tier-safe Slack message on a configured loop event, with the triggering evidence referenced.
- Zero admin/private content reaches any outbound channel (verifier-enforced).
