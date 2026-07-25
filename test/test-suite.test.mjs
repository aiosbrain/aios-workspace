import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CLIENT_TEST_FILE_RE,
  CLIENT_TEST_ROOT,
  discoverClientTests,
  discoverNodeTests,
  discoverTestInventory,
  findUnrunnableNodeTests,
  NODE_TEST_FILE_RE,
  NODE_TEST_ROOTS,
  parseArgs,
  parseShard,
} from "../scripts/test-suite.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Git-parity oracle: discovery must equal the *tracked* test files under each
// runner's root, filtered by that runner's own extension set (Node roots run
// .mjs/.js via node:test; the client root is Vitest's and also runs .ts/.tsx).
// Untracked scratch files and gitignored artifacts are deliberately excluded on
// both sides — tracked-ness is part of discovery itself.
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
  const client = tracked.filter(
    (file) => file.startsWith(`${CLIENT_TEST_ROOT}/`) && CLIENT_TEST_FILE_RE.test(file)
  );
  return [...node, ...client].sort();
}

test("every tracked test is discovered exactly once", () => {
  const inventory = discoverTestInventory();
  assert.equal(new Set(inventory.all).size, inventory.all.length);
  assert.deepEqual(inventory.all, trackedTests());
});

test("Node and client ownership are disjoint and every root contributes", () => {
  const node = discoverNodeTests();
  const client = discoverClientTests();
  for (const root of NODE_TEST_ROOTS) {
    assert.ok(
      node.some((file) => file.startsWith(`${root}/`)),
      `expected Node root ${root}/ to contribute at least one discovered test`
    );
  }
  assert.ok(client.length > 0, "expected the client root to contribute discovered tests");
  assert.ok(
    client.every((file) => file.startsWith(`${CLIENT_TEST_ROOT}/`)),
    "client tests must live under the client root"
  );
  assert.deepEqual(
    node.filter((file) => client.includes(file)),
    []
  );
});

test("a tracked Node-root test with an unrunnable extension fails loudly", () => {
  // The live tree must be clean of them (discoverNodeTests above would throw)…
  assert.deepEqual(findUnrunnableNodeTests(trackedTests()), []);
  // …and the guard itself must flag exactly the silently-unrunnable shapes.
  assert.deepEqual(
    findUnrunnableNodeTests([
      "test/foo.test.ts",
      "gui/server/bar.test.tsx",
      "scripts/baz.test.cjs",
      "test/ok.test.mjs",
      "gui/client/src/ok.test.ts",
      "test/node_modules/vendored.test.ts",
      "evals/outside-roots.test.ts",
    ]),
    ["gui/server/bar.test.tsx", "scripts/baz.test.cjs", "test/foo.test.ts"]
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
  assert.match(manifest.scripts["test:rust"], /run-rust-tests\.mjs/);
});

test("aggregate CI gate preserves the protected branch context", () => {
  const workflow = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  assert.match(workflow, /test-gate:\n(?:.|\n)*?name: unit tests \(npm test\)/);
  assert.match(workflow, /AIOS_REQUIRE_RUST_TESTS: "1"/);
});
