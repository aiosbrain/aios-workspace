/**
 * Fixture replay (AIO-835 Phase 0).
 *
 * A positive fixture must pass BOTH the schema and the cross-field rules. A negative
 * fixture must fail, and fail for the reason it declares — a fixture that trips a
 * different rule than the one it names is itself a failure. That is what stops negative
 * fixtures from decaying into "something, somewhere, rejected this".
 *
 * Rule-kind negatives must be schema-VALID: if the schema already rejects them, they are
 * exercising the schema rather than the rule they claim to prove.
 */
import Ajv2020 from "ajv/dist/2020.js";

import { loadFixture, loadFixtureIndex, listFixtureFiles } from "./load.mjs";
import { evaluateManifest, MANIFEST_RULE_IDS } from "./manifest-rules.mjs";

export function compileSchemas(artifacts) {
  // `strict: true` keeps the compile faithful: an unknown keyword or a `format` we cannot
  // enforce becomes a hard error rather than a silently ignored constraint. `allowUnionTypes`
  // only relaxes ajv's opinion about `"type": ["string", "number"]`, which JSON Schema
  // permits outright — a provider version marker is legitimately either.
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  return {
    manifest: ajv.compile(artifacts["manifest.schema.json"]),
    outcomes: ajv.compile(artifacts["outcomes.schema.json"]),
    evidence: ajv.compile(artifacts["evidence.schema.json"]),
  };
}

export function schemaErrorsAt(validate, pointer) {
  if (!pointer) return validate.errors ?? [];
  return (validate.errors ?? []).filter((err) => {
    const instancePath = err.instancePath ?? "";
    return instancePath === pointer || instancePath.startsWith(`${pointer}/`);
  });
}

function describeErrors(validate) {
  return (validate.errors ?? [])
    .slice(0, 4)
    .map((e) => `${e.instancePath || "/"} ${e.message}`)
    .join("; ");
}

export function checkFixtureIndexParity(index, fail) {
  const declared = new Set(
    [...index.manifest, ...index.outcomes, ...index.evidence].map((f) => f.file)
  );
  const onDisk = new Set(listFixtureFiles());

  for (const file of onDisk) {
    if (!declared.has(file)) fail(`fixtures: "${file}" exists but is not declared in index.json`);
  }
  for (const file of declared) {
    if (!onDisk.has(file)) fail(`fixtures: index.json declares "${file}", which does not exist`);
  }

  const ids = [...index.manifest, ...index.outcomes, ...index.evidence].map((f) => f.id);
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) fail(`fixtures: duplicate fixture id "${id}"`);
    seen.add(id);
  }
}

export function runManifestFixtures(index, contract, validate, fail) {
  const exercisedRules = new Set();

  for (const entry of index.manifest) {
    const doc = loadFixture(entry.file);
    const schemaOk = validate(doc);

    if (entry.expect === "valid") {
      if (!schemaOk) {
        fail(`fixture ${entry.id}: expected schema-valid, got ${describeErrors(validate)}`);
        continue;
      }
      const findings = evaluateManifest(doc, contract);
      if (findings.length > 0) {
        fail(
          `fixture ${entry.id}: expected zero rule findings, got ${findings.map((f) => `${f.rule}: ${f.message}`).join("; ")}`
        );
      }
      continue;
    }

    if (entry.failure.kind === "schema") {
      if (schemaOk) {
        fail(`fixture ${entry.id}: expected a schema failure, but the document validated`);
        continue;
      }
      if (schemaErrorsAt(validate, entry.failure.pointer).length === 0) {
        fail(
          `fixture ${entry.id}: expected a schema error under "${entry.failure.pointer}", got ${describeErrors(validate)}`
        );
      }
      continue;
    }

    // kind === "rule"
    if (!schemaOk) {
      fail(
        `fixture ${entry.id}: declares a rule failure but the schema already rejects it (${describeErrors(validate)}) — it would not exercise the rule`
      );
      continue;
    }
    const findings = evaluateManifest(doc, contract);
    const actual = new Set(findings.map((f) => f.rule));
    const expected = new Set(entry.failure.rules);

    for (const rule of expected) {
      if (!actual.has(rule)) {
        fail(`fixture ${entry.id}: expected rule ${rule} to fire, got [${[...actual].join(", ")}]`);
      }
      exercisedRules.add(rule);
    }
    for (const rule of actual) {
      if (!expected.has(rule)) {
        fail(
          `fixture ${entry.id}: unexpected rule ${rule} fired — narrow the fixture or declare it`
        );
      }
    }
  }

  // Every normative rule must have a fixture proving it fires. An unexercised rule is
  // untested code sitting in the Phase 0 exit gate.
  for (const rule of MANIFEST_RULE_IDS) {
    if (!exercisedRules.has(rule)) {
      fail(`fixtures: manifest rule ${rule} has no negative fixture exercising it`);
    }
  }

  checkProviderCoverage(index, fail);
}

