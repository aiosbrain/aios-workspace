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
import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { c, UpdateError } from "../cli-common.mjs";
import {
  atomicWrite,
  runMigration,
  classifyInstallType,
  resolveUserConfigPath,
  resolveDistributionRoot,
  DISTRIBUTION_PACKAGE,
} from "../cli.mjs";
import { readStamp, stampBody } from "./stamp.mjs";
import { readBaseIndex, writeBaseStore, manifestDigest } from "./base-store.mjs";
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

export const ROLLBACK_FILE = ".aios/rollback.json";

/**
 * Base-resolver policy (Decision 1): a format-2 stamp resolves bases from the workspace's
 * own store; `gitShow` against a checkout is the fallback for v1-stamped workspaces ONLY.
 * A v1 workspace updating from a registry root resolves bases via the RECORDED stamp
 * source when that is still a live checkout, otherwise surfaces per-file `fallback`.
 */
export function chooseBaseResolver(repo, srcDir, baseSha, { registry = false } = {}) {
  const stampInfo = readStamp(repo);
  if (stampInfo?.format >= 2) {
    const index = readBaseIndex(repo);
    if (index) return storeBaseResolver(repo, index);
    // v2 stamp with a missing/corrupt index: fall back to git where possible — for a
    // registry source the empty resolver below surfaces fallback rather than guessing.
    if (!registry) return gitBaseResolver(srcDir, baseSha);
  }
  if (!registry) return gitBaseResolver(srcDir, baseSha);
  const recorded = stampInfo?.source;
  if (recorded && path.isAbsolute(recorded)) {
    const rec = resolveDistributionRoot(recorded);
    if (rec?.kind === "checkout") return gitBaseResolver(rec.dir, baseSha);
  }
  return { kind: "none", base: () => undefined, baseFiles: () => [] };
}

function userConfigPathSafe() {
  try {
    return resolveUserConfigPath({});
  } catch {
    return null;
  }
}

/**
 * Record the exact prior-package state BEFORE the first mutating step of the v1→v2
 * upgrade. A workspace already on format 2 keeps the record from its original upgrade.
 */
