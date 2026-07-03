# Dynamic-Workflow Harnesses — Design Study

The skills in `scaffold/.claude/skills/` are **dynamic multi-agent workflow
harnesses**: instead of asking one agent to do a whole task in one context, they
spawn focused sub-agents and add an independent verification stage. This doc records
what we learned building and A/B-testing them — single-pass skill vs. harness, on
identical inputs — so contributors know *when* a harness helps and *how* to build one.

## The failure modes harnesses fix

A single long-running context degrades in three ways on big, parallel, adversarial
tasks:

- **Laziness** — declares done after partial progress (handles 20 of 50 items).
- **Self-preferential bias** — trusts its own findings when asked to verify them.
- **Goal drift** — loses fidelity to the objective across many turns.

Harnesses counter these structurally: one agent per unit of work (earns coverage),
and a separate agent to verify (defeats self-bias).

## What the A/B study found

Four harnesses were each compared against a single-pass baseline on the same inputs,
scored by an independent judge.

| Workflow | Outcome | Lesson |
|----------|---------|--------|
| Decision-log audit | **Harness wins, decisively** | A single pass emitted many findings, ~80%+ false positives; adversarial verification cut them to a small verified set. One-verifier-per-rule made coverage *structural*, not asserted. |
| Scope-creep detection | **Harness wins on precision** | A binary keep/drop refuter drove false accusations to zero — but also discarded true positives. Fix: **re-grade severity** (out-of-scope → watch → in-scope) instead of keep/drop. |
| Transcript → decisions | **Tie on extraction; harness wins on pipeline** | Both extract equally well on a short transcript; the harness's value is automatic **dedup** + per-decision **grounding**, not raw recall. |
| Weekly synthesis | **Single-pass wins** | With no fidelity check, fan-out *amplified* one reader's hallucination into the headline. When sources fit one context, single-pass kept fidelity. (This harness is on the roadmap, to be rebuilt **with** a fidelity verifier.) |

**The deciding variable was always verification, not parallelism.** A fan-out without
an independent grounding step can do *worse* than a single pass.

## The conventions (also in skills/README.md)

1. **Adversarial verification is the value.** Any harness emitting findings/claims
   needs an independent `verify(claim, evidence) → {real, reason, severity}` stage.
2. **Re-grade severity, don't keep/drop.** Preserves precision *and* recall.
3. **Read shared context once; pass excerpts inline.** Every agent re-reading the same
   file is the dominant cost.
4. **Earn coverage structurally** — one agent per rule/item beats "check everything."
5. **Batch by group to control agent count.** Agent *count* × per-agent context
   overhead — not file size — drives token cost. (In one audit, batching verification
   by rule took a run from ~80 agents / millions of tokens to ~16 agents / a fraction
   of the cost, with coverage intact.)
6. **Keep each agent's structured output small** — a single agent asked to emit a large
   digest can stall.
7. **Gate by input size** — single-pass is cheaper and as good for small inputs.
8. **Synthesis needs a fidelity gate** — completeness ≠ correctness.
9. **`args` is a JSON string** — `JSON.parse(args)`.
10. **Read-only** — return data; the caller writes.

## Per-step model config (agent relay)

The agent relay (`aios relay` plan phase + `aios build` build phase) resolves a **model,
reasoning effort, and timeout per pipeline step** from `scripts/loop-models.mjs`. A **missing**
config file just yields the defaults, but a **present-but-malformed** one fails loudly rather
than silently reverting to defaults (see "Config validation" below).

**Default matrix** (baked in code; also in `docs/loop-models.example.yaml`):

| step | model | effort |
|------|-------|--------|
| recon | claude-haiku-4-5 | — |
| plan | claude-opus-4-8 | xhigh |
| plan_review | gpt-5.5-high | — |
| build | claude-opus-4-8 | high |
| code_review | gpt-5.5-high | — |
| fix | claude-opus-4-8 | medium |
| fix_escalated | claude-opus-4-8 | high |
| consolidate | claude-haiku-4-5 | — |
| safety_review | claude-opus-4-8 | xhigh |
| orchestrate | fable-5 | — |
| digest | claude-haiku-4-5 | — |

**Config file** — `.aios/loop-models.yaml` (gitignored), flat keys only (parsed by
`scripts/flat-yaml.mjs`; no nesting, no dots): `<step>_model`, `<step>_effort`,
`<step>_timeout_s`. **Precedence, per field: CLI flag > file > default.**

**Diversity guard (fail closed).** `build` and `code_review` must be different model
families, and so must `plan` and `plan_review` — the reviewer has to be an independent
model. Families: `claude*`/`fable*` = anthropic, `gpt*` = openai. A same-family collision
aborts the run with an actionable message. The defaults pass (anthropic producer vs openai
reviewer on both pairs).

**Runner-family guard (fail closed).** The Claude-runner steps — `plan` (Claude Agent SDK),
`build`/`fix`/`fix_escalated` (Claude Code CLI), and `consolidate` (`aios consolidate-findings`,
Claude Code CLI) — must resolve to a **Claude-family** model. Setting e.g. `build_model:
gpt-5.3-codex` (or `--model` with a GPT id) aborts with an actionable message, rather than
handing a non-Claude id straight to a Claude runner.

**Config validation (fail loudly).** A present `.aios/loop-models.yaml` is validated: unknown
or misspelled keys / step names, non-scalar values, an effort outside `low|medium|high|xhigh|max`,
a non-numeric or non-positive `_timeout_s`, and an unreadable/unparseable file all abort with an
actionable message. Only a *missing* file falls back to defaults. (Effort keys on non-Claude
steps are currently accepted-and-ignored by their Cursor runner.)

