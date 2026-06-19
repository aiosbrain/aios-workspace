# AEM Curriculum — offline pattern catalogue

The condensed pattern library the `agentic-maturity` skill cites when prescribing a next
step. Canonical, fuller version: `agentic-engineering-maturity/01-pattern-library.md`
(root) and the public docs at `/agentic/patterns`. Patterns are grouped by the module a
placement maps to (see `individual.rubric.json` → `patternMap`).

---

## Module: start-reviewing (L1 → L2)
You're accepting output without really inspecting it. The leap is to start *reviewing*.
- **A3 — Point at examples, name the files.** Be specific: name the file to change, a good example to copy, the symptom, and what "fixed" means. *First action: rewrite your next prompt to name one example file.*
- **B5 — Watch it like a hawk.** Read every diff for code you care about; agent errors are subtle conceptual ones, not syntax. *First action: keep your editor open beside the agent and read the next diff before accepting.*
- **A1 — Start a CLAUDE.md.** A short file of conventions + gotchas. *First action: create CLAUDE.md with three rules you keep repeating.*

## Module: build-context-discipline (L2 → L3)
Your prompts are good but stateless. The leap is engineering the *system* around the model.
- **A1 — CLAUDE.md as compounding infrastructure.** After every correction, have the agent add a rule so it won't repeat the mistake. Keep it short. *First action: after your next correction, say "update CLAUDE.md so you don't do that again."*
- **A2 — Just-in-time context, not kitchen-sink.** `/clear` between unrelated tasks; keep identifiers, retrieve on demand. *First action: `/clear` before your next new task instead of continuing the old session.*
- **B1 — Explore → Plan → Code → Commit.** Plan first for anything non-trivial. *First action: start your next real task in plan mode.*

## Module: verification-first (L3 → L4) — HIGHEST PRIORITY when verification is weak
This is the line between vibe coding and engineering. Earn autonomy through verification.
- **B2 — Give it a check it can run.** Tests, a build, a screenshot to compare — the difference between a session you watch and one you walk away from (~2–3× quality). *First action: end your next task prompt with "then run the tests and fix what fails."*
- **B3 — Spec-first: let the agent interview you.** Have it ask questions, write a SPEC.md, then execute in a fresh session. *First action: ask the agent to interview you before it writes code next time.*
- **D3 — Eval-driven development.** Realistic tasks paired with verifiable outcomes. *First action: write down one pass/fail check for your current feature.*

## Module: into-agentic (L3 → L4, balanced)
- **B1 — Explore → Plan → Code → Commit.**
- **B2 — Give it a check it can run.**
- **C1 — If you do it twice a day, make it a command/skill.** *First action: turn your most-repeated prompt into a slash command.*

## Module: evals (L4, weak verification)
- **D3 — Eval-driven development.**
- **D4 — LLM-as-judge / Agent-as-judge.** Score outputs against a rubric; judge the end-state. *First action: add one rubric-scored check to your loop.*
- **B7 — Adversarial prompting.** "Prove to me this works." "Grill me before opening a PR." *First action: ask the agent to refute its own last change.*

## Module: parallelize (L4 → L5)
- **C3 — Parallel sessions / git worktrees.** Run several agents at once; writer/reviewer split. *First action: spin up a second worktree for an independent task.*
- **C2 — Subagents for investigation.** Isolate exploration in a fresh context that reports a summary. *First action: say "use a subagent to investigate X" next time.*
- **D1 — The five workflow patterns.** Prompt chaining, routing, parallelization, orchestrator-workers, evaluator-optimizer.

## Module: compound-and-learn (L5)
- **C6 — The Ralph loop.** Autonomous while-loop behind a strong check + sandbox + cost cap.
- **D6 — Autoresearch swarm.** Hill-climb any cheap-to-evaluate metric with an agent swarm overnight.
