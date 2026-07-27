# Provenance

Every component in this pack is curated from the published practice of working agentic
engineers or from battle-tested open-source packs, then adapted to be stack- and
runtime-agnostic. This file is the map. `AM` columns reference the open Agentic Maturity
pattern library (patterns A1–E5).

## Components → sources

| Component | Curated from | AM pattern | Notes on adaptation |
|---|---|---|---|
| `AGENTS.md` template (slow facts, <200 lines, error-ledger) | Boris Cherny — [How Boris Uses Claude Code](https://howborisusesclaudecode.com/); the [AGENTS.md standard](https://agents.md); Amp's "AGENTS.md for slow facts, MCP for live facts" split ([ampcode.com](https://ampcode.com)) | A1, A2 | Merged the error-ledger convention with the cross-tool standard. |
| `CONSTITUTION.md` (pinned principles + machine-read digest) | AIOS toolkit `ENGINEERING-CONSTITUTION.md` (itself adapted from [GitHub Spec Kit](https://github.com/github/spec-kit)'s Spec-Driven Development) | B3, E5 | Generalized: AIOS-specific domain rules removed; digest-injection convention kept. |
| `skills/plan-first` | Dex Horthy's RPI — [advanced context engineering](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents); Cherny's plan-mode-first habit | B1, B3 | Adds the 40–60% context-utilization discipline and plan-as-source-of-truth review point. |
| `skills/tdd-fail-first` | Jesse Vincent (obra) — [Superpowers](https://github.com/obra/superpowers) enforced TDD | B2, B4 | RED-GREEN-REFACTOR with the fail-first proof step; runner-agnostic. |
| `skills/systematic-debugging` | Superpowers four-phase debugging | B4 | Root-cause before fix; generalized commands. |
| `skills/simplify-pass` | Boris Cherny's code-simplifier subagent habit; AIOS `aios simplify` | C7 | Behavior-preserving, check-gated, revert-on-failure. |
| `skills/code-review` | Kieran Klaassen — [compound engineering](https://every.to/guides/compound-engineering) parallel review; AIOS `consolidate-findings` (fail-closed severity fusion) | C3, D4 | Fresh-context reviewer + P1/P2/P3 triage. |
| `skills/verify-change` | "Give it a check it can run" — the consensus pattern (Anthropic docs, Willison, AM B2) | B2 | Drive the real flow, not just the tests. |
| `skills/compound-learnings` | Klaassen's compound step; Mitchell Hashimoto's mistake→guardrail reflex ([Zed interview](https://zed.dev/blog/agentic-engineering-with-mitchell-hashimoto)) | A1, C1 | The closing step of every task: codify or it didn't compound. |
| `skills/git-master` | oh-my-opencode `git-master` (Yeongyu Kim / code-yeongyu), de-omo'd — dropped the attachment-upload specifics | C4 | Atomic commits, style detection, safe rebase/history ops; pairs with branch-reconciliation. |
| `skills/visual-qa` | oh-my-opencode `visual-qa` — methodology + the bundled zero-dependency evidence script (`scripts/visual-qa.mjs`, Node builtins only) copied verbatim; ported runtime-neutral (late-bound browser driver) | B2 | Objective screenshot/TUI diff + an independent (never-the-builder) reviewer loop; the UI specialization of verify-change. |
| `skills/ast-grep` | oh-my-opencode `ast-grep`, ported lean — technique + gotchas without the bundled Python helper | C4 | AST-aware structural search + deterministic codemods; `codebase-memory-mcp` stays the primary read-only structural tool. |
| `skills/programming` | oh-my-opencode `programming`, trimmed hard — kept the code-smell taxonomy + exhaustiveness/boundary rules + NEVER-assert-prose test rule; dropped tooling absolutism, the 250-LOC-as-defect law, and the per-language reference tree | C7 | Coding-standards conscience as advice, not law. |
| `skills/refactor` | oh-my-opencode `refactor`, trimmed to the phase discipline; dropped the command-template + `call_omo_agent`/LSP/refactor-squad plumbing | C7 | Planned, test-after-each-step restructure of existing code; distinct from simplify-pass. |
| `skills/skill-author` | Superpowers' skill-writing skill; Anthropic skill-authoring guidance | C1 | Includes obra's pressure-testing idea: stress a draft skill against realistic scenarios before trusting it. |
| `skills/branch-reconciliation` | AIOS toolkit skill (born from a real audit where ~80% of "stale" branches were squash-merge duplicates) | B5 | Evidence-based, classify-only. |
| `skills/test-ci-wiring-audit` | AIOS toolkit skill (born from finding tests wired into neither `npm test` nor CI) | B2, C8 | Generalized beyond npm to any runner/CI. |
| `hooks/` protocol + policies | AIOS `team-ops-guard.sh`; standard secret-pattern sets; Claude Code, Codex, and OpenCode lifecycle documentation | C4 | Versioned runtime-neutral events; native parsing stays in adapters; secret scan sees introduced content only. |
| `hooks/guard-destructive.sh` | IndyDevDan — [claude-code-hooks-mastery](https://github.com/disler/claude-code-hooks-mastery); Anthropic destructive-op confirmation practice | C4, B6 | Blocks `rm -rf`, force-push, hard reset, etc. outside an allowlist. |
| `hooks/guard-protected-paths.sh` | Hooks-as-enforcement consensus | C4 | Configurable denylist over normalized source and destination paths. |
| `hooks/guard-worktree.sh` + `hooks/git/pre-commit-primary-guard` + `hooks/git/reference-transaction-strand-guard` | AIOS `aios worktree` convention; aios-workspace #388 primary-commit guard (portable mirror) | C4, B6, E5 | Blocks branch-creation/edits/commits in the primary checkout across all runtimes so autonomous agents can't strand it on a feature branch. Two parse-free git-hook backstops make it authoritative: a pre-commit/pre-merge-commit guard mirrors #388 for commits, and a reference-transaction guard blocks HEAD moving onto a non-default branch (catching branch-creation the command-parsing agent hook can't, while allowing `git worktree add`). All physically resolved, symlink-safe. |
| `hooks/post-edit-format.sh` | Cherny (hooks auto-format); Hashimoto | C4 | Formats every normalized edited path and never blocks. |
| `hooks/stop-verify-gate.sh` | AM B2 ladder; Claude Code and Codex Stop contracts; OpenCode plugin events | B2, C4 | Native stop block where available; one-shot `session.idle` continuation on OpenCode. |
| `agents/code-reviewer` | Writer/reviewer split (AM C3 — a fresh session catches more); compound engineering's review agents | C3 | |
| `agents/adversarial-verifier` | AIOS spec-eval refute-style evaluator; AM B7 adversarial prompting | B7, D4 | Verdict-gated; tries to refute, not confirm. |
| `agents/security-reviewer` | compound engineering's specialized panel | C3, D2 | |
| `agents/simplifier` | Cherny's simplifier subagent | C7 | |
| `rubrics/spec-readiness.md` | AIOS `.claude/rubrics/spec-readiness.md` (two-layer deterministic + adversarial model) | B3, D3 | AIOS-specific criteria removed; the "cold-start builder can pick this up" test kept. |
| `rubrics/code-review.md` | consolidated multi-reviewer practice (AIOS `consolidate-findings`, fail-closed severity) | D4 | |
| `models/routing.yaml` | oh-my-opencode's category-based delegation ([omo.dev](https://omo.dev)); Amp's Oracle/Worker split & no-model-picker philosophy; [cc-compatible-models](https://github.com/Alorse/cc-compatible-models) wiring | E1, B6 | Categories → model + fallback chain; frontier reserved for plan/review/merge. |
| `docs/autonomy-ladder.md` | AM maturity spine + "earn the leash" (E5); Anthropic guardrails practice; sandbox tier ladder (devcontainer → worktree → microVM) | B6, E5 | The team-rollout story. |
| `docs/adopt-any-stack.md` | Armin Ronacher's stack-agnostic recommendations ([lucumr](https://lucumr.pocoo.org/2025/6/12/agentic-coding/)); AGENTS.md field practice | A1, E3 | |
| `adapters/claude-code`, `adapters/codex`, `adapters/opencode` | [Claude Code hooks](https://code.claude.com/docs/en/hooks), [Codex hooks](https://developers.openai.com/codex/hooks), [OpenCode plugins](https://opencode.ai/docs/plugins/) and [permissions](https://opencode.ai/docs/permissions/) | B2, C4, D3 | Equal first-class native normalizers behind one portable policy contract; lifecycle differences remain explicit. |
| `adapters/zed` | Zed's [ACP](https://zed.dev/acp) | B5, E3 | Client surface only; inherits the backing runtime's adapter strength. |
| `evals/` runner + scenarios | Hamel Husain (eval discipline, [Your AI Product Needs Evals](https://hamel.dev/blog/posts/evals/)); AM D3; obra's skill pressure-testing | D3, D4 | Isolated N-run drivers, deterministic trajectory grading, optional independent rubric judge, descriptive summaries. |
| `modules/aios-cli` | AIOS toolkit ([aiosbrain/aios-workspace](https://github.com/aiosbrain/aios-workspace)): operator loop, Team Brain sync, gated ship pipeline | C4-C6, D1 | By reference + version pin, not vendored. |
| `modules/agentic-maturity` | AIOS AM framework + the workspace `agentic-maturity` skill (verification cap, weakest-axis prescription) | E5 | Standalone interview version; signal-based scoring via the CLI module. |
| `modules/cost-monitor` | [ccusage](https://github.com/ryoppippi/ccusage); AIOS `cost-monitor` skill (team rollup) | E1, B6 | |
| `modules/context-monitor` | Dex Horthy (utilization discipline); Cherny line-test; oh-my-opencode defensive-hooks posture | A1, A2 | |

## Practitioners this pack is distilled from

Simon Willison · Armin Ronacher · Geoffrey Huntley · Peter Steinberger · Thorsten Ball ·
Boris Cherny · Mitchell Hashimoto · Dex Horthy · Jesse Vincent · Kieran Klaassen ·
Steve Yegge · Hamel Husain · Andrej Karpathy (framing) · the Anthropic engineering team ·
the OpenAI Codex team —
plus the AIOS toolkit's own shipped harness (`aios build/relay/spec/simplify/rails`),
where several of these patterns were first hardened for our own use.

## Deliberately not included (and why)

- **The Ralph loop** (Geoffrey Huntley's unattended while-loop) — powerful, but only safe
  behind a sandbox + strong tests + rollback. Documented as a gated future module in
  [docs/thin-spots.md](docs/thin-spots.md), not shipped default-on.
- **Heavy orchestration frameworks** (claude-flow, Gas Town, agent fleets) — overkill for
  a core pack; adopt only if you truly run fleets.
- **Beads** (Yegge's issue-graph agent memory) — excellent, but an infrastructure choice
  a team should make deliberately; noted as a compatible add-on.
- **Any single runtime's plugin API** — the pack targets the portable standards instead.
