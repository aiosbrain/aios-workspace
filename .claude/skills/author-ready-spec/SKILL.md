---
name: author-ready-spec
description: Draft or restructure a Linear issue, implementation spec, acceptance criteria, or issue slice into a cold-start buildable increment. Use for “write the spec,” “make this issue buildable,” or equivalent authoring requests; do not use to evaluate, repair, publish, plan, or implement it.
---

# Author a ready spec

Produce one implementation-ready candidate without mutating Linear.

1. Establish the outcome, fixed decisions, dependencies, in-scope increment, deferred work, risks,
   and testable acceptance criteria.
2. Inspect the immutable repository baseline before asserting paths, primitives, or architecture.
   Label every new path as new; cite existing paths exactly.
3. Keep one narrow public surface and identify consumers, contracts, migrations, generated outputs,
   and operational boundaries that the increment affects.
4. Sequence the in-scope increment as a thin end-to-end vertical slice by default (contract stub →
   mock consumer → wire real dependency → business logic → error handling); fall back to
   horizontal layering only when a slice genuinely cannot be isolated, and state why.
5. State missing prerequisites and the fail/stop behavior. Do not silently choose product,
   compatibility, privacy, or external-contract decisions.
6. Make every acceptance criterion observable with a named command, exit condition, artifact, or
   grep-able output. Include negative and rollback behavior where applicable.
7. Consult `.claude/skill-suite.json` and recommend at most two compatible builder skills when
   focused procedural judgment materially helps. Do not force a declaration.
8. Return only the candidate Markdown plus a short unresolved-decisions list when blockers remain.

Preserve user intent and scope. Do not run readiness evaluation, repair evaluator findings, publish,
or start implementation.

## Vertical slice vs. horizontal layering — a worked example

**Horizontal (avoid by default):** for a feature touching a new data field, a horizontally-ordered
plan does "add DB migration" → "add all service-layer methods" → "add all API endpoints" → "wire
the frontend" — nothing is reviewable or testable until every layer is done, so 1,000+ lines
accumulate before the first checkpoint.

**Vertical (default to this):** the same feature ordered as "stub the API contract with a mocked
response" → "wire the frontend against the stub" → "replace the mock with the real service call" →
"add the DB migration and business logic" → "add error handling" — each step is independently
testable and reviewable, so problems surface at the cheapest possible point instead of compounding.

`AIO-471` ("Gmail inbox context: refactor into incremental implementation slices") is a real,
worked instance of exactly this ordering being reached for organically on one feature — treat it as
a live example of the pattern this step asks every spec to apply by default, not a one-off.
