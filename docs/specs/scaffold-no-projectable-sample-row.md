---
eval_tier: full
spec_gate: block
safety: false
type: issue-spec
---

# SAMPLEROW-1: a fresh workspace must not ship a task row that lands on someone's PM board

## What / why

**Written against the pre-fix tree** (`origin/main`, `scripts/scaffold-project.sh:386`), where the
heredoc that emits every new workspace's team task file seeded one data row. At this branch's HEAD the
row is gone and the table is header-only, so line 386 no longer points at it — read the quote below as
the state this slice removes, not as current behaviour (round-2 review, confirmed):

```
| TT1 | Example team task | $OWNER | ready | — | — | — |
```

That file is **team tier**, so `scripts/sync-plan.mjs` pushes it on the first `aios push`, the Team
Brain materializes the row into `tasks`, and the brain's PM projector applies **no status filter and
no audience filter** — so the row is projected into whatever PM tool the team connected. A sample
row is therefore not inert: it is a work item on a real board.

**What that has already cost, measured in the AIOS install's own production brain on 2026-08-18.**
Until `aios-team-brain#588` (`ADOPTFOOT-1`, merged 2026-08-18) the brain's Linear adapter resolved an
existing issue by the footer `aios-ext: <row_key>` alone, and `row_key` for this row is `TT1` in
*every* workspace. So a fresh workspace's sample row did not create an issue — it **adopted** whoever
already had one keyed `TT1`. Two of the nineteen projects in that brain (`chetan`, 2026-08-03;
`acme-workspace`, 2026-08-16) adopted the same real issue, `AIO-444` ("Finish verified operator
loop"), and renamed it: its production URL slug is now `…/AIO-444/example-team-task`. Three
`task_pm_links` rows point at that one issue, each with a different projection fingerprint.

`ADOPTFOOT-1` closed the adoption hole. It did **not** close this one — it converted the failure
mode: a sample row that may no longer adopt someone's issue now **creates its own**. Every new
workspace that connects a PM tool mints an "Example team task" issue on its board. Better than
hijacking a colleague's ticket; still junk that a human has to clean up, in the one place a team
looks to decide what to work on.

The root cause is not in the brain's projector — the projector is doing exactly what it is asked. It
is that the scaffold **ships work**. The fix is that the shipped table is empty.

**Two adjacent hypotheses were tested and REFUTED before writing this, so nobody re-derives them:**

- **The private sample row is not at risk.** `scripts/scaffold-project.sh:410` seeds
  `| TP1 | Example private task | … |` into `3-log/tasks-private.md`, whose frontmatter is
  `access: private`. `normalizeTier("private")` returns `"admin"`
  (`packages/foundation/src/workspace-parse/core.mjs:34`), `scripts/sync-plan.mjs:167` blocks
  `admin`, and the brain independently rejects it (`app/api/v1/items/route.ts:95`, 422
  `forbidden_tier`). The production brain holds **zero** items from any `tasks-private` path and zero
  `TP`-keyed tasks, which is the observable confirmation. Stronger still, from the real planner rather
  than a code reading: `aios push --dry-run` in a freshly scaffolded workspace does not list
  `3-log/tasks-team.md`'s private sibling at all — it is absent from the generated `sync_include`, with
  a comment in `scaffold/aios.yaml.tmpl` saying so and citing `AIO-364`. TP1 stays.
- **The personal task row is out of reach too.** `5-personal/tasks.md` ships a `P1` sample row, and
  `5-personal` is in the generated `sync_exclude`; the planner does not list it. Enumerated here
  because "is `:386` really the only shipped row that reaches a board?" is the question this slice
  lives or dies on, and the answer is yes for all three contexts, which share the one heredoc.
- **The projector's missing audience filter is unreachable.** A private/admin item cannot become a
  task at all (same 422), and `tasks.audience` is the two-value `access_tier` enum — production shows
  1,177 tasks, all `team`. There is no private-task-onto-a-shared-board leak here.

**And one trap this spec exists to name, found by running the parser rather than reasoning about
it.** The obvious fix — move the sample row into the illustrative `<!-- … -->` block already in that
heredoc — **does not work**. `parseTaskRows` (`scripts/tasks-table.mjs`) is a line scanner with no
HTML-comment awareness: it trims each line and takes any `|`-delimited line as a row. A commented,
indented `| TT1 | … |` still parses, still syncs, still projects. Verified:

```
  | TT1 | Ship the thing | alex | ready | — | — | — |   → 1 row   (commented out; still parsed)
e.g.  | TT1 | Ship the thing | alex | ready | — | — | — | → 0 rows (non-pipe prefix; invisible)
```

So the illustration must carry a non-pipe prefix — which is the convention the **same comment block
already uses** for its optional-columns example (`e.g.  | ID | Task | …`). A fix that looked right
and changed nothing is the specific outcome the acceptance criteria below are written to make
impossible.

**One consequence of an empty table, checked rather than assumed.** A task item pushed with `rows: []`
is accepted (the brain's task payload schema is `rows(taskRowSchema).optional()` with no `.min(1)`;
the local `validateItemPayload` accepts both `rows: []` and an omitted `rows`), and the brain's
`materializeTasks` then runs its **project-wide diff-delete**: every `origin='sync'` task in that
project whose `row_key` is absent from the push is deleted. In a freshly scaffolded workspace — the
only state this change affects, since the scaffold refuses to write into a non-empty directory — there
are no such tasks, so it is a no-op. The pre-existing behaviour for a workspace that empties an
already-populated task file is unchanged by this slice and is not what this slice is about.

## Outcomes

- A freshly scaffolded workspace's first `aios push` sends the team task file with **zero** rows, so
  no issue is created on the connected PM board by anything the scaffold shipped.
- A reader of the scaffolded file still learns the row shape and the optional columns — the
  illustration is preserved, in a form the parser cannot see.
- A future contributor who re-adds a sample data row (or moves one into the comment block believing
  that is inert) **fails CI**, with a message that says why the row is not free.
- `AIO-524`'s guarantee — every sample item a fresh workspace ships is pushable — still holds. Its
  em-dash date-shape coverage **moves rather than persists**: the per-context walk over real scaffold
  output no longer has a task row to check, so the standalone fixture test becomes the only guard on
  `parseTaskRows`' em-dash handling. (Round-2 review, confirmed: draft 2 claimed here that the coverage
  was "unchanged" while Scope §4 of the same document said the walk's loop is disarmed. Both could not
  be true, and the honest one is this.)

