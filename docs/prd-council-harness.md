# PRD — Council Harness (`/council`)

**Status:** In progress — **P0 shipped** (`aios council`, stage-1 first opinions only). P1 ranking/synthesis not started.
**Last updated:** 2026-07-03 · **Owner:** John
**Inspiration:** [karpathy/llm-council](https://github.com/karpathy/llm-council) (external, unmaintained by its author)
**Precedent in this repo:** [`loop-models.example.yaml`](./loop-models.example.yaml) (diversity-guard doctrine),
`scripts/relay-core.mjs` `callCursorAgent` (existing single-reviewer cross-model-family call)

---

## 1. Summary

A workspace skill, `/council <question>`, that fans a question out to **N models across ≥2 model
families** (not just Anthropic), collects independent first opinions, has each model anonymously
critique and rank the others' answers, then synthesizes one final answer via a chairman. Structurally
this is Karpathy's `llm-council` three-stage pipeline (collect → anonymized peer-rank → synthesize),
adapted to run as an AIOS harness instead of a standalone FastAPI/React app.

**Why this earns a spot on the backlog and not just "use the Workflow tool":** the `Workflow` tool's
judge-panel pattern already gives AIOS N-way fan-out + scoring + synthesis — but every agent it spawns
is a Claude subagent. That's prompt-diversity, not model-diversity. The one place this repo already
reaches for a genuinely different model family is `scripts/relay-core.mjs`'s `callCursorAgent`, used
as the **single** `gpt-5.5-high` code-review/plan-review step in the ship pipeline (see
`loop-models.example.yaml`'s DIVERSITY GUARD, which already encodes "reviewer must be a different
family than builder" as a fail-closed rule). Council generalizes that one proven reviewer-pair pattern
into an N-way panel, for the narrower case of a single high-stakes question, not a build/review loop.

## 2. Goals / Non-goals

**Goals**
- **G1.** `/council "<question>"` returns, in one invocation: N raw first opinions (≥2 model
  families), an anonymized cross-ranking with an aggregate score per model, and one chairman-
  synthesized final answer.
- **G2.** Reuses the existing diversity-guard doctrine from `loop-models.example.yaml` — fail closed
  before any API call if the configured council resolves to a single model family — rather than
  inventing a second, inconsistent config surface.
- **G3.** Every run is persisted as an inspectable JSON transcript (mirrors Karpathy's
  `storage.py` per-stage persistence), so a *future* harness (decision-audit, spec-readiness) could
  cite "council result from `<timestamp>`" as evidence rather than a lost chat transcript.
- **G4.** No new required runtime dependency beyond an HTTP client already available (Node `fetch`)
  and the OpenRouter credential, which already cascades as a low-privilege global in the Tessera env
  model (`~/Projects/CLAUDE.md`) — this is a verify-it-reaches-the-project step, not a new secret.

**Non-goals (v1)**
- **N1.** No chat UI. No React frontend, no SSE streaming, no conversation history across turns —
  CLI/skill in, rendered answer + saved transcript out.
- **N2.** Not auto-wired into any existing harness (decision-audit, ship, spec-readiness) in v1.
  Manual invocation only. Auto-triggering (e.g. decision-audit escalates to council past a confidence
  threshold) is a v2 idea, see §9.5.
- **N3.** Not a replacement for the `Workflow` tool's same-model judge-panel pattern. That stays the
  default for iterate-and-score work; council is specifically for genuine cross-lab diversity on one
  bounded question.
- **N4.** No attempt at feature parity with the full Karpathy repo — no per-model title generation,
  no multi-turn conversation state. This is the decision-support kernel only.

## 3. Users & motivating scenarios

| Persona | Today | With `/council` |
|---|---|---|
| Workspace owner about to log a high-stakes call to `3-log/` | Writes it down, maybe self-reviews with one Claude pass | Runs `/council` first, gets independent reads from ≥2 non-Anthropic labs + a synthesized recommendation, logs the decision citing the transcript |
| Spec author committing acceptance criteria for an architecture call in a domain spec | Asks one Claude subagent to poke holes in its own output | Runs `/council "should X use approach A or B"` for genuine model diversity before the criteria are locked |
| Maintainer weighing a change that's explicitly gated in `CLAUDE.md`'s "Do not" list (e.g. touching `brain-api.md`'s pinned contract) | Relies on personal judgment | Gets 2-3 outside-lab opinions to pressure-test the call before touching a pinned contract |

## 4. Architecture

```
/council "<question>"  (scaffold/.claude/skills/council/SKILL.md, kind: workflow-harness)
   │  invokes: council.workflow.js  (a Workflow-tool script)
   ▼
Stage 1 — first opinions (parallel)
   • one fetch() POST per configured model → openrouter.ai/api/v1/chat/completions
   • collects { model, response } for every model that answers; null-filters failures
Stage 2 — anonymized peer ranking (parallel)
   • relabel stage1 responses "Response A/B/C…"; label_to_model map kept server-side only
   • re-send to every council model: "critique + FINAL RANKING:" prompt
   • parse FINAL RANKING via regex (same fragile-but-workable approach as Karpathy's parser);
     degrade to "no aggregate ranking" rather than crash if parsing fails
   • aggregate_rankings = average rank per model across all critics
Stage 3 — chairman synthesis
   • default: the invoking Claude Code session itself synthesizes stage1+stage2 (zero extra API call)
   • optional: a configured non-Claude chairman model via one more OpenRouter call, for full
     lab-neutrality (see open question §9.2)
   ▼
Transcript written to disk (admin-tier scratch by default; user can promote to 2-work/ if useful)
```

## 5. Config & model-family contract

- New flat-yaml file, `council-models.yaml` (mirrors `loop-models.example.yaml`'s flat-key,
  fail-closed style): `council_models` (list of OpenRouter model ids), `chairman_model` (optional;
  defaults to "invoking session", see §9.2).
- **DIVERSITY GUARD, ported directly from `loop-models.example.yaml`:** abort before any API call if
  `council_models` resolves to fewer than 2 distinct model families.
- **Net-new work, not reuse:** `loop-models.example.yaml`'s current family taxonomy only distinguishes
  `claude*/fable*` (anthropic) from `gpt*` (openai) — enough for a single reviewer pair. Council needs
  the taxonomy extended to `gemini*`, `grok*`, `deepseek*`, etc., since OpenRouter exposes all of them.
  This extension should live in one shared module so `loop-models.yaml` and `council-models.yaml`
  can't drift into two different definitions of "model family."
- **Auth:** `OPENROUTER_API_KEY`. Per the Tessera root `.envrc` cascade, this is already a shared
  low-privilege global — confirm it reaches `aios-workspace`'s own env-resolution precedence
  (project-local `.env` wins last) before relying on it. This is a verification step, not new secret
  provisioning.

## 6. Skill/tool surface

- `scaffold/.claude/skills/council/SKILL.md` frontmatter, matching the existing harness schema
  (`decision-audit`, `scope-creep`, `transcript-decisions`):
  ```yaml
  ---
  name: council
  description: |
    Fans a question out to multiple frontier models across ≥2 labs via OpenRouter, has them
    anonymously cross-rank each other's answers, then synthesizes one final answer.
    Use when a decision is high-stakes enough to want genuine cross-lab model diversity,
    not just another Claude pass.
  version: 0.1.0
  kind: workflow-harness
  workflow: council.workflow.js
  triggers:
    - "/council"
    - "get a council opinion"
    - "cross-model check"
  ---
  ```
- CLI: `/council "<question>"`, optional `--models gpt-5.5-high,gemini-3-pro,grok-4` override.

## 7. Phasing & deliverables

| Phase | Deliverable | State |
|---|---|---|
| **P0 — Skeleton + smoke test** | `council-models.yaml` config, OpenRouter client, 2-model stage-1-only round trip, no ranking yet | Proposed |
| **P1 — Full pipeline** | Stage 2 anonymized ranking + aggregate scoring, stage 3 chairman synthesis, disk transcript | Proposed |
| **P2 — Family-taxonomy extension** | Shared model-family module (gemini/grok/deepseek added), reused by both `loop-models` and `council-models` guards | Proposed |
| **P3 — Auto-trigger (optional, gated)** | decision-audit or spec-readiness escalates to council past a confidence threshold | Backlog, needs design sign-off (see §9.5) |

## 8. Acceptance criteria (v1 = P0+P1)

- **AC1.** `/council "<question>"` with default config returns stage1 (N raw responses), stage2
  (anonymized rankings + aggregate), stage3 (one synthesized answer), rendered to the user and
  persisted to disk as inspectable JSON.
- **AC2.** `council_models` resolving to a single model family aborts before any API call, with an
  actionable error — mirrors `loop-models.yaml`'s fail-closed diversity guard exactly.
- **AC3.** A missing/invalid `OPENROUTER_API_KEY` aborts with a clear message naming the missing var,
  before any partial API spend.
- **AC4.** One model failing (timeout/error) does not fail the whole council — matches Karpathy's
  null-filtering in `query_models_parallel`; the harness proceeds with whichever models responded and
  says so in the output.
- **AC5.** The transcript is byte-inspectable JSON, re-loadable, so a future harness can cite a past
  council result as evidence rather than a chat transcript.

## 9. Open questions

1. **OpenRouter direct HTTP vs. reusing `callCursorAgent`'s Cursor-CLI pattern.** Recommend
   OpenRouter for true N-way fan-out; the Cursor-CLI path is proven but shaped for a single reviewer
   call and depends on Cursor being installed/authenticated locally — it doesn't generalize cleanly
   to N concurrent models.
2. **Chairman = invoking Claude session vs. a dedicated non-Claude chairman model.** Lean:
   default to the invoking session (zero extra cost, and Claude Code is already the orchestrator),
   with a config flag for a dedicated chairman when full lab-neutrality actually matters for a
   specific call.
3. **Cost/latency ceiling.** N models × 2 rounds (opinions + ranking) = 2N calls — comparable to the
   `Workflow` tool's judge-panel cost model. Should invocation surface an explicit cost/latency
   estimate before running, the way expensive workflows already gate on user confirmation elsewhere
   in this repo?
4. **Where does the transcript live on the spine?** Leaning: ephemeral admin-tier scratch by default
   (never auto-syncs), with the user manually promoting a specific transcript into `2-work/` if it's
   worth keeping as team-visible evidence.
5. **Should any harness ever auto-invoke council, or should this stay permanently manual?** N2 says
   manual for v1; this question is whether that's a permanent stance or just a v1 simplification.

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Cost: N models × 2 rounds per invocation | Default to a small (3-model) council; surface a pre-run cost/latency estimate (§9.3) |
| New external credential dependency (OpenRouter) | Already cascades globally per the Tessera env model — verify reach, don't provision a new secret |
| Model-family taxonomy drifts as OpenRouter adds labs faster than a hardcoded list keeps up | Keep the family list in one shared module reused by both `loop-models` and `council-models` guards (§5, §7 P2) |
| Ranking-parse fragility (regex on free-text `FINAL RANKING:`, same weakness as Karpathy's own parser) | Degrade gracefully to "no aggregate ranking, stage1+stage3 still valid" rather than crashing the whole harness |
| Scope creep into a second, parallel orchestration engine competing with the `Workflow` tool | Keep council deliberately narrow — single question in, single synthesized answer out, not a general multi-agent framework (N3) |

## 11. References

- External inspiration: [karpathy/llm-council](https://github.com/karpathy/llm-council)
- Diversity-guard precedent: [`loop-models.example.yaml`](./loop-models.example.yaml)
- Existing single-reviewer cross-model-family call: `scripts/relay-core.mjs` (`callCursorAgent`,
  used by the ship pipeline's `code_review`/`plan_review` steps)
- Same-model-family equivalent already in AIOS: the `Workflow` tool's judge-panel pattern
