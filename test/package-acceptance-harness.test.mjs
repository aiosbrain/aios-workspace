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
