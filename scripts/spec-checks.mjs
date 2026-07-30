/**
 * spec-checks.mjs — barrel for the deterministic (zero-LLM) spec-readiness layer: rubric
 * loading/resolution, spec text/path helpers, and the structural SR checks.
 *
 * Extracted from scripts/spec-eval.mjs (AIO-594, devtools-lane decoupling): spec-eval.mjs is in
 * the devtools path set moving to the aios-devtools repo, while this layer stays in
 * aios-workspace core — scripts/spec-author.mjs (core) consumes it directly, and spec-eval.mjs
 * re-exports this surface for back-compat. Per boundary rule R1, files outside
 * scripts/spec-checks/ import ONLY through this barrel.
 */

export { DEFAULT_FIX_BUDGET, loadRubric, resolveRubricPath } from "./spec-checks/rubric.mjs";
export {
  extractSections,
  looksObservable,
  touchesSyncSurface,
  findReferencedPaths,
  classifyPathContext,
} from "./spec-checks/spec-text.mjs";
export {
  DETERMINISTIC_CHECK_IDS,
  SR17_TASK_LIMIT,
  SR17_SURFACE_LIMIT,
  assessScopeBound,
  runDeterministicChecks,
} from "./spec-checks/deterministic.mjs";

// Max parallel model calls in a spec batch (shared by `aios spec eval --batch` and the
// spec-author fan-out).
export const SPEC_BATCH_CONCURRENCY_MAX = 8;
