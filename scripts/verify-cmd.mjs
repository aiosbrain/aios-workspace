/**
 * verify-cmd.mjs — the default repo verify chain, shared by `aios ship` (scripts/ship/runtime.mjs,
 * which runs it in the worktree before each review round and pre-merge) and `aios simplify`
 * (scripts/simplify.mjs, which re-runs it after behavior-preserving cleanups).
 *
 * This constant lives in its own tiny core module — NOT in scripts/ship/ — so core-staying
 * commands (simplify) never import from the devtools path set (ship.mjs, scripts/ship/, build.mjs,
 * roadmap-run.mjs, spec-eval.mjs, spec-publish.mjs, consolidate-findings.mjs) that is moving to
 * the aios-devtools repo (AIO-594). ship.mjs keeps re-exporting SHIP_VERIFY_CMD (via
 * scripts/ship/runtime.mjs) so existing call sites are unchanged.
 */
export const SHIP_VERIFY_CMD =
  "npm run build:loop && npm test && npm run lint && npm run format:check";
