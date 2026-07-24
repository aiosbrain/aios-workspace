import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  discoverClientTests,
  discoverNodeTests,
  discoverTestInventory,
  parseArgs,
  parseShard,
} from "../scripts/test-suite.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function trackedTests() {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(
      (file) =>
        /^(?:test\/|gui\/server\/|gui\/client\/src\/|scripts\/)/.test(file) &&
        /\.test\.(?:mjs|js|ts|tsx)$/.test(file)
    )
    .sort();
}

test("every tracked test is discovered exactly once", () => {
  const inventory = discoverTestInventory();
  assert.equal(new Set(inventory.all).size, inventory.all.length);
  assert.deepEqual(inventory.all, trackedTests());
});

test("Node and client ownership are disjoint", () => {
  const node = discoverNodeTests();
  const client = discoverClientTests();
  assert.ok(node.length > 200, "expected the complete Node suite");
  assert.ok(client.length >= 9, "expected the GUI client suite");
  assert.deepEqual(
    node.filter((file) => client.includes(file)),
    []
  );
  assert.ok(node.includes("test/model-call-codex.test.mjs"));
  assert.ok(node.includes("test/transcript-pipeline.test.mjs"));
  assert.ok(node.includes("scripts/brain-mcp.test.mjs"));
});

test("shard and concurrency arguments are validated", () => {
  assert.equal(parseShard("2/3"), "2/3");
  assert.throws(() => parseShard("0/3"), /positive integer/);
  assert.throws(() => parseShard("4/3"), /exceeds total/);
  assert.throws(() => parseShard("bad"), /INDEX\/TOTAL/);
  assert.deepEqual(parseArgs(["--shard=1/3", "--concurrency=2"]).shard, "1/3");
  assert.equal(parseArgs(["--shard=1/3", "--concurrency=2"]).concurrency, 2);
});

test("package scripts use canonical discovery instead of enumerating tests", () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.match(manifest.scripts["test:node"], /scripts\/test-suite\.mjs/);
  assert.doesNotMatch(manifest.scripts.test, /\.test\./);
  assert.equal(manifest.scripts.pretest, undefined);
});
