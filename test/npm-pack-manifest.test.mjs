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
  // npm <= 11 prints an ARRAY of packed-tarball records; npm >= 12 prints an OBJECT KEYED BY
  // PACKAGE NAME whose values are those same records. The CI matrix still runs the npm bundled
  // with Node 22/24, but publish lanes pin a newer npm (trusted publishing needs >= 11.5.1), so
  // destructuring as an array throws `object is not iterable` there. Verified against npm 10.9.4
  // and npm 12.0.2; the record fields (filename, files) are identical in both shapes.
  const parsed = JSON.parse(raw);
  const [packed] = Array.isArray(parsed) ? parsed : Object.values(parsed);
  assert.ok(packed?.files, `unrecognized npm pack --json shape: ${raw.slice(0, 200)}`);
  const files = new Set(packed.files.map((entry) => entry.path));
  for (const doc of ["docs/devtools-migration.md", "docs/devtools-toolkit-contract.md"]) {
    assert.ok(files.has(doc), `npm package must ship ${doc}`);
  }
});
