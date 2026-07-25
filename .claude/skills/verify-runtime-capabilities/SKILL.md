---
name: verify-runtime-capabilities
description: Verify claims about lifecycle hooks, prompt injection, tool interception, stop continuation, subagents, or cross-runtime parity. Use for runtime or adapter preflights and capability matrices before a spec relies on behavior that may differ by installed runtime.
---

# Verify runtime capabilities

Produce a version-pinned capability matrix with `PASS`, `FAIL`, or `INDETERMINATE`.

1. Record exact installed runtime, adapter, schema/type, and binary versions.
2. Collect primary documentation plus exact local schema/type/binary evidence. Similar event names
   do not prove equivalent semantics.
3. Translate every claim into a bounded, non-destructive scratch smoke with an observable result.
   Never write to a real repository during a smoke.
4. Test hook timing, payload shape, blocking behavior, continuation semantics, prompt delivery,
   subagent scope, and failure behavior separately where claimed.
5. Mark missing or contradictory evidence `INDETERMINATE` or `FAIL`; never upgrade absence to
   support.
6. State the truthful fallback or degradation path for each unsupported capability.
7. Hash and retain redacted evidence so author/eval workflows can reference the exact matrix.

Do not implement adapters or claim parity from documentation alone.
