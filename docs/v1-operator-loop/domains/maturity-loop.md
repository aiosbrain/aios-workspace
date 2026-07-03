# Domain spec — Maturity Loop (`aios` maturity hooks + CLIs: the self-learning operator)

Governed by [`ENGINEERING-CONSTITUTION.md`](../../ENGINEERING-CONSTITUTION.md). Part of the
Agentic Maturity Loop epic (sibling to AIO-156 ship pipeline and AIO-166 Agentic Ergonomics;
extends the AEM analyzer shipped in AIO-169/AIO-190).

## Why

The AEM analyzer already **measures** (session logs → 18 signals, `scripts/analyze/metrics.mjs`)
and **evaluates** (5 axes → Spine L1–L5, `scripts/analyze/aem.mjs`; coaching text in
`scripts/analyze/guidance.mjs`). But it is batch-only and open-loop: nothing feeds the placement
back into the operator's live sessions, nothing learns from their corrections, and nothing
measures whether what was learned actually helped. The Maturity Loop closes it:

```
capture (per-session, SessionEnd)         → .aios/loop/maturity/sessions.ndjson
  → feed-forward (SessionStart brief)     → 3-line placement + tip in every session
  → observe corrections (Stop)            → .aios/loop/maturity/observations.ndjson
  → distill instincts (batch LLM)         → homunculus instinct records
  → score effectiveness (before/after)    → cull what didn't move the metrics
  → weekly report + belts (cadence)       → 3-log/maturity/week-<date>.md
```

The end state is a system that learns how the operator uses AI, tells them where they stand,
nudges the highest-leverage change, and proves (or disproves) that its own teaching worked.

## Reuse (shipped, KEEP)

- **Hook discipline** — `hooks/asks-capture.mjs` (AIO-167): fail-open always-exit-0, lockfile with
  30s stale reclaim + bounded retries, dedup inside the lock, hard line caps, `tier:"admin"` on
  every record. Every maturity hook clones this exactly. Test pattern:
  `test/operator-loop/asks-hook.test.mjs` (spawn hook with stdin payload + synthetic transcript).
- **Signals pipeline** — `scripts/analyze/parse-claude.mjs`, `normalize.mjs`, `metrics.mjs`
  (`computeSignals`). Plain-source ESM: hooks import these modules directly (never from `dist/`,
  which may be unbuilt when a hook fires — the asks-capture reimplement-for-parity rule does NOT
  apply here because these are `.mjs` source, not compiled TS).
- **Scoring** — `scripts/analyze/aem.mjs` `placement(signals)` / `scoreAxes` / `spineLevel` /
  `weakestAxis` / `AXIS_LABELS`; coaching steps in `guidance.mjs` `AXIS_GUIDE`.
- **Injectable-LLM seam** — `scripts/spec-eval.mjs` + `test/spec-eval-live.test.mjs` pattern:
  deterministic tests via injected fn; live test double-gated on an explicit env flag + key.
- **Decision corpus** — `.aios/loop/decisions/decisions.ndjson` (AIO-170/EE4) for Phase B
  ergonomics calibration outcomes.
- **Instinct format** — `~/.claude/homunculus` layout as defined by the continuous-learning
  instinct CLI (YAML frontmatter `id/trigger/confidence/domain/source/scope/tags` + markdown body).

## Build (slices; each is one Linear child issue, ship-able via `aios ship`)

| Slice | Surface |
|---|---|
| AM1 session-close capture | `hooks/maturity-capture.mjs` (SessionEnd) + additive `computeSessionRecord()` in `metrics.mjs` → `sessions.ndjson` |
| AM2 feed-forward brief | `hooks/maturity-brief.mjs` (SessionStart) → 3-line `additionalContext` |
| AM4a correction observations | `hooks/instinct-observe.mjs` (Stop) → `observations.ndjson` |
| AM4b instinct distill | `aios instincts distill` (batch, injectable LLM) → homunculus records |
| AM6 weekly report + belts | `aios maturity-week` + band-constant export refactor in `aem.mjs` |
| AM5 effectiveness scoring | `aios instincts score` (before/after per learned artifact) |
| AM3 anti-pattern nudge | `hooks/maturity-nudge.mjs` (UserPromptSubmit), one detector + cooldown |
| AM7 ergonomics Phase B | `scripts/analyze/ergonomics-calibrate.mjs` (per AIO-190 plan) |
| AM8 scaffold packaging | hooks + skills into `scaffold/.claude/` + `scripts/scaffold-project.sh` |

Deferred (documented, not filed): AM9 brain-side instinct sync + team maturity UI
(`aios-team-brain`; overlaps EE10 — gated on a versioned `brain-api.md` change).

## Contract

### v1 NDJSON — `.aios/loop/maturity/sessions.ndjson` (AM1 writes, AM2/AM5/AM6 read)

Append-only; state is the in-order fold. `op:"put"` is **last-wins** per `session_id`
(SessionEnd fires on `/clear`, logout, and resume-exit — later snapshots of the same session
supersede earlier ones). Malformed/unknown-version lines are skipped and counted, never fatal.

