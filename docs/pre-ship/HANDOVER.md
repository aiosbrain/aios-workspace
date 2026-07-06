# Pre-ship spec eval — handover (2026-07-06)

## What was fixed

1. **Paths:** `test/brain-mcp.test.mjs` → `scripts/brain-mcp.test.mjs` (real location).
2. **AF4:** Rewritten as docs-only slice reusing existing `scripts/brain-mcp.test.mjs`.
3. **arch3:** Tier-safety section added (SR7).
4. **af2:** Phase 7 table row de-conflicted (SR3 on `2-work/smoke-test.md`).
5. **sec1:** Waiver schema + checklist new-file contract.
6. **epic onboarding:** Fixed runbook path to `af2-onboarding-smoke-runbook.md`.
7. **Removed:** broken `onboarding-smoke-runbook.md` duplicate.
8. **spec-eval.mjs:** Collect all text blocks; JSON parse retry once; route eval/fix via `callPromptModel`.
9. **loop-models.mjs:** `spec_eval` / `spec_fix` default to **`deepseek-v4-pro`** (same backend as plan/code review — no Anthropic credits needed).

## Deterministic gate

All 24 `docs/pre-ship/*.md` specs pass `--no-llm` (exit 3 = clean).

## Full matrix (LLM adversarial)

Requires **`DEEPSEEK_API_KEY`** (default model: `deepseek-v4-pro`). Run:

```bash
for f in docs/pre-ship/*.md; do
  npm run aios -- spec eval "$f" || true
done
```

Until then, **deterministic gate passes on all 24** (`--no-llm` exit 3). AF1 previously reached SPEC_READY (score 82) when credits were available.

## If specs still NOT_READY (adversarial)

Common SR15 fixes:
- Name owner: `john@john-ellison.com`
- Split builder vs operator closure
- Put deliverables under **New files to create**
- Epics: closure = all child issues SPEC_READY + operator dogfood log

```bash
npm run aios -- spec eval docs/pre-ship/<file>.md
npm run aios -- spec fix docs/pre-ship/<file>.md --write --budget 2
```

## Linear issues

Epics AIO-268..272, children AIO-273..291 — update descriptions after specs pass:

```bash
LIN="dotenvx run --quiet -f .env -- node ~/.claude/skills/aios-linear/linear.mjs"
$LIN set-desc AIO-273 docs/pre-ship/af1-agent-onboarding-contract.md
# ... repeat for each issue
```

## Build order (onboarding epic)

1. AF1 → AF3 (parallel) → AF4 (needs AF1 file) → AF2 (operator run last)
