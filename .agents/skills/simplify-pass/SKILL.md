---
name: simplify-pass
description: Behavior-preserving cleanup pass over a reviewed diff — run AFTER tests pass and review is addressed, BEFORE merge. Deletes dead code, collapses needless indirection, applies YAGNI. Use when the user says "simplify", "clean up this diff", or as the standard final pass on any agent-authored change.
source: Boris Cherny (code-simplifier subagent habit); AIOS toolkit `aios simplify`
am_pattern: C7
triggers:
  - simplify
  - simplification pass
  - reduce complexity
  - cleanup pass
---

"Tests pass and the reviewer is happy" is where debt *compounds*, not where work ends.
You are running a dedicated simplification pass over the current change. The contract:
**behavior-preserving, scoped to the changed hunks, gated by the checks.**

## Procedure

1. Record the baseline: run the check (test suite / build / lint) and confirm green
   *before* touching anything. If it isn't green, stop — simplification never happens
   on a red baseline.
2. Read only the diff of the current change (`git diff <base>...` or the PR diff), not
   the whole codebase. Your scope is the hunks this change introduced or touched.
3. Apply, in order of value:
   - **Delete** — dead code, unused parameters/imports, commented-out code, redundant
     comments (comments that restate the code, narrate the change, or address a
     reviewer), defensive checks for conditions that cannot occur. Classic AI-slop tell:
     **redundant verification after a destructive action** (delete-then-query to
     "confirm", setter-then-getter, write-then-read-back) — the operation's contract is
     the proof; delete the re-check. **Before removing a line that has NO test coverage,
     pin its current behavior with a characterization test first** — then the deletion is
     provably safe, not hopeful.
   - **Collapse** — indirection with a single caller, wrapper functions that add
     nothing, premature abstractions with one concrete use (inline them — no
     abstraction before the second use).
   - **Align** — naming and idiom to match the surrounding file, so the diff reads as
     if the codebase's regular author wrote it.
4. Re-run the full check after the pass. **Any failure → revert the simplification
   entirely** (the cleanup is never worth a behavior change). Green → done.

## Hard rules

- Never change behavior, public interfaces, or error semantics — if you spot a *bug*
  during the pass, report it separately; don't fix it inside a "simplification".
- Never expand scope beyond the changed hunks ("while I'm here…" is how cleanup passes
  break things).
- One pass, cheap and fast. This is a hygiene step, not a redesign.
- **A prose/docs file has no behavioral seam** — never add a text-match or word-count
  "test" to pin it; that's pretend-coverage that blocks every future reword. Prose is
  guarded by review, not by an assertion.
