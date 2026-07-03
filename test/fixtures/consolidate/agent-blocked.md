## CI Status
[PASS] build
[PASS] lint

## Bot Findings (synthesized)
[High] scripts/example.mjs:42 — unbounded retry loop can hang the process (source: Bugbot, GPT-5.5)
[Medium] scripts/example.mjs:10 — may throw on null input before the guard (source: CodeRabbit)

## AIOS Rule Violations
None.

## Verdict
BLOCKED
If BLOCKED: fix the unbounded loop before merge.
