/**
 * The core→devtools dispatch contract (AIO-661; scripts/devtools-dispatch.mjs).
 *
 * Resolution order is load-bearing: in-tree BEFORE the published package, so that landing the
 * seam does not silently swap which implementation runs while the in-tree files are still
 * authoritative (CLAUDE.md §2c). These tests pin that ordering and the explicit-source-never-
 * falls-back rule, both of which are easy to "simplify" away later without noticing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEVTOOLS_MODULES,
  DEVTOOLS_PACKAGE,
  explicitDevtoolsDir,
  loadDevtoolsModule,
  resolveDevtoolsModule,
} from "../scripts/devtools-dispatch.mjs";

function tmpTree() {
  const dir = mkdtempSync(path.join(tmpdir(), "devtools-dispatch-"));
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  return dir;
}

test("in-tree wins over the published package while the files still exist", () => {
  // The whole point of this ordering: landing the adapter must be a behavioural no-op. If the
  // package were preferred, `aios ship` would start running npm's 0.2.0 instead of this
  // checkout's HEAD as a side effect of a seam change nobody thought was risky.
  const core = tmpTree();
  try {
    writeFileSync(path.join(core, "scripts", "ship.mjs"), "export const cmdShip = () => 0;\n");
    const r = resolveDevtoolsModule("ship", {
      coreScripts: path.join(core, "scripts"),
      argv: [],
      env: {},
    });
    assert.equal(r.kind, "file");
    assert.equal(r.source, "in-tree");
    assert.equal(r.specifier, pathToFileURL(path.join(core, "scripts", "ship.mjs")).href);
  } finally {
    rmSync(core, { recursive: true, force: true });
  }
});

test("the package takes over once the in-tree file is gone (the removal PR needs no further change)", () => {
  const core = tmpTree();
  try {
    const r = resolveDevtoolsModule("ship", {
      coreScripts: path.join(core, "scripts"),
      argv: [],
      env: {},
    });
    assert.equal(r.kind, "package");
    assert.equal(r.specifier, `${DEVTOOLS_PACKAGE}/ship`);
  } finally {
    rmSync(core, { recursive: true, force: true });
  }
});

test("an explicit --devtools-dir outranks in-tree and never silently falls back", () => {
  const core = tmpTree();
  const explicit = tmpTree();
  try {
    writeFileSync(path.join(core, "scripts", "build.mjs"), "export const runBuild = () => 0;\n");
    writeFileSync(
      path.join(explicit, "scripts", "build.mjs"),
      "export const runBuild = () => 1;\n"
    );

    const chosen = resolveDevtoolsModule("build", {
      coreScripts: path.join(core, "scripts"),
      argv: ["--devtools-dir", explicit],
      env: {},
    });
    assert.equal(chosen.source, "--devtools-dir");
    assert.equal(chosen.specifier, pathToFileURL(path.join(explicit, "scripts", "build.mjs")).href);

    // A wrong explicit path is a hard error even though a perfectly good in-tree copy exists —
    // running different code than the operator asked for is worse than failing.
    assert.throws(
      () =>
        resolveDevtoolsModule("build", {
          coreScripts: path.join(core, "scripts"),
          argv: ["--devtools-dir", path.join(explicit, "nope")],
          env: {},
        }),
      /does not exist/
    );
  } finally {
    rmSync(core, { recursive: true, force: true });
    rmSync(explicit, { recursive: true, force: true });
  }
});

test("AIOS_DEVTOOLS_DIR is honoured, and a valueless flag is an actionable error", () => {
  assert.deepEqual(explicitDevtoolsDir({ argv: [], env: { AIOS_DEVTOOLS_DIR: "/x" } }), {
    dir: "/x",
    source: "AIOS_DEVTOOLS_DIR",
  });
  assert.equal(explicitDevtoolsDir({ argv: [], env: {} }), null);
  assert.throws(
    () => explicitDevtoolsDir({ argv: ["--devtools-dir"], env: {} }),
    /requires a path argument/
  );
  assert.throws(
    () => explicitDevtoolsDir({ argv: ["--devtools-dir", "--other"], env: {} }),
    /requires a path argument/
  );
});

test("an unknown module name is refused with the known set", () => {
  assert.throws(() => resolveDevtoolsModule("nope"), /unknown devtools module 'nope'/);
  assert.deepEqual(DEVTOOLS_MODULES, [
    "ship",
    "build",
    "roadmap-run",
    "spec-eval",
    "spec-publish",
    "consolidate-findings",
  ]);
});

test("a missing package fails with an install instruction, not ERR_MODULE_NOT_FOUND", async () => {
  // Post-cut this is the error an operator without devtools actually hits. A bare
  // "Cannot find package" with no next step is exactly what the contract exists to prevent.
  const core = tmpTree();
  try {
    await assert.rejects(
      () =>
        loadDevtoolsModule("roadmap-run", {
          coreScripts: path.join(core, "scripts"),
          argv: [],
          env: {},
        }),
      (err) => {
        assert.match(err.message, /lives in @aiosbrain\/aios-devtools, which is not installed/);
        assert.match(err.message, /npm i -D @aiosbrain\/aios-devtools/);
        assert.match(err.message, /AIOS_DEVTOOLS_DIR/);
        return true;
      }
    );
  } finally {
    rmSync(core, { recursive: true, force: true });
  }
});

test("every declared module resolves in this checkout (in-tree, pre-cut)", () => {
  for (const name of DEVTOOLS_MODULES) {
    const r = resolveDevtoolsModule(name, { argv: [], env: {} });
    assert.equal(r.source, "in-tree", `${name} should resolve in-tree before the cut`);
  }
});
