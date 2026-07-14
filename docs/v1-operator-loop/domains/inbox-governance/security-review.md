---
status: final
owner: john
access: admin
created: 2026-07-14
type: governance
---

# Unified inbox — security-review requirements (PRD §7)

Explicit pass/fail requirements for the retention + audit-anchor package. No adjective claims: each
line is a checkable fact, marked `[x]` (met + demonstrated) or `[ ]` (open / out of this package's
scope). The redaction/doc lint rejects adjective claims anywhere in this package (the banned set
lives in the lint source), so a claim can never stand in for a check.

## §7.1 Audit chain

[x] An `audit_log` distinct from the agent-event journal exists (`audit-log.ndjson` vs `inbox-events.ndjson`).
[x] Each record binds an authenticated actor, an immutable event from a fixed vocabulary, correlation/causation ids, client + server timestamps, a payload digest, and a transport/runtime receipt.
[x] Records carry payload DIGESTS only — no message bodies, subjects, or participant plaintext.
[x] The log is an append-only hash chain (`prev_hash` link + per-record `hash`); a single-byte mutation is detected by `verifyChain`.
[x] `verifyChain` returns an explicit pass/fail with per-seq failure reasons — it never asserts trustworthiness as an adjective.

## §7.2 Anchoring (D6)

[x] Checkpoints anchor to a control plane INDEPENDENT of the inbox host (the `AnchorSink` seam; local git is excluded).
[x] The D6 ruling is the Team Brain checkpoint endpoint, digests only, tier-reviewed in `docs/brain-api.md` before first live use.
[x] Only chain heads + digests cross the anchor boundary — never records or payloads.
[x] Checkpoint cadence is honored on a time-faked run (`runCheckpointCadence`).
[x] After a backup/restore cycle, `verifyChain` against the independently-held anchors passes on an intact log and localizes a tampered prefix on a mutated one.
[ ] The live Team Brain checkpoint endpoint adapter is implemented and tier-reviewed (separate integration; not in this package).
[ ] Anchor cadence tuning under production load (deferred per the issue scope).

## §7.3 Retention + deletion

[x] A machine-readable retention table (`retention.yaml`) maps every store to a period + deletion procedure.
[x] Deletion covers backups: `executeDeletion` removes selected entries from the live store AND the backup set.
[x] Deleting a user's content leaves every audit digest intact — `verifyChain` still passes after deletion.
[x] The deletion is itself recorded as a `retention.deletion` audit record digesting which ids were erased (never the content).
[x] The data inventory enumerates every store the epic created; the lint fails on a store present in the domain doc but missing from the inventory.

## §7.4 Telemetry redaction

[x] The telemetry path carries no message bodies, subjects, or participant identities (redaction spec + lint).
[x] The redaction lint exits non-zero on any forbidden string from the fixture corpus, zero otherwise.
[x] `telemetry-nonsync.test.mjs` still proves the telemetry ledger is never picked up by the sync gate.

## §7.5 Incident response

[x] The IR runbook covers detection → containment → notification → recovery.
[x] The runbook has a `Revocation order` section listing every adapter.
[x] The runbook was exercised once as a tabletop; the notes (with the gap found + closed) are committed.

## §7.6 Deferred (named, not claimed)

[ ] Third-party security audit.
[ ] Compliance certifications.
[ ] Multi-tenant governance.
