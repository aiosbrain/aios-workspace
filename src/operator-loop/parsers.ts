// Single cross-boundary import point: re-export the shared zero-dep .mjs parsers so the
// rest of the TypeScript collector imports them from here. Centralizing the `../../scripts`
// path in one file keeps the relative depth consistent between src/ and the compiled dist/
// (both two levels below the repo root). Types come from the hand-written .d.mts siblings.

export {
  parseFrontmatter,
  normalizeTier,
  classifyKind,
  parseDecisionRows,
} from "../../scripts/workspace-parse.mjs";

export { parseTableRows, parseTaskRows } from "../../scripts/tasks-table.mjs";

export { parseFlatYaml } from "../../scripts/flat-yaml.mjs";

export type { Frontmatter, DecisionRow } from "../../scripts/workspace-parse.mjs";
export type { TaskRow } from "../../scripts/tasks-table.mjs";
