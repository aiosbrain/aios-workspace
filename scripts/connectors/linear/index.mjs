/**
 * The built-in Linear adapter behind `aios linear <verb>` (AIO-1067).
 *
 * This module is loaded LAZILY through the scripts/connectors.mjs barrel — `aios help`,
 * `version`, `doctor`, `provenance`, and every non-Linear command never import it, so a
 * broken adapter is quarantined to its own command surface.
 *
 * VERBS is the command-parity matrix: every canonical verb, the module that implements it,
 * and whether it needs a provider credential. test/linear-command-parity.test.mjs pins it
 * against the legacy CLI surface, so a verb cannot silently drop out of the canonical route.
 */
import { createOutput, normalizeError } from "../../cli.mjs";
import { ensureLinearCredential, findLinearBase } from "./credentials.mjs";
import { linearUsage, runLinearVerb } from "./verbs.mjs";

/** verb → { module, credential } — the canonical Linear command surface. */
export const VERBS = Object.freeze({
  get: { module: "scripts/connectors/linear/core.mjs", credential: true },
  "export-desc": { module: "scripts/connectors/linear/verbs.mjs", credential: true },
  "verify-desc": { module: "scripts/connectors/linear/verbs.mjs", credential: true },
  "set-desc": { module: "scripts/connectors/linear/desc-guard.mjs", credential: true },
  "patch-desc": { module: "scripts/connectors/linear/template.mjs", credential: true },
  "set-title": { module: "scripts/connectors/linear/verbs.mjs", credential: true },
  "set-state": { module: "scripts/connectors/linear/pagination.mjs", credential: true },
  "set-priority": { module: "scripts/connectors/linear/core.mjs", credential: true },
  comment: { module: "scripts/connectors/linear/verbs.mjs", credential: true },
  comments: { module: "scripts/connectors/linear/pagination.mjs", credential: true },
  list: { module: "scripts/connectors/linear/list.mjs", credential: true },
  relations: { module: "scripts/connectors/linear/core.mjs", credential: true },
  blocks: { module: "scripts/connectors/linear/core.mjs", credential: true },
  related: { module: "scripts/connectors/linear/core.mjs", credential: true },
  "remove-relation": { module: "scripts/connectors/linear/core.mjs", credential: true },
  "set-project": { module: "scripts/connectors/linear/core.mjs", credential: true },
  projects: { module: "scripts/connectors/linear/projects.mjs", credential: true },
  "create-project": { module: "scripts/connectors/linear/projects.mjs", credential: true },
  "set-parent": { module: "scripts/connectors/linear/verbs.mjs", credential: true },
  "add-label": { module: "scripts/connectors/linear/pagination.mjs", credential: true },
  template: { module: "scripts/connectors/linear/template.mjs", credential: false },
  create: { module: "scripts/connectors/linear/create.mjs", credential: true },
  users: { module: "scripts/connectors/linear/core.mjs", credential: true },
  assign: { module: "scripts/connectors/linear/core.mjs", credential: true },
  query: { module: "scripts/connectors/linear/query.mjs", credential: true },
  activity: { module: "scripts/connectors/linear/activity.mjs", credential: true },
  status: { module: "scripts/connectors/linear/setup.mjs", credential: false },
});

/**
 * `aios linear <verb> …`. Returns the exit code (the registry descriptor is exit-code);
 * legacy verb implementations keep their own process.exit(1) on provider failures, so the
 * observable exit status is byte-for-byte what the pre-AIO-1067 CLI produced.
 */
export async function cmdLinear(repo, rest, options = {}) {
  const verb = rest[0];
  const output = createOutput(options);
  // The dispatch-resolved workspace root governs credential AND template resolution, so a
  // subdirectory invocation behaves exactly like a root one; the compat bin passes no repo
  // and gets the same walk-up (Bugbot round 1).
  const base = repo ?? findLinearBase(options.cwd ?? process.cwd());
  const scoped = { ...options, cwd: base };
  if (!verb || verb === "help" || verb === "--help" || verb === "-h") {
    console.log(linearUsage());
    return 0;
  }
  // AIO-1116: `aios linear <verb> --help` is a HELP request, not a provider call — answer
  // it before credential resolution so an unconfigured machine can still read usage.
  if (rest.slice(1).includes("--help") || rest.slice(1).includes("-h")) {
    console.log(linearUsage());
    return 0;
  }
  if (verb === "status") {
    const { cmdLinearStatus } = await import("./setup.mjs");
    return cmdLinearStatus(rest.slice(1), scoped);
  }
  if (VERBS[verb]?.credential) {
    try {
      await ensureLinearCredential(scoped);
    } catch (error) {
      return output.failure(normalizeError(error));
    }
  }
  return runLinearVerb(rest, base);
}