## Interface / integration points

- `scripts/scaffold-project.sh` — the one data row, inside the heredoc that emits a fresh
  workspace's team task file (lines 370–395 at this branch's HEAD). Lines 364–369 already warn that the
  em-dash normalization is load-bearing and name the guard to re-run; this change is in that spirit.
- `test/scaffold-push-item-validation.test.mjs` — `AIO-524`'s guard. It scaffolds all three contexts,
  walks the workspace with its **own** helper (`collectPushItems`), and validates each payload.
  Extended here, not replaced. That helper is **not** `buildPlan`: it walks every markdown file minus a
  hardcoded skip list, whereas the real planner walks the `sync_include` whitelist — so it is a
  superset, and a team-tier file outside `sync_include` is walked by the test but never pushed. (Draft 1
  and draft 2 described it as walking "exactly as `buildPlan` does"; round-2 review caught that this
  contradicted the rationale in Scope §3 of the same document. The new guard is built on the real
  planner precisely because of this gap.)
- `scripts/tasks-table.mjs` (`parseTaskRows`) — **not modified.** Teaching it to skip HTML comments
  would be a parser change affecting every workspace's real files, to fix a problem the scaffold
  should not create. Out of scope, and named as a non-goal below.
- `packages/foundation/src/workspace-parse/core.mjs` (`normalizeTier`) and `scripts/sync-plan.mjs` —
  read only, to establish that the private row is out of reach.
- The Team Brain's PM projector — lib/pm-sync/project.ts in the aiosbrain/aios-team-brain repo, not
  this one — is **not modified, and deliberately not depended on.** This slice removes the input; it
  does not ask the brain to special-case a sample.

## Dependencies

Depends on: nothing in this repo. Sequenced **after** `aios-team-brain#588` (`ADOPTFOOT-1`, merged),
which is what makes this the remaining defect rather than a lesser one — before it, an empty scaffold
table would still have left two live hijacks in place, and the adoption rung would have re-formed
them on the next push.

Traceability: `SAMPLEROW-1` (brain row key; Linear `AIO-971`). Siblings, neither blocked by nor
blocking this: `ADOPTUNIQ-1` (reconcile the two live hijacked links, then add the DB uniqueness
backstop — needs a human call because detaching mints issues) and `ADOPTPLANE-1` (the same adoption
defect in the Plane adapter, unreachable today at 1 Plane link against 959 Linear).

## Scope

**In:** one PR against `scripts/scaffold-project.sh` and `test/scaffold-push-item-validation.test.mjs`.

1. Remove the single `TT1` data row from the `tasks-team.md` heredoc. The header and separator rows
   stay — the table shape is part of the contract, and `parseTaskRows` returns `[]` for a
   header-only table.
2. Add the row's illustration to the existing comment block using the `e.g. ` prefix the block
   already uses, plus two sentences stating that a row here becomes a real PM issue and that
   commenting a row out does **not** make it inert.
