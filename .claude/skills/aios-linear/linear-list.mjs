// List command for the aios-linear CLI (AIO-999), extracted from linear.mjs to keep that
// file under the file-size gate. Dispatch stays in linear.mjs; the behaviour lives here.
import { filterIssues, hasListFilters, listTeamIssues, parseListArgs } from "./linear-core.mjs";

/**
 * One stable stdout row: identifier/state/title always occupy the first three tab-separated
 * columns; the {labels} column is appended as a TRAILING column only when filters are on.
 * Downstream parsers (workstream-update.mjs) tab-split on ident/state/title — never insert
 * a column between them.
 */
export function formatListRow(issue, showLabels) {
  const base = `${issue.identifier}\t[${issue.state?.name}]\t${issue.title}`;
  if (!showLabels) return base;
  const labels = (issue.labels?.nodes ?? []).map((label) => label.name).join(",");
  return `${base}\t{${labels}}`;
}

export async function cmdList(argv) {
  const { teamKey, filters } = parseListArgs(argv.slice(1));
  const filtered = filterIssues(await listTeamIssues(teamKey), filters);
  const showLabels = hasListFilters(filters);
  for (const issue of filtered.sort((a, b) =>
    a.identifier.localeCompare(b.identifier, undefined, { numeric: true })
  )) {
    console.log(formatListRow(issue, showLabels));
  }
  // The queue-query denominator. Printed to stderr so stdout stays row-shaped for parsers.
  if (showLabels) console.error(`count: ${filtered.length}`);
}
