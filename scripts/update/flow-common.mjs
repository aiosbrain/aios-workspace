/**
 * update/flow-common.mjs — the pieces every `aios update` flow half shares: the structured
 * result builder (the ONE derivation of `applyAllowed`), the sha reader that feeds the
 * stamp, and the flag-value helper. Extracted from scripts/update.mjs (AIO-1072 size
 * discipline); no logic changed. update.mjs re-exports `gitSha` so existing importers
 * (context-health) keep their import path.
 */
import { execFileSync } from "node:child_process";
import { gitEnv } from "../cli-common.mjs";
import { REMOTE_APPLY_ALLOW_STATES } from "../toolkit-pull.mjs";

export function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export function gitSha(dir) {
  try {
    // Full sha (not --short): the version stamp is a merge base for future syncs,
    // and a full sha survives shallow/ephemeral clones where short shas can collide.
    // gitEnv(): an inherited GIT_DIR would make this report ANOTHER repo's HEAD — and
    // this sha becomes the workspace's stamped 3-way merge base.
    return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
      encoding: "utf8",
      env: gitEnv(),
    }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * Build the structured result every `cmdUpdate` mode returns (replaces the old bare
 * 0/1). `applyAllowed` is derived, not caller-supplied, so it can't drift from the
 * individual signals it's computed from: blocked by a non-fast-forward/uninspectable
 * remote, a dirty/uninspectable source, or an unsafe vendor result.
 */
export function buildResult({
  mode,
  exitStatus,
  remoteState = null,
  sourceClean = null,
  vendorSafety: vs = null,
  srcHead = null,
  applied = false,
  changedCount = 0,
  reasons = [],
}) {
  // ALLOWLIST, not a blocklist — and the ONE allowlist: REMOTE_APPLY_ALLOW_STATES is
  // exported by toolkit-pull.mjs beside the classifier that owns the vocabulary, and
  // pullToolkitCheckout's apply-mode refusals gate on the same constant, so a future
  // classifier state blocks by construction at every gate at once and the two files can
  // never drift.
  const remoteBlocks = remoteState ? !REMOTE_APPLY_ALLOW_STATES.includes(remoteState.state) : false;
  // "immutable" is a registry root (AIO-635 Decision 3): no working tree to be dirty,
  // allowed by construction — the only green states are these two.
  const sourceBlocks = sourceClean != null && !["clean", "immutable"].includes(sourceClean);
  const vendorBlocks = vs != null && !vs.safe;
  // mode === "error" is cmdUpdate's outer catch converting a thrown UpdateError into a
  // result — none of the other three signals were ever computed, so they default to
  // non-blocking and would otherwise leave applyAllowed silently true after a failed
  // check/preview. When we couldn't even evaluate whether it's safe, never default to
  // "allowed". The same principle covers a FAILED apply: a vendor child that died without
  // writing its result file leaves vendorSafety null (non-blocking) while remoteState/
  // sourceClean are green — the pre-flight signals were fine, but the apply itself failed,
  // and `applyAllowed: true` on a failed apply would lie to every programmatic caller
  // reading the documented `.applyAllowed` contract.
  const errorBlocks = mode === "error" || (mode === "apply" && exitStatus !== 0);
  // …and the same principle one more time, generalized: a result whose safety signals
  // were ALL never computed (remote, cleanliness, vendor safety) must not read as allowed
  // — whatever branch produced it evaluated nothing. Deliberately NOT gated on a mode
  // list: a mode list is a blocklist in disguise, and a future mode string missing from
  // it would read applyAllowed:true from nothing — the exact fail-open this clause
  // exists to close. All-null signals fail closed for every mode, present and future.
  // `contribute` is not an apply at all (it pushes a PR), so its result never advertises
  // apply permission.
  const unevaluated = remoteState == null && sourceClean == null && vs == null;
  const nonApplyMode = mode === "contribute";
  return {
    exitStatus,
    mode,
    remoteState,
    sourceClean,
    vendorSafety: vs,
    srcHead,
    applyAllowed:
      !remoteBlocks &&
      !sourceBlocks &&
      !vendorBlocks &&
      !errorBlocks &&
      !unevaluated &&
      !nonApplyMode,
    applied,
    changedCount,
    reasons,
  };
}
