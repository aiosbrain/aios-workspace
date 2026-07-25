---
name: ast-grep
description: "Use ast-grep (sg) for AST-aware code search and deterministic rewrites/codemods across many languages. Trigger when the target is syntax SHAPE, not text: find every function/call/class/import shaped like X, rewrite console.log to logger.info, strip `as any`, migrate require() to import, find empty catch blocks or missing await. Prefer this over rg/grep when the answer depends on the language's syntax tree; use rg for string contents, comments, filenames, or regex byte searches. For read-only structural queries you can also use the codebase graph (codebase-memory-mcp)."
source: oh-my-opencode `ast-grep` (Yeongyu Kim / code-yeongyu), ported lean — the technique + the load-bearing gotchas, without the bundled Python helper (use `sg` directly)
am_pattern: C4
triggers:
  - ast-grep
  - structural search
  - codemod
  - syntax-aware
  - rewrite across the codebase
---

`sg` (also installed as `ast-grep`) parses your pattern as code and matches the syntax tree, so it
finds **code shape**, not bytes. It is the right tool for structural search and, above all, for
**deterministic codemods** across many files. Install: `brew install ast-grep` (or `cargo install ast-grep`).

Decide the tool by the question: *does the answer depend on the language's syntax tree, or just on
the file's bytes?* Syntax → ast-grep. Bytes (string literals, comments, license headers, filenames,
cross-language regex) → `rg`. Read-only "what calls X / where is Y" → the codebase graph is often faster.

## Three things to internalize

**1. ast-grep is NOT regex.** The only wildcards are `$VAR` (one AST node) and `$$$` (zero or more
nodes). Regex syntax fails — usually silently:

| You wrote | ast-grep saw | You wanted |
|---|---|---|
| `foo\|bar` | a bitwise-or expression | two separate searches |
| `.*foo` | not parseable | `$$$ foo`, or use `rg` |
| `\w+` | not parseable | `$VAR` to capture any identifier |
| `[a-z]` | a character class | switch to `rg` |

**2. The pattern itself must be valid code.** `def $FN($$$):` fails (trailing `:` is incomplete) —
use `def $FN($$$)`. `function $NAME` fails — use `function $NAME($$$) { $$$ }`.

**3. `--update-all` and `--json` are mutually exclusive — silently.** `sg run -p P -r R --json
--update-all` returns JSON but **does not mutate files**. To both preview AND apply, run **two passes**:

```bash
sg run -p 'console.log($MSG)' -r 'logger.info($MSG)' --lang ts --json=compact .   # 1. preview
sg run -p 'console.log($MSG)' -r 'logger.info($MSG)' --lang ts --update-all .      # 2. apply
```

## Discipline

- **Validate the pattern before hunting "no matches" by hand** — a `sg run -p '<pattern>' <path>`
  with no `-r` confirms the pattern parses and matches what you expect.
- **Dry-run before you apply.** Always do the preview pass and read the diff before `--update-all`.
- **Scope with globs**: `--globs '!**/*.test.ts'` (repeatable; `!` excludes).
- **Codemods over a large set** are exactly ast-grep's strength — but the change is only as safe as
  your test gate. Run the project's tests after applying, per `verify-change`.
- For repeatable/lint-style rules, put them in a YAML rule file (`sg scan --rule rule.yml`).

Cite evidence in the result: the pattern, the file:line matches, and (for a rewrite) the diff you
applied and the test run that proved it safe.
