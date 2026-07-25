---
name: verify-schema-validator-parity
description: Prove parity when a JSON Schema, TypeScript or runtime validator, generated type, or fixture set changes. Use to detect optionality, enum, default, coercion, unknown-field, and test-wiring drift; do not decide product contract semantics.
---

# Verify schema and validator parity

1. Identify the canonical schema, runtime validators, generated or static types, fixtures, and all
   commands that exercise them.
2. Build a table of required or optional fields, types, enums, bounds, defaults, coercion, formats,
   additional or unknown fields, and conditional rules across every representation.
3. Add or run paired positive and negative boundary fixtures. For each fixture, record schema
   acceptance and runtime acceptance; any disagreement is a failure.
4. Test omitted, null, empty, minimum or maximum, unknown, legacy-version, and malformed cases
   where applicable.
5. Regenerate types and artifacts with the canonical command and verify a clean freshness diff.
6. Confirm the parity tests run in local and CI commands. Invoke `test-ci-wiring-audit` if wiring is
   uncertain.
7. Return the parity matrix, drift findings, and exact verification commands.

Do not choose contract meaning or treat typechecking alone as runtime validation.
