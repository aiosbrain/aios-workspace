# Personalized Activation Spike

Status: **quality gate open; production UI blocked**
Last local smoke: 2026-07-16 — dependency-free `aios analyze --since 3d --json --no-cache`
returned the expected aggregate schema without exposing raw transcript prose. This is a mechanics
check only, not relevance evidence.

## Deterministic baseline

1. Run `aios analyze --since 3d --json` and time it.
2. If fewer than 3 sessions or 5 task roots are usable, run once with `--since 7d`.
3. If the seven-day result still misses either threshold, return `insufficient-signal`.
4. Use `placement.weakest` as the one weakest axis. Cite only the aggregate signal used by the
   existing scorer: `verify_tool_rate` (verification), `cache_hit_rate` (context hygiene),
   `delegation_ratio` plus structural subagent/permission presence (autonomy), `tool_diversity`
   (learning), or fresh `tokens_per_task` (cost governance).
5. Select one existing entry from the shipped `individual.rubric.json` `patternMap`, preferring an
   exact Spine + weakest-axis match, then a Spine default. Use its existing pattern title and the
   first concrete step from `scripts/analyze/guidance.mjs`.
6. State that structural activity cannot prove intent, repeated instructions, or project facts.

Output shape:

```json
{
  "status": "personalized | insufficient-signal | cold-fallback",
  "window_days": 3,
  "evidence": { "signal": "verify_tool_rate", "value": 0.22 },
  "weakest_axis": "verification",
  "curriculum_pattern": { "id": "...", "title": "..." },
  "action_now": "Run the repository's test command before accepting the current change.",
  "limitations": "Structural signals do not reveal intent or transcript prose."
}
```

No output may contain transcript text, prompts, inferred repeated instructions, guessed goals, or
unmeasured project claims.

## Cold-state fallbacks

- Solo machine: inspect only the current repository and instructions, label the result
  `cold-fallback`, and let the user choose one quick win. Do not call it behavioral personalization.
- Empty Team Brain creator: preview one real team-tier starter artifact; push only after explicit
  approval; query it with citations only after that push.
- Early member of an empty Brain: use the local solo result and explain that Team Query needs real
  shared context. Never seed fake demo content.

## Dogfood matrix and rubric

Recruit at least ten users spanning Claude, Codex, Cursor, OpenCode, cold machines, warm machines,
and mixed project types. Record only aggregate timings and rubric answers with explicit consent.

| Run | Tool mix | State | ≥3 sessions/≥5 roots | Evidence accurate | Privacy pass | Relevant + actionable | First result | Status |
|---|---|---|---|---|---|---|---|---|
| Maintainer mechanics smoke | mixed local tools | warm | not recorded (privacy) | schema only | pass | not rated | <10s | not a quality sample |
| 1–10 | pending | pending | pending | pending | pending | pending | pending | pending |

Pass only when evidence and privacy have zero exceptions, at least 80% rate the result relevant and
actionable, no invented claims occur, p50 prompt-to-result is under five minutes, p90 under ten,
and structural analysis completes within 20 seconds or returns the honest fallback. The cold-Brain
path passes only after a real, explicitly approved starter push produces a cited answer.

## Decision

The mechanics smoke proves the existing analysis surface is structurally sufficient to run the
experiment. It does **not** prove user value. Fewer than ten rated dogfood samples exist, so the
personalized-activation gate remains open and production onboarding personalization remains blocked.
