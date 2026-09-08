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
import path from "node:path";
import { AiosError, createOutput, normalizeError } from "../../cli.mjs";
import { ensureLinearCredential, findLinearBase } from "./credentials.mjs";
import { prepareLinearInvocation as parseInvocation } from "./invocation.mjs";
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

// Required positional values can themselves be "--help". Beyond those operands,
// recognize help flags while consuming option values just as the verb parsers do.
export function prepareLinearInvocation(argv) {
  const plan = parseInvocation(argv);
  if (!plan.help && !Object.hasOwn(VERBS, plan.argv[0]))
    throw new AiosError("AIOS_E_USAGE", "Unknown Linear verb.", "Run aios linear help.");
  return plan;
}

/**
 * `aios linear <verb> …`. Returns the exit code (the registry descriptor is exit-code);
 * legacy verb implementations keep their own process.exit(1) on provider failures, so the
 * observable exit status is byte-for-byte what the pre-AIO-1067 CLI produced.
 */
export async function cmdLinear(repo, rest, options = {}) {
  const output = createOutput(options);
  let plan;
  try {
    plan = options.invocationPlan ?? prepareLinearInvocation(rest);
  } catch (error) {
    return output.failure(normalizeError(error));
  }
  if (plan.help) {
    console.log(linearUsage());
    return 0;
  }
  rest = plan.argv;
  const verb = rest[0];
  const base = plan.repoArg ?? repo ?? findLinearBase(options.cwd ?? process.cwd());
  const scoped = { ...options, cwd: base };
  if (verb === "status") {
    const { cmdLinearStatus } = await import("./setup.mjs");
    return cmdLinearStatus(rest.slice(1), scoped);
  }
  const activityPlan = plan.activity
    ? Object.freeze({
        ...plan.activity,
        repo: base,
        activityPath: plan.activity.activityPath
          ? path.resolve(base, plan.activity.activityPath)
          : null,
      })
    : undefined;
  if (VERBS[verb]?.credential) {
    try {
      await ensureLinearCredential(scoped);
    } catch (error) {
      return output.failure(normalizeError(error));
    }
  }
  return runLinearVerb(rest, base, { activityPlan, queryPlan: plan.query });
}
