# Unified inbox — retention + audit-anchor governance package (I-16 / AIO-397)

The data-governance + audit-anchor package that gates real pilot accounts (PRD entry condition; not
required for the Jul 29 demo). Two halves:

1. **Data-governance package** — [`data-inventory.md`](./data-inventory.md),
   [`retention.yaml`](./retention.yaml) (machine-readable retention + deletion table),
   [`ir-runbook.md`](./ir-runbook.md) (incident response + `Revocation order`),
   [`telemetry-redaction.md`](./telemetry-redaction.md).
2. **Audit anchor (D6)** — the tamper-evident `audit_log` + hash chain + host-independent checkpoint
   anchoring + post-restore verification, implemented in `src/operator-loop/inbox/audit.ts` and
   `src/operator-loop/inbox/retention.ts`.

The explicit pass/fail requirements are in [`security-review.md`](./security-review.md) (PRD §7).

## Enforcement

- Engine + tests: `src/operator-loop/inbox/{audit,retention}.ts`,
  `test/operator-loop/inbox-audit.test.mjs` (`node --test test/operator-loop/inbox-audit.test.mjs`).
- Lint (wired into CI as `npm run check:inbox-audit`): `scripts/inbox-redaction-lint.mjs` — telemetry
  redaction, data-inventory reconcile, IR-runbook `Revocation order` check, and adjective-claim
  rejection (the banned-adjective set lives in the lint source, not restated here).

## Tier posture

Everything here is admin-tier local under `.aios/loop/`; none is in `sync_include`. The only bytes
that ever cross to the Team Brain are audit chain heads + digests via the D6 checkpoint endpoint
(digests only, tier-reviewed in [`docs/brain-api.md`](../../../brain-api.md) first) — never a record,
body, subject, or participant. `src/operator-loop/comms/sender.ts` is untouched by this package.
