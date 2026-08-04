import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  discoverNodeTests,
  discoverTestInventory,
  findUnrunnableNodeTests,
  NODE_TEST_FILE_RE,
  NODE_TEST_ROOTS,
  parseArgs,
  parseShard,
} from "../scripts/test-suite.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Git-parity oracle: discovery must equal the *tracked* test files under the Node roots,
// filtered by the runner's extension set (.mjs/.js via node:test). The client half of this
// oracle left with gui/client in the AIO-612 cut. Untracked scratch files and gitignored
// artifacts are deliberately excluded on both sides — tracked-ness is part of discovery itself.
function trackedTests() {
  const tracked = execFileSync("git", ["ls-files", "-z", "--cached"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const node = tracked.filter(
    (file) =>
      NODE_TEST_ROOTS.some((root) => file.startsWith(`${root}/`)) && NODE_TEST_FILE_RE.test(file)
  );
  return [...node].sort();
}

test("every tracked test is discovered exactly once", () => {
  const inventory = discoverTestInventory();
  assert.equal(new Set(inventory.all).size, inventory.all.length);
  assert.deepEqual(inventory.all, trackedTests());
});

test("every Node root contributes discovered tests", () => {
  const node = discoverNodeTests();
  for (const root of NODE_TEST_ROOTS) {
    assert.ok(
      node.some((file) => file.startsWith(`${root}/`)),
      `expected Node root ${root}/ to contribute at least one discovered test`
    );
  }
});

test("a tracked Node-root test with an unrunnable extension fails loudly", () => {
  // The live tree must be clean of them (discoverNodeTests above would throw)…
  assert.deepEqual(findUnrunnableNodeTests(trackedTests()), []);
  // …and the guard itself must flag exactly the silently-unrunnable shapes.
  assert.deepEqual(
    findUnrunnableNodeTests([
      "test/foo.test.ts",
      "scripts/baz.test.cjs",
      "test/ok.test.mjs",
      "test/node_modules/vendored.test.ts",
      "evals/outside-roots.test.ts",
    ]),
    ["scripts/baz.test.cjs", "test/foo.test.ts"]
  );
});

test("shard and concurrency arguments are validated", () => {
  assert.equal(parseShard("2/3"), "2/3");
  assert.throws(() => parseShard("0/3"), /positive integer/);
  assert.throws(() => parseShard("4/3"), /exceeds total/);
  assert.throws(() => parseShard("bad"), /INDEX\/TOTAL/);
  assert.deepEqual(parseArgs(["--shard=1/3", "--concurrency=2"]).shard, "1/3");
  assert.equal(parseArgs(["--shard=1/3", "--concurrency=2"]).concurrency, 2);
  for (const flag of ["--shard", "--concurrency", "--only"]) {
    assert.throws(() => parseArgs([flag]), new RegExp(`${flag} requires a value`));
    assert.throws(() => parseArgs([`${flag}=`]), new RegExp(`${flag} requires a value`));
  }
});

test("package scripts use canonical discovery instead of enumerating tests", () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.match(manifest.scripts["test:node"], /scripts\/test-suite\.mjs/);
  // Test paths must front the suite with a STRICT loop build: a TS compile
  // failure has to fail the run, not fall through to stale dist/ (soft mode is
  // for postinstall only).
  assert.match(manifest.scripts["test:node"], /ensure-loop-built\.mjs --strict/);
  // --noEmitOnError keeps the mtime staleness gate sound: a failed compile must
  // never refresh dist/ and mask itself as "fresh" on the next run.
  assert.match(manifest.scripts["build:loop"], /--noEmitOnError/);
  assert.doesNotMatch(manifest.scripts.test, /\.test\./);
  assert.equal(manifest.scripts.pretest, undefined);
  assert.match(manifest.scripts["pretest:node"], /ensure-native-abi\.mjs/);
  // The Rust/Tauri and GUI-client legs left with the AIO-612 cut; `test` is Node-only now.
  assert.equal(manifest.scripts["test:rust"], undefined);
  assert.equal(manifest.scripts["test:client"], undefined);
  assert.doesNotMatch(manifest.scripts.test, /test:(?:rust|client)/);
});

test("aggregate CI gate preserves the protected branch context", () => {
  const workflow = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.match(workflow, /test-gate:\n(?:.|\n)*?name: unit tests \(npm test\)/);
  // The rust lane it used to assert on left with the AIO-612 cut. What still has to hold is that
  // `needs:` names only jobs that exist — a needs entry pointing at a removed job makes the whole
  // workflow invalid, and a lane dropped from the list becomes silently non-blocking because
  // `skipped` counts as passing.
  const jobNames = [...workflow.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1]);
  const gateNeeds = /test-gate:\n(?:.|\n)*?\n {4}needs:\n((?: {6}- .+\n)+)/.exec(workflow);
  assert.ok(gateNeeds, "test-gate must declare a needs: list");
  const needs = gateNeeds[1]
    .split("\n")
    .map((line) => line.replace(/^ {6}- /, "").trim())
    .filter(Boolean);
  for (const need of needs) {
    assert.ok(jobNames.includes(need), `test-gate needs "${need}", which is not a job in ci.yml`);
  }
  assert.ok(needs.length >= 9, `expected at least 9 mandatory lanes, got ${needs.length}`);
});
