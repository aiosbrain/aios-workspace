/**
 * update/vendor-apply.mjs — the `--vendor-apply-only` child entrypoint, extracted verbatim
 * from scripts/update.mjs (AIO-1072 size discipline). See the function docblock for the
 * invariant it owns; update.mjs dispatches here before anything else in cmdUpdateInner.
 */
import path from "node:path";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { c, UpdateError } from "../cli-common.mjs";
import { VERSION_FILE, managedPathsForConfig, pmToolPrunable } from "../toolkit-manifest.mjs";
import { printMergeReport } from "./report.mjs";
import { toolkitMeta } from "../toolkit-meta.mjs";
import { installWorktreeSafetyBackstops } from "../worktree.mjs";
import { assertGitToolkitSource } from "../toolkit-pull.mjs";
import { dirtyManagedPaths, assertDestPathSafe, plannedDestRels } from "./manifest-walk.mjs";
import { vendorSafety, vendorSafetyReason, mergeManaged } from "./merge.mjs";
import { readStampBaseSha } from "./stamp.mjs";
import { isDistributionRoot } from "../cli.mjs";
import { chooseBaseResolver, recordRollbackIfUpgrading, writeV2State } from "./registry-root.mjs";
import { argValue, gitSha, buildResult } from "./flow-common.mjs";

/**
 * `--vendor-apply-only <srcDir=snapshot> --repo <repo> [--force]` — the structurally
 * non-recursive vendor step. Has NO hand-off logic anywhere in it: it cannot spawn a
 * child, so there is nothing for an ambient environment variable or a stray flag to
 * confuse — the old `AIOS_UPDATE_VENDOR_CHILD` recursion guard this replaces is deleted
 * entirely, not hardened. `srcDir` is always the caller's pinned, immutable snapshot
 * (never the live, mutable toolkit checkout), so `vendorSafety` here is the authoritative,
 * TOCTOU-immune final gate — nothing can change under it between this check and the
 * writes that follow.
 */
