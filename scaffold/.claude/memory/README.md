---
access: team
---
# Memory — cross-session learning

This folder is how the repo's agents get better over time instead of re-deriving
(or re-committing) the same mistakes.

```
memory/
├── instincts.md     distilled, general rules — CONSULT BEFORE RUNNING HARNESSES
├── incidents/       one file per failure — the raw material rules distill from
├── USER.md          who the owner is (person) — injected at session start
└── WORKSPACE.md     the company / env / tooling — injected at session start
```

## Tiering is per-file (don't assume the folder is uniformly team)

Read each file's `access:` — they differ on purpose:

| File | `access:` | Why |
|------|-----------|-----|
| `instincts.md`, `incidents/` | `team` | Harness learning — compounds across the team via the brain. |
| `USER.md` | `admin` | Personal profile (prefs, goals, comms style). **Private — never syncs.** |
| `WORKSPACE.md` | `admin` | The agent's private working knowledge (env, tooling). Shareable company facts belong in `0-context/`, not here. **Private by default.** |

`USER.md` / `WORKSPACE.md` are **durable agent memory**, distinct from the
`incidents → instincts` harness loop below. They are bounded (see each file's cap
header) and injected into the agent at session start — frozen for the session, so
edits take effect next session. Their YAML frontmatter is stripped before
injection (it governs tiering, it's never shown to the model).

## The progression (follow it in order; don't skip to "distill")

1. **Fail.** A harness misses its rubric after budget exhaustion, a verifier
   catches a recurring class of error, or the user corrects agent output.
2. **Investigate.** Write `incidents/YYYY-MM-DD-<slug>.md`: what happened, what
   the output said, what the truth was, and the suspected root cause.
3. **Verify.** Before moving on, confirm the root cause — re-run the failing
   step, check the source file, test the alternative. Record HOW it was
   confirmed in the incident file. An unverified guess stays a guess.
4. **Distill.** When a pattern has **two or more verified incidents**, append a
   one-line general rule to `instincts.md` with `derived-from:` links to its
   incidents. One incident is an anecdote; two are a rule candidate.
5. **Consult.** Sessions read `instincts.md` before running any harness (the
   repo CLAUDE.md says so); rubric verifiers receive it as supplementary
   criteria. Reading the rule replaces re-deriving it.

## Incident file format

```markdown
---
status: investigating | verified | distilled
date: YYYY-MM-DD
harness: <name or "session">
---
# <slug>

**What happened:** …
**Expected:** …
**Root cause:** …
**How verified:** …          ← required before status: verified
**Distilled into:** <rule id in instincts.md, once it is>
```

OGR05 (`validation/check-rubrics.sh`) checks that every instinct links at least
one incident file that exists — rules without evidence don't accumulate.

## Background reviewer (shipped — cockpit, claude-code runtime only)

Beyond onboarding seeding and explicit "remember that" updates, the cockpit runs an
**automatic, conservative** writer after each turn (`memory_review: on` in `aios.yaml`;
toggle in **Settings → Memory**). It only ever appends short bullets to the
**`<!-- reviewer:learned … -->`** block at the end of `USER.md` / `WORKSPACE.md` — it
never edits the content you or onboarding wrote above that marker.

Trust boundary (the model only *suggests*; deterministic server code decides):
- **Runtime gate:** runs only on the `claude-code` runtime (reuses its ambient auth);
  never on codex/opencode/ACP/local — those make no Anthropic call.
- **Facts, not files:** a fast model (Haiku) returns tiny structured facts
  `{file, section, fact, reason}`; the **server** builds the Markdown. The model can't
  emit file bodies, frontmatter, or markup.
- **Locked-down call:** toolless / settingless `query()` (`settingSources:[]`,
  `allowedTools:[]`, `mcpServers:{}`, `maxTurns:1`); any error → skip silently.
- **Redact first:** turns matching `validation/secret-patterns.txt` are **not** sent to
  the reviewer, and any assembled content with a secret is **not** written (JS scan is
  authoritative; the host guard is a second layer that can fail open).
- **Fail-closed apply:** path enum (only these two files), single-line/no-code/
  no-frontmatter facts, an injection-phrase denylist, per-file cap (FIFO-evict), and a
  dirty-tree skip if a human edited the file since session start.
- **Reversible, not committed:** each write emits a `💾 memory updated` event with an
  **undo** (compare-and-swap — only reverts if the file is still exactly what we wrote);
  never `git commit`. Skipped if the WebSocket is closed (no write you can't see/undo).
- **Freeze-at-start:** memory is injected once per session, so a write lands **next
  session** — the notice says so.

Implementation: `gui/server/memory-reviewer.mjs` (`reviewTurn` + `applyMemoryUpdates`),
`gui/server/memory-files.mjs` (caps + section enums), wired in `gui/server/index.mjs`
after `emit({type:"result"})`. Still deferred: Curator GC, FTS5 session search, Honcho
multi-pass, and a reviewer for non-claude-code runtimes.
