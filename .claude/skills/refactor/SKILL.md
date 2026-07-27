---
name: refactor
description: "Structured restructuring of EXISTING code — extract, split, rename, modernize, de-duplicate, move responsibilities — with zero behavior change and a test run after every step. Use when the task is to reshape working code (not add a feature, not the post-diff hygiene pass). Distinct from simplify-pass, which is a cheap one-pass cleanup of the hunks you just changed; refactor is a planned, multi-step restructure of code that already exists. Triggers: refactor, restructure, extract, split this file/function, modernize, de-duplicate, move X into Y."
source: oh-my-opencode `refactor` (Yeongyu Kim / code-yeongyu), trimmed to the phase discipline; dropped the omo command-template, `call_omo_agent`/LSP/refactor-squad plumbing
am_pattern: C7
triggers:
  - refactor
  - restructure the code
  - extract a function
  - de-duplicate
  - move responsibilities
---

Refactoring changes structure, never behavior. The whole discipline is: **know what depends on the
target before you touch it, lock behavior with tests first, change in small steps, and run the tests
after every step.** A refactor that needs a "and also fix this bug" is two tasks — do them separately.

## 1 — Intent gate

Confirm the target and the desired end state before touching anything. If the request is open-ended
("clean this up", "improve X"), ask *what specific improvement* and *what scope* (file / module /
project). Articulate the success criteria in one sentence; if you can't, you're not ready to start.

## 2 — Codemap the blast radius

Map what the target is and everything that depends on it *before* editing: definitions, callers,
imports, subclasses, tests. Use the codebase graph (codebase-memory-mcp `search_graph`/`trace_path`)
or `ast-grep`/`rg`. The output is the impact zone — the set of files a correct refactor must keep
consistent. Surprises here mean stop and re-scope.

## 3 — Establish the safety net

Refactoring without a behavior lock is editing and hoping. Before the first change:
- If the target is covered by tests, note which ones assert its behavior.
- If it is **not** covered, write a characterization test that pins current observable behavior
  *first* (see `tdd-fail-first`), so any behavior drift during the refactor fails loudly.
- Identify the cheapest command that exercises the impact zone — you'll run it after every step.

## 4 — Plan the steps

Break the restructure into the smallest independently-valid steps (extract this function; move this
type; inline that indirection). Each step compiles and keeps the tests green on its own. Order them
so the tree is never broken between steps. For a large or risky refactor, get the plan reviewed
before executing (hand it to `plan-first` / a fresh-context reviewer).

## 5 — Execute, verifying after each step

Apply one step, run the safety-net command, confirm green, then the next. Prefer tool-assisted
structural edits (`ast-grep` codemods, editor/LSP rename) over hand edits for mechanical changes —
they're exhaustive where a manual sweep misses call sites. Never batch several steps before testing:
when something breaks you want it attributable to one step.

## 6 — Verify + hand off

Run the full relevant suite (not just the fast subset) and confirm behavior is unchanged end-to-end
per `verify-change`. The diff should be pure restructuring — if `git diff` shows a behavior change,
that's a bug the refactor smuggled in. Then the result still flows through `code-review` and
`simplify-pass` like any other change.
