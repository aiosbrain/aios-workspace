# Daily actions-first orientation (AIO-368)

## Why

The daily orientation currently leads with workspace changes and treats most communication signals
as directionless chatter. As a result, connector-ingested calendar events and unread email signals
are present in the manifest but absent from the human orientation. A capped Changed section also
hides the command that exposes the remaining evidence, while an empty `--as team|external` view
does not distinguish a genuinely quiet day from activity withheld above the selected audience.

This slice makes the daily a short action queue without weakening its owner/shareable tier boundary.

**Build with: Opus / high.** The change is bounded, but it modifies a tier-projected public JSON
shape and must preserve owner-private evidence while adding aggregate diagnostics to shareable views.

## Dependencies and sequencing

- AIO-365 supplies the non-recording JSON inspection contract.
- AIO-366 is merged and supplies the recording-daily Granola, GOG, and Slack pull phase.
- AIO-367 scheduling and AIO-369 create-if-absent seeds are independent and already merged.
- No Team Brain API or `docs/brain-api.md` change is required.

## Daily orientation contract

`DailyOrientation` gains two capped, typed sections:

- `calendar`: `kind:"comms"`, `source:"calendar"` signals whose `occurredAt` falls within the
  manifest's daily window. Window containment uses parsed instants, not an ISO date prefix, so a
  locally-today event normalized across a UTC boundary remains visible when it is in the collector
  window.
- `commsNeedingReply`: `kind:"comms"`, `source:"email"|"slack"` actionable reply signals. An
  explicit `waitingOn:"me"|"owner"` is actionable unless the record is outbound; inbound connector
  records whose summary states that a reply is needed are also actionable. Other Slack/email
  chatter remains omitted.

Each signal enters at most one section. Calendar and reply placement precede the legacy comms
blocker rule. A comms signal waiting on another person, or whose summary reads as blocked/waiting,
continues to enter `blocked`. Directionless chatter enters no section. The section arrays retain the
existing display cap, while `counts.calendar` and `counts.commsNeedingReply` carry true totals.

The classifier continues to diff the owner-complete signal set for snapshot correctness. It then
projects classified items to the requested audience. `counts.withheld` is the aggregate number of
otherwise classifiable daily items removed by that projection. It carries no tier, ref, path,
summary, or other content. Owner views report zero withheld. Admin-only asks remain absent rather
than counted in shareable projections, preserving their existing hard gate. Default-denied manifest
records remain represented only by `counts.excluded`; raw exclusions remain owner-only.

## Text render and empty states

The terse text order is actions-first:

1. Attention and queued asks, explicitly naming `aios asks` as the queue command; existing Blocked
   items remain in this attention group.
2. Owed today.
3. Today's calendar.
4. Comms needing reply.
5. Changed.

Agent runtime and the default-deny notice remain after the orientation sections. Changed stays
capped. When it is truncated, the `+N more` line includes the exact audience-safe audit command:
`aios loop manifest --explain --daily` for the owner, or
`aios loop manifest --explain --daily --as <tier>` for a shareable view.

An empty shareable view reports `0 <tier>-visible items`. If `counts.withheld` or
`counts.excluded` is non-zero, it reports only those safe aggregate counts and the exact command
`aios loop manifest --explain --daily --as <tier>`. If both counts are zero, it says the selected
audience truly has no daily items. It never emits above-tier item details. Owner empty-state wording
continues to distinguish default-denied exclusions from a clear day.

## GUI contract

The GUI protocol mirror adds `calendar`, `commsNeedingReply`, and their counts plus `withheld`.
`DailyView` renders the same actions-first information order, includes queued asks, and uses true
counts in section headings. The GUI endpoint remains a non-recording owner JSON read; no new route or
side effect is introduced.

## Implementation plan and tasks

1. Extend the TypeScript daily contract and classify calendar/reply comms before the legacy blocker
   rule, using manifest-window containment and audience projection after classification.
2. Redesign the CLI text renderer, its truncation hint, and safe shareable empty states.
3. Update the GUI protocol mirror and daily panel order/counts.
4. Update C4 and communication docs, then add core, CLI, and GUI/API regression tests under existing
   test chains.
5. Run targeted tests, full tests, TypeScript/build/lint/docs/constitution/secrets checks, pinned
   Prettier 3.9.5, and verify `package.json` did not change unless test wiring genuinely requires it.

## Acceptance criteria

1. Core tests prove a `source:"calendar"` event within the manifest daily window enters `calendar`,
   including an event whose UTC date prefix differs from `generatedAt`; an event outside the window
   does not.
2. Core tests prove inbound GOG email and Slack `waitingOn:"me"|"owner"` signals enter
   `commsNeedingReply`, a comms item waiting on another person still enters `blocked`, and
   directionless chatter is absent from every section.
3. Core tier tests prove team/external section arrays contain only visible tiers, owner output is
   complete, `counts.withheld` is aggregate-only and accurate, excluded refs remain owner-only, and
   asks never enter or increment a shareable view.
4. CLI tests prove required section order, explicit `aios asks` guidance, and the exact Changed
   expansion command when more than seven changed items are present.
5. CLI tests prove an empty shareable view with above-tier/default-denied activity reports safe
   aggregate withheld/excluded counts plus
   `aios loop manifest --explain --daily --as <tier>`, does not contain a sentinel summary/ref, and
   differs from a true zero-activity shareable view.
6. GUI protocol/build tests accept and render the new sections in actions-first order; the existing
   `/api/loop/daily` test asserts the additive JSON arrays/counts.
7. Existing snapshot, recording, connector, comms-blocker, and owner/shareable tests remain green;
   `npm test` includes the edited operator-loop and GUI server tests through their existing chains.
8. `npx -y prettier@3.9.5 --check .`, lint/build/docs/constitution/secrets checks, and the relevant
   scaffold validation pass; `git diff origin/main -- package.json` is empty unless a genuine wiring
   change was required.

## Scope and deferred work

In scope: additive daily types, classification, text/GUI ordering, safe aggregate empty-state
diagnostics, docs, and tests. Deferred: changing connector queries, outbound communication,
calendar timezone configuration beyond the existing manifest window, Slack thread expansion,
changing section cap, and any sync/brain contract change.
