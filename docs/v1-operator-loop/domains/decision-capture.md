# Domain spec — Decision Capture (`aios decisions`: human-in-the-loop decision corpus)

Governed by [`ENGINEERING-CONSTITUTION.md`](../../ENGINEERING-CONSTITUTION.md). Part of the
[Agentic Ergonomics](../README.md) human-operating layer (epic AIO-166, issue **AIO-170 / EE4**).

## Why
Every time Claude asks the operator to make a call — an `AskUserQuestion` prompt during planning, a
plan approval/rejection at `ExitPlanMode` — a genuine decision happens: a question, a set of options,
and a human choice made in context. Those moments are the highest-signal training data in the whole
loop, and today they evaporate the instant the turn moves on. Decision Capture records each one as a
structured, queryable record in a durable local corpus (`.aios/loop/decisions/`): the question, the
options offered, the operator's choice, the context, and (later, on annotation) the outcome. It feeds
the decision-quality feedback loop (**EE5**) and the training/eval corpus (**EE14**).

This is distinct from the workspace **decision-log** domain (which captures *engagement* decisions in
`3-log/`). Decision Capture records *human-in-the-loop prompt decisions* — the agent↔operator
interactions themselves — not project decisions.

## Reuse (shipped, KEEP)
- **EE1 asks store architecture** (`asks/store.ts`) — the append-only NDJSON + writer-honored
  lockfile pattern and the fold-to-state-on-read discipline. The decisions store copies the lock
  protocol deliberately (a small amount of duplication keeps each module bounded; the asks store is
  **not** refactored).
- **EE1 capture-hook posture** (`hooks/asks-capture.mjs`) — dependency-free, bounded stdin, wrap
  everything in try/catch, ALWAYS exit 0, self-contained v1 create-line writer + lock protocol.

## Capture sources (zero-LLM, deterministic)
Claude Code fires **PostToolUse** hooks with stdin JSON
`{session_id, transcript_path, cwd, hook_event_name:"PostToolUse", tool_name, tool_input, tool_response}`.
Two tools are the structured decision moments:

1. **`AskUserQuestion`** — one decision record **per question** in `tool_input.questions[]` (each
   `{question, header, options[{label, description}], multiSelect}`). The chosen label(s) + any
   free-text notes are extracted defensively from `tool_input.answers` / `tool_response` (answers
   object keyed by question text or header, an answers array, a bare response string for a single
   question). Unknown shape → `choice: null`, but the question + options are still captured.
2. **`ExitPlanMode`** — one `plan-approval` record; `choice: "approved"|"rejected"` read from the
   response text (approval contains "approved"; any non-approval response is a rejection whose text
   becomes the notes/feedback). Empty/unparseable response → `choice: null`.

## Contract

### v1 NDJSON line schema (`.aios/loop/decisions/decisions.ndjson`)
Append-only. State is the in-order fold; malformed lines, unknown-version lines, unknown-id outcome
ops, and duplicate create ids (**first create wins**) are skipped and counted in `warnings` (never
swallowed). Decisions are **never mutated** — an outcome is a separate append (last outcome wins).

```json
{"v":1,"op":"create","decision":{"id":"...","kind":"ask-user-question","question":"Which database?","header":"Database","options":[{"label":"Postgres","description":"relational"}],"choice":["Postgres"],"notes":"cheaper for our load","context":{"sessionId":"...","project":"...","transcriptPath":"...","cwd":"..."},"tier":"admin","createdAt":"2026-07-02T12:00:00.000Z"}}
{"v":1,"op":"outcome","id":"...","outcome":"chose Postgres, worked well","at":"2026-07-05T12:00:00.000Z"}
```

Folded `Decision` = the stored record plus fold-derived `outcome` (`null` until annotated) and
`outcomeAt`.

**Field rules (enforced at every write entry point — store + hook):**
- `id` — unique create id (`crypto.randomUUID()`).
- `kind` — `ask-user-question` | `plan-approval` (forward-compat: any normalized string, ≤ 40 chars).
- `question` — single-line, control chars stripped, ≤ 500 chars (plan approvals: `Plan approval: <title>`).
- `header` — AskUserQuestion header chip, single-line ≤ 200, or `null`.
- `options` — `[{label (single-line ≤200), description (≤1000 or null)}]`; `[]` when unknown.
- `choice` — selected label(s) as a string array, or `null` when not extractable.
- `notes` — user's free-text / rejection feedback, ≤ 2000, or `null`.
- `context` — `{sessionId, project, transcriptPath, cwd}`, each string or `null`.
- `tier` — always `admin`. The store is **local-only** and **never syncs** (not a C1 signal).
- `createdAt` — ISO; an invalid/absent input timestamp falls back to now.

### Lock protocol (part of the v1 contract — the hook reimplements it; parity-tested)
Identical to EE1: lock file `decisions.ndjson.lock`, `O_CREAT|O_EXCL` (`openSync(p,"wx")`), pid+token
inside; stale (`mtime` > 30s) reclaimed; appends acquire the lock, `appendFileSync` (O_APPEND),
release. Only appends run under the lock (no rewrite), so no line can be lost. The hook skips silently
on lock failure (a missed capture is acceptable — it never blocks a session); the store's callers die.

### Dedupe (double-fire protection)
The hook skips a create whose `sessionId | sha256(question)` key already exists in the store — a
re-fired PostToolUse for the same session+question does not double-write. Distinct sessions asking the
same question are kept (per-session key).

## Scope — dogfood-only (this slice)
AIO-170 ships as a **dogfood harness for this repository only**. Registration is a checked-in root
`.claude/settings.json` `PostToolUse` entry (matcher `AskUserQuestion|ExitPlanMode` →
`hooks/decision-capture.mjs`), added alongside the existing EE1 Notification/Stop hooks. Installing
the hook + CLI into scaffolded workspaces is **explicitly out of this slice** and tracked as a
follow-up (same decision as EE1).

## Acceptance
- Planning-time decision prompts are captured as queryable records: an `AskUserQuestion` (with the
  chosen label + notes) and an `ExitPlanMode` approval/rejection both land as structured records.
- A question whose answer can't be extracted is still captured with `choice: null`.
- Records are queryable: `aios decisions list` / `show` / `outcome` / `export` round-trip, offline
  (from a repo with no `aios.yaml`).
- The hook never disturbs a session (always exits 0) and re-fires do not duplicate (dedupe holds).

## Implementation
Clean TS under `src/operator-loop/decisions/store.ts` (`readDecisions` / `foldDecisionLines` /
`appendDecision` / `appendOutcome` + the copied lock), a dependency-free
`hooks/decision-capture.mjs`, and `cmdDecisions` in `scripts/aios.mjs` (registered in
`OFFLINE_CMDS`). Public surface re-exported from `src/operator-loop/index.ts`.
