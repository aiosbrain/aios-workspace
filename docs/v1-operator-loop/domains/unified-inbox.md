# Domain spec — Unified Inbox (`aios inbox`)

Governed by [`ENGINEERING-CONSTITUTION.md`](../../ENGINEERING-CONSTITUTION.md). Part of the
**Unified Human+Agent Inbox** epic (AIO-381), issue **AIO-382 / I-01** — the Track 0 contract
that every downstream issue (I-02…I-16, except the I-12/I-13 design work) is `blocked-by` in
Linear. This document is the canonical build contract: nothing downstream writes a line until it
merges. It resolves the three Sol r2 blockers (durable journal, reply-tier deadlock, capability-
envelope integrity), closes decisions **D5** (SQLite implementation) and **D6** (audit anchor),
and pre-registers the metric fixtures so the gates cannot move.

## Why
A solo operator running several parallel agent workstreams has no single place to see everything
demanding their attention. Blocking questions from N orchestrators compete with Slack, WhatsApp,
Telegram, email, and calendar — each in its own tool, interrupting on its own schedule. The
unified inbox aggregates every demand on human attention — **agent asks** *and* **external comms**
— into one ranked, drainable queue inside the AIOS Workstation, processed on the operator's own
cadence rather than by constant interruption. It sits above the per-epic orchestrators as a
learned second layer: every answer becomes triage signal.

This is the same non-blocking philosophy as the [asks queue](./asks-queue.md), extended across
external channels and given a durable, replayable spine. It supersedes the vision-stage
[`prd-unified-agent-inbox.md`](../../prd-unified-agent-inbox.md) — that PRD argued the shape of the
whole; this spec is the buildable contract.

## Delivery metadata

- **Deps:** AIO-386 depends on the shipped inbox journal/recovery/Telegram domain from PR #320 and
  the shipped AIO-392 outbox line from PR #321 plus its follow-up hardening. No unmerged code slice
  is a prerequisite for the outbound GUI notify/ack work.
- **Build-with:** Opus-class implementation at high effort. The work crosses durable journal
  semantics, cross-process coordination, localhost API behavior, and GUI lifecycle evidence.

## Reuse (shipped, KEEP)
- **Asks store lock discipline** (`src/operator-loop/asks/store.ts`) — the `O_CREAT|O_EXCL`
  lockfile, stale-lock reclaim, and 7-day GC. The `inbox-events.ndjson` journal writer copies this
  discipline verbatim; the journal must survive the asks-store GC (replay stays byte-equivalent
  after asks compaction).
- **Comms sender** (`src/operator-loop/comms/sender.ts`) — the tier-gated `dispatchOnEvent` and its
  four gates. **Untouched, byte-for-byte** by this epic; the reply PDP is a *new, separate* contract
  layered beside it, never a modification of it.
  `test/operator-loop/comms-sender.test.mjs` stays green unchanged.
- **GOG → activity writer** (`scaffold/.claude/descriptors/skills/gog-activity/gog-activity-pull.mjs`)
  — the current activity writer whose `tier: admin` default caused the v3 reply deadlock. The
  enriched observation record is emitted *alongside* the legacy `activity.jsonl` (which stays
  unchanged and readable), never in place of it.
- **Runtime adapter surface** (`gui/server/runtime-adapters/claude-code.mjs`) — the adapter the
  capability handle design binds to first (I-03 spike).
- **Sibling domain docs** — [asks-queue.md](./asks-queue.md) and [communication.md](./communication.md)
  set the NDJSON/tier/fold conventions this doc extends.

## Build (net-new clean TS)
- **`inbox-events.ndjson` journal** — versioned, totally-ordered, correlation/causation-linked event
  log with crash-safe append and a defined compaction boundary (I-02).
- **SQLite read model** — deterministic projection rebuilt from (asks ∪ activity ∪ inbox-events);
  implementation chosen in **D5** below (I-02).
- **Orthogonal state machines** — `attention_state` / `action_state` / per-source lifecycle, each
  with enumerated legal transitions and optimistic versions.
- **Runtime-issued capability handle** — opaque handle over a durable runtime-side pending/consumed
  record, compare-and-consume, restart-surviving tombstone, signed-envelope fallback (I-03/I-07).
- **Reply PDP** — origin-confined disclosure policy decision point, a new separate contract (I-10).
- **Enriched adapter-observation record** — versioned observation type with account/tenant identity
  and a corrected dedup key (I-06).
