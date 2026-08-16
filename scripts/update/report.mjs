/**
 * update/report.mjs — the one renderer for a mergeManaged() result.
 *
 * Extracted from update.mjs (which is at its size-cap ratchet) as pure presentation, alongside
 * the other update/ submodules. It owns no decisions: every category it prints is a list
 * mergeManaged already produced, and `preview` only selects the mode-appropriate wording for
 * a conflict hint. One implementation so the real apply (cmdVendorApplyOnly) and --preview
 * can never drift in what they call things.
 */
import { PRUNE_KEPT_HINT } from "./pm-tool.mjs";

/** Print the merge result and return the number of files that changed (or would). */
export function printMergeReport(color, r, { preview = false } = {}) {
  const report = (label, arr, tone = color.green) => {
    if (!arr.length) return;
    console.log(tone(`  ${label}: ${arr.length}`));
    for (const p of arr.slice(0, 20)) console.log(color.dim(`    ${p}`));
    if (arr.length > 20) console.log(color.dim(`    … and ${arr.length - 20} more`));
  };
  const pruned = r.pruned || [];
  const prunedKept = r.prunedKept || [];
  const retired = r.retired || [];
  const retiredKept = r.retiredKept || [];
  report("created", r.created);
  report("seeded (missing starter files)", r.seeded);
  report("updated", r.updated);
  report("merged (local edits + toolkit changes combined)", r.merged);
  report("removed (deleted upstream)", r.deleted);
  report("removed (withdrawn from the toolkit)", retired);
  report("kept — locally edited, withdrawn from the toolkit", retiredKept, color.yellow);
  if (retiredKept.length) {
    console.warn(
      color.dim(
        "  The toolkit no longer ships these and will not update them again. " +
          "Delete them yourself once you've salvaged anything you want to keep."
      )
    );
  }
  report("removed (not used by this workspace's pm_tool)", pruned);
  report("kept — locally edited, no longer used by this pm_tool", prunedKept, color.yellow);
  if (prunedKept.length) console.warn(color.dim(PRUNE_KEPT_HINT));
  report("skipped — uncommitted local changes", r.skippedDirty, color.yellow);
  if (r.skippedDirty.length) {
    console.warn(
      color.dim(
        "  Commit them (then re-run), `git checkout -- <path>` to take the toolkit version, " +
          "or re-run with --force to overwrite."
      )
    );
  }

  if (r.conflicts.length) {
    console.warn(color.yellow(`  ${r.conflicts.length} conflict(s) — NOT applied:`));
    for (const cf of r.conflicts.slice(0, 20)) {
      const how =
        cf.kind === "merge"
          ? preview
            ? "both sides changed — applying would create .aios-incoming and .aios-merge sidecars"
            : `both sides changed — see ${cf.path}.aios-merge, take ${cf.path}.aios-incoming, or edit in place`
          : cf.kind === "deleted-upstream"
            ? "removed upstream but you modified it — delete it or upstream your change"
            : preview
              ? "no sync baseline — applying would create an .aios-incoming sidecar"
              : `no sync baseline — see ${cf.path}.aios-incoming, or re-run --force if you have no local edits`;
      console.warn(color.dim(`    ✗ ${cf.path} — ${how}`));
    }
    if (r.conflicts.length > 20)
      console.warn(color.dim(`    … and ${r.conflicts.length - 20} more`));
  }

  // A prune or a retirement IS a change to the workspace, so both count — otherwise `aios
  // update` could report "0 files would change" for a run whose only effect is removing the
  // de-selected or withdrawn assets. prunedKept/retiredKept do NOT count: nothing was written.
  return (
    r.created.length +
    r.seeded.length +
    r.updated.length +
    r.merged.length +
    r.deleted.length +
    pruned.length +
    retired.length
  );
}
