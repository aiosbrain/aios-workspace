/**
 * update.mjs — `aios update`: get the latest AIOS (the "auto-update like Claude" command).
 *
 * One command, two halves. First it brings the local toolkit checkout current and pins an
 * immutable snapshot of the result (git fetch + fast-forward + `npm ci`; see
 * toolkit-pull.mjs) — because the workspace CLI is a thin shim forwarding to that checkout,
 * a stale checkout means stale command code AND a re-vendor of stale governance. Then it
 * re-vendors FROM that pinned snapshot: a scaffolded workspace carries a COPY of the toolkit
 * (see toolkit-manifest.mjs), so update re-syncs MANAGED_PATHS, fills missing SEED_IF_ABSENT
 * starter files, and pins the version. Seeds are create-only: an existing personal file is
 * never read, merged, overwritten, or deleted, even with `--force`.
 *
 * The re-vendor is a **3-way merge**, not a blind overlay (see toolkit-merge.mjs): with the
 * toolkit at the last-synced sha as the base, a file the workspace improved locally is
 * MERGED with the toolkit's change (or surfaced as a conflict) rather than silently
 * overwritten — the granola-1.1.0 regression class. Upstream deletions/renames are
 * propagated only for files the workspace didn't touch.
 *
 *   aios update            # pull the toolkit + reinstall deps + 3-way-merge governance
 *   aios update --check    # dry-run: how far behind is the toolkit / this workspace? (no writes)
 *   aios update --preview  # classify every managed-file change (implies --no-pull; no writes/sidecars)
 *   aios update --dry-run  # alias for --preview (unless combined with --contribute, see below)
 *   aios update --no-pull  # skip the git pull + npm ci; only re-vendor governance
 *   aios update --stash    # auto-stash a dirty toolkit tree, pull, then restore it
 *   aios update --no-install  # skip `npm ci` even if the toolkit lockfile changed
 *   aios update --from DIR  # use a specific toolkit checkout as the source
 *   aios update --force    # take the toolkit version for everything (overwrite)
 *
 * Zero dependencies (git + npm + cp/rm shelled out; Node >= 18).
 */

import os from "node:os";
import path from "node:path";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { c, UpdateError, gitEnv } from "./cli-common.mjs";
import { VERSION_FILE, managedPathsForConfig, pmToolPrunable } from "./toolkit-manifest.mjs";
import { migratePmTool } from "./update/pm-tool.mjs";
import { printMergeReport } from "./update/report.mjs";
import { askCiWorkflow, ciWorkflowState, persistCiWorkflow } from "./ci-workflow.mjs";
import { toolkitMeta } from "./toolkit-meta.mjs";
import { cmdContribute } from "./toolkit-contribute.mjs";
import {
  pullToolkitCheckout,
  sourceCleanliness,
  removePinnedSnapshot,
  remoteMessage,
  assertGitToolkitSource,
} from "./toolkit-pull.mjs";
import {
  dirtyManagedPaths,
  assertDestPathSafe,
  conflictMarkerPaths,
  missingSeedPaths,
  plannedDestRels,
} from "./update/manifest-walk.mjs";
import { vendorSafety, vendorSafetyReason, mergeManaged } from "./update/merge.mjs";
import { readStampBaseSha, readStamp } from "./update/stamp.mjs";
import { resolveDistributionRoot, isDistributionRoot } from "./cli.mjs";
import { argValue, gitSha, buildResult } from "./update/flow-common.mjs";
import { cmdVendorApplyOnly } from "./update/vendor-apply.mjs";
import {
  chooseBaseResolver,
  vendorFromRegistry,
  assessRegistrySource,
  rollbackFromRecord,
  selfUpgrade,
} from "./update/registry-root.mjs";

const DEFAULT_REPO = "https://github.com/aiosbrain/aios-workspace.git";

// The toolkit checkout this CLI is executing from — <toolkit>/scripts/update.mjs → <toolkit>.
// The workspace shim (scaffold/scripts/aios.mjs) may forward here via a relative path rather
// than $AIOS_TOOLKIT_DIR, so resolving from the running file guarantees update pulls/vendors
// the SAME checkout the user is actually running — not a different one on the default path.
const RUNNING_TOOLKIT = path.resolve(fileURLToPath(import.meta.url), "..", "..");

// Toolkit detection is `resolveDistributionRoot`/`isDistributionRoot` (AIO-635 Decision 3)
// — the ONE classifier, imported above; the local two-marker isDistributionRoot() is gone.

/**
 * Resolve a local toolkit checkout for read-only inspection — same candidates as
 * `resolveSource` (--from is caller-supplied, not applicable here; env var; the default
 * `~/Projects/aios/aios-workspace` path) but NEVER falls back to a network clone. Callers
 * that need a guaranteed dir (e.g. `aios update` itself) use `resolveSource`; callers that
 * just want to opportunistically compare versions (e.g. context-health) use this and treat
 * `null` as "signal unavailable" rather than triggering a clone as a side effect.
 */
