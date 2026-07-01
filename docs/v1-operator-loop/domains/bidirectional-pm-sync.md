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

### Phase B — Inbound create
A Linear issue with no `task_pm_link` (created directly, like AIO-139–144) → **create a brain task**:
- Generate a `row_key`, set `provider_resource_id` to adopt the existing issue (no duplicate), backfill the `aios-ext` footer.
- **Tier safety:** inbound-created tasks default to **team** tier; inbound NEVER creates `admin` content and never elevates tier (preserves the boundary the brain enforces at 422).

### Phase C — Trigger
- **Linear webhook receiver** (`issue.create` / `update` / state change) → enqueue a scoped reconcile for that issue (near-real-time).
- **Poll fallback** on the existing 30-min ingest scheduler (`lib/ingest/manual-sync.ts`) for resilience / missed webhooks.

### Phase D — Loop prevention (the "regenerate" gotcha)
When applying an inbound change, **update `last_projected_status` + `projection_fingerprint` in the same transaction** so the subsequent reactive projection sees "no change" and does not echo the edit back to Linear → prevents the infinite inbound→outbound→inbound loop.

## Contract
Any inbound write-back is a **versioned change to `brain-api.md`** first (bump revision), matched in `aios-team-brain`. Document the conflict policy, the tier-default for inbound-created tasks, and the loop-prevention invariant.

## Acceptance
- Move a card Todo→Done in Linear → after reconcile, the brain `tasks.status` reflects it; a subsequent "Project board now" makes **zero** writes (no echo).
- Create an issue directly in Linear → a brain task appears (team tier), adopted to the same Linear issue (no duplicate).
- Concurrent edits (brain + Linear) on the same task → surfaced as a conflict, not silently resolved.
- Admin/private content never created or leaked via inbound.
