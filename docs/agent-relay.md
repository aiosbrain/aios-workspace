# agent-relay — Opus ↔ Cursor Review Loop

`scripts/agent-relay.mjs` runs an automated plan–review cycle: Opus 4.8 writes an implementation plan, Cursor reviews it adversarially, Opus revises based on the feedback, and the loop repeats until Cursor emits `MERGE_READY` or the round limit is hit.

---

## Prerequisites

| Requirement | How to check | How to install |
|---|---|---|
| Node 18+ | `node --version` | `brew install node` |
| `cursor` CLI | `cursor --version` | `curl https://cursor.com/install -fsS \| bash` |
| `ANTHROPIC_API_KEY` | `echo $ANTHROPIC_API_KEY` | Add to `.env` (loaded by dotenvx) or export in shell |
| `@anthropic-ai/sdk` | `cat package.json \| grep anthropic` | `npm install` in `aios-workspace/` |

The `/review-plan` Cursor skill lives at `~/.cursor/skills/review-plan/SKILL.md`. It must exist for Cursor to trigger it by name.

---

## Quickstart

```bash
# From aios-workspace/
node scripts/agent-relay.mjs "Add a dark mode toggle to the settings panel" --dry-run
```

`--dry-run` skips all git operations so you can watch the loop without touching any branches.

---

## Full Usage

```
node scripts/agent-relay.mjs "<task>" [branch] [options]

Arguments:
  <task>        Plain-English description of what to implement (required)
  [branch]      Git branch to merge when approved (optional; omit to skip git ops)

Options:
  --rounds N       Max plan/review cycles before giving up. Default: 5
                   Use 5–6 for complex refactors, 3 for simple additions.
  --skill /name    Cursor slash command to invoke. Default: /review-plan
  --dry-run        Print what git commands would run but do not execute them.
```

### Examples

```bash
# Simple: no git ops, watch the loop
node scripts/agent-relay.mjs "Extract auth middleware into its own module" --dry-run

# With a branch: merges automatically on approval
node scripts/agent-relay.mjs "Add rate-limit headers to the push endpoint" feat/rate-limit-headers

# More rounds for a complex task
node scripts/agent-relay.mjs "Migrate all validators to Zod" --rounds 6 --dry-run

# Custom Cursor skill
node scripts/agent-relay.mjs "Audit the ingest pipeline" --skill /audit-plan --dry-run
```

---

## What Happens During a Run

```
── Agent Relay ──────────────────────────────────────────────
Task:       Add rate-limit headers to the push endpoint
Branch:     feat/rate-limit-headers
Skill:      /review-plan
Max rounds: 5
─────────────────────────────────────────────────────────────

══ Round 1/5 ══════════════════════════════════════════════

[opus] planning (xhigh effort)...  done.

── Opus plan ───────────────────────────────────────────────
1. Locate the push handler in aios.mjs …
2. Add X-RateLimit-Limit and X-RateLimit-Remaining headers …
…

[cursor] invoking agent...
<Cursor streams its review here — Blocker/Major/Minor issues>

── Cursor review done ──────────────────────────────────────

══ Round 2/5 ══════════════════════════════════════════════
[opus] planning (xhigh effort)...  done.
…
```

If Cursor approves, the last line of its output will be `MERGE_READY` exactly, and you'll see:

```
✓ MERGE_READY received after round 2.
✓ Merged and deleted: feat/rate-limit-headers
```

If the loop exhausts all rounds without approval:

```
✗ Reached max rounds (5) without receiving MERGE_READY.
```

Exit code is `0` on approval, `1` on exhaustion or fatal error.

---

## How Opus Plans (xhigh effort)

Opus 4.8 is called with:
- `thinking: {type: 'adaptive'}` — extended internal reasoning, visible to the model but not printed
- `output_config: {effort: 'xhigh'}` — maximum planning depth for coding/agentic tasks
- `max_tokens: 32000` — enough room for a full revised plan after each round of feedback

The full conversation history (task → plan → review → revised plan → …) is threaded through each Opus call so it has complete context when revising.

---

## How Cursor Reviews (`/review-plan`)

The skill is at `~/.cursor/skills/review-plan/SKILL.md`. It takes Opus's plan and:

1. Identifies issues scored `Blocker`, `Major`, or `Minor`
2. Outputs a copy-paste `<prompt>` block instructing Opus exactly how to revise

### Approval gate — when Cursor emits `MERGE_READY`

Cursor will **only** emit `MERGE_READY` (alone on the final line) when **all six** of these pass:

| # | Condition |
|---|-----------|
| 1 | Zero `Blocker` issues remaining |
| 2 | Zero `Major` issues remaining |
| 3 | All "Questions to resolve" have been answered internally in the plan (not deferred) |
| 4 | Every verification step names a concrete command, fixture, file, or manual flow — no "TBD" or "validate later" |
| 5 | All referenced files, functions, APIs, or contracts either exist in the repo or are created by a prior step in the plan |
| 6 | No hand-waving on architecture, data contracts, auth, security, access tiers, or user-visible behaviour — rollback/migration path must be explicit |

If any condition fails, Cursor issues another feedback `<prompt>` and the loop continues.

---

## Driving a Test Run Yourself

### Minimal test (no git, no side effects)

```bash
cd /Users/iamjohndass/Projects/aios/aios-workspace
node scripts/agent-relay.mjs "Add a status badge to the sync CLI output" --rounds 3 --dry-run
```

Watch for:
- Round-by-round Opus plan output
- Cursor's issue list (Blockers → Majors → Minors)
- Whether the plan converges in 3 rounds or not

### Observing a real approval

Pick a small, well-scoped task that has clear acceptance criteria — for example:

```bash
node scripts/agent-relay.mjs "Add a --version flag to aios.mjs that prints from package.json" --rounds 4 --dry-run
```

Small tasks with no ambiguous files or auth concerns typically approve in 1–2 rounds with xhigh effort.

### Testing with a real branch

```bash
git checkout -b feat/test-relay
node scripts/agent-relay.mjs "Add a --version flag to aios.mjs" feat/test-relay
# On approval, the branch is merged and deleted automatically.
```

---

## Tuning Advice

| Situation | Adjustment |
|---|-----------|
| Loop never approves | Check Cursor's last review — it lists which conditions aren't met. Address them in the task description or scope down the task. |
| Too many rounds on simple tasks | Use `--rounds 3` for single-file changes |
| Need a different reviewer persona | Point `--skill` at a different Cursor skill file |
| Cursor CLI not streaming | The parser handles NDJSON and falls back to raw text; check `cursor --version` is recent |
| ANTHROPIC_API_KEY not found | Run `npx dotenvx run -- node scripts/agent-relay.mjs …` if using a `.env` file |

---

## Files

| File | Purpose |
|---|---|
| `scripts/agent-relay.mjs` | The relay loop script |
| `~/.cursor/skills/review-plan/SKILL.md` | Cursor's review persona and approval criteria |
