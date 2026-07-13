The lightweight daily cadence — the habit driver. Reads the current C1 signal set and answers exactly three questions, nothing more:

1. **What changed** since the last run (decisions logged, deliverables moved, tasks edited).
2. **What's blocked** (stale carry-overs, things waiting on someone, blocked tasks/deliverables).
3. **What I owe today** (open next-actions due today/overdue, carried-over from yesterday via C7).

**Design rules (friction is the enemy):**
- Seconds to read, one screen / a few CLI lines. No verbose verification, no approval gate — daily is read-only orientation, not a deliverable.
- ONLY essential context. If in doubt, cut it. The daily's job is to keep the user oriented and feed the weekly, not to be a mini-report.
- Optional light evidence inline (a path), but skip the full C3 verifier pass.
- Runs identically from CLI and cockpit.

**Acceptance:**
- Daily run produces the three-section orientation in under a few seconds from a warm workspace.
- Carry-over from prior day is visible (via C7).
- No writeback, no sync — purely local orientation.

Ships first of the two cadences: cheapest, exercises C1, and builds the ritual before the heavy weekly lands.

---

## Implementation (AIO-127)

**Core** — `src/operator-loop/daily.ts`:
- `buildDailyOrientation({ manifest, prior, audience?, staleDays? }) → { orientation, nextSnapshot }` — a **pure** classifier over a manifest + the prior change-snapshot. "Today" is derived from `manifest.generatedAt` (the manifest is the contract), so a saved manifest is fully deterministic.
- `runDaily({ root, now?, member?, audience?, record? }) → DailyOrientation` — the thin filesystem wrapper the CLI **and** the cockpit both call: read prior snapshot → `collect({ cadence:"daily", window:false })` → classify → (owner only) persist the advanced baseline.

**CLI** — `aios loop daily [--as team|external] [--manifest <path>] [--no-record] [--record] [--no-connectors] [--json]`. Default is the owner-private local view; `--as team|external` is a tier-filtered shareable-safe view (never records); `--manifest` drives a deterministic saved-manifest run from an unwindowed full-state daily manifest (`windowed:false`, never records); `--json` prints the full `DailyOrientation`.

**Recording default depends on mode (AIO-365):** text mode (no `--json`) records by default — pass `--no-record` to suppress. `--json` mode does **not** record by default — pass `--record` to opt in. Rationale: a bare `--json` used to record by default, same as text mode, which meant a repeated poller (dashboard/cron/hook) calling `aios loop daily --json` on every tick would silently advance the baseline on its very first call and see near-zero "changed" on every call after — self-consuming its own signal. `--record --json` still lets a caller that genuinely wants both (e.g. a scheduled baseline-advance job that also wants JSON for logging) opt in explicitly.

**Connector preamble (AIO-366):** a live recording owner run pulls Granola, GOG
(calendar + unread Gmail), and Slack unread activity before `runDaily` collects and classifies.
Connectors run concurrently with independent deadlines and fail open; failures are concise stderr
diagnostics and the daily still renders current local signals. `--no-connectors` suppresses the
preamble. The side-effect-free inspection/projection paths (`--manifest`, `--as`, `--no-record`, and
bare `--json`) never invoke connector subprocesses. Manual connector scripts remain supported.

### Classification (each signal → at most one section; precedence **Blocked > Owed > Changed**)
- **carryover**: stale (`createdAt` older than `staleDays`, default 7) **or** blocked/waiting keyword → **Blocked**; else → **Owed today**.
- **task** (open status only): blocked/waiting keyword in status/labels/title → **Blocked**; else `due` on/before today → **Owed today**; else if changed since last run → **Changed**; else omit.
- **deliverable**: blocked status → **Blocked**; else if changed → **Changed**; else omit.
- **decision**: changed since last run → **Changed**; else omit.
- Unknown kinds are ignored (forward-compat). Dates are compared as ISO calendar strings (TZ-free, inclusive of today); a malformed/absent `due` is never overdue and a malformed `createdAt` is never stale.

### Change tracking (the reusable primitive) — `src/operator-loop/changes.ts`
"Changed" is a **content-fingerprint snapshot diff**, not an mtime check: a per-scope snapshot at `.aios/loop/state/changes-<scope>.json` records a sha256 of each artifact's `{kind, tier, summary, payload}` (occurredAt excluded), keyed by `path[#row]`. Run-to-run, added/modified artifacts populate "Changed". This gives real **per-row** task/decision change detection despite the file-level mtime the sources carry, and is generic over any signal kind (weekly/telemetry can reuse it). First run has no baseline, so it bootstraps "Changed" from the 24h window to avoid a day-one flood, then diffs thereafter.

### Boundaries
- **The classifier's only write** is the local change-snapshot under `.aios/loop/state/` — the same local-only, never-synced class as run manifests (outside `sync_include`; see `manifest-nonsync.test.mjs`). It records **only** on an owner run that resolves to `record: true` (text mode by default, or `--record` with `--json`). A recording owner may also receive connector-ingress writes before classification (transcripts and admin-tier comms activity); those connector adapters never sync or push. `--as`, `--manifest`, `--no-record`, and a bare `--json` remain side-effect-free.
- **C4 never** writes user artifacts (`3-log/`, `4-shared/`), syncs, touches Linear, runs the verifier/LLM, or **mutates the continuity store** — those are **C6** (AIO-129, approval-gated writeback). C4 reads the continuity store via `readContinuityActions`; when the user acts on an owed/blocked item (keyed by its action id in `ref`), that mutation is C6's.

### Known gaps (documented, not bugs)
- Carry-over (C7) is the durable backbone of Owed/Blocked (`occurredAt = now`, always current); task-derived items reflect whatever the current tasks table holds.
- PRs are absent from the daily (the github source is weekly-only and an inert stub) — deferred.
