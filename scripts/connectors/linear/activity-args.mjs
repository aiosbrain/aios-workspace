import path from "node:path";
import { AiosError } from "../../cli.mjs";

export const DEFAULT_TIER = "admin";
const VALUE_FLAGS = new Map([
  ["--repo", "repo"],
  ["--tier", "tier"],
  ["--activity-path", "activityPath"],
]);
const usage = (message) =>
  new AiosError(
    "AIOS_E_USAGE",
    message,
    "Usage: aios linear activity [pull] [--repo PATH] [--tier admin|team|external] [--activity-path PATH] [--dry-run]"
  );

/** Parse the complete activity request before credentials or provider access. */
export function parseLinearActivityArgs(argv, baseDir = process.cwd()) {
  const rest = argv[0] === "pull" ? argv.slice(1) : argv;
  const result = { repo: baseDir, tier: DEFAULT_TIER, activityPath: null, dryRun: false };
  const seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (seen.has(flag)) throw usage(`duplicate activity option ${flag}`);
    seen.add(flag);
    if (flag === "--dry-run") {
      result.dryRun = true;
      continue;
    }
    const key = VALUE_FLAGS.get(flag);
    if (!key) throw usage(`unknown activity argument ${flag}`);
    const value = rest[++i];
    if (!value || value.startsWith("-")) throw usage(`${flag} requires a value`);
    result[key] = value;
  }
  if (!["admin", "team", "external"].includes(result.tier))
    throw usage("--tier must be admin|team|external");
  result.repo = path.resolve(result.repo);
  return Object.freeze(result);
}
