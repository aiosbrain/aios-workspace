---
name: triage-pr-evidence
description: Reconcile Local Bugbot, CodeRabbit, CI, GPT review, security review, and plan-conformance findings for one exact PR head. Use after deterministic findings collection when evidence is ambiguous; do not re-review code, fix, merge, or treat a green check as substantive evidence.
---

# Triage PR evidence

Produce one ordered remediation input and a verdict for an exact base/head fingerprint.

1. Record PR, base SHA, head SHA, diff hash, and collection time for every source.
2. Reject or quarantine evidence from a different head or base. A green check without substantive
   review text is status, not reviewer evidence.
3. Normalize findings while preserving source, severity, file/line, claim, and evidence.
4. Classify each finding as `actionable`, `duplicate`, `outdated`, `unsupported`, or
   `needs-decision`.
5. Preserve all current Critical/High findings and plan-conformance Medium findings. Explain any
   severity or support dispute; do not silently drop it.
6. Order actionable remediation by safety, dependency, and verification sequence.
7. Return `CLEAR`, `BLOCKED`, or `INDETERMINATE`, plus quarantined evidence and the exact
   fingerprint.

Do not perform a fresh code review, edit code, merge, or weaken deterministic gates.
