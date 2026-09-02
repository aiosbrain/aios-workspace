/**
 * cli/distribution-root.mjs — THE one distribution-root capability check (AIO-635 Decision 3).
 *
 * `resolveDistributionRoot(dir)` replaces the three divergent `looksLikeToolkit()` copies
 * (`scripts/toolkit-locate.mjs`, `scripts/update.mjs`, `scripts/onboard-inspect.mjs`) and the
 * `TOOLKIT_MARKERS` triad with a single classifier that also names WHAT KIND of root it found:
 *
 *   - `checkout` — a real git checkout that is its own toplevel. Mutable; the pull/pin/
 *     snapshot flow of `aios update` applies.
 *   - `registry` — an npm-installed package, `npm link` target, or unpacked tarball. The
 *     capability that matters is "content is immutable, no git operations": `aios update`
 *     vendors straight from the installed files (bases come from the workspace's own
 *     `.aios/toolkit-bases` store, Decision 1) and NEVER writes into the root — files under
 *     the npm prefix belong to npm alone.
 *   - `workspace` — a stamped workspace (aios.yaml + the delegating shim, but NO manifest).
 *     Returned as a NAMED rejection so callers can say "that's a workspace, not a toolkit"
 *     instead of silently falling through.
 *   - `null` — not an AIOS distribution root at all.
 *
 * Capability markers (ALL required for checkout/registry): `scripts/toolkit-manifest.mjs`,
 * `scaffold/`, and a root `package.json` whose `name` is `@aiosbrain/aios`. The manifest file
 * is the discriminator: it is never vendored into a workspace and cannot be absent from a
 * valid toolkit, so a stamped workspace — which has a `scripts/aios.mjs` shim but no manifest
 * — can never be mistaken for a toolkit. The name check excludes arbitrary repos that happen
 * to ship a `scaffold/` directory (the hole the old two-marker check in update.mjs had).
 *
 * PARITY NOTE: `scripts/toolkit-locate.mjs` (copy-ledger row 16, byte-identical with the
 * devtools repo's copy) imports this module; the devtools companion PR mirrors both files.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

export const DISTRIBUTION_PACKAGE = "@aiosbrain/aios";

/** The three capability markers every toolkit root (checkout or registry) must carry. */
export const DISTRIBUTION_MARKERS = ["scripts/toolkit-manifest.mjs", "scaffold", "package.json"];

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Markers missing from `dir` — [] means marker-complete. Exported for error messages. */
export function missingDistributionMarkers(dir) {
  const missing = DISTRIBUTION_MARKERS.filter((m) => !existsSync(path.join(dir, m)));
  if (missing.length) return missing;
  const pkg = readJson(path.join(dir, "package.json"));
  if (pkg?.name !== DISTRIBUTION_PACKAGE) return [`package.json name ${DISTRIBUTION_PACKAGE}`];
  return [];
}

function isOwnGitToplevel(dir) {
  // The assertGitToolkitSource envelope (scripts/toolkit-pull/remote-state.mjs), downgraded
  // from assert to classifier: a dir is a `checkout` only when it is ITS OWN git toplevel.
  // A toolkit-shaped copy nested inside another repository must not classify as checkout —
  // git operations there would act on the enclosing repo.
  try {
    const top = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
    }).trim();
    return realpathOr(top) === realpathOr(dir);
  } catch {
    return false;
  }
}

function realpathOr(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Classify `dir` as an AIOS distribution root.
 * @returns {{ dir: string, kind: "checkout"|"registry"|"workspace", version: string|null,
 *             sha: string|null } | null}
 * `dir` in the result is the realpath. `sha` is the git HEAD for a checkout, the embedded
 * `build.json` sha for a registry root (or null when neither is available).
 */
export function resolveDistributionRoot(dir) {
  if (!dir || !existsSync(dir)) return null;
  const abs = realpathOr(dir);

  const missing = missingDistributionMarkers(abs);
  if (missing.length) {
    // Named rejection: a stamped workspace has the shim + aios.yaml but no manifest.
    if (existsSync(path.join(abs, "aios.yaml")) && existsSync(path.join(abs, "scripts/aios.mjs")))
      return { dir: abs, kind: "workspace", version: null, sha: null };
    return null;
  }

  const pkg = readJson(path.join(abs, "package.json"));
  const build = readJson(path.join(abs, "build.json"));
  const version = pkg?.version ?? null;

  if (isOwnGitToplevel(abs)) {
    let sha = null;
    try {
      sha = execFileSync("git", ["-C", abs, "rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
      }).trim();
    } catch {
      sha = null;
    }
    return { dir: abs, kind: "checkout", version, sha };
  }

  // Not a git toplevel: an npm install (realpath under node_modules/@aiosbrain/aios), a dir
  // shipping build.json (packed artifact), or any other marker-complete immutable copy —
  // all classify `registry`. The capability that matters is "immutable, no git operations".
  return { dir: abs, kind: "registry", version, sha: build?.sha ?? null };
}

/** Back-compat boolean: is `dir` a usable toolkit root (checkout OR registry)? */
export function isDistributionRoot(dir) {
  const root = dir ? resolveDistributionRoot(dir) : null;
  return root != null && root.kind !== "workspace";
}
