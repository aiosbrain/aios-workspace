/**
 * AIO-1071: fast, offline unit coverage for the package-acceptance harness's trusted
 * mechanisms — digest verification, environment allowlisting, sentinel scanning,
 * forbidden-tool probing, escaping-link detection, and evidence redaction. The full
 * lane (pack → install → journeys → fault controls) is exercised by
 * test/package-acceptance/run-cell.mjs, which is CI/workflow-driven, not test-discovered.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CellContext,
  SENTINELS,
  findEscapingLinks,
  probeForbiddenPathTools,
  scanTextForSentinels,
  sha256Hex,
} from "./package-acceptance/lib/context.mjs";
import { runFaultControls } from "./package-acceptance/lib/faults.mjs";
import { runNpmInstall } from "./package-acceptance/lib/journeys-lifecycle.mjs";
import { assertCleanPackSurface, findDirtyPackagedPaths } from "./package-acceptance/pack.mjs";

function makeArtifact(base, { tamper = false } = {}) {
  const artifactDir = path.join(base, "artifact");
  mkdirSync(artifactDir, { recursive: true });
  const bytes = Buffer.from("synthetic tarball bytes for AIO-1071\n");
  writeFileSync(path.join(artifactDir, "candidate.tgz"), bytes);
  const manifest = {
    schemaVersion: 1,
    candidateSha: "a".repeat(40),
    tarball: "candidate.tgz",
    sha256: tamper ? sha256Hex(Buffer.from("other")) : sha256Hex(bytes),
    packageName: "@aiosbrain/aios",
    packageVersion: "0.12.0",
    dependencies: { "@aiosbrain/aios-devtools": "0.3.1" },
    bin: { aios: "scripts/aios.mjs" },
  };
  writeFileSync(path.join(artifactDir, "manifest.json"), JSON.stringify(manifest));
  return artifactDir;
}

function makeContext(base, opts) {
  return new CellContext({
    artifactDir: makeArtifact(base, opts),
    evidenceDir: path.join(base, "evidence"),
    checkoutRoot: base,
    base,
  });
}

test("digest verification accepts the packed bytes and rejects a tampered manifest", (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "aio1071-unit-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const ctx = makeContext(base);
  assert.equal(ctx.verifyArtifactDigest(), ctx.manifest.sha256);
  const bad = makeContext(path.join(base, "bad"), { tamper: true });
  assert.throws(() => bad.verifyArtifactDigest(), /digest mismatch/);
});

test("cell environment is allowlisted: empty HOME, engine-strict, no ambient credential", (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "aio1071-unit-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  process.env.AIOS_UNIT_FAKE_API_KEY = "should-never-cross";
  t.after(() => delete process.env.AIOS_UNIT_FAKE_API_KEY);
  const env = makeContext(base).env();
  assert.equal(env.HOME, path.join(base, "home"));
  assert.equal(env.npm_config_engine_strict, "true");
  assert.equal(env.AIOS_UNIT_FAKE_API_KEY, undefined, "credential-shaped vars must not cross");
  assert.equal(env.LINEAR_API_KEY, undefined);
});

test("sentinel scanner detects every seeded sentinel (positive control) and stays quiet", () => {
  assert.deepEqual(scanTextForSentinels("clean output"), []);
  for (const [name, value] of Object.entries(SENTINELS)) {
    assert.deepEqual(scanTextForSentinels(`a ${value} b`), [name]);
  }
});

test("run() records redacted evidence and flags sentinel leaks without printing them", (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "aio1071-unit-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const ctx = makeContext(base);
  ctx.run(process.execPath, ["-e", `console.log("leak:" + ${JSON.stringify(SENTINELS.aiosKey)})`], {
    label: "leaky",
  });
  assert.equal(ctx.sentinelHits.length, 1);
  assert.equal(ctx.sentinelHits[0].sentinel, "aiosKey");
  const evidenceFile = ctx.writeEvidence({ ok: false });
  const persisted = readFileSync(evidenceFile, "utf8");
  assert.deepEqual(scanTextForSentinels(persisted), [], "evidence must be redacted");
  assert.match(persisted, /\[redacted sha256:/, "redaction fingerprint replaces the value");
});

test("unknown non-zero exits fail closed; expected failures surface status + output", (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "aio1071-unit-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const ctx = makeContext(base);
  assert.throws(
    () => ctx.run(process.execPath, ["-e", "process.exit(7)"], { label: "boom" }),
    /command failed \(exit 7\)/
  );
  const r = ctx.run(process.execPath, ["-e", "process.exit(3)"], {
    label: "expected",
    expectFailure: true,
  });
  assert.equal(r.status, 3);
});

test("forbidden-tool probe finds python/jq/dotenvx on PATH and passes a clean dir", (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "aio1071-unit-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const clean = path.join(base, "clean");
  const dirty = path.join(base, "dirty");
  mkdirSync(clean, { recursive: true });
  mkdirSync(dirty, { recursive: true });
  writeFileSync(path.join(dirty, "python3"), "#!/bin/sh\n");
  writeFileSync(path.join(dirty, "jq"), "#!/bin/sh\n");
  assert.deepEqual(probeForbiddenPathTools(clean), []);
  const found = probeForbiddenPathTools([clean, dirty].join(path.delimiter));
  assert.deepEqual(found.sort(), [path.join(dirty, "jq"), path.join(dirty, "python3")]);
});

test("run() defaults to the isolated node-only PATH — a planted ambient jq is unreachable", (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "aio1071-unit-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const planted = path.join(base, "ambient-tools");
  mkdirSync(planted, { recursive: true });
  writeFileSync(path.join(planted, "jq"), "#!/bin/sh\n", { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${planted}${path.delimiter}${originalPath}`;
  t.after(() => {
    process.env.PATH = originalPath;
  });
  const ctx = makeContext(base);
  // Default (no env passed): the CLI-execution environment the isolation probe verified.
  const seen = ctx
    .run(process.execPath, ["-p", "process.env.PATH"], { label: "default-env" })
    .stdout.trim();
  assert.equal(seen, path.dirname(process.execPath), "default run() env must be node-only");
  assert.deepEqual(probeForbiddenPathTools(seen), [], "planted jq must be unreachable");
  // Ambient toolchain access is an explicit, named opt-in — and still allowlisted.
  const ambient = ctx
    .runWithAmbientEnv(process.execPath, ["-p", "process.env.PATH"], { label: "ambient-env" })
    .stdout.trim();
  assert.ok(ambient.includes(planted), "runWithAmbientEnv exposes the runner PATH");
});

test("engine-strict relaxation is scoped to exactly the legacy 0.12.0 install step", () => {
  const calls = [];
  const stub = {
    runWithAmbientEnv(cmd, args, opts) {
      calls.push({ cmd, spec: args[1], envExtra: opts.envExtra });
    },
  };
  runNpmInstall(stub, { spec: "@aiosbrain/aios@0.12.0", cwd: "/x", label: "legacy", legacy: true });
  runNpmInstall(stub, { spec: "/tmp/candidate.tgz", cwd: "/x", label: "candidate" });
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls[0].envExtra,
    { npm_config_engine_strict: "false" },
    "ONLY the legacy 0.12.0 baseline may relax engine-strict"
  );
  assert.deepEqual(
    calls[1].envExtra,
    {},
    "candidate installs must keep the allowlist default npm_config_engine_strict=true"
  );
});

test("pack refuses a dirty packaged surface and passes a clean one", () => {
  const pkg = { files: ["scripts", "scaffold", "docs/devtools-*.md"] };
  // Dirty paths inside the packaged surface are caught; test/CI-only churn is not.
  assert.deepEqual(
    findDirtyPackagedPaths(
      [
        " M scripts/aios.mjs",
        "?? scaffold/new-file.tmpl",
        " M docs/devtools-migration.md",
        " M package.json",
        "?? test/package-acceptance/x.mjs",
        " M .github/workflows/ci.yml",
        " M docs/roadmap.md",
      ].join("\n"),
      pkg
    ),
    ["scripts/aios.mjs", "scaffold/new-file.tmpl", "docs/devtools-migration.md", "package.json"]
  );
  const execFor = (porcelain) => (cmd, args) => {
    assert.deepEqual([cmd, args[0]], ["git", "status"]);
    return porcelain;
  };
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  assert.throws(
    () => assertCleanPackSurface(root, execFor(" M scripts/aios.mjs\n")),
    /refusing to pack.*scripts\/aios\.mjs/s
  );
  assertCleanPackSurface(root, execFor("?? test/only-test-churn.mjs\n"));
});

test("broken fault-control machinery aborts as a harness error, never as a red control", async (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "aio1071-unit-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const ctx = makeContext(base);
  // A nonexistent install prefix breaks the disposable-copy machinery of the very first
  // control. The run must ABORT with the named harness-error code — if this ever reads
  // as red/allRed, the negative controls have gone fail-open.
  const ghostInstall = {
    prefix: path.join(base, "does-not-exist"),
    pkgDir: path.join(base, "does-not-exist", "node_modules", "@aiosbrain", "aios"),
    bin: path.join(base, "does-not-exist", "node_modules", ".bin", "aios"),
  };
  await assert.rejects(runFaultControls(ctx, ghostInstall), (error) => {
    assert.equal(error.code, "AIOS_ACCEPTANCE_HARNESS_ERROR");
    assert.match(error.message, /machinery failed in 'broken-bin'/);
    return true;
  });
  assert.equal(ctx.sections["fault-controls"].aborted, "broken-bin");
  assert.equal(ctx.sections["fault-controls"].allRed, false);
});

test("escaping-link probe catches a node_modules symlink that leaves the prefix", (t) => {
  const base = mkdtempSync(path.join(tmpdir(), "aio1071-unit-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const prefix = path.join(base, "prefix");
  const outside = path.join(base, "outside-checkout");
  const nm = path.join(prefix, "node_modules");
  mkdirSync(path.join(nm, "@scope"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(path.join(nm, "inside-pkg"), { recursive: true });
  symlinkSync(path.join(nm, "inside-pkg"), path.join(nm, "@scope", "inside-link"));
  assert.deepEqual(findEscapingLinks(nm, prefix), []);
  symlinkSync(outside, path.join(nm, "@scope", "escape-link"));
  assert.deepEqual(findEscapingLinks(nm, prefix), [path.join(nm, "@scope", "escape-link")]);
});
