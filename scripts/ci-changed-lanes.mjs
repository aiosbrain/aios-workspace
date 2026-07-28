#!/usr/bin/env node
/**
 * Classify a PR's changed paths into CI lane flags (AIO-599).
 *
 * ci.yml runs 17 jobs on every PR. Most of them cannot be affected by most changes —
 * `Rust tests` installs a GTK/WebKit toolchain and builds a Cargo workspace for a PR
 * that only touched `scripts/`. Each surplus job holds a runner slot, and runner
 * contention (not job duration) is what produces the wall-clock tail.
 *
 * FAIL-OPEN BY CONSTRUCTION. Every unknown, empty, or unreadable input yields `true`
 * for every lane. Skipping a lane that should have run is a silent correctness hole
 * that reaches main; running a lane that could have been skipped costs a runner minute.
 * There is no input to this module that produces a `false` by accident.
 *
 * WHAT IS DELIBERATELY *NOT* FILTERED:
 *   - The three protected-branch contexts (`leak-gate + secrets + harness checks`,
 *     `lint + format`, `unit tests (npm test)`) always run. They are matched by name
 *     by branch protection, and the leak gate must see every change — a docs-only diff
 *     is precisely where an NDA identifier would appear. `prettier --check .` also
 *     covers markdown, so `lint + format` is load-bearing for docs-only PRs.
 *   - `Node tests`, the coverage lanes, and the constitution guards. 47 files under
 *     test/ read `docs/` or root markdown (contract-conformance and toolkit-meta parse
 *     `docs/brain-api.md` directly), so "docs-only ⇒ skip the test suite" is not sound
 *     in this repo. Measured, not assumed.
 *
 *   node scripts/ci-changed-lanes.mjs --paths-from <file>
 *
 * Writes `name=value` lines to $GITHUB_OUTPUT when set, and always echoes the
 * decision (with the reason) to stdout so a run's log explains why a lane was skipped.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** Lanes this module can switch off, and the job each one gates. */
export const LANES = ["code", "rust", "client"];

/**
 * Paths that cannot change the behaviour of any filterable lane. Anything not matched
 * here counts as code — the allowlist is the narrow side of the decision on purpose.
 */
const INERT = [
  /^docs\//,
  /^[^/]+\.md$/, // root-level markdown only; scaffold/**.md is shipped product
  /^LICENSE$/,
  /^\.github\/ISSUE_TEMPLATE\//,
  /^\.github\/PULL_REQUEST_TEMPLATE/,
];

/** Changing any of these can break a production install or either sub-toolchain. */
const SHARED_BUILD_INPUTS = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /^\.github\/workflows\/ci\.yml$/,
];

const RUST = [/^src-tauri\//, /^scripts\/run-rust-tests\.mjs$/, ...SHARED_BUILD_INPUTS];
const CLIENT = [/^gui\//, ...SHARED_BUILD_INPUTS];

const matches = (patterns, p) => patterns.some((re) => re.test(p));

export const isInert = (p) => matches(INERT, p);

/** Every lane on, used for each fail-open path. */
export const allLanes = () => Object.fromEntries(LANES.map((lane) => [lane, true]));

/**
 * @param {string[] | null | undefined} paths repo-relative changed paths
 * @returns {{code: boolean, rust: boolean, client: boolean}}
 */
export function classifyChangedPaths(paths) {
  if (!Array.isArray(paths)) return allLanes();
  const clean = paths.map((p) => (typeof p === "string" ? p.trim() : "")).filter(Boolean);
  // An empty diff means we failed to compute one, not that nothing changed: a PR with
  // no files cannot exist. Treat it as unknown.
  if (clean.length === 0) return allLanes();

  return {
    code: !clean.every(isInert),
    rust: clean.some((p) => matches(RUST, p)),
    client: clean.some((p) => matches(CLIENT, p)),
  };
}

function readPaths(file) {
  if (!file) return null;
  try {
    return fs.readFileSync(file, "utf8").split("\n");
  } catch {
    return null; // missing/unreadable => fail open
  }
}

function main(argv) {
  const idx = argv.indexOf("--paths-from");
  const file = idx >= 0 ? argv[idx + 1] : null;
  const paths = readPaths(file);
  const lanes = classifyChangedPaths(paths);

  if (paths === null) {
    console.log(`no changed-path list at ${file || "(unset)"} — running every lane (fail-open)`);
  } else {
    console.log(`${paths.filter(Boolean).length} changed path(s)`);
  }
  for (const [lane, on] of Object.entries(lanes)) {
    console.log(`  ${lane}=${on}`);
  }

  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    fs.appendFileSync(
      out,
      Object.entries(lanes)
        .map(([lane, on]) => `${lane}=${on}\n`)
        .join("")
    );
  }
}

/**
 * Whether this module was run directly (as opposed to imported by a test).
 *
 * NOT `import.meta.url === `file://${process.argv[1]}``. That form fails two independent
 * ways, and both fail toward "main() never runs, no lane values are written, every filtered
 * lane skips":
 *   - it compares an ENCODED url against an UNENCODED path, so one space in the checkout
 *     path breaks it;
 *   - `import.meta.url` is symlink-resolved and `process.argv[1]` is not, so any checkout
 *     reached through a symlink breaks it (macOS /var -> /private/var is the everyday case).
 * Comparing realpaths on both sides is immune to both.
 */
function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(entry);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main(process.argv.slice(2));
}