function checkProviderCoverage(index, fail) {
  for (const provider of ["linear", "clickup"]) {
    const own = index.manifest.filter((f) => f.provider === provider);
    if (!own.some((f) => f.expect === "valid")) {
      fail(`fixtures: no positive manifest fixture for ${provider}`);
    }
    if (!own.some((f) => f.expect === "invalid")) {
      fail(`fixtures: no negative manifest fixture for ${provider}`);
    }
  }
}

export function runDocumentFixtures(entries, validate, label, fail) {
  for (const entry of entries) {
    const doc = loadFixture(entry.file);
    const ok = validate(doc);
    if (entry.expect === "valid") {
      if (!ok)
        fail(`fixture ${entry.id}: expected valid ${label}, got ${describeErrors(validate)}`);
      continue;
    }
    if (entry.failure.kind !== "schema") {
      // A cross-field-rule fixture must be schema-VALID, for the same reason the manifest
      // rule fixtures must be: if the schema already rejects it, it is not exercising the
      // rule it names. Its dedicated checker asserts the rule actually fires.
      if (!ok) {
        fail(
          `fixture ${entry.id}: declares a ${entry.failure.kind} failure but the schema already rejects it (${describeErrors(validate)})`
        );
      }
      continue;
    }
    if (ok) {
      fail(`fixture ${entry.id}: expected an invalid ${label}, but the document validated`);
      continue;
    }
    if (schemaErrorsAt(validate, entry.failure.pointer).length === 0) {
      fail(
        `fixture ${entry.id}: expected a schema error under "${entry.failure.pointer}", got ${describeErrors(validate)}`
      );
    }
  }
}

/** Every normalized discriminant needs a positive fixture, or the outcome model is unproven. */
export function checkOutcomeCoverage(index, artifacts, fail) {
  const discriminants = artifacts["outcomes.schema.json"].properties.outcome.enum;
  const covered = new Set(
    index.outcomes
      .filter((entry) => entry.expect === "valid")
      .map((entry) => loadFixture(entry.file).outcome)
  );
  for (const discriminant of discriminants) {
    if (!covered.has(discriminant)) {
      fail(`fixtures: no positive outcome fixture for discriminant "${discriminant}"`);
    }
  }
}

/** Evidence needs at least one valid pass and one valid inconclusive to pin both semantics. */
export function checkEvidenceCoverage(index, fail) {
  const statuses = new Set();
  for (const entry of index.evidence) {
    if (entry.expect !== "valid") continue;
    for (const suite of loadFixture(entry.file).suites) statuses.add(suite.status);
  }
  for (const required of ["pass", "inconclusive"]) {
    if (!statuses.has(required)) {
      fail(`fixtures: no valid evidence fixture with a "${required}" suite result`);
    }
  }
}

/**
 * Classify a capability id against the closed taxonomy: `known`, `extension`, or `unknown`.
 *
 * The distinction between `extension` and `unknown` is the whole point. The schemas' id
 * pattern accepts any syntactically valid `core.*.*` / `pm.*.*`, so "absent from the
 * taxonomy" is NOT the same as "an extension" — treating the two alike is how a typo like
 * `pm.work_item.typo` earns an exemption meant only for `x-<owner>.<name>`.
 */
export function classifyCapability(id, contract) {
  if (contract.capabilities[id]) return "known";
  if (new RegExp(contract.extension_namespace_pattern).test(id)) return "extension";
  return "unknown";
}

