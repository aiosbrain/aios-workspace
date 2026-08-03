import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("npm pack ships both operator-facing devtools documents", () => {
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  const [packed] = JSON.parse(raw);
  const files = new Set(packed.files.map((entry) => entry.path));
  for (const doc of ["docs/devtools-migration.md", "docs/devtools-toolkit-contract.md"]) {
    assert.ok(files.has(doc), `npm package must ship ${doc}`);
  }
});