export function resolveLocalToolkitDir(dir) {
  const candidates = [
    dir,
    process.env.AIOS_TOOLKIT_DIR,
    path.join(os.homedir(), "Projects", "aios", "aios-workspace"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (isDistributionRoot(candidate)) return path.resolve(candidate);
  }
  return null;
}

/** Resolve the toolkit source dir. `stampSource` remains meaningful after the pinned worktree
 *  is removed: the live checkout path for local sources, or the clone URL for an ephemeral
 *  fallback. Throws UpdateError (never exits) on invalid input or an invalid clone. */
function resolveSource(args, cfg, warn) {
  // An explicit --from is a promise: if it isn't a toolkit, that's an error, not a
  // silent fall-through to some other source the user didn't ask for.
  const from = argValue(args, "--from");
  if (from && !isDistributionRoot(from)) {
    throw new UpdateError(
      `--from ${from} doesn't look like an AIOS toolkit checkout ` +
        `(no scripts/aios.mjs + scaffold/). Point it at your aios-workspace clone.`
    );
  }
  const legacyCliDir = process.env.AIOS_TOOLKIT_CLI
    ? path.resolve(process.env.AIOS_TOOLKIT_CLI, "..", "..") // <dir>/scripts/aios.mjs → <dir>
    : undefined;
  const candidates = [
    from,
    process.env.AIOS_TOOLKIT_DIR,
    legacyCliDir, // deprecated alias — kept so existing custom-path configs don't break
    RUNNING_TOOLKIT, // the checkout this CLI runs from — matches whatever the shim forwarded to
    path.join(os.homedir(), "Projects", "aios", "aios-workspace"),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (isDistributionRoot(dir)) {
      const root = resolveDistributionRoot(dir);
      if (root.kind === "registry") {
        // Immutable registry root (AIO-635 Decision 3): no pull half, no git envelope —
        // the vendor reads the installed files directly and the stamp records a pkg:
        // source. This is what makes `aios update` work from a bare `npm i -g`.
        return {
          dir: root.dir,
          ephemeral: false,
          stampSource: `pkg:${root.version ? `@aiosbrain/aios@${root.version}` : "@aiosbrain/aios"}`,
          kind: "registry",
          root,
        };
      }
      const resolved = path.resolve(dir);
      // THE source-trust choke point: every flow that touches a toolkit source (check/
      // preview/apply, --contribute, onboarding) resolves through here, so the supported-
      // envelope gate lives here — a source must be a real git checkout that is its own
      // toplevel (docs/design-self-update.md, "supported source envelope"). Refusing the
      // winning candidate (not falling through to the next) is deliberate: silently
      // updating from a DIFFERENT source than the one the user configured would be worse
      // than the refusal. pullToolkitCheckout keeps its own assert as a backstop for
      // direct callers.
      assertGitToolkitSource(resolved);
      return { dir: resolved, ephemeral: false, stampSource: resolved, kind: "checkout" };
    }
  }
  // Fall back to cloning the canonical repo.
  const url = cfg?.toolkit_repo || DEFAULT_REPO;
  const tmp = mkdtempSync(path.join(os.tmpdir(), "aios-toolkit-"));
  warn(c.dim(`  no local toolkit found — cloning ${url} …`));
  try {
    execFileSync("git", ["clone", "--depth", "1", url, tmp], { stdio: "ignore" });
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw new UpdateError(
      `couldn't fetch the toolkit (${e.message}).\n` +
        `  Point at a local checkout: aios update --from /path/to/aios-workspace\n` +
        `  or set AIOS_TOOLKIT_DIR, or set toolkit_repo in aios.yaml.`
    );
  }
  if (!isDistributionRoot(tmp)) {
    rmSync(tmp, { recursive: true, force: true });
    throw new UpdateError(`cloned ${url} but it doesn't look like the AIOS toolkit`);
  }
  return { dir: tmp, ephemeral: true, stampSource: url, kind: "checkout" };
}

// Manifest walk, 3-way merge, and stamp bookkeeping moved to scripts/update/*.mjs
// (AIO-557) — re-exported here (via the imports above) so every existing caller/test
// keeps importing them from scripts/update.mjs unchanged. See each module's header
// comment for the invariant it owns.
export { gitSha };
export {
  dirtyManagedPaths,
  assertDestPathSafe,
  conflictMarkerPaths,
  missingSeedPaths,
  plannedDestRels,
  vendorSafety,
  mergeManaged,
};

// Every flag `aios update` understands. Anything else is refused up front — in particular so
// the internal vendor hand-off can never silently drop a flag it doesn't recognize.
const UPDATE_BOOL_FLAGS = new Set([
  "--check",
  "--preview",
  "--no-pull",
  "--stash",
  "--no-install",
  "--force",
  "--with-ci-workflow",
  "--dry-run", // alias for --preview UNLESS combined with --contribute (see cmdUpdate)
  "--rollback", // restore the recorded pre-upgrade stamp/config snapshots (AIO-635 D5)
  "--self", // upgrade a registry (npm) install of the toolkit itself — the ONLY root write
]);
// Recognized, but deliberately excluded from --help/the "supported:" error text — internal
// hand-off only, never meant to be typed by a user. See the exact allowlist check below.
const UPDATE_HIDDEN_BOOL_FLAGS = new Set(["--vendor-apply-only"]);
// --result-file: the vendor-apply-only child writes its structured result here as JSON.
// --stamp-source: the live checkout path (or clone URL for an ephemeral source) recorded in
// the workspace stamp; --from itself is the disposable pinned snapshot and must not be stamped.
// `stdio: "inherit"` gives the user live progress output (worth keeping — this can be a
// slow operation), but means the parent process can't read the child's stdout at all, so
// there is no other channel to get `changedCount`/`vendorSafety` back across the process
// boundary. Internal only, alongside --vendor-apply-only.
// --expect-src-head: refuse the apply if the resolved source's HEAD differs from the sha a
// prior --preview reported (result.srcHead) — the consent pin for two-step preview→apply
// flows (onboarding), so a source that moved between the two steps can never vendor content
// the user didn't see.
const UPDATE_HIDDEN_VALUE_FLAGS = new Set(["--result-file", "--stamp-source", "--expect-src-head"]);
const UPDATE_VALUE_FLAGS = new Set(["--from", "--repo", "--contribute"]);

function assertKnownUpdateFlags(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (UPDATE_VALUE_FLAGS.has(a) || UPDATE_HIDDEN_VALUE_FLAGS.has(a)) {
      i++; // skip the flag's value
      continue;
    }
    if (a.startsWith("--") && !UPDATE_BOOL_FLAGS.has(a) && !UPDATE_HIDDEN_BOOL_FLAGS.has(a))
      throw new UpdateError(
        `aios update: unknown flag ${a} — supported: ` +
          `${[...UPDATE_BOOL_FLAGS].join("|")} ${[...UPDATE_VALUE_FLAGS].map((f) => `${f} <val>`).join(" ")}`
      );
  }
}

