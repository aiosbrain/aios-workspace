/**
 * Phase 0 exit gate for the AIOS Integration Framework v1 contract (AIO-835).
 *
 * `npm run integration:contracts:validate` is the operator-facing command; this suite is the
 * same checks wired into `npm test`, plus assertions the CLI cannot make about itself:
 * that the digests are canonical (formatting-independent), that the reference compatibility
 * evaluator actually distinguishes its results, and that the validator FAILS when the
 * contract is corrupted — a gate nobody has watched fail is not a gate.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { checkInvariants } from "../scripts/integration-contracts/taxonomy.mjs";
import { loadFixture } from "../scripts/integration-contracts/load.mjs";
import { findSkippedDeclaredCapabilities } from "../scripts/integration-contracts/fixtures.mjs";

import { buildDigestArtifact, validateContracts } from "../scripts/integration-contracts.mjs";
import {
  ARTIFACT_FILES,
  CONTRACT_VERSION,
  canonicalDigest,
  canonicalJson,
  loadContracts,
  resolvePointer,
} from "../scripts/integration-contracts/load.mjs";
import {
  evaluateHarnessPolicy,
  evaluateManifestLoad,
} from "../scripts/integration-contracts/compat.mjs";
import {
  evaluateManifest,
  isPrivateHost,
  MANIFEST_RULE_IDS,
} from "../scripts/integration-contracts/manifest-rules.mjs";

test("the v1 contract validates with zero failures", () => {
  const { failures } = validateContracts();
  assert.deepEqual(failures, [], failures.join("\n"));
});

test("canonical JSON is key-order independent, so digests survive reformatting", () => {
  const a = { b: 1, a: [{ y: true, x: null }] };
  const b = { a: [{ x: null, y: true }], b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(canonicalDigest(a), canonicalDigest(b));
  assert.equal(canonicalJson(a), '{"a":[{"x":null,"y":true}],"b":1}');
});

test("the digest artifact names every normative artifact", () => {
  const { digests } = loadContracts();
  const artifact = buildDigestArtifact(digests);
  assert.equal(artifact.artifact, "integration-contract-v1-digests");
  assert.equal(artifact.contract_version, CONTRACT_VERSION);
  assert.deepEqual(artifact.files, ARTIFACT_FILES);
  for (const file of ARTIFACT_FILES) {
    assert.match(artifact.digests[file], /^[0-9a-f]{64}$/, file);
  }
});

test("every invariant has exactly one owning test and no test owns two", () => {
  const { artifacts } = loadContracts();
  const invariants = artifacts["invariants.json"].invariants;
  const owners = Object.values(invariants).map((i) => i.owning_test);
  assert.equal(Object.keys(invariants).length, 20);
  assert.equal(new Set(owners).size, owners.length, "an owning test id is reused");
  const tests = artifacts["capabilities.json"].tests;
  for (const owner of owners) assert.ok(tests[owner], `unknown owning test ${owner}`);
});

test("manifest load fails closed on a future major even when min_host is satisfied", () => {
  const host = { host_version: "1.4.0", supported_contract_majors: [1] };
  assert.deepEqual(evaluateManifestLoad(host, { contract_version: "2.0.0", min_host: "1.0.0" }), {
    result: "fail_closed",
    rule: "future_major",
  });
  // A host below min_host is INACTIVE, not an error — it activates on upgrade.
  assert.equal(
    evaluateManifestLoad(host, { contract_version: "1.4.0", min_host: "1.5.0" }).result,
    "inactive"
  );
  // Missing and malformed versions both fail closed.
  assert.equal(
    evaluateManifestLoad(host, { contract_version: "1.4", min_host: "1.0.0" }).result,
    "fail_closed"
  );
  assert.equal(
    evaluateManifestLoad(host, { contract_version: "1.4.0", min_host: undefined }).result,
    "fail_closed"
  );
});

test("harness policy blocks mutations but never applies outside a guard scope", () => {
  for (const state of ["missing", "malformed", "future_major", "stale_same_major"]) {
    assert.equal(
      evaluateHarnessPolicy({
        scope: "aios_guard_scope",
        policy_state: state,
        operation: "mutation",
      }).result,
      "block",
      state
    );
    assert.equal(
      evaluateHarnessPolicy({
        scope: "outside_guard_scope",
        policy_state: state,
        operation: "mutation",
      }).result,
      "noop",
      state
    );
  }
  assert.equal(
    evaluateHarnessPolicy({
      scope: "aios_guard_scope",
      policy_state: "stale_same_major",
      operation: "read",
    }).result,
    "warn"
  );
});

test("private, loopback and link-local provider hosts are rejected", () => {
  for (const host of [
    "localhost",
    "api.localhost",
    "dev.local",
    "127.0.0.1",
    "10.0.0.5",
    "172.16.4.9",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "239.1.1.1",
  ]) {
    assert.equal(isPrivateHost(host), true, host);
  }
  for (const host of ["api.linear.app", "api.clickup.com", "8.8.8.8"]) {
    assert.equal(isPrivateHost(host), false, host);
  }
});

test("resolvePointer returns undefined rather than throwing on a missing path", () => {
  const doc = { identity: { stable_external_id: true }, list: [1, 2] };
  assert.equal(resolvePointer(doc, "/identity/stable_external_id"), true);
  assert.equal(resolvePointer(doc, "/list/1"), 2);
  assert.equal(resolvePointer(doc, "/identity/missing"), undefined);
  assert.equal(resolvePointer(doc, "/nope/deeper"), undefined);
});

test("the validator fails when a contract invariant is corrupted", () => {
  // Proving the gate can actually fail: give two invariants the same owning test and the
  // one-owner-per-test rule must catch it.
  const { artifacts } = loadContracts();
  const capabilities = artifacts["capabilities.json"];
  const invariants = structuredClone(artifacts["invariants.json"]);
  invariants.invariants["INT-002"].owning_test = invariants.invariants["INT-001"].owning_test;

  const failures = [];
  checkInvariants(invariants, capabilities, (message) => failures.push(message));
  assert.ok(
    failures.some((f) => f.includes("one owner per test")),
    `expected a duplicate-owner failure, got ${JSON.stringify(failures)}`
  );
});

test("a declared capability may not be skipped, even in an otherwise passing suite", () => {
  const { artifacts } = loadContracts();
  const capabilities = artifacts["capabilities.json"];

  const clean = loadFixture("evidence/pass.valid.json");
  assert.deepEqual(findSkippedDeclaredCapabilities(clean, capabilities), []);

  const offending = loadFixture("evidence/pass.invalid-skipped-declared-capability.json");
  const offences = findSkippedDeclaredCapabilities(offending, capabilities);
  assert.equal(offences.length, 1);
  assert.equal(offences[0].capability, "pm.work_item.read");
  assert.equal(offences[0].test, "pm.work-item-read");
});

test("manifest rule ids are unique and a conformant manifest produces no findings", () => {
  assert.equal(new Set(MANIFEST_RULE_IDS).size, MANIFEST_RULE_IDS.length);
  const { artifacts } = loadContracts();
  const linear = loadFixture("manifest/linear.valid.json");
  assert.deepEqual(evaluateManifest(linear, artifacts["capabilities.json"]), []);
});
