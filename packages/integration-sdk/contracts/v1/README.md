# AIOS Integration Framework — v1 contract artifacts

The six normative artifacts of the integration constitution (AIO-835, Phase 0). They are
**data, reviewed by commit SHA**, and they land together as one unit: no adapter is written
against draft semantics.

| File | What it pins |
|------|--------------|
| `capabilities.json` | The closed v1 capability identifiers, profiles, capability classes, canonical conformance test ids, baseline/conditional test requirements, and dependency rules. |
| `manifest.schema.json` | JSON Schema Draft 2020-12 for the canonical connector manifest. |
| `outcomes.schema.json` | The ten normalized operation outcomes as a discriminated union. |
| `evidence.schema.json` | The machine-readable certification evidence format. |
| `compatibility.json` | The host/manifest load table and the Harness policy guard table, as executable cases. |
| `invariants.json` | `INT-001`…`INT-020`, each mapped to exactly one owning test id. |

`__fixtures__/` holds the positive and negative Linear and ClickUp fixtures. Every fixture is
declared in `__fixtures__/index.json`; a file that exists but is not declared, or a
declaration whose file is missing, is a hard failure.

## Validating

```bash
npm run integration:contracts:validate
```

It checks internal consistency (taxonomy, invariant ownership, schema hygiene), replays the
compatibility truth table through a reference evaluator, replays every fixture, and writes
`reports/integration/integration-contract-v1-digests.json`. The same checks run under
`npm test` via `test/integration-contracts.test.mjs`.

## Two things that are easy to get wrong

**Digests are over canonical JSON, not file bytes.** These files live under `packages/**`,
which prettier formats. A byte digest would change whenever the formatter's preferences
changed and would break every downstream pin for no semantic reason. The digest is taken over
an RFC 8785-style serialization (recursively key-sorted, no insignificant whitespace), so it
moves only when the contract moves — which is exactly the event that requires a
contract-version bump and refreshed fixtures.

**A negative fixture must fail for the reason it declares.** A fixture naming a cross-field
rule must be schema-*valid*; if the schema already rejects it, it is exercising the schema
rather than the rule it claims to prove, and the validator says so. Every rule in
`MANIFEST_RULE_IDS` must have a fixture that trips it, and no fixture may trip a rule it did
not declare.

## Changing the contract

A change to an identifier, a required field, an outcome meaning, or a compatibility result is
a **contract-version change**: bump `contract_version` in every artifact that carries it,
refresh the fixtures (including the `contract_digests` embedded in the evidence fixtures), and
re-run the validator. The digest-parity check turns "remember to update the fixtures" into a
mechanical failure rather than a convention.

Ownership, the phase sequence, and the gate-state table live in AIO-835.
