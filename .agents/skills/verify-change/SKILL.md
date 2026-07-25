---
name: verify-change
description: Verify a change actually works by exercising it end-to-end and observing real behavior — not just green tests. Use before declaring any nontrivial change done, before opening a PR, or when the user asks "does this actually work?".
source: AM pattern B2 ("give it a check it can run" — the single most important pattern); Anthropic verification guidance
am_pattern: B2
triggers:
  - verify the change
  - verify it works
  - prove it works
  - end-to-end check
  - did it actually work
---

Green tests are necessary, not sufficient. You are verifying the change by **driving the
affected flow the way a user or caller would** and observing the outcome. This is the
check that separates a session someone must babysit from one they can walk away from.

## Procedure

1. **Name the claim.** One sentence: "this change makes X happen under Y." If you can't
   state it, you can't verify it.
2. **Run the standing checks** — the repo's full test suite, build, lint/typecheck (see
   `AGENTS.md` Commands). Any failure stops verification; report it as-is, never as
   "mostly passing".
3. **Drive the real flow.** Pick the cheapest honest end-to-end exercise:
   - API/service change → real request against a locally running instance; inspect the
     response *and* the side effects (DB row, emitted event, log line).
   - CLI change → run the actual command on a realistic input.
   - UI change → open it in a real browser; click the path; screenshot the result.
   - Bug fix → replay the original reproduction and watch it not happen.
4. **Probe one boundary.** The empty input, the unauthorized caller, the double-submit —
   whichever edge the change plausibly moved.
5. **Report with evidence.** State what you ran and what you observed (command + output,
   screenshot, response body). "Verified: ran X, observed Y" — never "should work now."

## Rules

- If you cannot run the flow (missing credentials, no local env), **say exactly that**
  and list what a human must do to verify — do not substitute confidence for evidence.
- A verification that would pass even if the change were reverted is not a verification.
  When in doubt, revert mentally: what observable difference does this change make?
- New behavior worth verifying is usually worth a permanent test — if step 3 caught
  something the suite didn't, that's a `compound-learnings` entry.