```json
{"v":1,"op":"put","session":{"session_id":"<uuid>","tool":"claude","project":"<cwd-basename-slug>","ended_at":"2026-07-03T10:00:00.000Z","event_count":412,"signals":{"tasks":9,"total_tokens":1200000,"delegation_ratio":0.18,"error_rate":0.03,"cache_hit_rate":0.62,"tool_diversity":7,"verify_tool_rate":0.14,"subagent_usage":1,"correction_loop_avg":11.2,"tokens_per_task":83000,"permission_events":2},"counts":{"in_tok":0,"out_tok":0,"cache_read_tok":0,"cache_create_tok":0,"subagent_tok":0,"tool_use_total":0,"verify_tool_uses":0,"tool_results":0,"tool_result_errors":0,"tasks":0,"permission_events":0,"distinct_tools":["Bash","Edit"]},"tier":"admin","captured_at":"2026-07-03T10:00:01.000Z"}}
```

- `signals` = per-session `computeSignals()` subset; **numeric only, never transcript text**.
- `counts` = raw numerators/denominators so readers re-aggregate windows **exactly** (fold counts
  across sessions → recompute ratio signals → `placement()`); readers never average ratios.
  `distinct_tools` capped at 50 names.
- Write-skip dedup: same `session_id` with same `event_count` → no append.
- Transcript read cap 10 MB; hard line cap 20 000 (fold-compaction beyond it).

### v1 NDJSON — `.aios/loop/maturity/observations.ndjson` (AM4a writes, AM4b reads)

```json
{"v":1,"op":"create","obs":{"id":"<uuid>","session_id":"<uuid>","ts":"2026-07-03T10:00:00.000Z","kind":"correction","snippet":"no - use the existing helper in flat-yaml.mjs","prior_hash":"<sha256 of corrected assistant tail>","tier":"admin","createdAt":"..."}}
```

`snippet` ≤ 280 chars (the length-capped exception to numbers-only; still admin-tier, local-only,
excluded from every push path). Dedup key `sha256(session_id|prior_hash)`.

### Instinct record (AM4b writes; `AIOS_HOMUNCULUS_DIR`, default `~/.claude/homunculus`)

`<root>/projects/<project_id>/instincts/personal/<id>.md`:

```markdown
---
id: instinct-<slug>
trigger: "when editing YAML config loaders in this repo"
confidence: 0.6
domain: workflow
source: personal
scope: project
created_at: 2026-07-03T10:00:00Z
origin_obs: [<obs-id>, ...]
---
## Context
Operator corrected the agent twice for re-implementing YAML parsing.
## Action
Use `scripts/flat-yaml.mjs` instead of ad-hoc parsing.
```

`created_at` + stable `id` are the AM5 contract (before/after windows key on them).

### Hook stdin/stdout (Claude Code)

All hooks receive one JSON object on stdin: `hook_event_name`, `session_id`, `transcript_path`,
`cwd` (+ `reason` on SessionEnd, `source` on SessionStart, `prompt` on UserPromptSubmit,
`stop_hook_active` on Stop — skip when true). Context-emitting hooks (AM2, AM3) print exactly:

```json
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"AEM L4 · weakest axis: Autonomy/leash · tip: hand whole pieces of work to sub-agents instead of supervising one action at a time."}}
```

(`hookEventName:"UserPromptSubmit"` for AM3.) Capture hooks print nothing. Every hook always
exits 0.

## Tier / privacy invariants (verbatim in every slice)

All stores under `.aios/loop/maturity/` and all instinct records are **admin-tier, local-only**
(`.aios/` is gitignored; homunculus never syncs; reports go to `3-log/`, admin per the spine).
**`report.mjs buildPushPayload()` is unchanged — no new field crosses the tier boundary** (EE10
rule: attention signals + ergonomics shadow are never pushed; maturity-loop stores join that
list). Any LLM call is injectable + mockable; live tests are double-gated
(`INSTINCTS_LIVE=1` + key present), so `npm test` never spends tokens or touches the live
homunculus (tests set `AIOS_HOMUNCULUS_DIR` to a tmpdir).

## Scope — dogfood-only (this epic)

Slices AM1–AM7 register hooks in **this repo's** `.claude/settings.json` only. Packaging into
scaffolded workspaces (both `--context consultant` and `--context employee`, validators green) is
exactly the AM8 slice and out of scope for every other slice.

## Acceptance (epic-level; each slice carries its own)

- End a session → one folded `sessions.ndjson` record; start a session → 3-line brief renders
  from real store data in <200 ms.
- A correction turn produces one observation; `aios instincts distill` (mock fn) produces a
  valid instinct file in a tmp homunculus; `aios instincts score` returns null verdicts below
  corpus minimums and directional verdicts above them.
- `aios maturity-week` writes `3-log/maturity/week-<date>.md` with level delta, per-axis bars,
  and next-belt criteria sourced from the exported band constants (no duplicated thresholds).
- Full verify green on every slice: `npm run build:loop && npm test && npm run lint && npm run format:check`,
  with each slice's tests appended to the serial `npm test` chain in `package.json`.

## Implementation

Hooks live in `hooks/` beside `asks-capture.mjs` and follow its conventions to the letter.
CLI subcommands (`aios instincts …`, `aios maturity-week`) register in `scripts/aios.mjs`
(offline-capable). Shared fold/read helpers live in `scripts/analyze/maturity-store.mjs`
(new, zero-dep). Nothing imports from `dist/`; `aem.mjs` public exports are preserved.
