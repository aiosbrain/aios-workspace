---
status: final
owner: john
access: admin
created: 2026-07-14
type: governance
---

# Unified inbox — telemetry redaction spec (I-16 / AIO-397)

The telemetry path (`src/operator-loop/telemetry.ts`, ledger at `.aios/loop/telemetry/events.jsonl`)
is admin-tier operational data. It MUST NOT carry, in any field, any of:

- **message bodies** — the text of an email/DM/thread message;
- **subjects** — email/thread subject lines;
- **participant identities** — display names, handles, addresses, phone numbers, or account/tenant
  ids that identify a person.

Telemetry may carry: counts, durations, rank scores, tier labels, correlation ids, and `sha256:`
digests. A digest is the only permitted representation of any of the three forbidden classes.

## What crosses to telemetry (allowed shapes)

| Field | Allowed | Not allowed |
|-------|---------|-------------|
| item reference | `correlation_id`, `sha256:` digest | native message id, thread subject |
| who | rank weight, tier label | sender name / handle / address |
| what | operation name (`gmail.send`), counts | draft body, message body |
| when | ISO timestamps, latency ms | — |

## The lint (deterministic, no model)

`scripts/inbox-redaction-lint.mjs` is the enforcement backstop, reusing the `leak-sweep.ts`
convention (pure string containment, never an LLM judgment):

- **Corpus:** `test/operator-loop/fixtures/inbox-telemetry-corpus.fixture.json` enumerates the
  forbidden strings (bodies, subjects, participants) drawn from a synthetic inbox.
- **Target:** the telemetry fixtures (`test/operator-loop/fixtures/inbox-telemetry-*.jsonl`) that
  stand in for a real telemetry ledger.
- **Rule:** any exact (case-insensitive) occurrence of a corpus string in a telemetry fixture is a
  leak → the lint exits non-zero. Zero occurrences → exit zero.

The lint is wired into CI (`npm run check:inbox-audit`). It also carries the data-inventory
reconcile, the IR-runbook `Revocation order` check, and the adjective-claim rejection — see
`security-review.md`.

## Boundary test

`test/operator-loop/telemetry-nonsync.test.mjs` continues to prove the ledger is never picked up by
the sync gate. This redaction spec is the *content* boundary; that test is the *transport* boundary.
Both hold.
