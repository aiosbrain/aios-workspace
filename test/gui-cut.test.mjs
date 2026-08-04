import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * AIO-612 — the GUI cut is one-way.
 *
 * `gui/` and `src-tauri/` moved to aiosbrain/aios-workspace-gui. These assertions exist because
 * the ways they could come back are all quiet:
 *
 *   - a merge resurrecting a deleted tree, which no other test would notice;
 *   - a config or workflow still naming a path in the other repo, which does not fail — it just
 *     silently matches nothing, so a lane, a glob or a validator stops covering anything while
 *     continuing to report green. That "check that can never succeed" shape is the failure mode
 *     the cut had to clean up in several places, and it is the one worth a standing guard.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CUT = /^(?:gui|src-tauri)\//;

function tracked() {
  return execFileSync("git", ["ls-files", "-z", "--cached"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
}

test("no tracked file lives under gui/ or src-tauri/", () => {
  const strays = tracked().filter((file) => CUT.test(file));
  assert.deepEqual(
    strays,
    [],
    `these belong in aiosbrain/aios-workspace-gui:\n  ${strays.join("\n  ")}`
  );
});

test("the npm workspace set no longer includes the cut trees", () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const lockfile = JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
  const workspaces = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : (manifest.workspaces?.packages ?? []);
  assert.deepEqual(
    workspaces.filter((entry) => CUT.test(entry.replace(/^!/, ""))),
    []
  );
  // A script pointing into the other repo would fail only when someone ran it.
  for (const [name, body] of Object.entries(manifest.scripts ?? {})) {
    assert.doesNotMatch(body, CUT, `package.json script "${name}" still references a cut tree`);
  }
  for (const key of Object.keys(lockfile.packages ?? {})) {
    assert.doesNotMatch(key, CUT, `package-lock.json package "${key}" references a cut tree`);
  }
  for (const [name, entry] of Object.entries(lockfile.packages ?? {})) {
    assert.doesNotMatch(
      entry?.name ?? "",
      /^@aios-workspace\/gui-(?:client|server)$/,
      `${name} is GUI-only`
    );
  }
});

test("no build or CI config still points at the cut trees", () => {
  // Each of these silently matches nothing rather than erroring, so nothing else catches it.
  const files = [
    ".c8rc.json",
    ".prettierignore",
    "Makefile",
    "eslint.config.mjs",
    "scripts/boundaries.json",
    "scripts/size-caps.json",
    "scripts/ci-changed-lanes.mjs",
    "scripts/check-coverage.mjs",
    "scripts/run-mutation.mjs",
    "scripts/test-suite.mjs",
    ".github/workflows/ci.yml",
    ".github/workflows/mutation.yml",
  ];
  for (const rel of files) {
    const body = readFileSync(path.join(ROOT, rel), "utf8");
    const offenders = body
      .split("\n")
      .map((line, i) => [i + 1, line])
      // Prose explaining what moved and why is the point; a PATH is the problem.
      .filter(([, line]) => /(?:^|["'`\s([{,=/])(?:gui\/(?:client|server)|src-tauri)\//.test(line))
      .filter(([, line]) => !/^\s*(?:#|\/\/|\*|<!--)/.test(line));
    assert.deepEqual(
      offenders.map(([n, line]) => `${rel}:${n}: ${line.trim()}`),
      [],
      `${rel} still references a cut tree outside a comment`
    );
  }
});

test("every ci.yml needs: entry names a job that exists", () => {
  // Not strictly about the cut, but this is how the cut could break the workflow outright: a
  // `needs:` naming a removed job makes ci.yml invalid, and dropping a lane from test-gate's
  // list makes it silently non-blocking, because `skipped` counts as passing there.
  const lines = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8").split("\n");
  const jobs = lines
    .filter((l) => /^ {2}[a-z][a-z0-9-]*:$/.test(l))
    .map((l) => l.trim().slice(0, -1));
  // Scanned line by line rather than with one nested-quantifier regex: `(?:...+\n)+` over a whole
  // file is a catastrophic-backtracking shape, and this is clearer about what it accepts anyway.
  let inNeeds = false;
  for (const line of lines) {
    if (/^ {4}needs:$/.test(line)) {
      inNeeds = true;
      continue;
    }
    if (!inNeeds) continue;
    const entry = /^ {6}- (\S+)\s*$/.exec(line);
    if (!entry) {
      inNeeds = false;
      continue;
    }
    assert.ok(jobs.includes(entry[1]), `ci.yml needs "${entry[1]}", which is not a job`);
  }
});

test("every workflow step invokes a script that still exists", () => {
  // This one is here because it was MISSED. `scripts/lock-marketplace.mjs` was deleted while
  // ci.yml's "Marketplace lock check" step still ran it, and the cut-path assertions above did
  // not catch it — the step names a `scripts/` path, not a `gui/` one. CI found it instead.
  //
  // Deleting a script is the easy half; the reference that outlives it is the half that breaks a
  // required check. A path check is the general form of the specific thing that went wrong.
  const workflows = readdirSync(path.join(ROOT, ".github/workflows")).filter((f) =>
    /\.ya?ml$/.test(f)
  );
  const missing = [];
  for (const file of workflows) {
    const body = readFileSync(path.join(ROOT, ".github/workflows", file), "utf8");
    for (const m of body.matchAll(/(?:node|bash|sh)\s+((?:scripts|validation|hooks)\/[\w./-]+)/g)) {
      if (!existsSync(path.join(ROOT, m[1]))) missing.push(`${file} -> ${m[1]}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `workflow step(s) invoke a script that does not exist:\n  ${missing.join("\n  ")}`
  );
});
