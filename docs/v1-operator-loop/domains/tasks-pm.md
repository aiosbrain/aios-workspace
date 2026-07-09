# Domain spec — Tasks & PM (Linear)

Governed by [`ENGINEERING-CONSTITUTION.md`](../../ENGINEERING-CONSTITUTION.md). Feeds the [Operator Loop](../README.md).

## Why
Tasks are the operator's "what I owe next." The loop's daily (C4) and weekly (C5) cadences both
depend on a trustworthy task picture. Today there is **no task surface in the cockpit** and **no
`/api/tasks` route** — a task only moves through the CLI (`aios work done`, `aios push`) or the
brain dashboard, so the operator cannot see or lightly adjust the local task list without dropping
to a terminal. This slice adds a **standalone Tasks tab** to the cockpit that reads the workspace's
local task list, allows light field edits (status, assignee, priority, labels, parent — never the
title or body), and lets the operator **explicitly** push the task file to the brain over the
existing rails. Linear is the chosen PM tool; the brain `tasks` table is canonical and Linear is a
one-way downstream projection.

## Reuse (shipped — existing code this builds on, KEEP)
The following existing files are reused as-is; every claim below resolves to a real file:
- Markdown table parse/merge helpers `scripts/tasks-table.mjs` (`parseTaskRows`, `mergeTaskWriteback`).
- Tier + frontmatter parsers `scripts/workspace-parse.mjs` (`parseFrontmatter`, `normalizeTier`).
- The cockpit GUI server `gui/server/index.mjs` (raw-http, token-gated routes; already imports the
  two parser modules above and shells the CLI via `runAios`).
- The existing push route in `gui/server/index.mjs` (`POST /api/push`) — reused unchanged for the
  brain write; edits never auto-push.
- The C1 tasks collector `src/operator-loop/sources/tasks.ts`, which already emits one `task`
  signal per row. Because cockpit edits write back to the task file, the next collection re-emits
  the updated signal — **no new emitter is added**.
- The wire-contract types `gui/client/src/types/protocol.ts`, the API client seam
  `gui/client/src/state/cockpit.tsx` (`useConnection().api`), and the view registry
  `gui/client/src/hooks/useCockpit.ts` + `gui/client/src/components/layout/AppShell.tsx` +
  `gui/client/src/components/layout/Sidebar.tsx`.
- The panel patterns `gui/client/src/components/review/ReviewPanel.tsx` (read + select + push) and
  `gui/client/src/components/maturity/MaturityPanel.tsx` (load / empty / error states).
- Projection rails — epic **AIO-72**, brain-api **v1.5** — and the `/aios-linear` skill for board
  reads/writes.

## Build (net-new — files to create)
- **New file** `gui/server/tasks.mjs` — a pure, side-effect-free helper (mirroring
  `gui/server/maturity.mjs`) that resolves the task file, parses rows + file-level tier, and applies
  a single-row field patch via `mergeTaskWriteback`. It is unit-tested directly.
- **New route wiring** in `gui/server/index.mjs`: token-gated `GET /api/tasks` (parsed rows +
  file-level tier + local push-state badge) and `POST /api/tasks/edit` (a **local-only** markdown
  write — no network call). The edit route rejects any `title`/`body`/`description` key with HTTP
  400.
- **New file** `gui/client/src/components/tasks/TasksPanel.tsx` — the Tasks tab: a read-only title
  column, inline status/assignee/priority/labels/parent edits, a push-state badge, and an in-panel
  "Sync to brain" (dry-run → confirm) that reuses `POST /api/push`.
- **New test** `gui/server/tasks.test.mjs` — drives the pure helper (parse, patch, tier, rejection).

## Editable fields
The cockpit may edit **status, assignee, priority, labels, parent**. It must **never** edit the
task **title** or any **body/description** — those are brain-canonical and the markdown body is
never round-tripped (per `docs/brain-api.md`). The edit route enforces this by rejecting those keys.

## Signal contract (emitted to C1 — reused, not re-emitted here)
No new emitter is written. The existing tier-tagged signal shape is defined in
`src/operator-loop/signal.ts` and produced by `src/operator-loop/sources/tasks.ts`:
`{ kind: "task", source: "tasks", tier, occurredAt: <file mtime>, ref: { path, row, tier },
summary: <title>, payload: { status, assignee, sprint, due, priority, labels } }`. Cockpit edits
change the task file on disk; the next C1 collection re-reads it and re-emits the updated,
tier-tagged signal.

## Tier-safety posture
Tier is **file-level**, read from the task file's `access:` frontmatter through `normalizeTier`
(`private`→`admin`, `client`/`company`→`external`). **Default-deny:** a task file with no resolvable
`access:` is never pushed. `access: admin` never syncs — the brain rejects admin-tier at the
boundary (HTTP 422), and the push-state badge shows `blocked` with the reason. An edit still saves
locally regardless of tier; only the explicit "Sync to brain" step (reusing `aios push`) sends
anything to the brain, and it is disabled when the file is `blocked`.

## Deps
Deps: none blocking — the AIO-72 brain→Linear projection rails and brain-api v1.5 are already
shipped. No schema or brain change is required for this slice.

## Scope / Deferred
In scope: the cockpit Tasks tab (read + light edit), local-only save, an explicit push affordance,
and defaulting AIOS's own PM projection to Linear rather than Plane (Plane stays a **supported provider** — the adapter and admin selector remain; AIOS just no longer projects to it by default, keeping history + the dormant glyph).
Deferred (out of scope):
- Loop writeback adapter (C6) — approved weekly next-actions → brain → Linear — AIO-129.
- Linear⇄brain conflict/divergence UI in the cockpit (brain-internal; no `/api/v1` shape for the
  workspace) — AIO-78 / AIO-145.
- Editing the task title or body/description from the cockpit (brain-canonical).

## Build-with
Build-with: opus / high. Small, well-bounded modules across a server route, a pure helper, and one
React panel; correctness of the tier gate and the round-trip merge is the risk that earns the tier.

## Acceptance
- `GET /api/tasks` returns HTTP 200 with `{ rel, tier, rows, pushState }`; when no task file exists
  it returns `{ rel: null, tier: null, rows: [], pushState: null }` (no 500).
- `POST /api/tasks/edit` with a `{ row_key, patch }` body writes the patched row back to the task
  file and returns `{ ok: true, rel, row }`; the file's frontmatter and every other row are byte
  preserved (asserted by `gui/server/tasks.test.mjs`).
- `POST /api/tasks/edit` with a `title` or `body` key returns HTTP 400 and does not write.
- With `access: admin` on the task file, an edit still saves locally and `pushState.state` is
  `blocked`; the brain is never contacted (no push call is issued).
- The Tasks tab lists the rows of `examples/sample-engagement/03-status/tasks.md`, a status edit
  flips the badge to `modified`, and an explicit push returns the badge to `clean`.
- `node test/suggest-connectors.test.mjs` exits 0 after the Plane descriptor removal; `node
  test/tasks-table.test.mjs` exits 0; `npm run build:loop` succeeds.

## Testability
Each acceptance item is demonstrable by a named test: the parse/patch/tier/rejection paths by
`gui/server/tasks.test.mjs`; the merge round-trip by `test/tasks-table.test.mjs`; the connector
retirement by `test/suggest-connectors.test.mjs`; the client types by `npm run typecheck` in
`gui/client`.