- **`aios inbox` CLI + notify lane** — ranked read-only queue, `--overdue` recovery view, Telegram
  content-free notification lane (I-04/I-05/I-09), outbox + Gmail send (I-11).

### Current connector reachability

The local GUI refreshes Gmail/Calendar through the reviewed, toolkit-owned GOG observation adapter on
a bounded, non-overlapping cadence. An installed workspace descriptor is only the explicit opt-in marker:
its bytes are never loaded or executed. A selected workspace never supplies connector executable code,
and the child receives a minimal environment allowlist. Scheduled and manual/cron pulls share an atomic
workspace lock; timeout/shutdown terminate the full connector process group before another pull can run.
Public freshness comes from the last successful ingestion refresh, never from a source event's occurrence
time.

Telegram remains **outbound-only** until a separately gated inbound contract is proven. The GUI
server owns the production notify loop: on a bounded cadence it projects only open
`agent-event` asks in `needs-you` (plus protected open asks), folds the durable notification
journal, and sends one content-free Bot API alert for each ask with no recorded delivery. Telegram
acceptance is journaled as `delivery-attempted`; a failed request journals no delivery and the
durable ask remains the source of truth. The loop and the GUI acknowledgment endpoint share an
operator-local cross-process lock so two GUI servers do not concurrently send or acknowledge the
same ask.

A `human-ack` means the corresponding delivered ask detail was visible while the GUI document
was visible and focused. List/detail GETs and background polling are never acknowledgment evidence.
The server records an ack only when the item is still an open agent ask, at least one delivery is
journaled, and no effective later ack exists. Unknown, closed, non-agent, never-delivered, and
already-acked items do not append an ack. The honest delivery guarantee is one recorded successful
send per ask during normal concurrent operation; Telegram acceptance immediately before a local
journal failure or process death remains an unavoidable ambiguous duplicate window because the
provider has no idempotency key.

Outbound notify status is exposed separately from connector freshness:
`notify.lane.status = disabled | configured | delivery_ok | degraded | failed | unavailable`;
`degraded` means a bounded tick delivered at least one alert and failed at least one other alert.
It never contains configuration, token, chat id, ask content, or raw provider errors. Telegram inbound
freshness continues to report the legacy alerts-only/unavailable state; no `getUpdates` poller,
webhook ingestion, Telegram conversation projection, or reply affordance ships under this
outbound contract.

## Contract

The domain spec names these contracts before any implementation issue writes a line.

### 1. Three authorities
The system splits privileged authority across three actors. No actor holds another's power.

| Authority | Owns | Never does |
|---|---|---|
| **Coordinator** | Aggregating observations + agent events into the ranked `AttentionItem` queue; brokering the human decision; ordering the journal; surfacing the recovery view. | Never executes a privileged action itself; never mints or consumes a capability; never resolves participant identity for disclosure; never holds admin plaintext outside local state. |
| **Owning runtime** (e.g. Claude Code adapter) | Minting the capability handle for *its own* pending operation; durably recording pending/consumed; compare-and-consume; executing the action; emitting the native receipt. | Never trusts a capability it did not mint; never re-executes a consumed handle after restart; never sends comms plaintext to the Team Brain. |
| **Policy gateway** (reply PDP) | Origin-confined disclosure decisions; account/tenant participant-identity resolution; default-deny on every expansion. | Never widens recipients, moves channel, or quotes cross-thread without an explicit allow; never reads admin context it was not scoped to. |

Every `AttentionItem` keeps `origin: thread-state | agent-event` so the queue never conflates a
correlated external observation with a live agent request. The resolution affordance is
**"one-keystroke local resolution, or scoped confirmation where authority requires it"** — a purely
local dismiss is one keystroke; anything that exercises the owning runtime or the policy gateway
demands a scoped confirmation.

### 2. `inbox-events.ndjson` journal schema
Append-only, totally ordered per journal, `schema_version` on **every** line (forward-compat rule:
readers ignore unknown line versions and count them, never crash). Each event carries a stable `id`,
a `correlation_id` (the attention thread it belongs to) and a `causation_id` (the event it was
caused by, `null` at a chain root), a monotonic `seq`, and an ISO `at`.