/**
 * The one read-only safety assessment of a toolkit source — remote state (via a strictly
 * read-only pullToolkitCheckout), vendor safety, source cleanliness, and the reasons list
 * built from them. Shared by the toolkit-self check/preview block, workspace --check, and
 * --preview so a new signal (or a wording fix) lands in every mode at once instead of
 * drifting across three hand-built copies.
 */
function assessReadOnlySource(srcDir, { pullOpts, io, skipRemote = false, repo = null, cfg = {} }) {
  const pullInfo = skipRemote
    ? null
    : pullToolkitCheckout(srcDir, { ...pullOpts, check: true, dryRun: true, noInstall: true }, io);
  // Run the SAME containment pre-flight the apply runs (`repo` is set only for a real
  // workspace target — a toolkit-self assessment vendors nothing, so it has no
  // destinations to contain). Without this, `--check`/`--preview` computed
  // `applyAllowed: true` for a workspace whose managed destination is a symlink, and
  // onboarding offered an apply that then refused — the offer-then-refuse class this
  // whole change set exists to eliminate. Throwing (rather than folding into `reasons`)
  // matches the contract already set by `missingSeedPaths`, whose identical refusal has
  // always surfaced read-only as a structured `mode: "error"` result.
  const managedPaths = managedPathsForConfig(cfg);
  if (repo)
    for (const destRel of plannedDestRels(
      srcDir,
      // Same base resolver the apply itself would use (store for a v2 stamp, git for v1)
      // so the scanned set can never differ from the set an apply would touch.
      chooseBaseResolver(repo, srcDir, readStampBaseSha(repo)),
      managedPaths,
      pmToolPrunable(cfg)
    ))
      assertDestPathSafe(repo, destRel);
  const vs = vendorSafety(srcDir, managedPaths);
  const sourceClean = pullInfo?.sourceClean ?? sourceCleanliness(srcDir);
  const remoteState = pullInfo?.remoteState ?? null;
  // Read-only counterpart of apply's dist/ rebuild (AIO-504): report — never perform — whether
  // pulling would restale the compiled dist/. `true` only when the incoming range provably
  // touches src/; a `null` (can't tell without fetching) stays silent rather than crying wolf.
  const rebuildNeeded = pullInfo?.rebuildNeeded ?? false;
  const reasons = [];
  if (remoteState && !["current", "no-upstream"].includes(remoteState.state))
    reasons.push(remoteMessage(remoteState).text);
  if (sourceClean === "dirty") reasons.push("the toolkit checkout has uncommitted changes");
  if (sourceClean === "inspection-error")
    reasons.push("couldn't determine whether the toolkit checkout is clean");
  if (rebuildNeeded === true)
    reasons.push("pulling would rebuild dist/ (src/ changed upstream) — `aios update` handles it");
  if (!vs.safe) reasons.push(vendorSafetyReason(vs));
  return { remoteState, sourceClean, vs, rebuildNeeded, reasons };
}

/**
 * `aios update`. Returns a structured result object (never a bare number, never exits) so
 * programmatic callers (onboarding, tests) can inspect `.applyAllowed`/`.reasons` instead
 * of parsing console text. Every expected failure — dirty tree, unresolved conflict, bad
 * `--from`, unknown flag, a non-fast-forward, an uninspectable local repo — throws
 * `UpdateError`; this function is the ONE place that catches it and converts it into a
 * printed message + a non-zero result. Any OTHER thrown error is a genuinely unexpected
 * bug and is left to propagate to the CLI dispatcher's own catch-all (`scripts/aios.mjs`).
 */