/**
 * `mutation_class` gates the mutation-retry branch in outcomes.schema.json, but the schema
 * has no way to check that field against the capability it accompanies. Left unchecked, an
 * outcome for `pm.work_item.update` could declare `"mutation_class": "read"` and then carry
 * `retryable: true` with `duplicate_safety: "none"` — the mutation branch never runs, and the
 * duplicate-safety invariant (INT-007) is bypassed by self-report.
 *
 * Extension capabilities carry no class in the closed taxonomy and are genuinely exempt. An
 * unknown non-extension id is a fault, not an exemption — otherwise a single typo buys the
 * same escape.
 *
 * The outcome-specific capability fields must also name the root operation. Checking only
 * `outcome.capability` leaves `unsupported_capability` and
 * `attempted_mutation.capability` able to smuggle unknown ids past this rule.
 *
 * Returns `null`, or `{ kind: "class-mismatch" | "unknown-capability" |
 * "capability-mismatch", ... }`.
 */
export function findOutcomeCapabilityFault(outcome, contract) {
  const references = [
    ["capability", outcome.capability],
    ["unsupported_capability", outcome.unsupported_capability],
    ["attempted_mutation.capability", outcome.attempted_mutation?.capability],
  ].filter(([, id]) => typeof id === "string");

  for (const [field, id] of references) {
    if (classifyCapability(id, contract) === "unknown") {
      return field === "capability"
        ? { kind: "unknown-capability", capability: id }
        : { kind: "unknown-capability", capability: id, field };
    }
    if (field !== "capability" && id !== outcome.capability) {
      return {
        kind: "capability-mismatch",
        capability: id,
        field,
        expected: outcome.capability,
      };
    }
  }

  const id = outcome.capability;
  if (classifyCapability(id, contract) === "extension") return null;

  const expected = contract.capabilities[id].class;
  if (outcome.mutation_class === expected) return null;
  return { kind: "class-mismatch", capability: id, declared: outcome.mutation_class, expected };
}

const OUTCOME_FAULT_KINDS = {
  "outcome-class-mismatch": "class-mismatch",
  "outcome-unknown-capability": "unknown-capability",
  "outcome-capability-mismatch": "capability-mismatch",
};

export function checkOutcomeClassRule(index, contract, fail) {
  for (const entry of index.outcomes) {
    const fault = findOutcomeCapabilityFault(loadFixture(entry.file), contract);
    const expectedKind = OUTCOME_FAULT_KINDS[entry.failure?.kind];

    if (expectedKind && fault?.kind !== expectedKind) {
      fail(
        `fixture ${entry.id}: expected outcome fault "${expectedKind}", got ${fault ? `"${fault.kind}"` : "none"}`
      );
    }
    if (!expectedKind && fault) {
      fail(
        fault.kind === "unknown-capability"
          ? `fixture ${entry.id}: capability "${fault.capability}" is outside the closed v1 set and is not a namespaced extension`
          : fault.kind === "capability-mismatch"
            ? `fixture ${entry.id}: ${fault.field} names "${fault.capability}" instead of root capability "${fault.expected}"`
            : `fixture ${entry.id}: declares mutation_class "${fault.declared}" for ${fault.capability}, whose taxonomy class is "${fault.expected}"`
      );
    }
  }
}

/** Return the normalization fault for a rate-limit outcome, or null when it is coherent. */
export function findRateLimitNormalizationFault(outcome) {
  if (outcome.outcome !== "rate_limited") return null;
  const rateLimit = outcome.rate_limit;
  if (!rateLimit || typeof rateLimit.normalized_reset_at !== "string") return null;
  if (rateLimit.provider_unit === "unknown") return null;

  const rawText = rateLimit.provider_reset_raw;
  const raw = typeof rawText === "string" && rawText.trim() ? Number(rawText) : rawText;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { kind: "rate-limit-normalization", reason: "provider reset is not numeric" };
  }

  const occurredAt = Date.parse(outcome.occurred_at);
  const expected =
    rateLimit.provider_unit === "epoch_milliseconds"
      ? raw
      : rateLimit.provider_unit === "epoch_seconds"
        ? raw * 1000
        : occurredAt + raw * 1000;
  const actual = Date.parse(rateLimit.normalized_reset_at);
  if (!Number.isFinite(expected) || !Number.isFinite(actual) || actual !== expected) {
    return { kind: "rate-limit-normalization", expected, actual };
  }
  return null;
}

export function checkOutcomeRateLimitRule(index, fail) {
  for (const entry of index.outcomes) {
    const fault = findRateLimitNormalizationFault(loadFixture(entry.file));
    const expected = entry.failure?.kind === "outcome-rate-limit-normalization";
    if (expected && fault?.kind !== "rate-limit-normalization") {
      fail(`fixture ${entry.id}: expected a rate-limit normalization fault, got none`);
    }
    if (!expected && entry.failure?.kind !== "schema" && fault) {
      fail(`fixture ${entry.id}: normalized_reset_at does not match provider_reset_raw`);
    }
  }
}

