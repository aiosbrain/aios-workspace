# AIOS Engineering Harness

A curated, drop-in harness for **agentic software engineering** — the skills, hooks,
guards, subagent definitions, verification rubrics, and model-routing conventions that
make coding agents produce production-grade work on any stack (TypeScript, PHP, Python,
Go, …) under Claude Code, Codex, and OpenCode through equal first-class adapters.

**This is a curation-and-synthesis project, not an invention.** Every component cites
where it came from — the practicing agentic engineers and open-source packs whose
patterns have actually survived contact with production. See [PROVENANCE.md](PROVENANCE.md)
for the full component → source map, and [docs/thin-spots.md](docs/thin-spots.md) for an
honest account of what is still early or unproven.

> Status: **v0 — early, rough, usable.** Four weeks of open-source harness work distilled
> into a pack you can read in twenty minutes and adopt in an afternoon.

## The idea in one paragraph

Models are commoditizing; **the harness is where engineering quality lives**. An agent
with a strong model but no harness produces plausible code fast and debt faster. The fix
is not more prompting — it's *structure*: a plan the human reviews before code exists, a
check the agent can run itself, guards that make rules enforceable rather than advisory,
an adversarial review pass that isn't biased toward code it just wrote, and a compounding
step that turns every mistake into a permanent guardrail. Each of those is a component in
this pack.

## What's in the box

| Layer | Where | What it does |
|---|---|---|
| **Contracts** | [`AGENTS.md`](AGENTS.md) · [`CONSTITUTION.md`](CONSTITUTION.md) | The repo↔agent contract (slow facts, conventions, error-ledger) and the pinned engineering principles with a machine-readable digest agents ingest every session. |
| **Skills** | [`skills/`](skills/) | Ten curated methodology skills — plan-first, fail-first TDD, systematic debugging, verification, post-review simplification, compounding learnings, and a skill that writes new skills. Portable `SKILL.md` format (Claude Code, Codex, opencode). |
| **Hooks & guards** | [`hooks/`](hooks/) | A versioned normalized event contract plus portable POSIX policies for secrets, destructive commands, protected paths, worktree discipline, formatting, and stop verification. |
| **Subagents** | [`agents/`](agents/) | The review panel: fresh-context code reviewer, adversarial verifier, security reviewer, behavior-preserving simplifier. |
| **Rubrics** | [`rubrics/`](rubrics/) | Machine-checkable readiness criteria — a spec-readiness gate (is this plan pick-up-able by a cold-start agent?) and a code-review grading sheet. Verdict-gated, refute-style. |
| **Model routing** | [`models/routing.yaml`](models/routing.yaml) | Category-based multi-model delegation: a frontier lane for planning/review/merge, a bulk lane (e.g. GLM), a cheap utility lane — with fallback chains. Route by capability tier, never expose a model picker. |
| **Adapters** | [`adapters/`](adapters/) | Native normalization and outcome mapping for Claude Code, Codex, and OpenCode; Zed/ACP inherits whichever backing runtime it hosts. |
| **Evals** | [`evals/`](evals/) | Guard and cross-runtime conformance tests plus an isolated, N-run eval lab with deterministic trajectory grading and optional semantic judging. |
| **Optional modules** | [`modules/`](modules/) | Opt-in batteries the core never depends on: the AIOS CLI (loop engineering + Team Brain), agentic-maturity self-assessment, cost monitoring, context-hygiene monitoring. |
| **Docs** | [`docs/`](docs/) | [Adopt on any stack](docs/adopt-any-stack.md) · [The autonomy ladder](docs/autonomy-ladder.md) · [Runtime conformance](docs/runtime-conformance.md) · [Thin spots](docs/thin-spots.md). |

## The maturity model behind it

This pack is the executable companion to the open **Agentic Maturity** framework — a
5-level spine (Prompting → Prompt Engineering → Context Engineering → Agentic Engineering
→ Agentic Orchestration), five cross-cutting axes (verification, context hygiene,
autonomy, learning, cost/governance), and a library of 24 named patterns distilled from
the field's best practitioners. Every component here is tagged with the AM pattern it
implements (`am_pattern:` in its frontmatter) and the maturity level it unlocks.