**Fix-escalation ladder** (`selectBuilderStep`). The build loop picks the builder step from
prior feedback, **never the outer loop `round`** and **never `detectBugbotClear`**:

- no prior feedback yet → **build** (round 1 is the initial implementation)
- first fix attempt, no structural Critical/High finding → **fix** (medium effort)
- otherwise (≥2nd fix attempt, or any Critical/High) → **fix_escalated** (high effort)

The trigger is `hasCriticalOrHighFindings(reviewText)` — a *structural* match on a listed
`- Critical:`/`| High |` finding, so a Medium/Low-only review escalates only on the 2nd
attempt. **Gate-feedback note:** when the fed-back text is a verify/secrets gate failure
(not a Cursor review), the structural matcher is virtually always false, so a first
gate-retry resolves to **fix** and later attempts to **fix_escalated**.

**Effort split.** The Claude *builder* steps (`build`/`fix`/`fix_escalated`) pass effort via
the Claude Code CLI `--effort` flag. The relay *plan* step passes effort via the SDK's
`output_config.effort` instead — the CLI flag is not used there.

**What's consumed today.** `plan.{model,effort}` drives the Opus planner; `plan_review.timeoutMs`
drives the Cursor plan-review call in `aios relay` (with `--cursor-timeout` taking precedence);
`build`/`fix`/`fix_escalated`'s `{model,effort}` drive the builder; `code_review.timeoutMs` drives
the Cursor code-review call in `aios build`. The **reviewer `model` keys** (`plan_review_model`,
`code_review_model`) are resolved and enforced by the diversity guard but **not yet passed to the
Cursor runner** (the `cursor` CLI's model selection is not wired here) — set them to keep the guard
honest; the running review model is Cursor's own default. `consolidate.{model,effort,timeoutMs}` now
drives `aios consolidate-findings` (below). Remaining steps (`recon`, `safety_review`, `orchestrate`,
`digest`) are resolved for later consumers and not yet wired.

## The ship pipeline (build → PR → consolidate → fix)

For a PR-based flow, `aios build --pr` is one stage of a resilient loop that survives unattended,
overnight runs on an always-on host (see the [Hermes runbook](./hermes-runbook.md)):

```
aios build … --pr → wait-for-bots → GPT-5.5 PR review → aios consolidate-findings → aios build --findings <file>
```

- **`scripts/wait-for-bots.mjs`** blocks until Bugbot + CodeRabbit post substantive feedback
  (require-all by default; exit 2 on a missing bot at timeout — `--any` opts back into
  proceed-on-timeout, `--bots <list>` gates on a subset).
- **`aios consolidate-findings --pr <n> --issue AIO-<n>`** merges CI checks, the PR diff, the bot
  comments/reviews, and an optional GPT-5.5 review into **one severity-ranked finding list** at
  `.aios/loop/<issue>/findings-r<N>.md`, using `.claude/agents/code-reviewer.md` as its (single,
  un-forked) prompt. A deterministic **fail-closed** pass forces `BLOCKED` on red **or still-pending**
  CI or a dropped source-level Critical/High. Exit `0` CLEAR · `3` BLOCKED · `1` error (red/pending
  CI is data → `3`).
- **`aios build --findings <file>`** seeds round 1 from the file's **must-fix subset** (all
  Critical/High + `(plan-conformance)` Medium), so the builder fixes them through the
  fix/fix_escalated ladder exactly like a Cursor review.

### `aios ship` — the single-command wrapper

`aios ship AIO-<n>` runs the *whole* loop for one Linear issue — recon → plan → build → PR → review
→ fix → merge → cleanup — behind two operator gates (plan + merge, both default ON). Recon reads
**only git-tracked, deny-filtered files** referenced by the (untrusted) issue text; the merge gate
requires green CI, a CLEAR consolidator, and — when the diff touches a safety surface — a
`SAFETY_APPROVED` path-gated review. Gates fail closed in a non-TTY context (a `*_GATE_BLOCKED` exit,
never a hang). `--dry-run` prints the step plan offline with no key. Full flag + `SHIP_EXIT` table:
[`agent-build.md` → aios ship](./agent-build.md#aios-ship--the-whole-gated-loop-for-one-issue).

### `aios roadmap-run` — the unattended walker

`aios roadmap-run (--label|--epic|--project)` ships one **unblocked, unassigned, Todo** issue at a
time (top priority, ties → oldest) via `aios ship --auto --auto-merge`, fast-forwarding `main`
between issues and writing a deterministic morning digest every run. The `SHIP_EXIT` code decides
continue / skip / halt. Ideal for the overnight Hermes host — see the
[Hermes runbook](./hermes-runbook.md).

**Review resilience** (in `aios build`): the review call **auto-retries once on timeout** with a
doubled timeout, and the default review timeout **adapts to the real diff size** (`300s + 60s/10k
chars`, capped `600s`) unless `--cursor-timeout` / `code_review_timeout_s` pins it explicitly. See
[`agent-build.md` → Review resilience](./agent-build.md#review-resilience).

## Cost note

Harness runs cost meaningfully more than a single pass (often multiples). Use them
where the verification genuinely pays off — large or adversarial tasks, or where a
wrong answer is expensive — and keep single-pass skills for routine small work.

## Try it

Every harness ships with the synthetic `examples/sample-engagement/`, which is seeded
with deliberate issues. See that folder's README for the expected findings, and run a
harness with `repoPath` pointed at it.