export async function recordRollbackIfUpgrading(repo, { packageRoot } = {}) {
  const stampInfo = readStamp(repo);
  if (stampInfo && stampInfo.format >= 2) return null;
  const sourceIsPath = stampInfo?.source && path.isAbsolute(stampInfo.source);
  const previousPackage = stampInfo
    ? sourceIsPath
      ? `checkout:${stampInfo.baseSha ?? "unknown"}`
      : `${DISTRIBUTION_PACKAGE}@${stampInfo.toolkitVersion ?? "unknown"}`
    : null;
  const reinstall = stampInfo
    ? sourceIsPath
      ? {
          argv: ["git", "-C", stampInfo.source, "checkout", stampInfo.baseSha ?? "HEAD"],
          display: `git -C ${stampInfo.source} checkout ${stampInfo.baseSha ?? "HEAD"}`,
        }
      : {
          argv: ["npm", "i", "-g", `${DISTRIBUTION_PACKAGE}@${stampInfo.toolkitVersion}`],
          display: `npm i -g ${DISTRIBUTION_PACKAGE}@${stampInfo.toolkitVersion}`,
        }
    : null;
  const configPath = userConfigPathSafe();
  let configSnapshot = null;
  try {
    if (configPath) configSnapshot = readFileSync(configPath, "utf8");
  } catch {
    configSnapshot = null; // no user config yet — nothing to restore
  }
  const record = {
    schemaVersion: 1,
    previousPackage,
    integrity: "unverified",
    installType: classifyInstallType({ packageRoot, packageName: DISTRIBUTION_PACKAGE }),
    stampPath: VERSION_FILE,
    stampSnapshot: stampInfo?.raw ?? null,
    configPath,
    configSnapshot,
    reinstall,
    recordedAt: new Date().toISOString(),
  };
  await atomicWrite(path.join(repo, ROLLBACK_FILE), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/**
 * Write the complete v2 post-apply state in the Decision-1 order: base-store entries →
 * index → stamp LAST. The stamp transition from an existing stamp runs through the
 * shipped `runMigration` state machine (stamp = configPath, pre-upgrade bytes = the
 * `.last-known-good` snapshot, staged format-2 stamp validated against the freshly
 * written index before commit); a first-ever stamp is a plain atomic write.
 */
export async function writeV2State(
  repo,
  { srcDir, sha, meta, stampSource, managedPaths, packageVersion, packageIntegrity }
) {
  const files = [];
  for (const entry of managedPaths) {
    if (!existsSync(path.join(srcDir, entry.src))) continue;
    for (const f of entryFiles(srcDir, entry)) {
      files.push({
        destRel: f.destRel,
        srcRel: f.srcRel,
        content: readFileSync(path.join(srcDir, f.srcRel), "utf8"),
      });
    }
  }
  await writeBaseStore(repo, files, { packageVersion: packageVersion ?? meta.version });
  const digest = manifestDigest(files);
  const body = stampBody(sha, meta, stampSource, {
    packageName: DISTRIBUTION_PACKAGE,
    packageVersion: packageVersion ?? meta.version,
    packageIntegrity: packageIntegrity ?? "unverified",
    manifestDigest: digest,
  });
  const stampPath = path.join(repo, VERSION_FILE);
  if (!existsSync(stampPath)) {
    await atomicWrite(stampPath, body);
    return { digest };
  }
  const journalPath = `${stampPath}.migration.json`;
  const snapshotPath = `${stampPath}.last-known-good`;
  const stagedPath = `${stampPath}.staged`;
  const run = () =>
    runMigration({
      configPath: stampPath,
      journalPath,
      snapshotPath,
      stagedPath,
      packageRecord: { name: DISTRIBUTION_PACKAGE, version: packageVersion ?? meta.version },
      stage: () => body,
      validate: (staged) => {
        const m = String(staged).match(/^manifest-digest (.+)$/m);
        if (!m || m[1] !== digest) {
          throw new Error(
            "staged stamp digest does not match the freshly written base-store index"
          );
        }
      },
    });
  try {
    await run();
  } catch {
    // A stale journal/snapshot from an interrupted run against a DIFFERENT toolkit state
    // cannot be resumed into today's apply — discard that transition and run fresh once.
    // The live stamp is untouched by construction (only `committed` mutates it).
    for (const p of [journalPath, snapshotPath, stagedPath]) rmSync(p, { force: true });
    await run();
  }
  // The transition is committed; the journal artifacts are working files, not state.
  for (const p of [journalPath, snapshotPath, stagedPath]) rmSync(p, { force: true });
  return { digest };
}

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
export function selfUpgrade(root) {
  if (root?.kind !== "registry") {
    throw new UpdateError(
      "aios update --self upgrades a registry (npm) install of the toolkit — this CLI is " +
        "running from a checkout. Update the checkout with `git pull` / `aios update` there."
    );
  }
  const res = spawnSync("npm", ["i", "-g", `${DISTRIBUTION_PACKAGE}@latest`], {
    stdio: "inherit",
  });
  if (res.error) throw new UpdateError(`couldn't run npm (${res.error.message})`);
  return res.status ?? 1;
}

/**
 * `aios update --rollback` — restore the recorded pre-upgrade stamp and user-config
 * snapshots atomically, print the exact reinstall command from `.aios/rollback.json`, and
 * execute it only on interactive confirmation.
 */
export async function rollbackFromRecord(repo, { interactive = process.stdin.isTTY } = {}) {
  const recPath = path.join(repo, ROLLBACK_FILE);
  let record;
  try {
    record = JSON.parse(readFileSync(recPath, "utf8"));
  } catch {
    throw new UpdateError(
      `no rollback record at ${ROLLBACK_FILE} — nothing recorded a prior package for this ` +
        `workspace. Rollback is only available after a v2 upgrade wrote the record.`
    );
  }
  const stampPath = path.join(repo, record.stampPath ?? VERSION_FILE);
  if (record.stampSnapshot != null) {
    await atomicWrite(stampPath, record.stampSnapshot);
    console.log(
      c.green(`  restored ${record.stampPath ?? VERSION_FILE} to its pre-upgrade bytes.`)
    );
  } else {
    rmSync(stampPath, { force: true });
    console.log(c.green("  removed the version stamp (no stamp existed before the upgrade)."));
  }
  if (record.configPath && record.configSnapshot != null) {
    await atomicWrite(record.configPath, record.configSnapshot);
    console.log(c.green(`  restored ${record.configPath} to its pre-upgrade bytes.`));
  }
  if (record.reinstall?.display) {
    console.log(`  reinstall the prior package with:\n    ${record.reinstall.display}`);
    if (interactive && Array.isArray(record.reinstall.argv) && record.reinstall.argv.length) {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      const answer = (await rl.question("  run it now? [y/N] ")).trim().toLowerCase();
      rl.close();
      if (answer === "y" || answer === "yes") {
        const [cmd, ...rest] = record.reinstall.argv;
        const res = spawnSync(cmd, rest, { stdio: "inherit" });
        if ((res.status ?? 1) !== 0) {
          throw new UpdateError(
            `the reinstall command failed — run it by hand: ${record.reinstall.display}`
          );
        }
      }
    }
  }
  return { previousPackage: record.previousPackage ?? null };
}

/**
 * Vendor governance into `repo` from an immutable registry root — the apply half only,
 * with ZERO git invocations against the source. Returns the pieces update.mjs folds into
 * its structured result.
 */
export async function vendorFromRegistry(repo, cfg, args, root, io = {}) {
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
  assertDestPathSafe(repo, VERSION_FILE, "write version stamp");
  for (const rel of [".claude/skills/INDEX.md", ".claude/INTEGRATIONS.md", "RESOLVER.md"])
    assertDestPathSafe(repo, rel, "regenerate catalog");
  for (const destRel of plannedDestRels(root.dir, resolver, managedPaths, prunablePaths))
    assertDestPathSafe(repo, destRel);
  const force = args.includes("--force");
  const dirty = force ? new Set() : dirtyManagedPaths(repo, managedPaths);
  log(c.dim(`  syncing toolkit ${meta.label} from ${stampSource} (${sha.slice(0, 12)}) …`));

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
  if (r.conflicts.length || catalogFailed) {
    warn(
      c.yellow(
        `  ${r.conflicts.length ? `resolve the conflict(s) and ` : "catalogs were not regenerated — "}re-run \`aios update\` — version stays pinned at ${(baseSha || "(none)").slice(0, 12)} until then.`
      )
    );
    return {
      exitStatus: 0,
      changedCount,
      vs,
      applied: true,
      reasons: r.conflicts.length
        ? [`${r.conflicts.length} conflict(s) — not applied for those files`]
        : ["catalog regeneration failed — version not stamped; re-run `aios update`"],
    };
  }

  await writeV2State(repo, {
    srcDir: root.dir,
    sha,
    meta,
    stampSource,
    managedPaths,
    packageVersion: meta.version,
    packageIntegrity: readInstalledIntegrity(root.dir),
  });
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
