/**
 * cli.mjs — the v2 runtime barrel. `run` is the canonical CLI bootstrap (scripts/aios.mjs);
 * the named contract exports are the shared error/output/config/credential surfaces the
 * built-in adapters consume (R1 allows scripts/cli/** to be reached only through this
 * barrel — scripts/check-boundaries.mjs).
 */
export { AiosError, normalizeError, exitCodeFor } from "./cli/errors.mjs";
export { createOutput } from "./cli/output.mjs";
export { resolveCredentialRoot, redactedCredential } from "./cli/credential-broker.mjs";
export { readUserConfig, resolveUserConfigPath, writeUserConfig } from "./cli/config-broker.mjs";
export { validateDestination, trustedFetch } from "./cli/destination-policy.mjs";
export { run } from "./cli/bootstrap.mjs";
// AIO-635 v2 distribution surfaces (consumed by the update/onboard/locate command set —
// R1 routes every cross-cmd use of scripts/cli/** through this barrel).
export { atomicWrite, snapshotFile, assertNotSymlink } from "./cli/atomic-file.mjs";
export { runMigration, rollbackMigration, MIGRATION_STATES } from "./cli/migration.mjs";
export { classifyInstallType, collectProvenance } from "./cli/provenance.mjs";
export {
  resolveDistributionRoot,
  isDistributionRoot,
  missingDistributionMarkers,
  DISTRIBUTION_MARKERS,
  DISTRIBUTION_PACKAGE,
} from "./cli/distribution-root.mjs";
