import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
  const workflow = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const jobs = [...workflow.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1]);
  for (const m of workflow.matchAll(/^ {4}needs:\n((?: {6}- .+\n)+)/gm)) {
    for (const need of m[1].split("\n").map((l) => l.replace(/^ {6}- /, "").trim())) {
      if (!need) continue;
      assert.ok(jobs.includes(need), `ci.yml needs "${need}", which is not a job`);
    }
  }
});
