---
description: Produce a pinned, evidence-backed capability matrix for installed agent runtimes
argument-hint: [runtime ...]
---

Use `verify-runtime-capabilities` for $ARGUMENTS. Pin exact installed versions, collect primary
documentation and local schema or binary evidence, and run only bounded non-destructive smokes in a
disposable scratch directory. Return `PASS`, `FAIL`, or `INDETERMINATE` per capability with a
truthful fallback and redacted evidence hashes. Never write to a real repository during a smoke.
