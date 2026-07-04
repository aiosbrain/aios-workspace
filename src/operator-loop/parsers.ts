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

// AM1/AEM engine (AIO-144): the maturity source reuses the SAME store fold + placement the
// brief (AM2) and weekly report (AM6) use — never a re-implementation. Store constants are
// renamed on re-export (their .mjs names are module-scoped generics like STORE_REL).
export {
  foldSessions,
  STORE_REL as MATURITY_STORE_REL,
} from "../../scripts/analyze/maturity-store.mjs";
export {
  foldSignals,
  projectSlug,
  STORE_SIZE_CAP as MATURITY_STORE_SIZE_CAP,
} from "../../scripts/analyze/maturity-fold.mjs";
export { placement } from "../../scripts/analyze/aem.mjs";

export type { Frontmatter, DecisionRow } from "../../scripts/workspace-parse.mjs";
export type { TaskRow } from "../../scripts/tasks-table.mjs";
export type { MaturitySession } from "../../scripts/analyze/maturity-store.mjs";
export type { AemPlacement } from "../../scripts/analyze/aem.mjs";
