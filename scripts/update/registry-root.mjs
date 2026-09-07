import { withUpdateLock } from "./lock.mjs";
import { prepareV2State, commitV2State } from "./state-plan.mjs";
/**
 * update/registry-root.mjs — the registry-root half of `aios update` (AIO-635 Decisions
 * 1/3/5) plus the v2 state writer and rollback machinery shared with the checkout path.
 *
 * A `registry` distribution root (npm install / unpacked tarball) is IMMUTABLE: the pull
 * half of update (`pullToolkitCheckout`, `npm ci`, `sourceCleanliness`) does not apply —
 * `sourceClean` reports `"immutable"`, allowed by construction — and `aios update` NEVER
 * writes into the root (files under the npm prefix belong to npm alone). "Update the
 * toolkit itself" is `npm i -g @aiosbrain/aios@<version>`; `aios update` on a registry root
 * re-vendors governance from the installed version, reports (stderr, non-fatal offline)
 * when the registry has a newer version, and runs the npm upgrade only under an explicit
 * `aios update --self`.
 *
 * Rollback (Decision 5, ADR 0002 §9): before its first mutating step, the v1→v2 upgrade
 * records `.aios/rollback.json` — the EXACT prior package, install type, and the
 * pre-upgrade stamp/config snapshots. `aios update --rollback` restores the snapshots
 * atomically and prints (and only on interactive confirmation executes) the exact
 * reinstall command. Reinstall-plus-restore — never a reverse field-by-field migration.
 */

import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { c, UpdateError } from "../cli-common.mjs";
import { resolveDistributionRoot, DISTRIBUTION_PACKAGE } from "../cli.mjs";
import { readStamp } from "./stamp.mjs";
import { verifiedBaseIndex } from "./base-store.mjs";
import {
  entryFiles,
  assertDestPathSafe,
  plannedDestRels,
  dirtyManagedPaths,
} from "./manifest-walk.mjs";
import {
  mergeManaged,
  vendorSafety,
  vendorSafetyReason,
  gitBaseResolver,
  storeBaseResolver,
} from "./merge.mjs";
import { printMergeReport } from "./report.mjs";
import { installWorktreeSafetyBackstops } from "../worktree.mjs";
import { toolkitMeta } from "../toolkit-meta.mjs";
import { VERSION_FILE, managedPathsForConfig, pmToolPrunable } from "../toolkit-manifest.mjs";

export { ROLLBACK_FILE, recordRollbackIfUpgrading, rollbackFromRecord } from "./rollback.mjs";
import { recordRollbackIfUpgrading } from "./rollback.mjs";

/**
 * Base-resolver policy (Decision 1): a format-2 stamp resolves bases from the workspace's
 * own store; `gitShow` against a checkout is the fallback for v1-stamped workspaces ONLY.
 * A v1 workspace updating from a registry root resolves bases via the RECORDED stamp
 * source when that is still a live checkout, otherwise surfaces per-file `fallback`.
 */
export function chooseBaseResolver(repo, srcDir, baseSha, { registry = false } = {}) {
  const stampInfo = readStamp(repo);
  if (stampInfo?.format >= 2) {
    return storeBaseResolver(repo, verifiedBaseIndex(repo, stampInfo));
  }
  if (!registry) return gitBaseResolver(srcDir, baseSha);
  const recorded = stampInfo?.source;
  if (recorded && path.isAbsolute(recorded)) {
    const rec = resolveDistributionRoot(recorded);
    if (rec?.kind === "checkout") return gitBaseResolver(rec.dir, baseSha);
    // The recorded source is a still-installed REGISTRY root at the SAME version the
    // stamp pinned: its content IS the base (immutable by construction). This is what
    // makes a 0.12.0-registry-scaffolded workspace upgradeable without a checkout —
    // without it, every stamp-time-personalized file is a permanent no-base conflict.
    if (rec?.kind === "registry" && rec.version && rec.version === stampInfo?.toolkitVersion) {
      return {
        kind: "source-content",
        base: (srcRel) => {
          try {
            return readFileSync(path.join(rec.dir, srcRel), "utf8");
          } catch {
            return undefined;
          }
        },
        baseFiles: (entry) => entryFiles(rec.dir, entry).map((f) => f.srcRel),
      };
    }
    if (stampInfo?.format < 2) {
      throw new UpdateError(
        "The registry installation recorded by this v1 workspace has already been replaced. " +
          "Restore its exact previous package version and follow docs/migration-v2.md: " +
          "run the staged v2 CLI's update before replacing the working installation. " +
          "No managed files were changed; --force is not a migration recovery path."
      );
    }
  }
  if (stampInfo?.format < 2) {
    throw new UpdateError(
      "The exact source recorded by this v1 workspace is unavailable. Restore the recorded checkout or previous package and follow docs/migration-v2.md before updating. No managed files were changed; --force is not a migration recovery path."
    );
  }
  return { kind: "none", base: () => undefined, baseFiles: () => [] };
}

