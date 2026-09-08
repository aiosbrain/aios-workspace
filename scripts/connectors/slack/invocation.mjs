import { extractConnectorRepo } from "../../connector-invocation.mjs";
import { parseVerbArgs, VERB_SPECS } from "./args.mjs";

export function prepareSlackInvocation(argv) {
  let cursor = 0;
  while (argv[cursor] === "--json") cursor++;
  const verb = argv[cursor];
  const spec = Object.hasOwn(VERB_SPECS, verb) ? VERB_SPECS[verb] : null;
  const valueFlags = new Set(
    Object.entries(spec?.flags ?? {})
      .filter(([name, kind]) => name !== "repo" && kind === "value")
      .map(([name]) => `--${name}`)
  );
  const selected = extractConnectorRepo(argv.slice(cursor + 1), { valueFlags });
  const topHelp = !verb || ["help", "--help", "-h"].includes(verb);
  const args =
    !topHelp && spec ? parseVerbArgs([...selected.argv, ...(cursor ? ["--json"] : [])], spec) : {};
  return Object.freeze({
    argv: Object.freeze([...argv]),
    verb,
    repoArg: selected.repoArg,
    args: Object.freeze(args),
    help: topHelp || args.help === true,
    unknown: !topHelp && !spec,
  });
}
