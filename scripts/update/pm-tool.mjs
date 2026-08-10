/**
 * update/pm-tool.mjs — the `pm_tool` seam's update-time behavior (AIO-844).
 *
 * Two things live here, both deliberately out of update.mjs (which is at its size-cap
 * ratchet): the one-time migration write-back, and the wording for the prune report.
 *
 * The GATING itself is not here — it is `managedPathsForConfig`/`pmToolPrunable` in
 * toolkit-manifest.mjs, so the manifest stays the single answer to "what does this workspace
 * get?" and update.mjs consumes it exactly as it already consumed the `ci_workflow` gate.
 */
import { persistScalar } from "../ci-workflow.mjs";
import { PM_TOOL_DEFAULT } from "../toolkit-manifest.mjs";

export const PM_TOOL_KEY = "pm_tool";

/** Shown when a de-selected asset was edited locally and therefore kept. */
export const PRUNE_KEPT_HINT =
  "  Your aios.yaml `pm_tool` no longer selects these, but you have edited them, so they " +
  "were left alone. Delete them by hand once you've salvaged anything you want.";

/**
 * Back-fill `pm_tool` on a workspace scaffolded before the key existed.
 *
 * Gated STRICTLY on the key being ABSENT, so it can fire at most once per workspace: after it
 * writes, the key is present and rule 2 takes over — ANY value already there (hand-set or
 * written by an earlier run of this function; the two are indistinguishable, intentionally) is
 * used as-is and never overwritten. That is what makes an owner's `linear` → `clickup` edit
 * stick across every later `aios update`.
 *
 * A write failure is NOT fatal. Every other managed path still syncs, and because the key is
 * still absent the next run simply re-attempts this same branch — the migration is idempotent
 * by construction, so an interrupted write self-heals instead of needing recovery logic. It
 * must be LOUD, though: a silent skip here is how a workspace ends up permanently relying on
 * an implicit default nobody can see in the file.
 *
 * Mutates `cfg` either way, so the caller's sync decisions in this run use the effective value
 * whether or not the write landed.
 */
export function migratePmTool(repo, cfg, warn) {
  if ((cfg[PM_TOOL_KEY] ?? "") !== "") return { migrated: false };
  cfg[PM_TOOL_KEY] = PM_TOOL_DEFAULT;
  try {
    persistScalar(repo, PM_TOOL_KEY, PM_TOOL_DEFAULT, "PM tool preference");
    return { migrated: true };
  } catch (e) {
    warn(
      `  could not record ${PM_TOOL_KEY} in aios.yaml (${e.message}) — continuing with the ` +
        `${PM_TOOL_DEFAULT} default; the next \`aios update\` will retry.`
    );
    return { migrated: false, error: e };
  }
}