```json
{"schema_version":1,"seq":1,"id":"evt_a1","correlation_id":"corr_9","causation_id":null,"type":"observation_correlated","at":"2026-07-14T09:00:00.000Z","payload":{"source":"gmail","observation_id":"obs_..."}}
{"schema_version":1,"seq":2,"id":"evt_a2","correlation_id":"corr_9","causation_id":"evt_a1","type":"user_intent","at":"2026-07-14T09:01:00.000Z","payload":{"intent":"reply"}}
{"schema_version":1,"seq":3,"id":"evt_a3","correlation_id":"corr_9","causation_id":"evt_a2","type":"pdp_decision","at":"2026-07-14T09:01:02.000Z","payload":{"decision":"allow","scope":"same-thread"}}
{"schema_version":1,"seq":4,"id":"evt_a4","correlation_id":"corr_9","causation_id":"evt_a3","type":"capability_consumed","at":"2026-07-14T09:01:03.000Z","payload":{"handle":"cap_opaque_...","issuer":"claude-code"}}
{"schema_version":1,"seq":5,"id":"evt_a5","correlation_id":"corr_9","causation_id":"evt_a4","type":"action_attempt","at":"2026-07-14T09:01:04.000Z","payload":{"operation":"gmail.send"}}
{"schema_version":1,"seq":6,"id":"evt_a6","correlation_id":"corr_9","causation_id":"evt_a5","type":"action_outcome","at":"2026-07-14T09:01:06.000Z","payload":{"outcome":"success"}}
{"schema_version":1,"seq":7,"id":"evt_a7","correlation_id":"corr_9","causation_id":"evt_a5","type":"native_receipt","at":"2026-07-14T09:01:07.000Z","payload":{"provider_id":"gmail:<message-id>"}}
{"schema_version":1,"seq":8,"id":"evt_a8","correlation_id":null,"causation_id":null,"type":"audit_checkpoint","at":"2026-07-14T09:05:00.000Z","payload":{"through_seq":7,"digest":"sha256:...","anchor_ref":"brain:checkpoint/..."}}
```

**Event vocabulary** — `observation_correlated`, `user_intent`, `pdp_decision`,
`capability_consumed`, `action_attempt`, `action_outcome` (with `outcome: success | failure |
outcome_unknown`), `native_receipt`, `audit_checkpoint`.

**Crash-safe append** — the writer uses the **same lock discipline as the asks store**
(`O_CREAT|O_EXCL` lockfile, stale reclaim, `O_APPEND` under the lock). A partially written trailing
line is truncated on recovery and never folded.

**Rotation bounds** — segments roll at **64 MiB**; the active segment is always the highest-sequence
file. Replay reads segments in order and reconstructs total ordering from `seq`.

**Compaction boundary** — compaction may drop fully-superseded intermediate events, but
**consumed-capability tombstones and native receipts are never compacted within the retention
window** (they are the replay-protection and audit-anchor evidence). Replay after compaction stays
byte-equivalent for the surviving lines, including after an asks-store GC pass.

### 3. State machines
Three **orthogonal** machines; an item's full state is the tuple. Each carries an optimistic
`version` incremented on every transition (a stale-version write is rejected). **Reopen is a
transition event, not a state.**

- **`attention_state`** — legal transitions:
  `unseen → surfaced`, `surfaced → acknowledged`, `acknowledged → resolved`,
  `surfaced → stale` / `acknowledged → stale` (STALE after the overdue window),
  and the reopen transitions `resolved → surfaced` and `stale → surfaced`. No other pair is legal.
- **`action_state`** — legal transitions:
  `none → proposed`, `proposed → pending`, `pending → consumed`, `consumed → executing`,
  `executing → succeeded`, `executing → failed`, `executing → outcome_unknown`, and the retry
  transition `outcome_unknown → executing` (idempotency-class-gated). `proposed → none` (withdraw)
  is legal; `succeeded` and `failed` are terminal.
- **Per-source lifecycle** — legal transitions:
  `observed → correlated`, `correlated → superseded` (edit revision), `correlated → deleted`
  (tombstone), `superseded → superseded` (further edits), `superseded → deleted`. `deleted` is
  terminal; a re-observed native id after delete starts a fresh `observed`.

The transition table is exhaustively enumerated in
`test/operator-loop/inbox-state-machines.test.mjs` (all legal + illegal pairs generated).

### 4. Capability handle
A privileged action is authorized by an **opaque, runtime-issued capability handle** — never a
coordinator-forged token. The owning runtime keeps a **durable pending/consumed record** holding:
operation, normalized args, target resources, repo/worktree identity, TTL, and a canonical request
digest. Semantics:

- **Compare-and-consume** — the runtime validates the presented handle against *its own* pending
  record and consumes it atomically; a field-mutated, issuer-substituted, audience-substituted, or
  session-substituted handle is rejected.
