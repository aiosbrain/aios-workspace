import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function packedFiles() {
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
  return packed.files.map((entry) => entry.path);
}

test("npm pack ships both operator-facing devtools documents", () => {
  const files = new Set(packedFiles());
  for (const doc of ["docs/devtools-migration.md", "docs/devtools-toolkit-contract.md"]) {
    assert.ok(files.has(doc), `npm package must ship ${doc}`);
  }
});

// The published tarball carries `validation/` and `scripts/`, but a consumer's global
// `npm i -g @aiosbrain/aios` installs ONLY `dependencies`. So a shipped file importing a
// devDependency is not a lint nit — it is a crash on someone else's machine that no amount of
// local testing reproduces, because the dev tree always has the package installed.
//
// This has now shipped twice. In 0.10.0, `validate-all.sh` ran OGR09 against
// `gui/server/skill-library/`, a path `files` never included, so the documented validation step
// exited ENOENT on every clean install. While cutting 0.11.0 the same shape turned up again:
// OGR15's `check-delivery-skill-suite.mjs` statically imports `ajv`, which was a devDependency,
// so the validator suite still died — on a different validator, with a different error. `ajv`
// moved to `dependencies`; this test is what stops the third instance.
test("every shipped module resolves against runtime dependencies, not devDependencies", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  // `packages/foundation/` is a published workspace with its own manifest, and its sources ship
  // inside this tarball too, so its runtime deps are legitimately resolvable from those files.
  const foundation = JSON.parse(
    readFileSync(path.join(ROOT, "packages", "foundation", "package.json"), "utf8")
  );
  const runtime = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(foundation.dependencies ?? {}),
    ...Object.keys(foundation.peerDependencies ?? {}),
    pkg.name,
    foundation.name,
  ]);
  const devOnly = new Set(
    Object.keys(pkg.devDependencies ?? {}).filter((name) => !runtime.has(name))
  );

  // `from "x"`, `import("x")` and `require("x")` — bare specifiers only; a leading `.` or `/`
  // is a relative/absolute path and a `node:` prefix is a builtin.
  const SPECIFIER = /(?:from\s+|import\s*\(\s*|require\(\s*)["']([^"'./][^"']*)["']/g;
  const offenders = [];
  for (const rel of packedFiles()) {
    if (!/\.(?:mjs|cjs|js)$/.test(rel)) continue;
    let source;
    try {
      source = readFileSync(path.join(ROOT, rel), "utf8");
    } catch {
      continue; // generated into the tarball but absent from the tree; nothing to read
    }
    for (const [, specifier] of source.matchAll(SPECIFIER)) {
      if (specifier.startsWith("node:")) continue;
      const name = specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0];
      if (devOnly.has(name)) offenders.push(`${rel} imports devDependency '${name}'`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `shipped files import devDependencies — a global install cannot resolve these:\n  ${offenders.join("\n  ")}`
  );
});
