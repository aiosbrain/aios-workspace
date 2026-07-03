# Spec — Bidirectional task sync (Linear ⇄ brain)

Part of the **Tasks & PM** domain ([tasks-pm.md](./tasks-pm.md)). Governed by [`ENGINEERING-CONSTITUTION.md`](../../ENGINEERING-CONSTITUTION.md) and the pinned sync contract [`brain-api.md`](../../brain-api.md). This completes the deferred **Phase 5** (AIO-78) of the brain→PM projection (AIO-72).

## Why
Today the brain `tasks` table is canonical and projects **one-way** into Linear (brain wins). That means **any edit made directly in Linear is silently overwritten** on the next projection of that task — and a Linear issue created directly is invisible to the brain. In practice (incl. this planning session) people *do* edit the board in Linear, so the PM system has to make those edits durable instead of clobbering them. The operator loop's C6 writeback (AIO-129) also needs round-trip integrity: it writes next-week actions to Linear and must trust that state survives.

## What exists (reuse, don't rebuild)
- `task_pm_links`: `provider_resource_id`, `provider_external_id/source`, `last_projected_status`, `projection_fingerprint`, `provider_seen_status`, `last_synced_*` (`postgres/schema.sql`).
- `lib/pm-sync/reconcile.ts` `reconcileProviderState()` — reads Linear's current state → writes `provider_seen_status` → surfaces divergence on the Admin → PM-sync page. **Surface-only: never writes the provider, never writes brain `tasks`.**
- Projection engine `lib/pm-sync/project.ts` (`projectTask`, `projectAllTasks`) — brain-wins upsert, fingerprint-skip. Triggers: reactive per-task (`app/actions/tasks.ts` `scheduleProjection`), changed-rows on `aios push`, manual "Project board now". No projection cron.
- Linear adapter `lib/pm-sync/linear.ts` adopts existing issues by `provider_resource_id` or the `aios-ext: <row_key> · source: aios-backlog` footer (`issuesByExt`).

## The gap (what to build)
Turn the surface-only loop into a **policy-driven inbound apply**, plus inbound creation and a trigger.

### Phase A — Inbound apply (status first), conflict-safe
Extend reconcile from detect-only to **apply under a field-level policy**:
- For each link, compare `provider_seen_status` (live Linear) vs `last_projected_status` (what the brain last pushed) vs the current brain `tasks.status`.
- **PM changed, brain unchanged** (brain fingerprint == last projection) → **apply Linear → brain** (write `tasks.status`). This is the safe, common case (someone moved a card in Linear).
- **Both changed** → **conflict** → surface for human resolution; never auto-merge.
- Default policy `status: pm-wins-if-brain-unchanged`; `body/title/labels/priority: brain-wins` (configurable per team). Status is the field humans actually drag around the board.

### Phase B — Inbound adopt/create (promote-in-place in the existing Linear mirror)
An **inbound Linear mirror already ships** (`lib/ingest/sources/linear-normalize.ts` + `runLinearIngestion`): a Linear-authored issue (no `aios-ext` footer, id ∉ `ownedResourceIds`) already becomes a **team-tier** `kind=task` item in project `linear-<teamKey>` and a `tasks(origin='sync', source_item_id, row_key=<identifier>)` row. So Phase B is not "create from scratch" — it is **promoting** that mirror row into an owned, linked, round-trippable task:
- **Reuse the mirror's write** for tier provenance — the team-tier `items` row (`items.access='team'`) + `tasks.source_item_id` already exist and are correct. Tier flows from `items.access`, so an adopted task is **team**-tier; inbound NEVER creates `admin` content and never elevates tier (preserves the boundary the brain enforces at 422).
- Upsert a `task_pm_links` row: `provider='linear'`, `provider_resource_id=<issue node id>`, `provider_external_id=<identifier>`, `task_id=<task id>`. Seed `last_projected_status` = current Linear state name and `projection_fingerprint` = `projectionFingerprint(<projectable>, <parentResourceId>)` so a later projection is a guaranteed no-op (zero echo).
- Backfill the durable `aios-ext: <identifier> · source: <src>` footer into the Linear issue (the round-trip marker).
- **Flip the task `origin` `sync → ui` (required, not cosmetic).** Adopting via a `task_pm_links` link puts the issue id into `ownedResourceIds`, which excludes it from the next mirror `rows[]`; the mirror's project-wide diff-delete (which removes absent `origin='sync'` rows) would otherwise **delete the very row just adopted**. `origin='ui'` makes it a first-class owned task the diff-delete skips.
- **No duplicate:** adoption is by resource id + footer, so the next poll's `ownedResourceIds` excludes the issue from the mirror and projection never creates a second Linear issue. Each issue is materialized once, promoted once, then owned.

### Phase C — Trigger (poll-first; webhook deferred)
- **Poll-driven** on the existing 30-min ingest scheduler (`lib/ingest/scheduler.ts`, and the admin "Sync now" `lib/ingest/manual-sync.ts`): run adopt (Phase B) then apply (Phase A) within a tick, per **opted-in** team.
- **Linear webhook receiver is deferred to a fast-follow** — a webhook adds HMAC-over-raw-body verification, signing-secret provisioning, team routing, and replay/idempotency, and would force reopening the "webhooks out of scope for v1" contract line. Poll covers every acceptance criterion; not worth coupling to this change.

### Phase D — Loop prevention (the "regenerate" gotcha)
When applying an inbound change, **update `last_projected_status` + `projection_fingerprint` in the same transaction** (an `apply_inbound_status(...)` Postgres RPC, patterned on the existing `rate_limit_hit`/`audit_protect` functions, guarded on the expected pre-apply status for optimistic concurrency) so the subsequent reactive projection sees "no change" and does not echo the edit back to Linear → prevents the infinite inbound→outbound→inbound loop. Adoption (Phase B) seeds the same baseline for the same reason.

## Rollout — per-team opt-in
Inbound apply + adopt newly let Linear write brain state, so both are gated by a **per-team opt-in flag `teams.bidirectional_pm_sync` (default `false`)** — a kill switch that rolls out per team. Teams with the flag off are fully unaffected: reconcile stays surface-only, the mirror stays read-only.

## Contract
Any inbound write-back is a **versioned change to `brain-api.md`** first (bump revision), matched in `aios-team-brain`. Done in **v1.4** — see the "Bidirectional PM sync (Linear ⇄ brain)" section there, which documents the field-level conflict policy, the `team`-tier default for adopted tasks, the loop-prevention invariant, and the poll-first / webhook-deferred trigger decision. The inbound rule is kept **separate** from the markdown↔dashboard "last write wins per `row_key`" rule (they are independent axes).

## Acceptance
On a team with `bidirectional_pm_sync = true`:
- Move a card Todo→Done in Linear → after reconcile, the brain `tasks.status` reflects it; a subsequent "Project board now" makes **zero** writes (no echo).
- Create an issue directly in Linear → after a poll, a brain task appears (team tier), adopted to the same Linear issue (no duplicate), and a second poll neither diff-deletes it nor creates a duplicate.
- A custom/renamed Linear state maps to the right status group; a deleted/renamed baseline state → conflict, no apply.
- Concurrent edits (brain + Linear) on the same task → surfaced as a conflict, not silently resolved (including the RPC optimistic-guard case where the brain moves between read and apply).
- Admin/private content never created or leaked via inbound.

On a team with `bidirectional_pm_sync = false` (default): reconcile stays surface-only, the mirror stays read-only, and nothing above happens — the team is fully unaffected.