/**
 * The same distinction applied to every capability-bearing evidence field. An id that is
 * neither in the taxonomy nor a valid extension would silently match no canonical test, so
 * the skipped-capability rule below would have nothing to catch it on.
 */
export function findEvidenceCapabilityFault(evidence, contract) {
  const references = [
    ...(evidence.capability_matrix?.supported ?? []).map((id) => [
      "capability_matrix.supported",
      id,
    ]),
    ...(evidence.capability_matrix?.unsupported ?? []).map((id) => [
      "capability_matrix.unsupported",
      id,
    ]),
    ...(evidence.suites ?? []).flatMap((suite, index) =>
      (suite.capabilities ?? []).map((id) => [`suites[${index}].capabilities`, id])
    ),
  ];
  for (const [field, capability] of references) {
    if (classifyCapability(capability, contract) === "unknown") {
      return { kind: "unknown-capability", capability, field };
    }
  }
  return null;
}

export function checkEvidenceCapabilityIds(index, contract, fail) {
  for (const entry of index.evidence) {
    const fault = findEvidenceCapabilityFault(loadFixture(entry.file), contract);
    const shouldFault = entry.failure?.kind === "evidence-unknown-capability";
    if (shouldFault && fault?.kind !== "unknown-capability") {
      fail(`fixture ${entry.id}: expected an unknown evidence capability, found none`);
    }
    if (!shouldFault && fault) {
      fail(
        `fixture ${entry.id}: ${fault.field} lists "${fault.capability}", which is outside the closed v1 set and is not a namespaced extension`
      );
    }
  }
}

/**
 * "A declared capability cannot be skipped" is a cross-field rule: it relates a suite's
 * `skipped` test ids to the connector's `capability_matrix.supported`. JSON Schema cannot
 * see across those two, so without this a connector could claim a capability, skip its
 * canonical test, and still report `pass`.
 *
 * Returns the offending `{ suite, test, capability }` triples so both the validator and a
 * future conformance runner can share one implementation.
 */
export function findSkippedDeclaredCapabilities(evidence, contract) {
  // Defensive reads: a schema-invalid evidence fixture still reaches this function, because
  // `fail` accumulates instead of halting. Missing structure means "nothing to report here",
  // not a TypeError that masks the real diagnostic.
  const supported = new Set(evidence.capability_matrix?.supported ?? []);
  const offences = [];
  for (const suite of evidence.suites ?? []) {
    for (const entry of suite.skipped ?? []) {
      for (const capability of supported) {
        if (contract.capabilities[capability]?.tests?.includes(entry.test)) {
          offences.push({ suite: suite.suite, test: entry.test, capability });
        }
      }
    }
  }
  return offences;
}

export function checkEvidenceSkipRule(index, contract, fail) {
  for (const entry of index.evidence) {
    const doc = loadFixture(entry.file);
    const offences = findSkippedDeclaredCapabilities(doc, contract);
    const shouldOffend = entry.failure?.kind === "declared-capability-skipped";

    if (shouldOffend && offences.length === 0) {
      fail(`fixture ${entry.id}: expected a skipped declared capability, found none`);
    }
    if (!shouldOffend && offences.length > 0) {
      fail(
        `fixture ${entry.id}: skips the canonical test of declared capabilit${offences.length === 1 ? "y" : "ies"} ${offences.map((o) => `${o.capability} (${o.test})`).join(", ")}`
      );
    }
  }
}

/**
 * Evidence fixtures embed the contract digests they were produced against. Holding them to
 * the LIVE digests is deliberate: it makes "a contract change requires updated fixtures" a
 * mechanical failure rather than a convention, and it proves the digest export the
 * downstream repositories pin is the one the evidence format actually describes.
 */
export function checkEvidenceDigestParity(index, digests, fail) {
  for (const entry of index.evidence) {
    const declared = loadFixture(entry.file).contract_digests;
    for (const [file, digest] of Object.entries(digests)) {
      if (declared[file] !== digest) {
        fail(
          `fixture ${entry.id}: contract_digests["${file}"] is stale (${declared[file]?.slice(0, 12)}… vs ${digest.slice(0, 12)}…) — the contract changed, so refresh the fixtures`
        );
      }
    }
  }
}

export function loadIndex() {
  return loadFixtureIndex();
}
