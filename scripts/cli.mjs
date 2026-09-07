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