export async function cmdVendorApplyOnly(repo, cfg, args) {
  const color = c;
  const srcDir = argValue(args, "--from");
  if (!srcDir || !isDistributionRoot(srcDir)) {
    throw new UpdateError(
      `--vendor-apply-only requires --from pointing at a valid toolkit checkout — got ${srcDir}.`
    );
  }
  const stampSource = argValue(args, "--stamp-source");
  if (!stampSource || /[\r\n]/.test(stampSource)) {
    throw new UpdateError("--vendor-apply-only requires a single-line --stamp-source value.");
  }
  // The envelope gate must hold on THIS entry path too: --vendor-apply-only is dispatched
  // before resolveSource and never calls pullToolkitCheckout, so without its own assert a
  // toolkit-shaped non-git dir nested in another repository would sail through — and
  // worse than sailing through: gitSha/vendorSafety's git calls resolve the ENCLOSING
  // repo, so the apply would vendor from the copy but stamp the workspace with a FOREIGN
  // repo's HEAD as the future 3-way merge base (silent, compounding corruption). The
  // internal hand-off always passes the pinned snapshot (a real git worktree), which
  // passes this trivially.
  assertGitToolkitSource(srcDir);
  const force = args.includes("--force");
  const managedPaths = managedPathsForConfig(cfg);
  const vs = vendorSafety(srcDir, managedPaths);
  if (!vs.safe) {
    throw new UpdateError(
      `the pinned toolkit snapshot has unresolved conflicts — ${vendorSafetyReason(vs)}.\n` +
        `  Refusing to vendor conflict markers into your workspace.`
    );
  }
  const sha = gitSha(srcDir); // srcDir IS the pinned snapshot — this trivially equals the pinned sha
  const meta = toolkitMeta(srcDir); // unmodified — reads the snapshot's own frozen files
  assertDestPathSafe(repo, VERSION_FILE, "write version stamp");
  // gen-catalog (spawned below) writes these fixed destinations with no containment checks
  // of its own — assert them here, at the same chokepoint as every other managed write, so
  // a symlinked catalog destination is refused before anything is written.
  for (const rel of [".claude/skills/INDEX.md", ".claude/INTEGRATIONS.md", "RESOLVER.md"])
    assertDestPathSafe(repo, rel, "regenerate catalog");
  const baseSha = readStampBaseSha(repo);
  // PRE-FLIGHT containment scan over the COMPLETE write+delete set — all-or-nothing.
  // plannedDestRels enumerates everything the apply below could touch (managed + seed
  // writes, conflict sidecars, upstream-deletion targets) via the same helpers the write
  // loop itself calls, so the scan can't cover a different set than the loop touches. The
  // per-file asserts inside mergeManaged remain as a backstop, but they fire mid-write-
  // loop: one bad destination there would leave every earlier file already vendored (a
  // partial apply with no stamp). Refusing up front, before the first write, keeps a
  // symlinked/escaping destination from ever producing a half-applied workspace.
  const prunablePaths = pmToolPrunable(cfg);
  // Base resolver policy (AIO-635 Decision 1): a format-2 stamp resolves bases from the
  // workspace's own content-addressed store; gitShow against the snapshot's history is the
  // v1-stamped fallback. Same resolver drives the pre-flight scan AND the merge below.
  const resolver = chooseBaseResolver(repo, srcDir, baseSha);
  for (const destRel of plannedDestRels(srcDir, resolver, managedPaths, prunablePaths))
    assertDestPathSafe(repo, destRel);
  const dirty = force ? new Set() : dirtyManagedPaths(repo, managedPaths);
  const shortSha = sha.slice(0, 12);
  console.log(color.dim(`  syncing toolkit ${meta.label} from ${stampSource} (${shortSha}) …`));
  // Exact prior-package record BEFORE the first mutating step (AIO-635 Decision 5) —
  // only ever written while the workspace is still on stamp format 1.
  await recordRollbackIfUpgrading(repo, { packageRoot: srcDir });
  const r = mergeManaged(srcDir, srcDir, repo, baseSha, {
    dirty,
    force,
    dryRun: false,
    managedPaths,
    prunablePaths,
    resolver,
  });

  // Regenerate the derived catalogs from the just-synced skills so INDEX.md,
  // INTEGRATIONS.md, and RESOLVER.md's generated block never drift after an update.
  // A snapshot without the script ships no catalogs to regenerate — skip. A script that
  // RAN and FAILED is an incomplete apply: recorded, and the stamp write below is skipped
  // so `--check` keeps reporting the workspace behind until a re-run succeeds.
  const catalogScript = path.join(srcDir, "scripts", "gen-catalog.mjs");
  let catalogFailed = false;
  if (existsSync(catalogScript)) {
    try {
      execFileSync(process.execPath, [catalogScript, "--repo", repo], { stdio: "inherit" });
    } catch {
      catalogFailed = true;
      console.warn(
        color.yellow("  gen-catalog failed — catalogs may be stale; fix and re-run `aios update`.")
      );
    }
  }

  const changedCount = printMergeReport(color, r);

  if (r.conflicts.length) {
    // Leave the stamp at the old base so a re-run re-surfaces the conflicts once resolved.
    // This is a NORMAL outcome of local customization (a workspace edit conflicting with
    // the toolkit's incoming change) — not the same as vendorSafety's hard refusal above
    // (which means the SOURCE toolkit itself is broken) — exitStatus stays 0.
    console.warn(
      color.yellow(
        `  resolve the conflict(s) and re-run \`aios update\` — version stays pinned at ${(
          baseSha || "(none)"
        ).slice(0, 12)} until then.`
      )
    );
    return buildResult({
      mode: "vendor-apply-only",
      exitStatus: 0,
      applied: true,
      changedCount,
      vendorSafety: vs,
      reasons: [`${r.conflicts.length} conflict(s) — not applied for those files`],
    });
  }

  if (catalogFailed) {
    // Same honesty model as conflicts: an incomplete apply is never stamped — a fresh
    // stamp would make `--check` report "up to date" over drifted catalogs forever.
    console.warn(
      color.yellow(
        `  catalogs were not regenerated — version stays pinned at ${(baseSha || "(none)").slice(0, 12)} until a re-run succeeds.`
      )
    );
    return buildResult({
      mode: "vendor-apply-only",
      exitStatus: 0,
      applied: true,
      changedCount,
      vendorSafety: vs,
      reasons: ["catalog regeneration failed — version not stamped; re-run `aios update`"],
    });
  }

  // Decision-1 write ordering: managed files (above) → base-store entries → index →
  // stamp LAST, all atomic — an interruption leaves the old stamp/index intact and the
  // next run re-derives the same plan. Always writes stamp format 2 (one-way ratchet),
  // including for --from <checkout> sources. The stamp destination is asserted safe above.
  await writeV2State(repo, {
    srcDir,
    sha,
    meta,
    stampSource,
    managedPaths,
    packageVersion: meta.version,
  });
  // AIO-482: restore machine-local worktree hooks after an update. Personal workspaces receive
  // post-checkout hydration only; the public product repo also restores its commit/push
  // backstops because it carries scripts/leak-gate.sh. Never fails an update.
  installWorktreeSafetyBackstops(repo, { quiet: true, productOnly: true });
  if (changedCount) {
    console.log(
      color.green(
        `  toolkit synced to ${meta.label} (${shortSha}) — ${changedCount} file(s) changed.`
      )
    );
    console.log(color.dim("  Review + commit these on your workspace's master branch."));
  } else {
    console.log(color.green(`  already up to date — ${meta.label} (${shortSha}).`));
  }
  return buildResult({
    mode: "vendor-apply-only",
    exitStatus: 0,
    applied: true,
    changedCount,
    vendorSafety: vs,
  });
}