- **Restart-surviving tombstone** — consumption writes a durable tombstone; a replay of the same
  handle **after a runtime restart** is rejected (it was already consumed).
- **Every crash/replay/rotation case is defined** — crash-after-consume-before-action (tombstone
  present → do not re-execute), crash-after-action-before-receipt (`outcome_unknown` → idempotency-
  class retry, native reconcile), handle rotation, and journal rotation mid-round-trip.
- **Signed-envelope fallback** — if the runtime cannot durably consume in the I-03 spike, the named
  fallback is a signed capability envelope brokered by the coordinator (notify + deep-link), and
  *that* fallback ships as the feature. Kill criterion is written into I-03.

### 5. Reply PDP disclosure rules
The reply Policy Decision Point is a **new, separate contract** — it never touches
`comms/sender.ts`. Default posture is **origin-confined**: evidence from the same thread may only be
disclosed to the **same verified participants** of that thread, with participant identity resolved
per **account/tenant** (never by raw display name). Every expansion is **default-denied** unless an
explicit allow is granted:

- recipient-set expansion (adding anyone not a verified participant) — denied;
- channel move (replying on a different channel/provider) — denied;
- cross-thread quoting — denied;
- workspace attachments — denied;
- unrelated admin context — denied.

Group-thread, quoting/attachment, mixed-tier, and unknown-participant rules are enumerated; an
  unknown or unverifiable participant is treated as outside the origin set (deny). The full **Sol r2
reply-policy fixture matrix** (e.g. reply-same-sender → content-free Telegram) lives in
`test/operator-loop/inbox-reply-policy.test.mjs`, with
`test/operator-loop/comms-sender.test.mjs` untouched.

### 6. Observation record
The enriched adapter-observation record is a **versioned** type carrying account/tenant identity,
object kind, thread id, participants, and edit/delete revisions. The corrected dedup key is
**`(connection/account/tenant, object kind, native id)`** — so the same native id across two
accounts never collapses. Cursors are transactional (advance atomically with the write). The legacy
`CommsActivityRecord` (from `activity.jsonl`) **stays readable** via a dual-read path; the gog writer
emits the enriched record alongside the unchanged legacy record.

### 7. D5 — SQLite implementation (closed)
Native dep vs subprocess vs Tauri boundary; WAL (and FTS5 if snippets use it) proven on Mac Node ≥18
and the Fly image; migrations, downgrade, corruption recovery, busy-timeout, consistent backups.

| Option | Status |
|---|---|
| **`better-sqlite3`** (native dep, WAL-proven, synchronous API) | **Chosen** |
| Subprocess `sqlite3` CLI | Named fallback — ships only if the Tauri packaging check fails |
| In-runtime Tauri SQLite plugin | Rejected |

Ruling recorded per the I-01 kickoff default (Stephan/Abe may override at G1 kickoff). Resolved
before G4 file planning.

### 8. D6 — Audit anchor (closed)
Host-independent signing key / control plane; checkpoint cadence; post-restore verification;
tamper-evidence retention reconciled with deletion obligations. Local git is excluded.

| Option | Status |
|---|---|
| **Team Brain checkpoint endpoint** (digests only, tier-reviewed in [`docs/brain-api.md`](../../brain-api.md) first) | **Chosen** |
| Signed ref pushed under separate credentials | Named fallback — ships if the endpoint review does not fit the window |
| Local git anchor | Excluded (host-dependent) |

Ruling recorded per the I-01 kickoff default (Chetan/John may override at G1 kickoff). The endpoint
carries **digests only, never message bodies**, and is tier-reviewed before use (I-16).

### 9. Pre-registered metrics
Locked here so no gate can move after the fact:

- **Protected-partition recall = 100%** on a labeled corpus of **≥200 items, ≥3 channels, ≥30
  protected-sender items**. Any protected miss is a defect, not a tuning knob
  (`test/operator-loop/inbox-ranking-fixtures.test.mjs`).
- **Ingestion completeness ≥99% over a 7-day window**, with a manual spot-audit protocol defined.
- **Freshness: p95 ingest lag ≤5 min** while the coordinator is up.
- **Final module placement ruling** — the provisional `src/operator-loop/inbox/` modules land at
  **`src/operator-loop/inbox/`** (confirmed as the final path, sibling to `asks/` and `comms/`).

### Sol verification matrix → named test files
Every Sol r1+r2 verification item maps to a named test file (naming follows
`test/operator-loop/asks-store.test.mjs` conventions):

