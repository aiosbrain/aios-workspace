#!/usr/bin/env node
/**
 * Integration Framework v1 contract validator (AIO-835 Phase 0).
 *
 * `npm run integration:contracts:validate` — the Phase 0 exit gate. It proves the six
 * normative contract artifacts under `packages/integration-sdk/contracts/v1/` are
 * internally consistent, that every declared invariant has exactly one owning test, that
 * the compatibility truth table is reproducible by a reference evaluator, and that every
 * Linear and ClickUp fixture passes or fails for exactly the declared reason. It then emits
 * the canonical-JSON digest artifact that downstream repositories pin.
 *
 * This is a data-integrity gate on the CONSTITUTION, not on any connector implementation.
 * No adapter exists yet at Phase 0 — that is the point: the contract has to be provably
 * coherent before anything is written against it.
 *
 * Barrel for `scripts/integration-contracts/` (boundary rule R1): consumers import this
 * file, never the directory's modules directly.
 */
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadContracts,
  ARTIFACT_FILES,
  CONTRACT_VERSION,
  REPO_ROOT,
} from "./integration-contracts/load.mjs";
import {
  checkContractVersions,
  checkInvariants,
  checkSchemaHygiene,
  checkTaxonomy,
} from "./integration-contracts/taxonomy.mjs";
import { checkCompatibility } from "./integration-contracts/compat.mjs";
import {
  checkEvidenceCoverage,
  checkEvidenceDigestParity,
  checkEvidenceSkipRule,
  checkFixtureIndexParity,
  checkOutcomeClassRule,
  checkOutcomeCoverage,
  compileSchemas,
  loadIndex,
  runDocumentFixtures,
  runManifestFixtures,
} from "./integration-contracts/fixtures.mjs";

export const DIGEST_ARTIFACT_DIR = path.join(REPO_ROOT, "reports", "integration");
export const DIGEST_ARTIFACT_PATH = path.join(
  DIGEST_ARTIFACT_DIR,
  "integration-contract-v1-digests.json"
);

/**
 * Run every contract check. Returns `{ failures, digests }`; the caller decides whether to
 * write the artifact and how to report. Pure enough to be driven from a test.
 */
export function validateContracts() {
  const failures = [];
  const fail = (message) => failures.push(message);

  const { artifacts, digests } = loadContracts();
  const capabilities = artifacts["capabilities.json"];

  checkContractVersions(artifacts, fail);
  checkSchemaHygiene(artifacts, fail);
  checkTaxonomy(capabilities, fail);
  checkInvariants(artifacts["invariants.json"], capabilities, fail);
  checkCompatibility(artifacts["compatibility.json"], fail);

  const validators = compileSchemas(artifacts);
  const index = loadIndex();
  if (index.contract_version !== CONTRACT_VERSION) {
    fail(
      `fixtures: index.json contract_version is ${index.contract_version}, expected ${CONTRACT_VERSION}`
    );
  }
  checkFixtureIndexParity(index, fail);
  runManifestFixtures(index, capabilities, validators.manifest, fail);
  runDocumentFixtures(index.outcomes, validators.outcomes, "outcome", fail);
  runDocumentFixtures(index.evidence, validators.evidence, "evidence", fail);
  checkOutcomeCoverage(index, artifacts, fail);
  checkOutcomeClassRule(index, capabilities, fail);
  checkEvidenceCoverage(index, fail);
  checkEvidenceSkipRule(index, capabilities, fail);
  checkEvidenceDigestParity(index, digests, fail);

  return { failures, digests, index };
}

/** The digest artifact downstream repositories pin. Canonical JSON, so formatting-stable. */
export function buildDigestArtifact(digests) {
  return {
    artifact: "integration-contract-v1-digests",
    contract_version: CONTRACT_VERSION,
    digest_algorithm: "sha256",
    digest_input:
      "RFC 8785-style canonical JSON (recursively key-sorted, no insignificant whitespace)",
    contract_dir: "packages/integration-sdk/contracts/v1",
    files: ARTIFACT_FILES,
    digests,
  };
}

function main() {
  // Remove any artifact from a previous run BEFORE validating. Simply not writing on failure
  // would leave the last successful run's digests on disk, and a consumer reading the file
  // after a failed run would pin digests that no longer describe the contract.
  rmSync(DIGEST_ARTIFACT_PATH, { force: true });

  const { failures, digests, index } = validateContracts();

  if (failures.length > 0) {
    console.error(`integration contracts v1: ${failures.length} failure(s)\n`);
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    console.error("\nNo digest artifact was written. Fix the contract, then re-run.");
    process.exitCode = 1;
    return;
  }

  mkdirSync(DIGEST_ARTIFACT_DIR, { recursive: true });
  writeFileSync(DIGEST_ARTIFACT_PATH, JSON.stringify(buildDigestArtifact(digests), null, 2) + "\n");

  const fixtureCount = index.manifest.length + index.outcomes.length + index.evidence.length;
  console.log(`integration contracts v1 — OK (contract_version ${CONTRACT_VERSION})`);
  console.log(`  ${ARTIFACT_FILES.length} normative artifacts, ${fixtureCount} fixtures replayed`);
  for (const file of ARTIFACT_FILES) console.log(`  ${digests[file]}  ${file}`);
  console.log(`\ndigest artifact → ${path.relative(REPO_ROOT, DIGEST_ARTIFACT_PATH)}`);
}

/**
 * Whether this module was run directly, rather than imported by a test.
 *
 * NOT `import.meta.url === `file://${process.argv[1]}``; see the same guard in
 * scripts/ci-changed-lanes.mjs for the full reasoning. That form compares an ENCODED url
 * against an UNENCODED path (one space in the checkout path breaks it) and compares a
 * symlink-resolved url against an unresolved path (macOS /var -> /private/var breaks it).
 * Both failures are silent and both fail the same way: `main()` never runs, nothing is
 * validated, no artifact is written, and the process still exits 0 — a gate that reports
 * success without checking anything. Comparing realpaths on both sides is immune to both.
 */
function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isDirectRun()) main();
