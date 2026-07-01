# Domain spec — Time Tracking (native agent-session runtime)

Governed by [`ENGINEERING-CONSTITUTION.md`](../../ENGINEERING-CONSTITUTION.md). Feeds the [Operator Loop](../README.md). Issue: **AIO-139**.

## Why
The weekly closeout (C5) needs an honest picture of where time went, and the daily loop (C4)
benefits from "what agents ran for me yesterday." Time is captured **natively from Claude terminal
session logs** — not hand-logged, not dependent on a third-party tracker.

## What v1 tracks — **agent runtime only**
The session logs hold two honest-but-different quantities:
- **Agent runtime** — the wall-clock an agent was actively working, derived deterministically from
  event timestamps. Across concurrent terminals it **sums** (4 sessions × 1h = 4 agent-hours) — this
  is the *agentic-leverage* number, not a double-count bug.
- **Attended (human) effort** — what a human was actually engaged for. This is an *inference*
  problem the logs cannot settle honestly (an agent can run autonomously while you are away).

**v1 ships agent runtime only.** Attended effort is **deferred** to a future purpose-built tracker
(e.g. Toggl) with its own presence signal — we do not infer human presence. The signal's `source`
discriminator keeps the door open: a later `source:"toggl"` can emit the same `kind:"time"`.

This domain stays in its own lane: it does **not** change the hand-logged hours lane
(`3-log/hours-log.md`, `kind:"hours"`). Wherever both appear, they are labelled **agent runtime**
(native) vs **logged hours** (manual) — they are distinct and never conflated.

## Reuse (KEEP)
- `scaffold/.claude/rules/hours.md` — the manual hours lane (unchanged).
- `scripts/analyze/parse-claude.mjs` — the *tolerant JSONL parsing approach* to reference (it keeps
  only a project **basename** and drops raw `cwd`, so the reader below defines its own typed event
  that preserves canonical `cwd`).

## Build (net-new clean TS)
Two-stage, because operator-loop sources are pure and read the workspace, while session logs live
outside it at `~/.claude/projects/*/*.jsonl`:

1. **Capture** (side-effecting CLI): parse logs → typed events preserving `realpath(cwd)` → segment
   into work blocks on idle gaps → tag → **scope by realpath** → tier → write finalized blocks to a
   local store. `aios time capture`.
2. **Source** (pure): `sources/time.ts` reads the store and emits `kind:"time"` signals into C1.
3. **Reconcile/report** (CLI, flags + JSON): confirm/correct tags and tiers; the confirm step is
   what makes the derived tags trustworthy.

### Work-block derivation (deterministic, no presence inference)
- Sort a session's events by timestamp (logs can be out-of-order); tolerate missing/garbled records.
- Segment into blocks on idle gaps greater than `idleGapMin` (default ~25 min). A block's
  `runtimeMin = round((lastEvent − firstEvent)/60000)`. Single-event / zero-length blocks are dropped.
- **Open-session rule:** only finalize (write) a block whose last event is older than `idleGapMin`
  before "now" — an ongoing block would keep growing and cannot be confirmed.
- Concurrency **sums** (leverage); no cross-session union (that belonged to attended effort).

### Repo scoping & tiering (safety boundary)
- Scope by **canonical realpath** of the session's `cwd` (`fs.realpathSync`), never a basename
  (basenames collide across worktrees / unrelated repos and could up-scope unknown work).
- Match against the **current-workspace realpath** + an explicit **allowlist** of realpaths.
  - Current workspace → `team` by default (config may override to `admin`/`exclude`).
  - Allowlisted repo → its configured tier.
  - Unknown/unlisted repo → **`exclude`** (default) or `admin` (opt-in) — **never** `team`.
- Allowlist lives in a **git-ignored** `.aios/time-config.json`
  (`{ repos: { "<absolute-realpath>": { tier, alias } }, default: "exclude"|"admin", idleGapMin }`).
  No private/NDA paths ever appear in committed source. The store records a **display alias only**,
  never a raw path.

### Tagging (ontology: engineering · strategy · communication · admin · research · meetings)
Deterministic heuristic from the event stream (tool-mix + path); the prior build's tag ontology and
scope-creep bands are *design reference only* — rebuilt clean. Imperfect by design; the reconcile
confirm/correct step is the trust mechanism.

## Store — `3-log/time-log.md`
Markdown table (round-trips via the shared `parseTableRows`), frontmatter `access: admin`, kept out
of `sync_include` — so the file can **never** sync. Columns:
`ID | Start | End | Repo(alias) | Runtime (min) | Tag | Tier | Confirmed | Task Ref`.
`Confirmed=yes` rows are **immutable**; `Confirmed=no` rows are refreshed idempotently by `ID`.

## Signal contract (emitted to C1)
`{ kind: "time", source: "session", tier, occurredAt: <block start>, ref: <store row>, payload: { repo: <alias>, durationMin, tag, taskRef? } }`
- The signal **summary carries the tag + runtime only — never the repo/alias**.
- Attributed to a reporting window by **start time** (`occurredAt = block start`); the C1 collector's
  existing occurredAt window filter handles daily/weekly with no change.

## Sharing (tier-safety, non-negotiable)
Time signals are **partitioned out** of every drafter / verifier / signal-catalogue path. The weekly
digest and the daily orientation get a **deterministic `{ tag, durationMin }` runtime-by-tag
roll-up** only. Repo aliases, block IDs, raw paths, branch names, session ids, and payloads never
reach a remote-LLM prompt, a digest claim, verifier JSON, or a next-week action. Admin/unlisted rows
are already stripped by audience projection, so a shareable digest sums only ≤-audience blocks.

## Acceptance
- A week of sessions produces `time` signals with sensible tags and a total agent-runtime figure.
- C5 weekly closeout surfaces runtime-by-tag; C4 daily surfaces "what agents ran yesterday"; the user
  can confirm/correct via `aios time reconcile`.
- Capture runs with **zero external service**, scopes strictly by realpath allowlist (unknown repos
  never up-scoped), and respects tier — no admin/unlisted session content in a shareable digest.
