# Daily connector pull phase (AIO-366)

## Why

`aios loop daily` currently renders only signals already on disk. The shipped Granola and GOG
connectors work when a human remembers their buried script paths, while Slack has no writer for the
loop's normalized comms activity store. A recording daily run must refresh those inputs before C1
collects them, without allowing a missing, unauthenticated, slow, or broken connector to prevent the
daily orientation from rendering.

**Build with: Opus / high.** This is a bounded local orchestration change, but it crosses a subprocess boundary,
handles credentials, and must preserve tier and side-effect contracts under timeout/failure.

## Dependencies and sequencing

- AIO-365 (JSON recording semantics) is already merged. Its contract determines when this
  side-effecting phase may run.
- No unmerged slice blocks AIO-366. AIO-367 may land independently and invoke the ordinary
  recording text-mode daily command. AIO-368 depends on AIO-366's comms/calendar signals.
- No Team Brain API or `docs/brain-api.md` change is required. The existing additive
  `GET /api/v1/me/slack-token` endpoint is reused when `SLACK_USER_TOKEN` is absent.

## Contracts and integration points

### Operator Loop API

Add `pullDailyConnectors(options) -> Promise<DailyConnectorPullResult>` to
`src/operator-loop/connectors.ts`, exported only through `src/operator-loop/index.ts`. It owns the
three connector subprocess definitions and returns one non-secret result per connector:

`{ name: "granola"|"gog"|"slack", status: "ok"|"failed"|"timed_out"|"skipped", durationMs, detail? }`.

Each connector runs with its own timer. Connector failures are values, not thrown phase failures.
All three pulls may run concurrently, but `pullDailyConnectors` resolves only after every connector
has exited or its own timer has killed it. No stdout from a connector may contaminate the daily
JSON surface, and result details must never contain credentials or connector output.

### CLI ordering and side-effect boundary

In `scripts/loop.mjs`, a live recording owner run executes:

`connector pull phase -> loop.runDaily() (collect/classify/snapshot) -> render JSON or text`.

The phase runs for the ordinary text-mode owner daily (recording is the default) and for explicit
`--record --json`. It does not run for `--manifest`, `--as team|external`, `--no-record`, or bare
`--json`, preserving their inspection/projection side-effect contract. `--no-connectors` lets an
operator suppress connector subprocesses while still recording/rendering. Existing manual connector
commands/scripts remain supported and unchanged.

### Connector subprocesses

- Granola: `.claude/descriptors/skills/granola-direct/granola-pull.mjs --repo <root> --since
  <today>`. It keeps its dual-auth behavior and writes transcripts with its existing tier contract.
- GOG: `.claude/descriptors/skills/gog-activity/gog-activity-pull.mjs --repo <root>`. It keeps
  idempotent `cal:` / `gmail:` writes to `<inbox>/comms/activity.jsonl`, admin-tier by default.
- Slack: `.claude/descriptors/skills/slack-personal/slack-activity-pull.mjs --repo <root>`. The
  dependency-free manual script resolves the existing user token from `SLACK_USER_TOKEN`, or from
  `GET /api/v1/me/slack-token` using the scheduled process's AIOS brain environment. It requests
  Slack conversation objects, considers only conversations exposing a user `last_read` marker and
  evidence of newer/unread content, fetches messages strictly newer than that marker, excludes the
  authenticated user's own messages, and appends normalized admin-tier records idempotently by
  `slack:<conversation-id>:<message-ts>` to the same activity store. Slack does not guarantee unread
  fields for every conversation type, so conversations without an authoritative read marker are
  skipped rather than guessed.

Each Slack message is written with the existing `CommsActivityRecord` boundary shape:
`{ source:"slack", tier:"admin", occurredAt:<ISO timestamp>,
ref:"slack:<conversation-id>:<message-ts>", channel:<stable label>, direction:"inbound",
summary:<single-line text>, waitingOn:"me" }`.

### Tier-safety posture

Connector ingress is owner-private and default-deny. Slack, Gmail, and calendar activity records use
canonical `admin` tier unless a manual connector invocation deliberately supplies a supported wider
tier; the automatic daily invocation supplies no widening override. `admin` content remains local,
is excluded from team/external projections, and can never be pushed by the sync gate. Missing or
unresolvable tier input is not guessed. The brain token endpoint returns only the authenticated
member's encrypted-at-rest connector credential after bearer/team authentication; this phase does
not read or write brain items, does not send a tier value to the brain, and therefore has no 422 item
ingestion path to handle. A 401/403/404/422 or malformed token response is a connector failure value
and daily rendering still proceeds; response bodies and credentials are never recorded.

Secrets are inherited through the child environment only; they never enter argv, stdout, result
details, activity records, or tests. All connector writes remain local and retain their established
tier defaults. This phase does not sync or push.

## Scope and deferred work

In scope: pre-render orchestration, three independently bounded/fail-open connectors, Slack unread
normalization, an opt-out flag, documentation, and deterministic tests for ordering, timeout,
failure, idempotency, tier, and side-effect gates.

Deferred: scheduling/install mechanics (AIO-367); daily section/ranking changes (AIO-368);
transcript-to-decision/task automation (AIO-370/371/372); Slack thread-reply expansion; guessing
unread state for Slack conversation objects that do not expose `last_read`; webhook/event-driven
pulls; outbound messages; sync/push.

## Implementation plan and tasks

1. Add the typed loop-core connector runner with injectable spawn/timeouts and non-secret results.
2. Add the dependency-free Slack activity writer beside the existing manual Slack CLI; update its
   skill/descriptor scope documentation without modifying the pinned
   `scaffold/.claude/descriptors/skills/slack-personal/slack.py` copy.
3. Wire the phase immediately before `runDaily` on the recording owner live path and render concise
   failures to stderr only.
4. Update C4 and communication domain docs from manual-only to recording-daily behavior.
5. Add tests under the already-wired `test/operator-loop/*.test.mjs` chain and verify the test-chain
   membership explicitly.

## Acceptance criteria

1. `node --test test/operator-loop/connector-pull.test.mjs` proves all three connector definitions
   start before rendering is allowed, and that the phase settles only after each connector succeeds,
   fails, is skipped, or reaches its own timeout.
2. The same test makes Granola fail and GOG time out while Slack succeeds, then proves the returned
   phase result contains all three statuses and the caller can still render; no failure/output text or
   supplied sentinel credential appears in a result detail.
3. The Slack tests feed fixture `conversations.list`, `auth.test`, and `conversations.history`
   responses and prove only inbound messages newer than `last_read` become admin-tier
   `source:"slack"` activity records, and that a second pull writes zero duplicates.
4. `node --test test/operator-loop/daily-cli.test.mjs` drives the real CLI against stub connector
   scripts and proves their marker/activity write occurs before `runDaily` collection; connector
   non-zero exit and timeout both still produce exit `0` plus a rendered daily orientation.
5. The CLI test also proves `--manifest`, `--as team`, `--no-record`, bare `--json`, and
   `--no-connectors` never invoke connector scripts, while `--record --json` does and remains
   parseable JSON on stdout.
6. `npm test` includes both test files through the existing `test/operator-loop/*.test.mjs` glob and
   passes; `npm run format:check` passes; `git diff origin/main -- package.json` is empty unless a
   genuine test-chain change was required.
7. Existing `node --test test/gog-activity.test.mjs` and `node test/slack-cli-sync.test.mjs` pass,
   demonstrating the manual GOG writer remains usable and the pinned manual
   `scaffold/.claude/descriptors/skills/slack-personal/slack.py` is unchanged.
