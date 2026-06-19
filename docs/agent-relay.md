# aios relay — Opus ↔ Cursor Review Loop

`aios relay` runs an automated plan–review cycle: Opus 4.8 writes an implementation plan, Cursor reviews it adversarially, Opus revises based on the feedback, and the loop repeats until Cursor emits `MERGE_READY` or the round limit is hit.

It is wired into the `aios` CLI (`scripts/relay.mjs`, exposed as `aios relay`). Run it through the CLI:

```bash
npm run aios -- relay "<task>" [branch] [options]
```

> **Deprecated:** `node scripts/agent-relay.mjs …` still works but only forwards to `aios relay` and prints a deprecation notice. There is one relay implementation — prefer the CLI form above. The standalone shim will be removed in a future release.

---

## Prerequisites

| Requirement | How to check | How to install |
|---|---|---|
| Node 18+ | `node --version` | `brew install node` |
| `cursor` CLI | `cursor --version` | `curl https://cursor.com/install -fsS \| bash` |
| `ANTHROPIC_API_KEY` | `echo $ANTHROPIC_API_KEY` | Add to `.env` (loaded by dotenvx) or export in shell |
| `@anthropic-ai/sdk` | `cat package.json \| grep anthropic` | `npm install` in `aios-workspace/` |

The `/review-plan` Cursor skill lives at `~/.cursor/skills/review-plan/SKILL.md`. It must exist for Cursor to trigger it by name.

`npm run aios` runs under `dotenvx`, so a `.env` with `ANTHROPIC_API_KEY` is picked up automatically.

---

## Quickstart

```bash
# From aios-workspace/
npm run aios -- relay "Add a dark mode toggle to the settings panel" --dry-run
```

`--dry-run` skips all git operations so you can watch the loop without touching any branches.

---

## Full Usage

```
npm run aios -- relay "<task>" [branch] [options]

Arguments:
  <task>        Plain-English description of what to implement (required)
  [branch]      Git branch to merge when approved (optional; omit to skip git ops)

Options:
  --rounds N           Max plan/review cycles before giving up. Default: 3
                       Use 5–6 for complex refactors, 3 for simple additions.
  --skill /name        Cursor slash command to invoke. Default: /review-plan
  --merge              Auto-merge the branch on approval. OFF by default — without
                       it, relay prints the diff and merge command for you to run.
  --log <file>         Save the approved (or last) plan to a Markdown file.
  --cursor-timeout N   Seconds before killing a stalled Cursor call. Default: 300
  --dry-run            Print what git commands would run but do not execute them.
```

### Examples

```bash
# Simple: no git ops, watch the loop
npm run aios -- relay "Extract auth middleware into its own module" --dry-run

# With a branch: on approval, prints the diff + merge command (does NOT merge)
npm run aios -- relay "Add rate-limit headers to the push endpoint" feat/rate-limit-headers

# With a branch + --merge: merges and deletes the branch automatically on approval
npm run aios -- relay "Add rate-limit headers" feat/rate-limit-headers --merge

# More rounds for a complex task, and save the plan
npm run aios -- relay "Migrate all validators to Zod" --rounds 6 --log zod-plan.md --dry-run

# Custom Cursor skill
npm run aios -- relay "Audit the ingest pipeline" --skill /audit-plan --dry-run
```

---

## What Happens During a Run

```
── aios relay ───────────────────────────────────────────────
Task:       Add rate-limit headers to the push endpoint
Branch:     feat/rate-limit-headers
Skill:      /review-plan
Max rounds: 3
─────────────────────────────────────────────────────────────

══ Round 1/3 ══════════════════════════════════════════════

[opus] planning (xhigh effort)...  done.

── Opus plan ───────────────────────────────────────────────
1. Locate the push handler in aios.mjs …
2. Add X-RateLimit-Limit and X-RateLimit-Remaining headers …
…

[cursor] invoking agent...
<Cursor streams its review here — Blocker/Major/Minor issues>

── Cursor review done ──────────────────────────────────────

══ Round 2/3 ══════════════════════════════════════════════
[opus] planning (xhigh effort)...  done.
…
```

When Cursor approves, the last line of its output is `MERGE_READY` exactly. What happens next depends on your flags:

```
✓ MERGE_READY received after round 2.

# With a branch but no --merge (default):
Plan approved. Review the diff before merging:
  git diff main...feat/rate-limit-headers
  git merge --no-ff -- feat/rate-limit-headers
Re-run with --merge to have aios relay merge automatically.

# With a branch and --merge:
✓ Merged and deleted: feat/rate-limit-headers
```

If the loop exhausts all rounds without approval:

```
✗ Reached max rounds (3) without receiving MERGE_READY.
```

Exit code is `0` on approval, `1` on exhaustion or fatal error. With `--log`, the approved plan (or the last plan on exhaustion) is written to the given file so the work is never lost.

---

## How Opus Plans (xhigh effort)

Opus 4.8 is called with:
- `thinking: {type: 'adaptive'}` — extended internal reasoning, visible to the model but not printed
- `output_config: {effort: 'xhigh'}` — maximum planning depth for coding/agentic tasks
- `max_tokens: 32000` — enough room for a full revised plan after each round of feedback

The full conversation history (task → plan → review → revised plan → …) is threaded through each Opus call so it has complete context when revising. Because xhigh effort can run for several minutes, the call streams and is bounded by `--cursor-timeout` only on the Cursor side.

---

## How Cursor Reviews (`/review-plan`)

The skill is at `~/.cursor/skills/review-plan/SKILL.md`. It takes Opus's plan and:

1. Identifies issues scored `Blocker`, `Major`, or `Minor`
2. Outputs a copy-paste `<prompt>` block instructing Opus exactly how to revise

### Approval gate — when Cursor emits `MERGE_READY`

Cursor emits `MERGE_READY` (alone on the final line) only when the plan is ready to implement: no `Blocker`s, no approach-level `Major`s, all open questions answered in the plan, every verification step names a concrete command/fixture/file, all referenced files/APIs either exist or are created by a prior step, and no hand-waving on architecture, data contracts, auth, security, access tiers, or user-visible behaviour. On the final round, Cursor approves unless a `Blocker` remains. If any condition fails, Cursor issues another feedback `<prompt>` and the loop continues.

---

## Driving a Test Run Yourself

### Minimal test (no git, no side effects)

```bash
npm run aios -- relay "Add a status badge to the sync CLI output" --rounds 3 --dry-run
```

Watch for:
- Round-by-round Opus plan output
- Cursor's issue list (Blockers → Majors → Minors)
- Whether the plan converges in 3 rounds or not

### Observing a real approval

Pick a small, well-scoped task that has clear acceptance criteria — for example:

```bash
npm run aios -- relay "Add a --version flag to aios.mjs that prints from package.json" --rounds 4 --dry-run
```

Small tasks with no ambiguous files or auth concerns typically approve in 1–2 rounds with xhigh effort.

### Testing with a real branch

```bash
git worktree add -b feat/test-relay ../aios-workspace-test-relay origin/main
cd ../aios-workspace-test-relay
npm run aios -- relay "Add a --version flag to aios.mjs" feat/test-relay --merge
# On approval with --merge, the branch is merged and deleted automatically.
# Omit --merge to review the diff and merge yourself.
```

---

## Tuning Advice

| Situation | Adjustment |
|---|-----------|
| Loop never approves | Check Cursor's last review — it lists which conditions aren't met. Address them in the task description or scope down the task. |
| Too many rounds on simple tasks | Use `--rounds 3` (the default) for single-file changes |
| Need a different reviewer persona | Point `--skill` at a different Cursor skill file |
| Cursor call stalls | Raise `--cursor-timeout` (seconds); the default is 300 |
| Cursor CLI not streaming | The parser handles NDJSON and falls back to raw text; check `cursor --version` is recent |
| ANTHROPIC_API_KEY not found | `npm run aios` loads `.env` via dotenvx; confirm the key is set there or exported |

---

## Files

| File | Purpose |
|---|---|
| `scripts/relay.mjs` | The relay loop implementation (`cmdRelay`), exposed as `aios relay` |
| `scripts/agent-relay.mjs` | Deprecated shim that forwards to `aios relay` |
| `~/.cursor/skills/review-plan/SKILL.md` | Cursor's review persona and approval criteria |