export async function cmdUpdate(repo, cfg, args) {
  let result;
  try {
    result = await cmdUpdateInner(repo, cfg, args);
  } catch (e) {
    if (e instanceof UpdateError) {
      console.error(c.red(`error: ${e.message}`));
      result = buildResult({ mode: "error", exitStatus: 1, reasons: [e.message] });
    } else {
      throw e;
    }
  }
  // --vendor-apply-only runs as a SEPARATE PROCESS from its caller (see the hand-off in
  // cmdUpdateInner) — `stdio: "inherit"` gives live progress output but means the parent
  // can't read this process's return value at all, only its exit code. --result-file is
  // the one place BOTH the normal-return and thrown-UpdateError paths converge (this same
  // try/catch), so writing it here — once — covers every outcome the child can have.
  const resultFile = argValue(args, "--result-file");
  if (resultFile) {
    try {
      writeFileSync(resultFile, JSON.stringify(result));
    } catch {
      /* best-effort — the parent falls back to exit-code-only if this write fails */
    }
  }
  return result;
}

async function cmdUpdateInner(repo, cfg, args) {
  const color = c;
  assertKnownUpdateFlags(args);

  // Structurally non-recursive internal hand-off. Validated and dispatched FIRST, before
  // anything else in this function runs — nothing below this block is reachable from a
  // --vendor-apply-only invocation, and cmdVendorApplyOnly itself has no code path that
  // could ever reach back here.
  if (args.includes("--vendor-apply-only")) {
    const allowed = new Set([
      "--vendor-apply-only",
      "--from",
      "--repo",
      "--force",
      "--with-ci-workflow",
      "--result-file",
      "--stamp-source",
    ]);
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--from" || a === "--repo" || a === "--result-file" || a === "--stamp-source") {
        i++; // skip the flag's value
        continue;
      }
      if (!allowed.has(a)) {
        throw new UpdateError(
          `aios update --vendor-apply-only accepts only --from/--repo/--force/--result-file/--stamp-source — got ${a}. ` +
            `This is an internal hand-off entrypoint, not meant to be combined with other flags.`
        );
      }
    }
    return await cmdVendorApplyOnly(repo, cfg, args);
  }

  // `--rollback` (AIO-635 Decision 5): restore the recorded pre-upgrade snapshots and
  // print (interactively: offer to run) the exact reinstall command. Reinstall-plus-
  // restore, never a reverse migration (ADR 0002 §9). Refuses combination with any other
  // mode flag — a rollback is not an update.
  if (args.includes("--rollback")) {
    for (const a of args)
      if (a.startsWith("--") && a !== "--rollback")
        throw new UpdateError("aios update --rollback takes no other flags.");
    await rollbackFromRecord(repo);
    return buildResult({ mode: "rollback", exitStatus: 0, sourceClean: "immutable" });
  }

  // `--self` (AIO-635 Decision 4): the ONLY path that mutates a registry install of the
  // toolkit itself. A plain `aios update` never writes into the npm prefix.
  if (args.includes("--self")) {
    const exitStatus = selfUpgrade(resolveDistributionRoot(RUNNING_TOOLKIT));
    return buildResult({ mode: "self-upgrade", exitStatus, sourceClean: "immutable" });
  }

  const check = args.includes("--check");
  // --dry-run is this CLI's universal "no writes" convention; alias it to --preview for the
  // general case. Excluded when --contribute is present, where it keeps its existing
  // narrower meaning (handled inside cmdContribute — previews the PR without writing).
  const preview =
    args.includes("--preview") || (args.includes("--dry-run") && !args.includes("--contribute"));

  // --contribute performs Git + `gh` writes (pushes a branch, opens a PR). It must never run
  // under a read-only mode — otherwise `aios update --check --contribute <path>` silently makes
  // remote writes while claiming to be read-only. Preview it with `--contribute <path> --dry-run`.
  if (args.includes("--contribute") && (check || preview)) {
    throw new UpdateError(
      "aios update --contribute cannot be combined with --check/--preview — it pushes a branch and\n" +
        "  can open a PR. Preview it instead with: aios update --contribute <path> --dry-run"
    );
  }

  // --expect-src-head is the consent pin for a two-step preview→apply flow: "apply
  // EXACTLY the state I previewed." That is only coherent for a --no-pull apply — a pull
  // is by definition moving past the pinned state, and check/preview don't apply anything
  // to pin. Refusing the incompatible combinations up front keeps the pin's contract
  // binary (enforced or refused — never accepted-and-ignored on some branch), the same
  // treatment as --contribute with --check/--preview above.
  if (argValue(args, "--expect-src-head") !== undefined) {
    if (args.includes("--check") || args.includes("--preview") || args.includes("--dry-run")) {
      throw new UpdateError(
        "--expect-src-head only pins an apply — it cannot be combined with --check/--preview/--dry-run."
      );
    }
    if (!args.includes("--no-pull")) {
      throw new UpdateError(
        '--expect-src-head requires --no-pull: the pin means "apply exactly the previewed state", ' +
          "and a pull would move the source past it. Re-preview after pulling instead."
      );
    }
  }

  const noPull = args.includes("--no-pull") || preview;
  if (args.includes("--with-ci-workflow")) {
    cfg.ci_workflow = "true";
    if (!check && !preview) persistCiWorkflow(repo, true);
  }
  const stash = args.includes("--stash");
  const noInstall = args.includes("--no-install");
  const pullOpts = { stash, noInstall, dryRun: check, check };
  const io = { log: (m) => console.log(m), warn: (m) => console.warn(m) };
  const mode = check ? "check" : preview ? "preview" : "apply";

  if (
    mode === "apply" &&
    !args.includes("--with-ci-workflow") &&
    ciWorkflowState(cfg) === null &&
    process.stdin.isTTY
  ) {
    const enabled = await askCiWorkflow();
    persistCiWorkflow(repo, enabled);
    cfg.ci_workflow = enabled ? "true" : "false";
  }

  // One-time pm_tool back-fill for a workspace scaffolded before the key existed (AIO-844).
  if (mode === "apply") migratePmTool(repo, cfg, (m) => console.warn(c.yellow(m)));

  // Run inside the toolkit checkout itself: no workspace to re-vendor into, so `aios update`
  // just brings the checkout current (git pull + npm ci) — the "self-update" case. Nothing
  // is ever vendored here, so any snapshot pullToolkitCheckout pins is unused — discard it.
  const repoRoot = resolveDistributionRoot(repo);
  if (repoRoot?.kind === "registry") {
    // Files under the npm prefix belong to npm alone (AIO-635 Decision 4): `aios update`
    // never writes into a registry install, and an installed package dir is not a
    // workspace to vendor into either.
    throw new UpdateError(
      `${repo} is an installed @aiosbrain/aios package, not a workspace or checkout — ` +
        `aios update never writes into a registry install. Run it from your workspace, ` +
        `or upgrade the install itself with \`aios update --self\`.`
    );
  }
  if (repoRoot?.kind === "checkout") {
    console.log(color.blue("aios update") + color.dim(`  toolkit checkout ${repo}`));
    assertGitToolkitSource(repo);
    // The consent pin must never be silently ignored on ANY branch that can return
    // success: this flag is only meaningful for a two-step preview→apply over a
    // WORKSPACE, and this branch is the toolkit itself. Accepting-then-ignoring it would
    // let a pinned-apply recipe report exit 0 against a source the user never previewed —
    // so validate it against this checkout's actual HEAD and refuse a mismatch.
    const selfExpectHead = argValue(args, "--expect-src-head");
    if (selfExpectHead && gitSha(repo) !== selfExpectHead) {
      throw new UpdateError(
        `--expect-src-head ${selfExpectHead.slice(0, 12)} doesn't match this toolkit checkout's ` +
          `HEAD (${gitSha(repo).slice(0, 12)}) — the source moved since it was previewed. ` +
          `Re-run the preview and confirm against the new state.`
      );
    }
    if (check || preview) {
      // Both read-only modes must report the same remote/local safety signals that apply
      // enforces — one shared assessment (ls-remote only; vendorSafety catches an
      // unresolved index before we advertise applyAllowed).
      const a = assessReadOnlySource(repo, { pullOpts, io });
      if (preview) {
        console.log(color.dim("  --preview — nothing to re-vendor in the toolkit checkout."));
      }
      return buildResult({
        mode,
        exitStatus: 0,
        remoteState: a.remoteState,
        sourceClean: a.sourceClean,
        vendorSafety: a.vs,
        srcHead: gitSha(repo),
        reasons: a.reasons,
      });
    }
    if (noPull) {
      // Even a no-op needs an honest signal: with every safety field null, buildResult
      // would have nothing to derive applyAllowed from (and now fails closed on that) —
      // cleanliness is the one cheap, local signal this branch can truthfully report.
      console.log(color.dim("  --no-pull — nothing to re-vendor in the toolkit checkout."));
      return buildResult({
        mode,
        exitStatus: 0,
        sourceClean: sourceCleanliness(repo),
        srcHead: gitSha(repo),
      });
    }
    // selfUpdate: nothing is vendored here, so a current-but-dirty checkout is a no-op
    // success (the everyday state of an actively-developed checkout), no snapshot is
    // pinned, and only a REAL pull still requires a clean tree or --stash.
    const pr = pullToolkitCheckout(repo, { ...pullOpts, selfUpdate: true }, io);
    if (pr.snapshotDir) removePinnedSnapshot(repo, pr.snapshotDir);
    return buildResult({
      mode,
      exitStatus: 0,
      remoteState: pr.remoteState,
      sourceClean: pr.sourceClean,
    });
  }

  const source = resolveSource(args, cfg, (m) => console.warn(m));
  const { dir: srcDir, ephemeral, stampSource } = source;

  // ── Registry root (AIO-635 Decision 3): the pull half does not apply — content is
  // immutable, no git operations run against the source, bases come from the workspace's
  // own store (Decision 1), and `aios update` never writes into the npm prefix. ──
  if (source.kind === "registry") {
    if (args.includes("--contribute")) {
      throw new UpdateError(
        "aios update --contribute needs a git checkout source — the toolkit here is an npm " +
          "install. Clone aios-workspace and re-run with --from <checkout>."
      );
    }
    const expectHead = argValue(args, "--expect-src-head");
    if (expectHead && source.root.sha !== expectHead) {
      throw new UpdateError(
        `the installed package's build sha (${(source.root.sha ?? "unknown").slice(0, 12)}) doesn't ` +
          `match --expect-src-head ${expectHead.slice(0, 12)} — the install changed since the preview.`
      );
    }
    const managedPaths = managedPathsForConfig(cfg);
    const prunablePaths = pmToolPrunable(cfg);
    const a = assessRegistrySource(repo, cfg, source.root);
    const sha = source.root.sha ?? null;
    const resolver = chooseBaseResolver(repo, srcDir, readStampBaseSha(repo), { registry: true });
    for (const destRel of plannedDestRels(srcDir, resolver, managedPaths, prunablePaths))
      assertDestPathSafe(repo, destRel);
    if (check || preview) {
      const stampInfo = readStamp(repo);
      const meta = toolkitMeta(srcDir);
      const reasons = [...a.reasons];
      const matches = !!sha && !!stampInfo?.baseSha && sha === stampInfo.baseSha;
      if (!matches)
        reasons.push(
          `this workspace is on ${stampInfo?.toolkitVersion ? `v${stampInfo.toolkitVersion}` : "(unstamped)"}, installed package ${meta.label}`
        );
      const missingSeeds = missingSeedPaths(srcDir, repo);
      if (missingSeeds.length)
        reasons.push(
          `missing seed${missingSeeds.length === 1 ? "" : "s"}: ${missingSeeds.join(", ")}`
        );
      let changedCount = 0;
      if (preview) {
        const dirty = args.includes("--force") ? new Set() : dirtyManagedPaths(repo, managedPaths);
        const r = mergeManaged(srcDir, srcDir, repo, stampInfo?.baseSha, {
          dirty,
          force: args.includes("--force"),
          dryRun: true,
          managedPaths,
          prunablePaths,
          resolver,
        });
        changedCount = printMergeReport(color, r, { preview: true });
        console.log(
          color.dim(
            `  preview only — ${changedCount} managed file(s) would change; no files or conflict sidecars were written.`
          )
        );
      } else if (matches && !missingSeeds.length && a.vs.safe) {
        console.log(color.green(`  up to date — ${toolkitMeta(srcDir).label} (pkg).`));
      } else {
        console.log(color.yellow(`  behind — ${reasons.join("; ")}. Run \`aios update\`.`));
      }
      return buildResult({
        mode,
        exitStatus: 0,
        sourceClean: "immutable",
        vendorSafety: a.vs,
        srcHead: sha,
        changedCount,
        reasons,
      });
    }
    const v = await vendorFromRegistry(repo, cfg, args, source.root, io);
    return buildResult({
      mode: "apply",
      exitStatus: v.exitStatus,
      sourceClean: "immutable",
      vendorSafety: v.vs,
      srcHead: sha,
      applied: v.applied,
      changedCount: v.changedCount,
      reasons: v.reasons,
    });
  }

  // --contribute upstreams a locally-improved managed file as a toolkit PR (own flow).
  if (args.includes("--contribute")) {
    try {
      await cmdContribute(repo, { dir: srcDir, ephemeral }, args, argValue(args, "--contribute"));
    } finally {
      if (ephemeral) rmSync(srcDir, { recursive: true, force: true });
    }
    return buildResult({ mode: "contribute", exitStatus: 0 });
  }

  try {
    if (check) {
      // ephemeral (freshly cloned) sources are trivially current — no remote check needed.
      const a = assessReadOnlySource(srcDir, { pullOpts, io, skipRemote: ephemeral, repo, cfg });
      const { remoteState, sourceClean, vs } = a;

      const sha = gitSha(srcDir);
      const meta = toolkitMeta(srcDir);
      const stampPath = path.join(repo, VERSION_FILE);
      const stampField = (label) => {
        if (!existsSync(stampPath)) return undefined;
        const m = readFileSync(stampPath, "utf8").match(new RegExp(`^${label}\\s+(.+)$`, "m"));
        return m ? m[1].trim() : undefined;
      };
      const have = existsSync(stampPath)
        ? readFileSync(stampPath, "utf8").split(/\s/)[0]
        : "(none)";
      const matches = have !== "(none)" && (sha.startsWith(have) || have.startsWith(sha));
      const short = (s) => (s === "(none)" ? s : s.slice(0, 12));
      const haveVer = stampField("toolkit-version");
      const missingSeeds = missingSeedPaths(srcDir, repo);
      const remoteCurrent =
        !remoteState || remoteState.state === "current" || remoteState.state === "no-upstream";

      // Check-only extras (stamp match, missing seeds) append to the shared assessment.
      const reasons = [...a.reasons];
      if (!matches)
        reasons.push(
          `this workspace is on ${haveVer ? `v${haveVer}` : short(have)}, local toolkit ${meta.label} (${short(sha)})`
        );
      if (missingSeeds.length)
        reasons.push(
          `missing seed${missingSeeds.length === 1 ? "" : "s"}: ${missingSeeds.join(", ")}`
        );

      const allGreen =
        matches && !missingSeeds.length && remoteCurrent && sourceClean === "clean" && vs.safe;
      if (allGreen) {
        console.log(color.green(`  up to date — ${meta.label} (${short(sha)}).`));
      } else {
        console.log(color.yellow(`  behind — ${reasons.join("; ")}. Run \`aios update\`.`));
      }
      return buildResult({
        mode: "check",
        exitStatus: 0,
        remoteState,
        sourceClean,
        vendorSafety: vs,
        srcHead: sha,
        reasons,
      });
    }

    if (preview) {
      // preview never pulls (implies --no-pull) and never writes — it operates directly
      // against the live srcDir, same honest point-in-time scope as --check. No snapshot
      // is needed since nothing is ever written.
      const a = assessReadOnlySource(srcDir, { pullOpts, io, skipRemote: ephemeral, repo, cfg });
      const { remoteState, sourceClean, vs } = a;
      if (!vs.safe) {
        console.warn(
          color.yellow(`  toolkit has unresolved conflicts — ${vendorSafetyReason(vs)}.`)
        );
      }
      if (sourceClean !== "clean") {
        console.warn(
          color.yellow(
            `  toolkit checkout is ${sourceClean === "dirty" ? "dirty" : "not fully inspectable"} — this preview may not match what apply produces.`
          )
        );
      }

      const sha = gitSha(srcDir);
      const meta = toolkitMeta(srcDir);
      console.log(
        color.dim(`  previewing toolkit ${meta.label} from ${srcDir} (${sha.slice(0, 12)}) …`)
      );
      const stampPath = path.join(repo, VERSION_FILE);
      const baseSha = existsSync(stampPath)
        ? readFileSync(stampPath, "utf8").split(/\s/)[0]
        : undefined;
      const force = args.includes("--force");
      const managedPaths = managedPathsForConfig(cfg);
      const dirty = force ? new Set() : dirtyManagedPaths(repo, managedPaths);

      const r = mergeManaged(srcDir, srcDir, repo, baseSha, {
        dirty,
        force,
        dryRun: true,
        managedPaths,
        prunablePaths: pmToolPrunable(cfg),
        // Same base policy as the apply (store for v2 stamps, git for v1) so preview and
        // apply can never classify the same file differently.
        resolver: chooseBaseResolver(repo, srcDir, baseSha),
      });

      const changedCount = printMergeReport(color, r, { preview: true });
      console.log(
        color.dim(
          `  preview only — ${changedCount} managed file(s) would change; no files or conflict sidecars were written.`
        )
      );
      return buildResult({
        mode: "preview",
        exitStatus: 0,
        remoteState,
        sourceClean,
        vendorSafety: vs,
        srcHead: sha,
        changedCount,
        reasons: a.reasons,
      });
    }

    // APPLY mode from here. Every path below ends with a pinned, immutable snapshot to
    // hand off to --vendor-apply-only — whether the source was actually pulled, skipped
    // via --no-pull, or is a freshly-cloned ephemeral checkout (already current). Both
    // paths run through pullToolkitCheckout (throws UpdateError on its own failures), so
    // the clean gate, --stash handling, and snapshot pinning are one implementation —
    // The consent pin for two-step preview→apply flows (onboarding): the caller passes
    // the sha its preview reported, and a source that has since moved refuses instead of
    // silently vendoring content the user never saw. Checked HERE, before
    // pullToolkitCheckout builds (and then tears down) an entire snapshot worktree just
    // to report the mismatch — a moved HEAD refuses identically either way (a pull that
    // moves HEAD past the pin is by definition not what was previewed), this is just the
    // cheap seat for the same refusal. The post-snapshot check below stays as the
    // authoritative TOCTOU backstop against the sha the snapshot actually pinned.
    const expectHead = argValue(args, "--expect-src-head");
    if (expectHead && gitSha(srcDir) !== expectHead) {
      throw new UpdateError(
        `the toolkit source moved since it was previewed (previewed ${expectHead.slice(0, 12)}, ` +
          `now ${gitSha(srcDir).slice(0, 12)}) — re-run the preview and confirm against the new state.`
      );
    }

    // `localOnly` just skips the remote classification and fast-forward.
    const snapshotSource =
      noPull || ephemeral
        ? pullToolkitCheckout(srcDir, { ...pullOpts, localOnly: true, noInstall: true }, io)
        : pullToolkitCheckout(srcDir, pullOpts, io);

    // From here the pinned snapshot exists on disk (a registered git worktree in the
    // user's toolkit checkout). ONE finally owns its whole lifetime: every exit — the
    // UpdateError refusals below, a plain system error (mkdtempSync ENOSPC, an
    // uninspectable probe read), or the normal return — runs the same cleanup, so no new
    // exit path can ever reintroduce the leak class this block used to have (three
    // hand-placed removePinnedSnapshot calls, each covering only the throws above it).
    let resultDir = null;
    try {
      const entrypoint = path.join(snapshotSource.snapshotDir, "scripts", "aios.mjs");
      if (!existsSync(entrypoint)) {
        throw new UpdateError(
          `the pinned toolkit snapshot is missing its CLI entrypoint (${entrypoint}) — the toolkit checkout may be corrupted.`
        );
      }

      // The child below is the SNAPSHOT's own CLI, so the snapshot must understand the
      // hand-off flags — a snapshot of a toolkit that predates --vendor-apply-only would
      // reject them via its own assertKnownUpdateFlags and die with an opaque "unknown
      // flag". That happens for real sources the state table lets proceed without a
      // fast-forward to current main: a pinned AIOS_TOOLKIT_DIR/--from at an old commit,
      // or an offline/no-upstream checkout. Probe the snapshot's update.mjs for the flag
      // and refuse with a message naming the actual problem + the fix. A snapshot with NO
      // scripts/update.mjs can't be probed (real toolkits always ship it; test stubs
      // don't) — let those through to the entrypoint, which speaks for itself. If a future
      // change adds a hand-off flag an older POST-protocol toolkit won't know, extend this
      // probe to cover that flag too.
      const snapshotUpdateModule = path.join(snapshotSource.snapshotDir, "scripts", "update.mjs");
      if (
        existsSync(snapshotUpdateModule) &&
        !readFileSync(snapshotUpdateModule, "utf8").includes("--vendor-apply-only")
      ) {
        const fixHint = ephemeral
          ? `Set toolkit_repo in aios.yaml (or AIOS_TOOLKIT_DIR/--from) to a toolkit at or after the hand-off protocol — the cloned source itself is a throwaway temp dir.`
          : `Bring that checkout up to date first (git -C ${srcDir} pull), then re-run \`aios update\`.`;
        throw new UpdateError(
          `the toolkit source (${stampSource}) predates the self-update hand-off protocol — its own ` +
            `CLI doesn't understand --vendor-apply-only, so this toolkit can't drive it.\n` +
            `  ${fixHint}`
        );
      }

      // Authoritative consent-pin backstop against the sha the snapshot ACTUALLY pinned
      // (the early check above ran against the live checkout pre-pull). FAIL-CLOSED on a
      // missing srcHead: apply-mode pullToolkitCheckout always sets it or throws, so a
      // null here means an invariant broke upstream — refuse rather than silently skip
      // the one comparison the pin exists for.
      if (expectHead && snapshotSource.srcHead !== expectHead) {
        throw new UpdateError(
          `the toolkit source moved since it was previewed (previewed ${expectHead.slice(0, 12)}, ` +
            `now ${(snapshotSource.srcHead ?? "unknown").slice(0, 12)}) — re-run the preview and confirm against the new state.`
        );
      }

      // stdio: "inherit" gives live progress output for what can be a slow operation, but
      // means this process can't read the child's return value at all — only its exit
      // outcome. --result-file is the one side-channel back (see cmdUpdate).
      resultDir = mkdtempSync(path.join(os.tmpdir(), "aios-vendor-result-"));
      const resultFile = path.join(resultDir, "result.json");
      const passthrough = [
        "update",
        "--vendor-apply-only",
        "--from",
        snapshotSource.snapshotDir,
        "--repo",
        repo,
        "--result-file",
        resultFile,
        "--stamp-source",
        stampSource,
      ];
      if (args.includes("--force")) passthrough.push("--force");
      if (args.includes("--with-ci-workflow")) passthrough.push("--with-ci-workflow");
      // env: gitEnv() — the child runs the SNAPSHOT's own CLI, which may predate the
      // git-env hardening entirely. Scrubbing at the spawn boundary closes the inherited
      // GIT_DIR/GIT_WORK_TREE hole for EVERY snapshot version, including old ones whose
      // internal git calls are unsanitized; sanitizing only our own call sites would
      // protect the parent and leave the child (the process that actually writes the
      // workspace and the version stamp) resolving against the wrong repository.
      const res = spawnSync(process.execPath, [entrypoint, ...passthrough], {
        stdio: "inherit",
        env: gitEnv(),
      });

      let exitStatus, reasons;
      if (res.error) {
        exitStatus = 1;
        reasons = [`couldn't launch the vendor step (${res.error.message})`];
        console.error(color.red(`error: couldn't launch the vendor step (${res.error.message})`));
      } else if (res.signal) {
        exitStatus = 1;
        reasons = [`the vendor step was terminated (signal ${res.signal})`];
        console.error(color.red(`error: the vendor step was terminated (signal ${res.signal})`));
      } else {
        exitStatus = res.status ?? 1;
        reasons = exitStatus ? ["the vendor step failed — see output above"] : [];
      }

      // Best-effort: if the child's result file is missing/unparseable (e.g. it crashed
      // before writing it, or res.error fired before it ever ran), fall back to the
      // exit-code-only synthesis above rather than throwing here.
      let childResult = null;
      try {
        childResult = JSON.parse(readFileSync(resultFile, "utf8"));
      } catch {
        /* fall back to exit-code-only reasons/changedCount below */
      }

      return buildResult({
        mode: "apply",
        exitStatus,
        remoteState: snapshotSource.remoteState,
        sourceClean: snapshotSource.sourceClean,
        vendorSafety: childResult?.vendorSafety ?? null,
        srcHead: snapshotSource.srcHead,
        applied: exitStatus === 0,
        changedCount: childResult?.changedCount ?? 0,
        reasons: childResult?.reasons?.length ? childResult.reasons : reasons,
      });
    } finally {
      if (resultDir) rmSync(resultDir, { recursive: true, force: true });
      removePinnedSnapshot(srcDir, snapshotSource.snapshotDir);
    }
  } finally {
    if (ephemeral) rmSync(srcDir, { recursive: true, force: true });
  }
}
