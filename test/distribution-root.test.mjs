/**
 * distribution-root.test.mjs — AIO-635 Decision 3: the ONE toolkit classifier.
 *
 * Classification matrix: a real git checkout → `checkout`; an unpacked tarball and a
 * node_modules install → `registry`; a stamped workspace → the NAMED `workspace`
 * rejection; a scaffold-bearing non-AIOS repo → null (the hole the old two-marker check
 * had). Plus: zero remaining local looksLikeToolkit definitions outside the classifier.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  resolveDistributionRoot,
  isDistributionRoot,
  missingDistributionMarkers,
  DISTRIBUTION_MARKERS,
} from "../scripts/cli/distribution-root.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const discard = { recursive: true, force: true };

function markerComplete(dir, { name = "@aiosbrain/aios", version = "2.0.0" } = {}) {
  mkdirSync(path.join(dir, "scaffold"), { recursive: true });
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  writeFileSync(path.join(dir, "scripts", "toolkit-manifest.mjs"), "// marker\n");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version }));
  return dir;
}

test("a real git checkout classifies `checkout` with its HEAD sha", () => {
  const dir = markerComplete(mkdtempSync(path.join(tmpdir(), "droot-co-")));
  try {
    execFileSync("git", ["-C", dir, "init", "-q"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "t@t.t"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
    execFileSync("git", ["-C", dir, "add", "-A"]);
    execFileSync("git", ["-C", dir, "commit", "-qm", "init"]);
    const root = resolveDistributionRoot(dir);
    assert.equal(root.kind, "checkout");
    assert.equal(root.version, "2.0.0");
    assert.match(root.sha, /^[0-9a-f]{40}$/);
  } finally {
    rmSync(dir, discard);
  }
});

test("an unpacked tarball (marker-complete non-git dir with build.json) classifies `registry`", () => {
  const dir = markerComplete(mkdtempSync(path.join(tmpdir(), "droot-tar-")));
  try {
    const sha = "a".repeat(40);
    writeFileSync(path.join(dir, "build.json"), JSON.stringify({ sha, version: "2.0.0" }));
    const root = resolveDistributionRoot(dir);
    assert.equal(root.kind, "registry");
    assert.equal(root.sha, sha);
  } finally {
    rmSync(dir, discard);
  }
});

test("a node_modules install classifies `registry` even without build.json", () => {
  const base = mkdtempSync(path.join(tmpdir(), "droot-nm-"));
  try {
    const dir = path.join(base, "node_modules", "@aiosbrain", "aios");
    mkdirSync(dir, { recursive: true });
    markerComplete(dir);
    const root = resolveDistributionRoot(dir);
    assert.equal(root.kind, "registry");
    assert.equal(root.sha, null);
  } finally {
    rmSync(base, discard);
  }
});

test("a stamped workspace returns the NAMED `workspace` rejection, never a toolkit", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "droot-ws-"));
  try {
    mkdirSync(path.join(dir, "scripts"), { recursive: true });
    writeFileSync(path.join(dir, "scripts", "aios.mjs"), "// delegating shim\n");
    writeFileSync(path.join(dir, "aios.yaml"), "owner: t\n");
    const root = resolveDistributionRoot(dir);
    assert.equal(root.kind, "workspace");
    assert.equal(isDistributionRoot(dir), false, "a workspace is never a distribution root");
  } finally {
    rmSync(dir, discard);
  }
});

test("a scaffold-bearing NON-AIOS repo is null (the old two-marker check accepted it)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "droot-other-"));
  try {
    mkdirSync(path.join(dir, "scaffold"), { recursive: true });
    mkdirSync(path.join(dir, "scripts"), { recursive: true });
    writeFileSync(path.join(dir, "scripts", "aios.mjs"), "// entry\n");
    writeFileSync(path.join(dir, "scripts", "toolkit-manifest.mjs"), "// marker\n");
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "someone-else" }));
    assert.equal(resolveDistributionRoot(dir), null);
    assert.ok(missingDistributionMarkers(dir).join(" ").includes("@aiosbrain/aios"));
  } finally {
    rmSync(dir, discard);
  }
});

test("this checkout itself classifies `checkout`", () => {
  const root = resolveDistributionRoot(ROOT);
  assert.equal(root.kind, "checkout");
});

test("zero remaining local looksLikeToolkit definitions outside the classifier seam", () => {
  // The AIO-635 acceptance: every former copy imports the ONE classifier. toolkit-locate
  // keeps the exported NAME (copy-parity with devtools) but its body must delegate.
  for (const rel of ["scripts/update.mjs", "scripts/onboard-inspect.mjs"]) {
    const src = readFileSync(path.join(ROOT, rel), "utf8");
    assert.ok(
      !/function looksLikeToolkit/.test(src),
      `${rel} still defines a local looksLikeToolkit`
    );
  }
  const locate = readFileSync(path.join(ROOT, "scripts/toolkit-locate.mjs"), "utf8");
  assert.match(locate, /isDistributionRoot\(dir\)/, "toolkit-locate delegates to the classifier");
  assert.equal(DISTRIBUTION_MARKERS.length, 3);
});
