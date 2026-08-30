import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relative) => JSON.parse(readFileSync(path.join(ROOT, relative), "utf8"));
const RANGE = "22.x || 24.x || 26.x";

test("root and foundation declare the exact runtime contract while development stays on 22", () => {
  const root = readJson("package.json");
  const foundation = readJson("packages/foundation/package.json");
  const lock = readJson("package-lock.json");
  assert.equal(root.engines.node, RANGE);
  assert.equal(foundation.engines.node, RANGE);
  assert.equal(lock.packages[""].engines.node, RANGE);
  assert.equal(lock.packages["packages/foundation"].engines.node, RANGE);
  assert.match(readFileSync(path.join(ROOT, ".nvmrc"), "utf8").trim(), /^22(?:\.|$)/);
  assert.match(readFileSync(path.join(ROOT, ".node-version"), "utf8").trim(), /^22(?:\.|$)/);
});

test("the packed fileset covers the portable runtime and the canonical bin is executable", () => {
  const pkg = readJson("package.json");
  assert.ok(pkg.files.includes("scripts"));
  assert.equal(pkg.bin.aios, "scripts/aios.mjs");
  if (process.platform !== "win32") assert.ok(statSync(path.join(ROOT, pkg.bin.aios)).mode & 0o111);
  for (const relative of [
    "scripts/cli/config-broker.mjs",
    "scripts/cli/credential-broker.mjs",
    "scripts/cli/destination-policy.mjs",
    "scripts/cli/migration.mjs",
    "scripts/cli/doctor.mjs",
    "scripts/cli/provenance.mjs",
  ])
    assert.doesNotThrow(() => statSync(path.join(ROOT, relative)), relative);
});
