# Unified Inbox — start here

> **V1.0 scope (2026-07-22):** the Unified Inbox **GUI is cut from V1.0** (PR #377). V1.0 ships the
> inbox **CLI only** (`aios inbox` + the `src/operator-loop/inbox/` engine + coordinator). The GUI
> API, the `comms/` cockpit view, and the channel-ingestion / GUI-send extensions return in **v2**
> (canceled + labeled `v2` in Linear). This doc describes the full feature; read GUI/ingestion
> sections as v2. See [`../../release-status-v1.md`](../../release-status-v1.md).

The Unified Inbox is one of the largest single features in the operator loop: roughly 8,800 lines
across 21 TypeScript modules under `src/operator-loop/inbox/`, plus a CLI, a coordinator daemon,
and a governance package. Each artifact is documented in detail, but that detail is spread
across nine-plus separate docs written for people already inside the epic. This page is the missing
entry point — read it first, then follow the table in §5 to go deeper on any one area.

## 1. What it is

The Unified Inbox aggregates every demand on the operator's attention — blocking questions from
agent workstreams ("asks") *and* observations from readable external channels such as Gmail and
calendar — into one ranked, drainable, journal-backed local queue (`aios inbox`). Telegram has no
automatic V1 GUI alert/ack lane; that integration is part of the V2 deferral.
It replaces "check five tools on five different schedules" with one queue the operator drains on
their own cadence. Everything it stores is admin-tier and local; nothing about a message's content
ever leaves the machine except through an explicit, policy-approved send (e.g. a Gmail reply).

## 2. Component map

The 21 modules in `src/operator-loop/inbox/` split into five groups:

**Ingestion** — `journal.ts` is the append-only, crash-safe `inbox-events.ndjson` log: every
lifecycle event (an observation getting correlated, a human intent, a policy decision, a capability
being consumed, an action's outcome, a checkpoint) is one line, versioned, totally ordered by a
monotonic `seq`. `read-model.ts` deterministically rebuilds a SQLite projection (via
`better-sqlite3`) from the union of the asks store, the legacy activity log, and this journal —
rebuilding it always produces the same projected state from the same inputs. `observations.ts`
holds the versioned, account/tenant-aware `EnrichedObservation` record and dual-reads it alongside
the legacy `activity.jsonl` stream so existing readers keep working unchanged.

**Ranking** — `ranker.ts` is a pure, zero-LLM classifier (ported rules + an importance signal) that
runs in shadow mode: it never changes what the read model stores, only what a per-row sidecar
records. `ranker-adapter.ts` is the thin seam that lets the CLI (`cli.ts`) consume the real ranker's
ordering instead of a plain recency fallback.

**State** — `state-machines.ts` defines three *orthogonal* machines that together describe an
item's full status: `attention_state` (has the human seen/acted on it — unseen → surfaced →
acknowledged → resolved, plus a stale/reopen path), `action_state` (what's happening with any
associated privileged action — proposed → pending → consumed → executing → succeeded/failed/
outcome_unknown), and a per-source lifecycle (observed → correlated → superseded/deleted). Because
they're independent, an item can be re-surfaced by the human while its last reply attempt is still
`failed` — the two facts don't collide.

**Action authority** — `capability.ts` is the coordinator-side half of an opaque, runtime-issued
capability handle: the coordinator never mints or executes anything, it only records the human's
decision against a handle someone else (the owning runtime) issued and will itself validate.
`reply-policy.ts` is the Reply Policy Decision Point (PDP) — a new, separate, origin-confined
disclosure gate that decides whether evidence from one thread may go back out to that thread's
verified participants (default-deny on every expansion: new recipients, channel moves, cross-thread
quoting). `outbox.ts` is the first real privileged action — an idempotent, reconcile-first Gmail
send that only proceeds under a PDP `allow`. `notify-telegram.ts` retains the content-free
notification primitive (ask id, count, or deep link; never a message body or sender name), but no
V1 GUI server drives it. `recovery.ts` remains active and powers the shipped `aios inbox --overdue`
surface, where the durable asks queue remains the source of truth. No inbox acknowledgment endpoint
or React Comms view ships in V1; that runtime wiring is deferred to V2.

**Audit, retention, host/coordinator** — `audit.ts` is a tamper-evident hash chain of
*authorization* events (who allowed what), storing only digests, never content, so it survives
retention deletions intact. `retention.ts` is the engine that executes deletion for a given store
across both the live store and its backups. `scripts/inbox-redaction-lint.mjs` is the CI backstop
that fails the build if a store isn't in the data inventory, if telemetry isn't redacted, or if a
banned "trust us" adjective creeps into a claim. On the host side, `host-supervisor.ts` is a pure
fold over adapter lifecycle events into per-adapter health; `host-health.ts` turns that into a
signal and a queue item so a degraded host shows up in the same view as an overdue ask;
`credential-broker.ts` and `device-identity.ts` are the per-adapter credential isolation and
device-enrollment/token layer for a remote (Fly) deployment. `scripts/inbox-coordinator.mjs` is the
actual long-running daemon that ties supervision + an internal, authenticated `/healthz` endpoint
together; `deploy/fly/` holds the Dockerfile and Fly config for running it remotely.

```
 [ingested observations]           [agent asks store]
         |                                |
         v                                v
   observations.ts  ---dual-read--->  read-model.ts  <---  journal.ts (inbox-events.ndjson)
         |                                |                       ^
         v                                v                       |
     ranker.ts  --------------->  cli.ts (aios inbox) ------> state-machines.ts
                                        |
                    +-------------------+-------------------+
                    v                   v                   v
             capability.ts      reply-policy.ts        notify-telegram.ts
                    |                   |                       |
                    v                   v                       v
           (owning runtime executes) outbox.ts (Gmail send)  recovery.ts (--overdue)
                                        |
                                        v
                              audit.ts + retention.ts
```

`notify-telegram.ts` is retained as a domain primitive but has no automatic V1 GUI driver;
`recovery.ts` remains active through the CLI `--overdue` path. The automatic notifier and
acknowledgment wiring are deferred to V2.

Host/coordinator (`host-supervisor.ts`, `host-health.ts`, `credential-broker.ts`,
`device-identity.ts`, `scripts/inbox-coordinator.mjs`, `deploy/fly/`) runs alongside all of the
above when the coordinator is deployed off the operator's own machine.

## 3. The three-authority model

This is the central security invariant of the whole feature (verify it against
[`unified-inbox.md` §1](./unified-inbox.md) — the framing below matches that contract as written):

- **The coordinator** aggregates observations and agent events into the ranked queue and brokers the
  human's decision. It **never executes a privileged action itself**, never mints or consumes a
  capability, and never resolves participant identity for disclosure.
- **The owning runtime** (e.g. the Claude Code adapter) is the only actor that mints a capability
  handle for its own pending operation, durably records it, validates a presented handle against
  that record (compare-and-consume), and actually executes. It never trusts a handle it didn't mint,
  and never re-executes a consumed handle after a restart.
- **The policy gateway** (the reply PDP) makes origin-confined disclosure decisions and resolves
  participant identity by account/tenant. It never widens a recipient set, moves channel, or quotes
  cross-thread without an explicit allow.

No single actor holds another's power — the coordinator can *see* everything and *propose*
decisions, but cannot itself send a message or approve its own disclosure. This is why
`capability.ts` (coordinator side) and the owning runtime's capability store are separate code
paths, and why `reply-policy.ts` is a new contract that never modifies the existing outbound gate
(`src/operator-loop/comms/sender.ts`, which this epic leaves byte-for-byte untouched).

## 4. CLI surface

`scripts/inbox.mjs` implements `aios inbox` as a read-only, local-first, offline-capable CLI, plus a
small number of maintenance/action subcommands. Verified subcommands (from the source):

| Subcommand | What it does |
|---|---|
| `aios inbox` (default / `list`) | The unified ranked queue: asks ∪ enriched observations ∪ legacy activity. Protected items render above a separator; `--overdue` shows the recovery view; `--raw` is a pure-chronological escape hatch; `--json` emits `{ items, ranker_version, generated_at, staleness }`. |
| `aios inbox rebuild` | Deterministically re-projects the SQLite read model from `asks.ndjson ∪ activity.jsonl ∪ inbox-events.ndjson`. |
| `aios inbox compact` | Collapses superseded transition events into a snapshot while keeping consumed-tombstones and receipts (the ones that must never be dropped). |
| `aios inbox outbox` | Inspects/manages the idempotent Gmail-send outbox state. |
| `aios inbox send` | Sends a PDP-approved reply through the outbox. |
| `aios inbox m365-verify` | Runs the M365 (Microsoft Graph) connect-and-verify checks, against either a fixture transport or a live test tenant. |
| `aios inbox seed` | Cold-start entity seeding: proposes registry/entity-file suggestions from observation history for the operator to merge or reject — never writes on its own. |
| `aios inbox status` | Reports coordinator/adapter health (the host-health summary). |

None of these subcommands mutate the asks store or sync anything to the Team Brain. The only
paths that produce off-machine effects are `send` (an explicit, policy-approved Gmail send) and
`seed merge` (an explicit registry write the operator triggers one suggestion at a time).
`rebuild` and `compact` are mutating on local state (SQLite writes, journal compaction) but never
alter the asks store, the brain, or any external surface.

## 5. Where to go deeper

| Area | Canonical doc | Test files |
|---|---|---|
| Full build contract (journal schema, state machines, capability handle, reply PDP, observation record, D5/D6 decisions, pre-registered metrics) | [`unified-inbox.md`](./unified-inbox.md) | `test/operator-loop/inbox-journal-replay.test.mjs`, `inbox-journal-store.test.mjs`, `inbox-state-machines.test.mjs`, `inbox-capability.test.mjs`, `inbox-reply-policy.test.mjs`, `inbox-observations-dualread.test.mjs`, `inbox-ranking-fixtures.test.mjs` |
| Original vision framing (superseded — mine for rationale, not for contracts) | [`../../prd-unified-agent-inbox.md`](../../prd-unified-agent-inbox.md) | — |
| CLI + read view | `scripts/inbox.mjs` | `test/operator-loop/inbox-cli.test.mjs`, `inbox-recovery.test.mjs`, `inbox-send-bypass.test.mjs` |
| Outbox / Gmail send | `src/operator-loop/inbox/outbox.ts`, `scripts/inbox-coordinator.mjs` | `test/operator-loop/inbox-outbox.test.mjs`, `inbox-outbox-gog.test.mjs` |
| M365 channel | `src/operator-loop/inbox/m365-verify.ts`; runbook: [`../runbooks/m365-connect-and-verify.md`](../runbooks/m365-connect-and-verify.md) | `test/operator-loop/inbox-m365-verify.test.mjs` |
| Cold-start seeding | `src/operator-loop/inbox/seeding.ts` | `test/operator-loop/inbox-seeding.test.mjs` |
| Host / coordinator deployment (Fly) | [`../host/provisioning-runbook.md`](../host/provisioning-runbook.md) | `test/operator-loop/inbox-host-daemon.test.mjs`, `inbox-host-health.test.mjs`, `inbox-host-isolation.test.mjs`, `inbox-host-manifest.test.mjs`, `inbox-host-nonce.test.mjs`, `inbox-identity-seam.test.mjs`, `inbox-remote-contract.test.mjs` |
| GUI refresh/API/Comms + Telegram notify/ack | **Deferred to V2; no V1 Unified Inbox GUI runtime** | — |
| Data governance, retention, audit anchor | [`inbox-governance/README.md`](./inbox-governance/README.md), [`inbox-governance/data-inventory.md`](./inbox-governance/data-inventory.md) | `test/operator-loop/inbox-audit.test.mjs` |

## 6. Status honesty

- **The CLI, journal, read model, ranking, state machines, capability handle, reply PDP, Gmail
  outbox, CLI recovery view, retained notification primitive, and governance/audit package are
  built and tested** per the table above.
- **The Unified Inbox GUI surface is not shipped in V1.** Gmail/Calendar GUI refresh, the localhost
  inbox API, the cockpit Comms view, desktop inbox notifications, and Telegram notify/ack wiring are
  deferred together to V2. Retained Telegram types and fixtures do not constitute an active V1
  notification lane.
- **The Fly coordinator deployment is a standing residual.** Per
  [`../host/provisioning-runbook.md`](../host/provisioning-runbook.md), the live deploy is
  merge-gated behind PR #321 and was flagged at-risk for the Jul 29 demo. Everything in the host/I-15
  slice is built and tested locally against a faked supervisor; the live Fly smoke test is the
  outstanding verification step. This residual does not add a Unified Inbox GUI surface to V1.
- **M365 is "connected and verified" only in the credential-free, fixture-transport sense.** Per
  `m365-verify.ts` and the M365 runbook, no live-tenant run has happened yet — that is a named,
  separate residual, not a documentation gap.