That matters for teams: you don't adopt a harness by switching everything on. You place
each engineer on the ladder, adopt the components that unlock their next level, and
lengthen the autonomy leash only as verification strengthens. **You don't climb to
autonomy — you earn it through verification.** See
[docs/autonomy-ladder.md](docs/autonomy-ladder.md).

## Quickstart

After vendoring, run the installer from your repo root. It is idempotent, auto-detects your runtimes
(`.claude`/`.codex`/`.opencode`/`.cursor`), and **never overwrites** an existing config
(it writes `<file>.harness-incoming` for you to merge):

```bash
git clone https://github.com/aiosbrain/aios-engineering-harness .harness && rm -rf .harness/.git
.harness/install.sh            # or: --all, or: --runtime cursor --runtime codex
# then: edit .harness/check (your real gate) and fill the AGENTS.md TODOs
```

Until the separate AIOS CLI shim lands, invoke `.harness/install.sh` directly. To wire a
single runtime by hand:

<details><summary>Manual (Claude Code shown; Codex/OpenCode/Cursor in their adapter READMEs)</summary>

```bash
# from your repo root
git clone https://github.com/aiosbrain/aios-engineering-harness .harness && rm -rf .harness/.git
# The manual flow is seed-only: abort if these destinations already exist, then
# merge deliberately instead of overwriting user-managed runtime files.
test ! -e .claude/skills || { echo ".claude/skills exists; merge manually" >&2; exit 1; }
mkdir -p .claude/skills && cp -R .harness/skills/. .claude/skills/
test ! -e .claude/agents || { echo ".claude/agents exists; merge manually" >&2; exit 1; }
mkdir -p .claude/agents && cp -R .harness/agents/. .claude/agents/
# make EVERY hook + adapter script executable (all runtimes, not just claude)
chmod +x .harness/hooks/*.sh .harness/hooks/git/install-primary-commit-guard.sh \
  .harness/adapters/run-hook.sh .harness/adapters/*/normalize.sh \
  .harness/adapters/cursor/stop-gate.sh
# MERGE (never overwrite) .harness/adapters/claude-code/settings.json into
# .claude/settings.json — keep your existing hooks/permissions keys. If a target
# already exists, create a separate merge file or abort; never replace it in place.
test ! -e AGENTS.md || { echo "AGENTS.md exists; merge manually" >&2; exit 1; }
cp .harness/AGENTS.md ./AGENTS.md
test ! -e CONSTITUTION.md || { echo "CONSTITUTION.md exists; merge manually" >&2; exit 1; }
cp .harness/CONSTITUTION.md ./CONSTITUTION.md
# edit .harness/check to your real gate command; do not overwrite a configured gate
.harness/hooks/git/install-primary-commit-guard.sh   # worktree commit guard (all repos)
```

</details>

Then, in a Claude Code session: `/plan-first` on your next non-trivial task, and watch
the guards fire. **Codex, OpenCode, and Cursor are first-class too** — each has its own
adapter under `adapters/{codex,opencode,cursor}/` (merge its config the same way; never
overwrite an existing `.codex/hooks.json` / `opencode.json` / `.cursor/hooks.json`). Full
per-stack instructions: [docs/adopt-any-stack.md](docs/adopt-any-stack.md).

**Zero-effort install:** copy [BOOTSTRAP.md](BOOTSTRAP.md) into any coding agent
(Claude Code, Codex, OpenCode, or Cursor) and the agent itself will clone the harness,
run `.harness/install.sh`, and fill in the blanks — no manual steps.

## Design principles

1. **Portable policy, native adapters.** Policies are markdown + POSIX shell behind a
   versioned event contract; each runtime owns the smallest adapter needed for its
   actual lifecycle and payloads.
2. **Enforcement over instruction.** Anything that must happen every time is a hook, not
   a sentence in a prompt.
3. **Verification is the value.** Every autonomy increase is paid for with a stronger
   check. Non-frontier model output always passes a review gate.
4. **Compounding.** The harness gets better every time it's used: mistakes become
   guardrails, solutions become skills, corrections become AGENTS.md lines.
5. **Cited, honest, small.** Provenance on everything, thin spots documented, and no
   component you can't read in one sitting.

## License

MIT — see [LICENSE](LICENSE).
