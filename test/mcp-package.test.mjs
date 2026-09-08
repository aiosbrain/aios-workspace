import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  assertMcpClosure,
  buildMcpPackage,
  MCP_SOURCE_ROOT,
  MCP_MODULES,
  MCP_PACK_INPUTS,
  sha256,
} from "../packages/mcp-build/build.mjs";
import {
  packMcp,
  assertMcpPackageInventory,
  parseMcpPackOutput,
} from "../packages/mcp-build/pack.mjs";

function temporary(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "mcp-package-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("explicit dependency closure rejects imports outside the standalone surface", (t) => {
  assertMcpClosure();
  const dir = temporary(t);
  const file = path.join(dir, "entry.mjs");
  for (const [source, error] of [
    ['import x from "foreign-package";', /External MCP dependency/],
    ['export * from "../outside.mjs";', /Unlisted MCP dependency/],
    ['import /* comment */ ("./hidden.mjs");', /Dynamic module loading/],
    ['require /* comment */ ("native-addon");', /Dynamic module loading/],
  ]) {
    writeFileSync(file, source);
    assert.throws(() => assertMcpClosure(["entry.mjs"], dir), error);
  }
  writeFileSync(file, 'import fs from "node:fs"; // import("ignored comment")\n');
  assert.doesNotThrow(() => assertMcpClosure(["entry.mjs"], dir));
});

test("standalone build copies the canonical modules and rejects package inventory expansion", (t) => {
  const target = path.join(temporary(t), "build");
  const digests = buildMcpPackage(target);
  for (const file of MCP_MODULES) {
    assert.equal(sha256(readFileSync(path.join(target, "lib", file))), digests[file]);
    assert.deepEqual(
      readFileSync(path.join(target, "lib", file)),
      readFileSync(path.join(MCP_SOURCE_ROOT, file))
    );
  }
  const files = [
    "package.json",
    "README.md",
    "LICENSE",
    "bin/aios-brain-mcp.mjs",
    ...MCP_MODULES.map((file) => `lib/${file}`),
  ].map((file) => ({ path: file }));
  const manifest = assertMcpPackageInventory({ directory: target, files });
  assert.equal(manifest.version, "0.1.0");
  assert.deepEqual(manifest.bin, { "aios-brain-mcp": "bin/aios-brain-mcp.mjs" });
  assert.throws(
    () =>
      assertMcpPackageInventory({
        directory: target,
        files: [...files, { path: "lib/operator-loop.mjs" }],
      }),
    /inventory drift/
  );
  writeFileSync(
    path.join(target, "package.json"),
    JSON.stringify({ ...manifest, dependencies: { sqlite: "*" } })
  );
  assert.throws(
    () => assertMcpPackageInventory({ directory: target, files }),
    /must not contain dependencies/
  );
  assert.throws(() => buildMcpPackage(target), /EEXIST/);
});

test("one frozen candidate tarball records its exact bytes and refuses dirty source", (t) => {
  const dir = temporary(t);
  const source = path.join(dir, "source");
  mkdirSync(source);
  for (const file of MCP_PACK_INPUTS) {
    mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    copyFileSync(path.join(MCP_SOURCE_ROOT, file), path.join(source, file));
  }
  const git = (...args) =>
    execFileSync("git", args, { cwd: source, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "--quiet");
  git("add", ".");
  git(
    "-c",
    "user.name=Package Test",
    "-c",
    "user.email=package-test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "Synthetic package candidate"
  );
  const out = path.join(dir, "artifact");
  const evidence = packMcp(out, source);
  assert.equal(evidence.candidateSha, git("rev-parse", "HEAD").trim());
  assert.equal(evidence.sha256, sha256(readFileSync(path.join(out, evidence.tarball))));
  assert.match(evidence.integrity, /^sha512-/);
  assert.deepEqual(JSON.parse(readFileSync(path.join(out, "candidate.json"), "utf8")), evidence);
  assert.throws(() => packMcp(out, source), /EEXIST/);
  writeFileSync(path.join(source, "scripts/mcp-runtime.mjs"), "// changed after freeze\n");
  assert.throws(() => packMcp(path.join(dir, "dirty"), source), /uncommitted MCP source/);
});

test("pack metadata accepts npm 10/11 arrays and npm 12 named records, rejecting ambiguous output", () => {
  const record = { name: "@aiosbrain/mcp", files: [] };
  assert.deepEqual(parseMcpPackOutput(JSON.stringify([record])), record);
  assert.deepEqual(parseMcpPackOutput(JSON.stringify({ "@aiosbrain/mcp": record })), record);
  for (const value of [
    [],
    {},
    [record, record],
    [{ name: "foreign", files: [] }],
    [{ name: "@aiosbrain/mcp" }],
  ])
    assert.throws(
      () => parseMcpPackOutput(JSON.stringify(value)),
      /Unrecognized npm pack metadata/
    );
});