3. Add a guard to `test/scaffold-push-item-validation.test.mjs` that asserts against **the real push
   planner, not the test's own walker**. For each context: scaffold, then run `aios push --dry-run` in
   the scaffolded workspace and assert its plan (a) **contains a line for `3-log/tasks-team.md`**, and
   (b) reports `rows=0` for it. This is the inverse assertion — the existing walk asserts every shipped
   row is *valid*, which an empty table satisfies vacuously, so without this the invariant would be
   unpinned the moment it was created.

   **Why the real planner and not `collectPushItems`** (round-1 review, confirmed): that helper walks
   every markdown file except a hardcoded skip list (`test/scaffold-push-item-validation.test.mjs:86`),
   whereas what actually leaves the machine is `buildPlan` over `aios.yaml` `sync_include`
   (`scripts/sync-plan.mjs:138`, `walkFiles` at `:31`). Those two disagree in both directions: drop
   `3-log/tasks-team.md` from `sync_include` and a `collectPushItems`-based guard stays green while the
   file no longer syncs at all; add a team-tier task-shaped file outside `sync_include` and it fails a
   guard for a file that can never reach a board. Measured: `aios push --dry-run` runs offline in a
   freshly scaffolded workspace, needs no API key, and today prints
   `3-log/tasks-team.md [task, team] rows=1` — the defect, in the planner's own words.

   **Part (a) is not decoration** (round-1 review, confirmed). Without it the guard is vacuous under a
   real mutant: rename the generated file, or break task classification, and the set of task items is
   empty, every `rows.length === 0` assertion passes, and the guard reports success for a scaffold that
   has *lost* its task surface rather than emptied its table. The same hole already exists one level up —
   `test/scaffold-push-item-validation.test.mjs:138` asserts only "at least one task **or decision**
   file", which `decision-log.md` satisfies alone.
4. State the disarmament in the test file itself (round-1 review, confirmed in substance): after this
   change the per-context walk's `due`-shape loop iterates **no task rows**, so the standalone
   `a '—' placeholder cell normalizes to null…` fixture is the only remaining guard on `parseTaskRows`'
   em-dash handling. One detail of that finding is **refuted**: it claimed the loop "will still run for
   decision rows", but a freshly scaffolded `3-log/decision-log.md` ships **zero** data rows too
   (`aios push --dry-run` reports `rows=0` for it), so that loop is already vacuous today and this
   change does not disarm something that was live.

**Deferred, with reasons:**

- **The two live hijacked links are not repaired here.** They hold `provider_resource_id`, so they
  resolve before any adoption rung and nothing in this repo touches them. `ADOPTUNIQ-1`.
- **A brain-side "hold this task, never project it" capability** is the more general answer (it would
  let a sample row exist in the brain but stay off the board) and is a schema + `brain-api` payload
  change across two repos. Not justified by one scaffold row.
- **`parseTaskRows` remains comment-blind.** Named as a non-goal above; this spec's acceptance
  criteria are written so that the blindness cannot silently defeat the fix.
- **A fresh workspace's first REAL task will now be keyed `TT1`.** The sample row used to occupy that
  key, so hand-written work started at `TT2`. This matters only for a self-hosted brain that PREDATES
  `aios-team-brain#588`: the toolkit ships independently of brain upgrades, and on an older brain the
  footer rung still matches `row_key` alone, so that first real task can adopt another workspace's
  `TT1` issue — with real content rather than a placeholder. Named, not fixed here: the fix is the
  brain-side one that already shipped, and the workspace cannot detect which brain version it faces.
  Raised by round-3 review; the Dependencies section above sequences after `#588` as though it were
  merged everywhere, which is true of the AIOS install and not of self-hosters.
- **`TP1` in `tasks-private.md` stays**, on the refuted-hypothesis evidence above: it cannot reach the
  brain, so removing it would delete an illustration for zero safety gain.

## Implementation approach

Single-file behaviour change plus its guard; the ordering is guard-first so the guard is proven to
have teeth against the *current* scaffold before the scaffold changes.

1. Add the zero-task-rows guard first and watch it **fail** against today's scaffold — it must report
   `rows=1`, the shipped `TT1`. A guard written after the fix cannot distinguish "invariant holds" from
   "assertion never ran". (Already observed by hand: the planner prints
   `3-log/tasks-team.md [task, team] rows=1` in a probe workspace scaffolded from `origin/main` — i.e.
   BEFORE this fix. At this branch's HEAD the same probe prints `rows=0`, so do not expect to
   reproduce the red baseline by rerunning it here.)