/**
 * Write the complete v2 post-apply state in the Decision-1 order: base-store entries →
 * index → stamp LAST. The stamp transition from an existing stamp runs through the
 * shipped `runMigration` state machine (stamp = configPath, pre-upgrade bytes = the
 * `.last-known-good` snapshot, staged format-2 stamp validated against the freshly
 * written index before commit); a first-ever stamp is a plain atomic write.
 */
export { writeV2State } from "./state-plan.mjs";

/** Best-effort, non-fatal-offline: tell the user (stderr) when the registry is newer. */
export function reportNewerVersion(currentVersion, warn) {
  if (process.env.AIOS_UPDATE_OFFLINE) return; // explicit no-network mode (tests, air-gapped)
  try {
    const latest = execFileSync("npm", ["view", `${DISTRIBUTION_PACKAGE}@latest`, "version"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (latest && latest !== currentVersion) {
      warn(
        c.yellow(
          `  a newer ${DISTRIBUTION_PACKAGE} is available (${latest}; installed ${currentVersion}) — upgrade with \`aios update --self\`.`
        )
      );
    }
  } catch {
    /* offline or npm unavailable — never fatal */
  }
}

/**
 * `aios update --self` — the ONLY path that mutates the toolkit install itself when the
 * running CLI is a registry root. Explicit by design: a plain `aios update` never writes
 * into the npm prefix.
 */
export { upgradeInvokedInstallation as selfUpgrade } from "./npm-installation.mjs";

/**
 * `aios update --rollback` — restore the recorded pre-upgrade stamp and user-config
 * snapshots atomically, print the exact reinstall command from `.aios/rollback.json`, and
 * execute it only on interactive confirmation.
 */
/**
 * Vendor governance into `repo` from an immutable registry root — the apply half only,
 * with ZERO git invocations against the source. Returns the pieces update.mjs folds into
 * its structured result.
 */
export async function vendorFromRegistry(repo, cfg, args, root, io = {}) {
  return withUpdateLock(repo, () => vendorFromRegistryLocked(repo, cfg, args, root, io));
}

async function vendorFromRegistryLocked(repo, cfg, args, root, io) {
  const log = io.log ?? ((m) => console.log(m));
  const warn = io.warn ?? ((m) => console.warn(m));
  const sha = root.sha;
  if (!sha) {
    throw new UpdateError(
      `the installed package at ${root.dir} carries no build provenance (build.json) — ` +
        `can't record a merge base. Reinstall from the registry (npm i -g ${DISTRIBUTION_PACKAGE}) ` +
        `or update from a git checkout (aios update --from <checkout>).`
    );
  }
  const meta = toolkitMeta(root.dir);
  const stampSource = `pkg:${DISTRIBUTION_PACKAGE}@${meta.version}`;
  const managedPaths = managedPathsForConfig(cfg);
  const prunablePaths = pmToolPrunable(cfg);
  const vs = vendorSafety(root.dir, managedPaths, { gitIndex: false });
  if (!vs.safe) {
    throw new UpdateError(
      `the installed toolkit content is not safe to vendor — ${vendorSafetyReason(vs)}.`
    );
  }
  const stampInfo = readStamp(repo);
  const baseSha = stampInfo?.baseSha;
  const resolver = chooseBaseResolver(repo, root.dir, baseSha, { registry: true });
  assertDestPathSafe(
    repo,
    ".gitignore",
    "record versioned merge bases (materialize a symlinked ignore file before updating)"
  );
  assertDestPathSafe(repo, VERSION_FILE, "write version stamp");
  for (const rel of [".claude/skills/INDEX.md", ".claude/INTEGRATIONS.md", "RESOLVER.md"])
    assertDestPathSafe(repo, rel, "regenerate catalog");
  for (const destRel of plannedDestRels(root.dir, resolver, managedPaths, prunablePaths))
    assertDestPathSafe(repo, destRel);
  const force = args.includes("--force");
  const dirty = force ? new Set() : dirtyManagedPaths(repo, managedPaths);
  log(c.dim(`  syncing toolkit ${meta.label} from ${stampSource} (${sha.slice(0, 12)}) …`));

  const statePlan = prepareV2State(repo, {
    srcDir: root.dir,
    sha,
    meta,
    stampSource,
    managedPaths,
    packageVersion: meta.version,
    packageIntegrity: readInstalledIntegrity(root.dir),
  });

  // Exact prior-package record BEFORE the first mutating step (Decision 5).
  await recordRollbackIfUpgrading(repo, { packageRoot: root.dir });

  const r = mergeManaged(root.dir, root.dir, repo, baseSha, {
    dirty,
    force,
    dryRun: false,
    managedPaths,
    prunablePaths,
    resolver,
  });

  const catalogScript = path.join(root.dir, "scripts", "gen-catalog.mjs");
  let catalogFailed = false;
  if (existsSync(catalogScript)) {
    try {
      execFileSync(process.execPath, [catalogScript, "--repo", repo], { stdio: "inherit" });
    } catch {
      catalogFailed = true;
      warn(c.yellow("  gen-catalog failed — catalogs may be stale; fix and re-run `aios update`."));
    }
  }
  const changedCount = printMergeReport(c, r);
  if (r.conflicts.length || r.skippedDirty.length || catalogFailed) {
    warn(
      c.yellow(
        `  ${r.conflicts.length ? `resolve the conflict(s) and ` : r.skippedDirty.length ? "commit the skipped managed changes and " : "catalogs were not regenerated — "}re-run \`aios update\` — version stays pinned at ${(baseSha || "(none)").slice(0, 12)} until then.`
      )
    );
    return {
      exitStatus: 0,
      changedCount,
      vs,
      applied: true,
      reasons: r.conflicts.length
        ? [`${r.conflicts.length} conflict(s) — not applied for those files`]
        : r.skippedDirty.length
          ? [
              "uncommitted managed files skipped — version not stamped; commit and re-run `aios update`",
            ]
          : ["catalog regeneration failed — version not stamped; re-run `aios update`"],
    };
  }

  await commitV2State(statePlan);
  // AIO-482 parity with the checkout apply: restore machine-local worktree hooks.
  installWorktreeSafetyBackstops(repo, { quiet: true, productOnly: true });
  if (changedCount) {
    log(
      c.green(
        `  toolkit synced to ${meta.label} (${sha.slice(0, 12)}) — ${changedCount} file(s) changed.`
      )
    );
    log(c.dim("  Review + commit these on your workspace's master branch."));
  } else {
    log(c.green(`  already up to date — ${meta.label} (${sha.slice(0, 12)}).`));
  }
  reportNewerVersion(meta.version, warn);
  return { exitStatus: 0, changedCount, vs, applied: true, reasons: [] };
}

/** npm records tarball integrity for local installs; globals usually don't carry it —
 *  "unverified" is the honest fallback the stamp format specifies. */
function readInstalledIntegrity(rootDir) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
    if (typeof pkg._integrity === "string" && pkg._integrity) return pkg._integrity;
  } catch {
    /* fall through */
  }
  return "unverified";
}

/** Read-only assessment of a registry root for `--check`/`--preview`. */
export function assessRegistrySource(repo, cfg, root) {
  const managedPaths = managedPathsForConfig(cfg);
  const vs = vendorSafety(root.dir, managedPaths, { gitIndex: false });
  const reasons = [];
  if (!vs.safe) reasons.push(vendorSafetyReason(vs));
  return { remoteState: null, sourceClean: "immutable", vs, rebuildNeeded: false, reasons };
}