| Verification item | Test file |
|---|---|
| Journal replay byte-equivalence (incl. post-asks-GC) + truncation at every byte boundary | `test/operator-loop/inbox-journal-replay.test.mjs` |
| Legacy-record compat + multi-account collision fixtures (dual-read) | `test/operator-loop/inbox-observations-dualread.test.mjs` |
| Reply-policy fixture matrix (reply-same-sender → content-free Telegram), `test/operator-loop/comms-sender.test.mjs` untouched | `test/operator-loop/inbox-reply-policy.test.mjs` |
| Capability tamper / replay-before-and-after-restart / rotation / crash-after-consume / crash-after-action / `outcome_unknown` idempotency-class retry | `test/operator-loop/inbox-capability.test.mjs` |
| G5 bypass tests scoped to the claimed surface ("inbox path gated") | `test/operator-loop/inbox-send-bypass.test.mjs` |
| G3 recovery: Telegram disabled, token revoked, API-success-without-ack, coordinator restart, phone offline | `test/operator-loop/inbox-recovery.test.mjs` |
| State-machine transition generation (all legal/illegal transitions enumerated) | `test/operator-loop/inbox-state-machines.test.mjs` |
| Pre-registered metric fixtures failing the gate on any protected miss | `test/operator-loop/inbox-ranking-fixtures.test.mjs` |

## Scope
**In:** this domain doc (one new markdown file); the superseded-by pointer edit to
[`prd-unified-agent-inbox.md`](../../prd-unified-agent-inbox.md); the domains README table row; the
D5 and D6 rulings recorded above; the verification-matrix table reproduced above.

**Deferred:** all implementation (I-02+); any `docs/brain-api.md` change (if a ranking-graph contract
ever lands, brain-api updates **first** — a G6b concern); adapter-contract publication (stays behind
its maturity gate).

## Tier safety
The standing posture, enforced two layers deep:

- The inbox **never syncs comms plaintext to the Team Brain**. The journal, the SQLite read model,
  and the observation records are **admin-tier local state**, default-deny, and are **never added to
  `sync_include`**.
- `src/operator-loop/comms/sender.ts` and its tests stay **byte-for-byte untouched**.
- The **reply PDP is a new, separate contract** — it does not modify the sender's gates.
- The D6 audit anchor, using the Team Brain checkpoint endpoint, carries **digests only (never
  bodies)** and is tier-reviewed in `docs/brain-api.md` before use.
- **Sync enforcement is two-layer:** the aios sync client default-denies admin/untagged content, and
  the brain rejects any private-tier push with a 422 — nothing in this epic ever reaches that path.

## Acceptance
- **EXIT (verbatim from the build plan): PR merged; every Sol r1+r2 verification item mapped to a
  named test file** (the eight-row table above).
- The doc contains all nine enumerated contracts — verifiable, exit 0 required:
  `for h in "Three authorities" "journal schema" "State machines" "Capability handle" "Reply PDP" "Observation record" "D5" "D6" "Pre-registered metrics"; do grep -qi "$h" docs/v1-operator-loop/domains/unified-inbox.md || exit 1; done`.
- The verification matrix appears with all eight rows; `grep -c 'inbox-.*\.test\.mjs'` prints ≥ 8.
- `grep -qi 'superseded' docs/prd-unified-agent-inbox.md` exits 0.
- **D5 and D6 each show exactly one chosen option** in the decision tables above — no undecided
  path remains on the must-path.
- Baseline suites still green: `npm run build:loop` and
  `node --test test/operator-loop/comms-sender.test.mjs` pass unchanged.
- Chetan review recorded on the PR before merge (Track 0 owner pair: Chetan + John).

## Implementation
No product code lands in this issue — it is documentation + contract design. The contracts above
are implemented across the downstream issues under the [Operator Loop](../README.md), all as clean,
well-bounded TypeScript modules under **`src/operator-loop/inbox/`** (sibling to `asks/` and
`comms/`), governed by [`ENGINEERING-CONSTITUTION.md`](../../ENGINEERING-CONSTITUTION.md):
I-02 (journal + read model), I-03/I-07 (capability round-trip), I-04/I-05 (ranking + notify +
recovery), I-06 (enriched observations), I-09/I-10/I-11 (Gmail read → reply → send), and
I-15/I-16 (host + retention/audit-anchor package). Integration points the modules stay consistent
with: `src/operator-loop/asks/store.ts`, `src/operator-loop/comms/sender.ts`,
`scaffold/.claude/descriptors/skills/gog-activity/gog-activity-pull.mjs`, and
`gui/server/runtime-adapters/claude-code.mjs`.
