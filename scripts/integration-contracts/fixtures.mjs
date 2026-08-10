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

function schemaErrorsAt(validate, pointer) {
  if (!pointer) return validate.errors ?? [];
  return (validate.errors ?? []).filter((err) => (err.instancePath ?? "").startsWith(pointer));
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
 * "A declared capability cannot be skipped" is a cross-field rule: it relates a suite's
 * `skipped` test ids to the connector's `capability_matrix.supported`. JSON Schema cannot
 * see across those two, so without this a connector could claim a capability, skip its
 * canonical test, and still report `pass`.
 *
 * Returns the offending `{ suite, test, capability }` triples so both the validator and a
 * future conformance runner can share one implementation.
 */
export function findSkippedDeclaredCapabilities(evidence, contract) {
  const supported = new Set(evidence.capability_matrix.supported);
  const offences = [];
  for (const suite of evidence.suites) {
    for (const entry of suite.skipped) {
      for (const capability of supported) {
        if (contract.capabilities[capability]?.tests.includes(entry.test)) {
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
