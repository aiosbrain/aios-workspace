# Domain spec — Communication (Slack, email, calendar, gog-cli)

Governed by [`ENGINEERING-CONSTITUTION.md`](../../ENGINEERING-CONSTITUTION.md). Feeds the [Operator Loop](../README.md).

## Why
The loop needs to know what the operator communicated and what's waiting on someone ("what's blocked"). It also needs an outbound path: surface loop events (decisions logged, scope moves, task assignments) into the channels the team already uses. Today this layer is thin — connectors exist but there's no unified notification surface.

## Reuse (shipped, KEEP)
- Slack one-click OAuth (workspace PR #102, brain PR #107), native TS Slack connector (brain PR #27), per-member token store (brain PR #105).
- `gog-workspace` skill (Gmail / Calendar / Drive via `gog`), `slack-cli` skill.
- Brain-side Slack/Gmail/Calendar ingestion readers.
- **GOG → activity.jsonl writer (AIO-355)**: `.claude/descriptors/skills/gog-activity/gog-activity-pull.mjs`
  (descriptor: `.claude/descriptors/gog.json`). Pulls today's calendar events (`gog calendar events
  --today --json --results-only`) and unread inbox threads (`gog gmail search "in:inbox is:unread"
  --json --results-only -z UTC`, query overridable — `gog` has no dedicated "needs reply" flag) and
  appends them, idempotent by stable `ref` (`cal:<eventId>` / `gmail:<threadId>`), to
  `<inbox>/comms/activity.jsonl`. Emits `tier: admin` by default (calendar/email is personal-by-default;
  override `--tier` to deliberately widen). The script remains manually invokable, and AIO-366 now
  runs it automatically before a recording owner `aios loop daily` collect.
- **Slack → activity.jsonl writer (AIO-366)**:
  `.claude/descriptors/skills/slack-personal/slack-activity-pull.mjs` reuses the personal Slack
  connector credential, scans only conversation objects with an authoritative `last_read` marker,
  and appends inbound unread messages as admin-tier `source:"slack"` records, idempotent by
  `slack:<conversation-id>:<message-ts>`. Slack does not expose unread markers on every returned
  conversation type; missing state is skipped rather than guessed. The manual script remains
  available, while recording owner daily runs invoke it automatically.

### Enriched adapter-observation record (AIO-387)

Alongside the legacy `activity.jsonl` line, the gog writer now **dual-emits** a versioned
**enriched adapter-observation** record to `.aios/loop/inbox/observations.ndjson`
(`src/operator-loop/inbox/observations.ts`, part of the unified-inbox domain). The legacy stream
stays **byte-identical** — existing readers (`sources/comms.ts`, the I-02 read-model advisory join)
are untouched; no flag turns the legacy stream off in this slice.

The enriched record carries what `CommsActivityRecord` lacks: **account/tenant identity**, **object
kind** (`email` | `calendar-event` | `message` | …), **thread id**, **participants**, and
**edit/delete revisions**. Its dedup key is the corrected
**`(connection/account/tenant, object_kind, native_id)`** — account/tenant are part of identity, so
two Gmail accounts observing the same native message project to **two items, not one**. Cursors ride
on each record (no cursor-ahead-of-data crash window), and bodies are never stored (snippet +
metadata only, on-demand fetch under retention). Same admin-tier posture as the journal: local
state under `.aios/loop/inbox/`, never added to `sync_include`, never pushed to the Team Brain. The
dual-read projection (`projectObservations`) folds the enriched log and legacy `activity.jsonl` into
one keyed item set; see `test/operator-loop/inbox-observations-dualread.test.mjs`.

### Automatic recording-daily preamble (AIO-366)

Before C1 collection, a recording owner daily runs Granola, GOG, and Slack concurrently through
`src/operator-loop/connectors.ts`. Each subprocess has its own deadline and fail-open result, so
render always proceeds from whatever is on disk. Connector output is isolated from stdout.
`--manifest`, `--as`, `--no-record`, bare `--json`, and `--no-connectors` do not pull.

## Build (net-new clean TS — the keystone gap)
- **Unified notification layer**: rebuild the prior-build notification-engine *pattern* (a set of detectors → typed events → channel sender) in clean, well-bounded TS. Detectors include: decision-log Type 2/3, scope change, task assignment, stale inbox, deliverable status. **Do not port the legacy code** — rebuild from the pattern only.
- **Signal emission**: normalize Slack/email/calendar activity into tier-tagged comms signals for C1.
- Swappable sender (Slack first); tier-gated — never emit admin content outward.

## Reply PDP — origin-confined disclosure (I-10 / AIO-391)
The **outbound reply** path is gated by a NEW, SEPARATE policy decision point,
`src/operator-loop/inbox/reply-policy.ts` — distinct from and upstream of the notification
`sender.ts` (which stays byte-for-byte unchanged). Inbound comms evidence is admin-tier by
default, so the sender's "admin-never-outbound" invariant would reject every reply; the reply PDP
resolves that with a two-axis rule — content that originated in a thread may return to THAT
thread's verified participants (admin-tier or not), and every expansion (added recipients, channel
move, cross-thread quoting, workspace attachments, unrelated admin context, unknown participant) is
default-denied with a named promotion path. `evaluateReply` is a pure/deterministic core;
`decideReply` journals one I-02 `pdp-decision` event (refs/counts only, admin-tier local, never
synced). Contract + rule ids: `src/operator-loop/inbox/reply-policy.ts`; matrix:
`test/operator-loop/inbox-reply-policy.test.mjs`. See the domain spec `I-10-reply-pdp.md` and
disclosure rules in `I-01` §5.

## m365 connect-and-verify (I-12 / AIO-393)
The **m365** channel is wired as the second channel at the honest claim level: **auth → read → one
policy-mediated send** on a **test tenant**, reported at exactly the level proven — the support claim
is **"connected and verified"** and nothing more. The verify flows live in
`src/operator-loop/inbox/m365-verify.ts` behind a single injected `GraphTransport` seam (auth / read /
send); `verifyM365` runs the three checks and returns a deterministic `VerifyReport`
(`{ tenant, mode, status, verified, claim, checks, graph_permissions, native_message_id, cursor, ts }`).
The report enumerates the **exact Microsoft Graph scopes** the flows used, as observed on the token
(`Mail.Read`, `Mail.Send` — least privilege). `aios inbox m365-verify [--json]` exits 0 with all three
checks `pass` against a live test tenant and non-zero with the failing check named otherwise; a bundled
fixture self-test (`--fixture happy|bad-token|missing-scope|throttled`) demonstrates the diagnostic
states with no tenant. The one journal event is content-free and admin-tier local (never synced); test
data only, no production recipient is addressable, and `sender.ts` is untouched.

The **"connected and verified"** claim is published only when a `mode: "live"` run passes all three
checks against a real tenant — a fixture run is honestly `mode: "fixture"` with claim `"not verified"`.
As of this slice the live run has **not** been performed (no test tenant is provisioned): the single
residual is the labelled live-verification step in
[`../runbooks/m365-connect-and-verify.md`](../runbooks/m365-connect-and-verify.md). The **deep adapter**
(enriched m365 observation writer, reply-PDP integration, outbox, production-tenant connection) is
**post-Jul-29** and out of scope here.

## Signal contract (emitted to C1)
`{ kind: "comms", source: "slack|email|calendar", tier, occurredAt, ref: <message/event id>, payload: { channel, direction, summary, waitingOn?, dueAt? } }`

## Acceptance
- Daily loop renders calendar agenda and inbound email/Slack needing-reply records as distinct
  typed sections; comms waiting on another person remain blockers and directionless chatter drops.
- Notification layer fires a tier-safe Slack message on a configured loop event, with the triggering evidence referenced.
- Zero admin/private content reaches any outbound channel (verifier-enforced).

## Implementation (first slice, AIO-140)
Clean TS under `src/operator-loop/`:
- **Inbound** — `sources/comms.ts` reads normalized connector activity (JSONL at
  `<inbox>/comms/activity.jsonl`, or a configured `activityPath`) and emits tier-tagged `comms`
  signals. It fetches a **fixed, max-bounded lookback** (`lookbackHours`, default **168** = 7 days);
  the collector's per-cadence `occurredAt` window trims further (daily 1d / weekly 7d). No cadence
  is threaded through the `Source` shape. Tier is **channel-authoritative**: when a `channels` map
  is configured, a channel-backed record resolves its tier from that map — an unlisted channel, or
  a record whose self-reported tier disagrees with its channel's tier, is default-denied (excluded,
  never emitted). Each emitted signal carries a **collision-proof EvidenceRef** — a per-source /
  per-tier / per-channel synthetic path (`.aios/loop/comms/<source>/<tier>/<channel>.ndjson`) with
  the message id as `row` — so a raw id reused across channels/sources never collapses to the same
  `path + row + tier`, and records are deduped on that key.
- **Outbound** — `comms/detectors.ts` derives typed `NotificationEvent`s (decision Type 2/3, scope
  change, task assignment, deliverable status, stale inbox) from C1 signals; `comms/sender.ts`
  `dispatchOnEvent` gates before any format/send. Order: (0) **trigger gate** — when `sender.on`
  is configured, only listed event names dispatch (others are a `noop`); (1) **tier-spoof guard** —
  the authorizing tier is derived from the trusted evidence `ref.tier`, and an event whose
  self-reported `tier` disagrees with its evidence tier is rejected (default-deny); then the
  **two-sided tier gate** — resolve the destination channel (`sender.channel ?? slack.defaultChannel`),
  resolve the destination's audience tier (default-deny on an unresolvable channel), and send only
  when that audience is cleared to see the message tier. Admin content is never emitted, whatever a
  channel is configured as.
- **Config** — `comms/config.ts` (`.aios/comms-config.json`); see `comms-config.example.json`. The
  `channels` map (channel → audience tier) is default-deny: an unlisted channel is unresolvable.
  `sender.on` (string or list of event names) is the optional trigger gate; unset = fire on any
  authorized event.
