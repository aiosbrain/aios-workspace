import { extractConnectorRepo } from "../../connector-invocation.mjs";
import { parseLinearActivityArgs } from "./activity-args.mjs";
import { parseLinearQueryArgs } from "./query-args.mjs";

function helpRequested(rest) {
  const isHelp = (value) => value === "--help" || value === "-h";
  if (rest.length === 2 && isHelp(rest[1])) return true;
  const arity =
    {
      "export-desc": 2,
      "verify-desc": 2,
      "set-desc": 2,
      "patch-desc": 2,
      "set-title": 2,
      "set-state": 2,
      "set-priority": 2,
      comment: 2,
      blocks: 2,
      related: 2,
      "remove-relation": 3,
      "set-project": 2,
      "set-parent": 2,
      "add-label": 2,
      assign: 2,
      get: 1,
      comments: 1,
      list: 1,
      relations: 1,
      projects: 1,
      "create-project": 1,
      template: 1,
      create: 1,
      users: 1,
      query: 1,
    }[rest[0]] ?? 0;
  const valueFlags = new Set([
    "--desc",
    "--template",
    "--label",
    "--state",
    "--parent",
    "--assignee",
    "--project",
    "--priority",
    "--team",
    "--missing-label",
    "--vars",
    "--repo",
    "--tier",
    "--activity-path",
  ]);
  let operands = 0;
  for (let i = 1; i < rest.length; i++) {
    if (valueFlags.has(rest[i])) {
      i++;
      continue;
    }
    if (operands < arity) {
      operands++;
      continue;
    }
    if (isHelp(rest[i])) return true;
  }
  return false;
}

export function prepareLinearInvocation(argv) {
  const verb = argv[0];
  const literal = new Set([
    "comment",
    "set-title",
    "export-desc",
    "verify-desc",
    "set-desc",
    "patch-desc",
  ]);
  const valueFlags = new Set([
    "--desc",
    "--template",
    "--label",
    "--state",
    "--parent",
    "--assignee",
    "--project",
    "--priority",
    "--team",
    "--missing-label",
    "--vars",
    "--tier",
    "--activity-path",
  ]);
  const selected = extractConnectorRepo(argv.slice(1), {
    valueFlags,
    literalPositions: literal.has(verb) ? new Set([1]) : new Set(),
  });
  const rest = Object.freeze([verb, ...selected.argv]);
  const help = !verb || ["help", "--help", "-h"].includes(verb) || helpRequested(rest);
  return Object.freeze({
    argv: rest,
    repoArg: selected.repoArg,
    help,
    activity: !help && verb === "activity" ? parseLinearActivityArgs(rest.slice(1)) : undefined,
    query: !help && verb === "query" ? parseLinearQueryArgs(rest.slice(1)) : undefined,
  });
}
