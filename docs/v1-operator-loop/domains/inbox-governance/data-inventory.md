---
status: final
owner: john
access: admin
created: 2026-07-14
type: governance
---

# Unified inbox — data inventory (I-16 / AIO-397)

The complete inventory of every store the unified-inbox epic created. Each store is admin-tier local
under `.aios/loop/`; none is in `sync_include`. This inventory is reconciled by the redaction/doc
lint (`scripts/inbox-redaction-lint.mjs`): a store named in the domain doc or the retention table but
missing here makes the lint exit non-zero. The retention period + deletion procedure for each store
is the machine-readable [`retention.yaml`](./retention.yaml); this doc is the human enumeration.

The canonical store `id`s (matched verbatim by the lint against `retention.yaml`):

| Store | `id` | What it holds | Contains comms plaintext? |
|-------|------|---------------|---------------------------|
| Journal | `store: journal` | `inbox-events.ndjson` — the append-only agent-event log | No — ids + digests + metadata |
| Read model | `store: read_model` | `read-model.db` — the SQLite projection rebuilt from the journal | No — projected state |
| Observation log | `store: observations` | Enriched adapter observations (account/tenant identity, thread ids) | Participant identity only |
| Snippets / body cache | `store: snippets_body_cache` | Cached message bodies + subjects for ranking/preview | **Yes** — shortest window (7d) |
| Outbox | `store: outbox` | Pending/sent draft payloads | Draft bodies |
| Audit | `store: audit` | `audit-log.ndjson` — the tamper-evident governance chain | No — digests only |
| Backups | `store: backups` | Byte mirrors of the stores above, under `backups/` | Mirror of source |
| Telemetry | `store: telemetry` | Loop telemetry ledger (`events.jsonl`) | No — redaction lint enforced |

## Deletion reconciliation with tamper-evidence

Deleting a user's content (any content store above) removes it from the live store **and** its
backup mirror (`retention.ts::executeDeletion`). The audit log is never touched by a content
deletion: it holds only `payload_digest`s, so every digest survives and `verifyChain` still returns
pass after the erasure. The deletion itself is recorded as a `retention.deletion` audit record — a
digest of *which ids* were erased, never the content — so the erasure stays accountable.

## Cross-references

- Retention periods + procedures: [`retention.yaml`](./retention.yaml)
- Incident response + revocation order: [`ir-runbook.md`](./ir-runbook.md)
- Telemetry redaction spec + lint: [`telemetry-redaction.md`](./telemetry-redaction.md)
- Security-review pass/fail list: [`security-review.md`](./security-review.md)
- Domain contract: [`../unified-inbox.md`](../unified-inbox.md) §2 (journal), §6 (observations), §8 (D6 audit anchor)
