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
4. State missing prerequisites and the fail/stop behavior. Do not silently choose product,
   compatibility, privacy, or external-contract decisions.
5. Make every acceptance criterion observable with a named command, exit condition, artifact, or
   grep-able output. Include negative and rollback behavior where applicable.
6. Consult `.claude/skill-suite.json` and recommend at most two compatible builder skills when
   focused procedural judgment materially helps. Do not force a declaration.
7. Return only the candidate Markdown plus a short unresolved-decisions list when blockers remain.

Preserve user intent and scope. Do not run readiness evaluation, repair evaluator findings, publish,
or start implementation.
