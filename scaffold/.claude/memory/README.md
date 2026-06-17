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

## Next: background reviewer (design handoff — not yet built)

`USER.md` / `WORKSPACE.md` are seeded at onboarding and updated on explicit
request ("remember that"). A later slice adds an automatic, conservative writer.
Spec for whoever builds it:

- **Hook:** server-side, after a turn completes — `emit({ type: "result" })` in
  `gui/server/index.mjs` (~L424).
- **Model:** a cheap/fast model, cost-capped. If unavailable, skip silently —
  never block or delay the user's turn.
- **Write bar (conservative):** persist only what would be wasteful to re-derive
  next session — user corrections, stated goals, environment facts, tools in use,
  necessary workarounds. Not a running transcript.
- **Guard path:** route every write through the host write-guard
  (`runGuardWrite`, `gui/server/index.mjs` ~L524) so the secret/tier scan still runs.
- **Reversibility:** write the working-tree file and emit a `💾 memory updated`
  event the cockpit shows with an **undo** (revert that single write). **Do not
  `git commit`** — the user owns commits.
- **Dirty-tree rule:** if the target file changed since session start (a human
  edited it), **skip** the write and surface a notice — never clobber.
- **Caps:** enforce the per-file cap programmatically here (this is where the
  advisory cap headers become real); evict the least-useful entry before adding.
