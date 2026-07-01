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

## Implementation (first slice, AIO-140)
Clean TS under `src/operator-loop/`:
- **Inbound** — `sources/comms.ts` reads normalized connector activity (JSONL at
  `<inbox>/comms/activity.jsonl`, or a configured `activityPath`) and emits tier-tagged `comms`
  signals. It fetches a **fixed, max-bounded lookback** (`lookbackHours`, default **168** = 7 days);
  the collector's per-cadence `occurredAt` window trims further (daily 1d / weekly 7d). No cadence
  is threaded through the `Source` shape.
- **Outbound** — `comms/detectors.ts` derives typed `NotificationEvent`s (decision Type 2/3, scope
  change, task assignment, deliverable status, stale inbox) from C1 signals; `comms/sender.ts`
  `dispatchOnEvent` applies a **two-sided tier gate** before any format/send — resolve the
  destination channel (`sender.channel ?? slack.defaultChannel`), resolve the destination's audience
  tier (default-deny on an unresolvable channel), and send only when that audience is cleared to see
  the message tier. Admin content is never emitted, whatever a channel is configured as.
- **Config** — `comms/config.ts` (`.aios/comms-config.json`); see `comms-config.example.json`. The
  `channels` map (channel → audience tier) is default-deny: an unlisted channel is unresolvable.
