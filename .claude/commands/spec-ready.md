---
description: Author, evaluate, and boundedly repair a local spec; publishing is excluded by default
argument-hint: <source> --repo <path>
---

Resolve $ARGUMENTS, then compose the focused local stages:

1. Use `author-ready-spec` only when the source is not already a candidate spec.
2. Run `aios spec eval <candidate> --json` with `evaluate-spec-readiness`.
3. On `NOT_READY`, run `aios spec fix <candidate>` with `repair-spec-safely` within the rubric
   budget, then re-run the normal evaluator.
4. Return the candidate plus evaluation, resolution-map, and diff artifacts.

This command is read-only with respect to Linear. Never publish unless the user separately and
explicitly invokes `/linear-publish-spec`.
