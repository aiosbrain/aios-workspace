# Domain spec — Asks Queue (`aios asks`: non-blocking escalation queue)

Governed by [`ENGINEERING-CONSTITUTION.md`](../../ENGINEERING-CONSTITUTION.md). Part of the
[Agentic Ergonomics](../README.md) human-operating layer (epic AIO-166, issue **AIO-167 / EE1**).

## Why
Agents constantly hit moments that *should* interrupt the operator — a genuine blocker, a Type-2/3
decision that needs a human call, a "done, ready for review" hand-off — but a blocking prompt in the
middle of a run is expensive: it stalls the agent and trains the operator to reflexively approve. The
asks queue is the non-blocking alternative: agents (and loop events) drop escalations into a local,
append-only queue; the operator drains it on their own cadence. Nothing blocks, nothing is lost.

## Reuse (shipped, KEEP)
- **AIO-140 comms sender** (`comms/sender.ts` `dispatchOnEvent`) — the tier-gated dispatch with its
  four gates (trigger / tier-spoof / admin-never-outbound / two-sided audience). The asks transport
  is an additive sink on the *same* gated path: only the final authorized-send line changes.
- **AIO-140 detectors + config** (`comms/detectors.ts`, `comms/config.ts`) and the **C1 collector**
  (`collector.ts` `collect`) — `aios asks harvest` reuses them wholesale.
- **Telemetry NDJSON pattern** (`telemetry.ts`) — append-only local-only admin-tier log, folded to
  state on read; the asks store mirrors it (with a writer-honored lock added for maintenance).

## Build (net-new clean TS)
- **Append-only asks store** (`asks/store.ts`): NDJSON event log folded to state, with a
  writer-honored lockfile so maintenance (compaction/GC) never races an append.
- **Fail-silent capture hook** (`hooks/asks-capture.mjs`): a dependency-free Claude Code
  `Notification`(idle) / `Stop`(transcript-tail) hook that writes create lines directly, always
  exiting 0 (a hook failure must never disturb a session).
- **Inbox transport** (`asks/transport.ts`) + **real caller** (`asks/harvest.ts`,
  `aios asks harvest`): route loop events through the comms sender into the local queue.
- **`aios asks` CLI**: offline-capable `list` / `show` / `resolve` / `drain` / `add` / `harvest`.

## Contract

### v1 NDJSON line schema (`.aios/loop/asks/asks.ndjson`)
Append-only. State is the in-order fold; malformed lines, unknown-version lines, unknown-id ops, and
duplicate create ids (**first create wins**) are skipped and counted in `warnings` (never swallowed).

```json
{"v":1,"op":"create","ask":{"id":"...","dedupeKey":null,"kind":"idle","severity":"blocker","title":"...","body":"","ref":null,"source":"hook:idle","sessionId":"...","tailHash":null,"transcriptPath":"...","tier":"admin","createdAt":"2026-07-02T12:00:00.000Z"}}
{"v":1,"op":"resolve","id":"...","at":"2026-07-02T13:00:00.000Z"}
{"v":1,"op":"orphan","id":"...","at":"2026-07-02T13:00:00.000Z"}
```

Folded `Ask` = the stored record plus fold-derived `status` (`open` | `resolved` | `orphaned`) and
`resolvedAt` (the close op's `at`, for both resolve and orphan; `null` while open).

**Field rules (enforced at every write entry point — CLI, hook, transport):**
- `id` — unique create id (`crypto.randomUUID()`). Not a dedupe key.
- `dedupeKey` — open-ask suppression key, or `null`. `sha256(sessionId|"idle")` for idle asks;
  `sha256(sessionId|sha256(tailNormalized))` for stop asks; `sha256(kind|ref.path|ref.row)` for
  harvested asks; `null` for plain `cli` adds.
- `kind` — normalized: trim, lowercase, non-`[a-z0-9-]` → `-`, trimmed of `-`, ≤ 40 chars.
- `severity` — enum `blocker` | `decision` | `fyi`; anything else is rejected.
- `title` — control chars stripped, truncated to 200 chars.
- `body` — truncated to 2000 chars; `""` allowed. JSON serialization escapes newlines (NDLJSON-safe).
- `tier` — defaults `admin`. The store is local-only and **never syncs**; asks are NOT C1 signals in
  this slice. Harvested asks carry the triggering evidence tier.
- `createdAt` — ISO; an invalid/absent input timestamp falls back to now.

### `aios asks add` write contract
`aios asks add --kind <k> --severity <blocker|decision|fyi> --title <t> [--body <b>] [--ref <r>] [--json]`
validates the severity enum + required flags, writes one `create` line (`source:"cli"`, `dedupeKey:null`),
and prints the created id. A soft cap of 500 open asks warns (never blocks) on add.

### Lock protocol (part of the v1 contract — the hook reimplements it; parity-tested)
- Lock file `asks.ndjson.lock`, created with `O_CREAT|O_EXCL` (`openSync(p,"wx")`), pid+timestamp inside.
- Stale (`mtime` > 30s) → removed and retried.
- **Appends** acquire the lock (bounded retries), `appendFileSync` (O_APPEND), release. The hook skips
  silently on lock failure (a missed idle nudge is acceptable; it never blocks a session); the CLI dies.
- **Compaction/GC** (in `drain` only) holds the same lock across fold → temp write → `renameSync`.
  Because every writer honors the lock, no append can occur during the rewrite — no line is lost by
  construction (there is no optimistic-rename CAS to race).

### `drain` lifecycle (ordered)
1. Orphan-detect open asks: a set `transcriptPath` whose file is now missing → orphan; open > 14 days
   with a `sessionId` → orphan (append `orphan` ops).
2. Print the remaining open asks.
3. Auto-resolve them (unless `--keep-open`).
4. GC under the lock: drop resolved/orphaned older than 7 days (compaction rewrite).

Orphaning runs *before* resolve so it is effective (a resolved ask is no longer open to orphan).

## Scope — dogfood-only (this slice)
AIO-167 ships as a **dogfood harness for this repository only**. Registration is a checked-in root
`.claude/settings.json` (`Notification` + `Stop` → `hooks/asks-capture.mjs`). Installing the hook +
CLI into scaffolded workspaces (`scaffold/.claude/settings.json`, `scaffold-project.sh`, OGR
validators, both `--context consultant` and `--context employee`) is **explicitly out of this slice**
and tracked as a follow-up. Scaffolded-workspace acceptance is not part of AIO-167.

## Acceptance
- Right events only: an interrogative Stop tail creates a `decision` ask, a completion-marker tail a
  `fyi` ask, plain prose creates nothing; an idle `Notification` creates a `blocker` ask.
- Dedup holds under two concurrent sessions (distinct dedupeKeys; no duplicate open asks per session).
- The CLI works offline (routes from a repo with no `aios.yaml`, like `aios time`).
- Maintenance safety: no append is lost while compaction runs (contention-tested).
- `aios asks harvest` creates asks through the real collect → detect → dispatch → sink path; a
  re-harvest of the same window does not duplicate open asks.

## Implementation
Clean TS under `src/operator-loop/asks/` (`store.ts`, `transport.ts`, `harvest.ts`), an additive
`SendEventFn` on `comms/sender.ts`, a dependency-free `hooks/asks-capture.mjs`, and `cmdAsks` in
`scripts/aios.mjs` (registered in `OFFLINE_CMDS`). Public surface re-exported from
`src/operator-loop/index.ts`.
</invoke>
