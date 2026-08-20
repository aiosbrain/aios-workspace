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
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  applyToolkitDefault,
  consumeDevtoolsDirArg,
  coreToolkitDir,
  DEVTOOLS_MODULES,
  DEVTOOLS_PACKAGE,
  explicitDevtoolsDir,
  missingPackageError,
  resolveDevtoolsModule,
} from "../scripts/devtools-dispatch.mjs";
import { DEVTOOLS_COMMANDS } from "../scripts/cli/devtools-commands.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AIOS = path.join(ROOT, "scripts", "aios.mjs");

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

test("the global --devtools-dir selector is consumed before the selected command runs", () => {
  const checkout = tmpTree();
  try {
    for (const [command, module, handler] of [
      ["spec", "spec-eval", "cmdSpec"],
      ["build", "build", "cmdBuild"],
    ]) {
      writeFileSync(
        path.join(checkout, "scripts", `${module}.mjs`),
        `export function ${handler}(repo, rest) { console.log(JSON.stringify({ repo, rest })); }\n`
      );
      const result = spawnSync(
        process.execPath,
        [AIOS, command, "--devtools-dir", checkout, "--help"],
        { cwd: ROOT, encoding: "utf8", env: { ...process.env, AIOS_DEVTOOLS_DIR: "" } }
      );
      assert.equal(result.status, 0, `${command}: ${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stdout.trim()).rest, ["--help"], command);
    }

    const rest = ["--json", "--devtools-dir", checkout, "--help"];
    assert.equal(consumeDevtoolsDirArg(rest), checkout);
    assert.deepEqual(rest, ["--json", "--help"]);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("every devtools command declares the global checkout selector", () => {
  assert.deepEqual(
    Object.values(DEVTOOLS_COMMANDS)
      .filter((descriptor) => descriptor.usesDevtoolsDir)
      .map((descriptor) => descriptor.name)
      .sort(),
    ["build", "consolidate-findings", "roadmap-run", "ship", "spec"]
  );
  assert.ok(Object.values(DEVTOOLS_COMMANDS).every((descriptor) => descriptor.usesDevtoolsDir));
});

test("an unknown module name is refused with the known set", () => {
  assert.throws(() => resolveDevtoolsModule("nope"), /unknown devtools module 'nope'/);
  // spec-publish is deliberately absent: devtools-internal (reached via spec-eval), not a
  // core dispatch target, and not in the package exports map.
  assert.deepEqual(DEVTOOLS_MODULES, [
    "ship",
    "build",
    "roadmap-run",
    "spec-eval",
    "consolidate-findings",
  ]);
});

test("a missing/unexported package maps to an install instruction, not ERR_MODULE_NOT_FOUND", () => {
  // Post-cut @aiosbrain/aios-devtools is a real dependency, so this branch can no longer be
  // reached by simply not installing it — hence the extracted mapper. A test that silently
  // stopped exercising this path would be worse than no test.
  const pkgResolved = { kind: "package", specifier: "@aiosbrain/aios-devtools/ship" };

  for (const msg of [
    "Cannot find package '@aiosbrain/aios-devtools'",
    "ERR_MODULE_NOT_FOUND",
    `Package subpath './ship' is not defined by "exports"`,
  ]) {
    const mapped = missingPackageError("ship", pkgResolved, new Error(msg));
    assert.ok(mapped, `should map: ${msg}`);
    assert.match(mapped.message, /npm i @aiosbrain\/aios-devtools/);
    assert.match(mapped.message, /AIOS_DEVTOOLS_DIR/);
  }

  // An unrelated failure inside the module must surface unchanged, never be relabelled as
  // "not installed" — that would send you installing something you already have.
  assert.equal(
    missingPackageError("ship", pkgResolved, new Error("TypeError: x is not a function")),
    null
  );
  // A file-resolved load is never an install problem.
  assert.equal(
    missingPackageError(
      "ship",
      { kind: "file", specifier: "file:///x" },
      new Error("ERR_MODULE_NOT_FOUND")
    ),
    null
  );
});

test("every declared module resolves to a real package subpath export", async () => {
  // Post-cut the in-tree files are gone, so this is what actually proves the adapter works:
  // each name must be a subpath the package genuinely exports. Listing a devtools-internal
  // module here (spec-publish) failed exactly this check.
  const pkg = JSON.parse(
    readFileSync(new URL("../node_modules/@aiosbrain/aios-devtools/package.json", import.meta.url))
  );
  for (const name of DEVTOOLS_MODULES) {
    assert.ok(
      pkg.exports[`./${name}`],
      `${name} is dispatched by core but @aiosbrain/aios-devtools does not export ./${name}`
    );
  }
});

// ── the toolkit default core hands to out-of-tree devtools (AIO-686, copy-ledger row 13) ────────
// `toolkit-locate.mjs` falls back to "the repo containing this file", which is the TOOLKIT in-tree
// and the DEVTOOLS root everywhere else — and the devtools root ships no scaffold/ or
// scripts/aios.mjs, so it is not a toolkit and resolution hard-fails. Core is the only participant
// that knows where the toolkit is, so core supplies it — without ever outranking the operator.

test("core's toolkit root is the package root, the dir that actually owns .claude/rubrics", () => {
  const dir = coreToolkitDir();
  assert.equal(dir, path.resolve(fileURLToPath(new URL("..", import.meta.url))));
  for (const marker of ["scripts/aios.mjs", "scaffold", "package.json"]) {
    assert.ok(existsSync(path.join(dir, marker)), `toolkit root must contain ${marker}`);
  }
  assert.ok(
    existsSync(path.join(dir, ".claude", "rubrics", "spec-readiness.md")),
    "the toolkit root is what ships the spec-readiness rubric"
  );
});

test("in-tree resolution is left alone, so its source stays containing-repo", () => {
  const env = {};
  assert.equal(applyToolkitDefault({ source: "in-tree" }, { argv: [], env }), null);
  assert.equal(env.AIOS_TOOLKIT_DIR, undefined);
});

test("an out-of-tree devtools module is told which toolkit it is running against", () => {
  for (const source of [DEVTOOLS_PACKAGE, "--devtools-dir", "AIOS_DEVTOOLS_DIR"]) {
    const env = {};
    assert.equal(applyToolkitDefault({ source }, { argv: [], env }), coreToolkitDir());
    assert.equal(env.AIOS_TOOLKIT_DIR, coreToolkitDir(), `${source} must get the toolkit default`);
  }
});

test("an explicit toolkit selector always outranks the default — core never overrides it", () => {
  const preset = { AIOS_TOOLKIT_DIR: "/operator/choice" };
  assert.equal(applyToolkitDefault({ source: DEVTOOLS_PACKAGE }, { argv: [], env: preset }), null);
  assert.equal(preset.AIOS_TOOLKIT_DIR, "/operator/choice", "a pre-set env var is never rewritten");

  const flagged = {};
  assert.equal(
    applyToolkitDefault(
      { source: DEVTOOLS_PACKAGE },
      { argv: ["--toolkit-dir", "/x"], env: flagged }
    ),
    null
  );
  assert.equal(
    flagged.AIOS_TOOLKIT_DIR,
    undefined,
    "--toolkit-dir is resolved by the locator, not here"
  );
});