2. Edit the heredoc: drop the data row, extend the comment block.
3. Re-run the guard — now green — plus the whole `AIO-524` suite for all three contexts.
4. Mutation-verify **two** mutants, each against the assertion it is meant to catch:
   - re-insert the row inside the comment block (the plausible wrong fix) → the `rows=0` half must
     redden. This is the mutation that matters most, because that edit is what a reasonable
     contributor would try;
   - rename the emitted file (or otherwise stop it being classified as a task) → the **presence** half
     must redden. Without that half this mutant survives, which is the vacuity hole named in Scope §3.

## Acceptance criteria

### Automated

- `node --test test/scaffold-push-item-validation.test.mjs` passes, including a new per-context case
  that runs the real `aios push --dry-run` in a freshly scaffolded workspace and asserts its plan
  contains a `3-log/tasks-team.md` line **and** that the line reports `rows=0`. Both halves are
  required: the presence half is what stops the emptiness half passing vacuously.
- `node --test test/scaffold-push-item-validation.test.mjs` asserts the same plan does **not** list
  `3-log/tasks-private.md` — pinning the private-row refutation against the real planner rather than
  against a code reading (it is absent from scaffolded `sync_include`, and `access: private`
  normalizes to `admin`, which `scripts/sync-plan.mjs:167` blocks).
- `node --test test/scaffold-push-item-validation.test.mjs` still passes its existing three
  `every sample item pushes clean` cases — an empty task table must not break payload validation
  (confirmed already: the brain's task schema is `rows(taskRowSchema).optional()`, no `.min(1)`, and
  the local `validateItemPayload` accepts both `rows: []` and an omitted `rows`).
- `node --test test/scaffold-push-item-validation.test.mjs` still passes the standalone
  `a '—' placeholder cell normalizes to null…` case, which pins the `AIO-524` date shape from its own
  fixture and therefore does not depend on the shipped row.
- `grep -cE '^[[:space:]]*\| TT1 \|' scripts/scaffold-project.sh` returns `0` — **anchored**, because
  the criterion is "no line the row parser would read as a row", and `parseTaskRows` trims leading
  whitespace and takes any line that then starts with `|`.
- `grep -q 'e.g.  | TT1' scripts/scaffold-project.sh` exits 0 — the illustration is present in the
  parser-invisible form, not merely deleted.

  These two criteria **contradicted each other in draft 1** (round-1 review, confirmed): the first was
  written unanchored as `grep -c '| TT1 |'`, and since `|` is literal in a basic regex, the illustration
  the second criterion *requires* made the first return `1`. A builder implementing the slice exactly as
  intended would have failed its own acceptance check. Verified after the fix: against the illustration
  line alone, the unanchored form returns `1` and the anchored form returns `0`.
- `node --test test/task-tier-split.test.mjs test/transcripts.test.mjs` passes — these write their own
  `TT1` rows and must be unaffected by the scaffold no longer shipping one.
- `npm test` passes.
- **Mutation 1:** re-inserting `  | TT1 | Example team task | alex | ready | — | — | — |` inside the
  comment block makes the new case's **`rows=0`** assertion fail, and restoring makes it pass.
- **Mutation 2:** renaming the emitted file (or otherwise breaking its task classification) makes the
  new case's **presence** assertion fail. Required as its own criterion (round-2 review, confirmed):
  draft 2 named this mutant in the implementation approach but left it out of the formal gate, so the
  half of the guard the spec itself calls load-bearing could have shipped unverified — the exact vacuity
  hole this slice exists to close.
- **Mutation 3:** the same rename **with the presence assertion deleted** must go **green** — that is
  what proves mutation 2 is caught by the presence assertion specifically, and not incidentally by the
  pre-existing "at least one task/decision file" check, which the scaffolded decision log satisfies
  on its own.
- `node scripts/check-file-size.mjs` passes. `scripts/scaffold-project.sh` sits exactly **at** its
  grandfathered 775-line ceiling on `main`, and that ceiling may never rise, so the added comments are
  funded by tightening prose in the same two comment blocks. Net line delta must be ≤ 0.

### Manual

- `bash scripts/scaffold-project.sh --context consultant --slug tmp-ws … --output <tmpdir>`, then read
  `3-log/tasks-team.md`: the table has a header and no rows, and the comment block still shows the row
  shape and the optional columns.
- In that scaffolded workspace, `aios push --dry-run` lists `3-log/tasks-team.md` with `rows=0` rather
  than omitting it or erroring.

## Build-with

Build-with: Sonnet 5, medium effort. One heredoc edit plus one guard; the only subtlety — that a
commented row is still parsed — is already measured and written down above.

## Tier safety

No tier boundary moves. The team task file stays `access: team`; the private file is untouched and
stays out of reach of the brain (`normalizeTier("private") === "admin"`). Nothing here changes what
syncs, only what the scaffold puts in a file that already synced. The change strictly **reduces**
what leaves a fresh workspace on its first push, from one row to none.
