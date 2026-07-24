---
spec_gate: block
type: issue-spec
---

# Pick-up-able template smoke spec

## What / why

Verify the aios issue template and `aios spec init` scaffold pass the deterministic spec gate.

## Outcomes

- `aios spec init` writes a file from `docs/agentic-ergonomics/aios-issue-template.md`.
- `linear.mjs template` prints the same scaffold for Linear issue bodies.

## Interface / integration points

- `docs/agentic-ergonomics/aios-issue-template.md` — canonical template
- `scripts/spec-eval.mjs` — `cmdSpecInit`, SR5 Outcomes recognition
- `scaffold/.claude/skills/aios-linear/linear.mjs` — template / patch-desc commands

## Dependencies

Depends on: none

## Scope

**In:** template file, spec-eval init, linear CLI template commands, tests.

**Deferred:** custom Linear MCP server; harness hooks for session closeout blocking.

## Acceptance criteria

### Automated

- `node --test test/template-spec-readiness.test.mjs` exits 0
- `node scripts/aios.mjs spec eval test/fixtures/spec-eval/aios-issue-filled.md --no-llm --repo .` exits 3

### Manual

- (none)

### Visual

- (none)

## Build-with

Build-with: deterministic docs/CLI change — no model build required.

## Tier safety

No brain/sync surfaces touched.
