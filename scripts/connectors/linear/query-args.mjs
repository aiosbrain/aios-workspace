import { AiosError } from "../../cli.mjs";
const usage = (message) =>
  new AiosError(
    "AIOS_E_USAGE",
    message,
    "Usage: aios linear query [<graphql>] [--vars <json-object>]"
  );

export function parseLinearQueryArgs(argv) {
  let query = null,
    variables = {},
    seenVars = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--vars") {
      if (seenVars) throw usage("duplicate --vars option");
      seenVars = true;
      const raw = argv[++i];
      if (!raw || raw.startsWith("-")) throw usage("--vars requires a JSON value");
      try {
        variables = JSON.parse(raw);
      } catch {
        throw usage("--vars must be valid JSON");
      }
      if (!variables || typeof variables !== "object" || Array.isArray(variables))
        throw usage("--vars must be a JSON object");
    } else {
      if (argv[i].startsWith("-")) throw usage(`unknown option ${argv[i]}`);
      if (query !== null) throw usage("query accepts one GraphQL document — quote the whole query");
      query = argv[i];
    }
  }
  return Object.freeze({ query, variables: Object.freeze(variables) });
}
