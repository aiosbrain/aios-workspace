import path from "node:path";
import { AiosError } from "./cli.mjs";

const usage = (message) =>
  new AiosError(
    "AIOS_E_USAGE",
    message,
    "Place one --repo PATH (or --repo=PATH) after the verb's arguments."
  );

/** Pure workspace-selector parsing. Values owned by other flags/operands remain data. */
export function extractConnectorRepo(
  argv,
  { valueFlags = new Set(), literalPositions = new Set() } = {}
) {
  const rest = [];
  let repoArg = null,
    operand = 0;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (valueFlags.has(arg)) {
      rest.push(arg);
      if (i + 1 < argv.length) rest.push(argv[++i]);
      continue;
    }
    if (literalPositions.has(operand)) {
      rest.push(arg);
      operand++;
      continue;
    }
    if (arg === "--repo" || arg.startsWith("--repo=")) {
      if (repoArg !== null) throw usage("duplicate --repo option");
      const value = arg === "--repo" ? argv[++i] : arg.slice(7);
      if (!value || value.startsWith("-")) throw usage("--repo requires a path, not an option");
      repoArg = path.resolve(value);
      continue;
    }
    rest.push(arg);
    if (!arg.startsWith("-")) operand++;
  }
  return { argv: Object.freeze(rest), repoArg };
}
