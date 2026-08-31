#!/usr/bin/env node
/**
 * AIO-1071 package-acceptance pack step: pack the candidate EXACTLY ONCE and emit the
 * immutable artifact tuple every acceptance cell consumes — tarball + SHA-256 digest +
 * file inventory + npm metadata + provenance (candidate SHA, packer node/npm).
 *
 * Usage: node test/package-acceptance/pack.mjs --out <dir>
 *
 * The output directory becomes the workflow artifact. No acceptance cell may run
 * `npm pack` itself; cells verify the digest recorded here before installing.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "./lib/context.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", cwd: ROOT, ...opts });

export function packCandidate(outDir) {
  mkdirSync(outDir, { recursive: true });

  // dist/ ships prebuilt in the tarball; self-heal exactly like the golden-path test so a
  // partial checkout fails with the build error rather than a confusing inventory assert.
  run(process.execPath, [path.join(ROOT, "scripts/ensure-loop-built.mjs"), "--quiet"]);

  const candidateSha = run("git", ["rev-parse", "HEAD"]).trim();
  const packOut = run("npm", ["pack", "--pack-destination", outDir]);
  const tarballName = packOut.trim().split("\n").at(-1);
  const tarball = path.join(outDir, tarballName);
  const bytes = readFileSync(tarball);
  const inventory = run("tar", ["-tzf", tarball]).split("\n").filter(Boolean).sort();

  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const manifest = {
    schemaVersion: 1,
    issue: "AIO-1071",
    candidateSha,
    tarball: tarballName,
    sha256: sha256Hex(bytes),
    sizeBytes: bytes.length,
    packageName: pkg.name,
    packageVersion: pkg.version,
    dependencies: pkg.dependencies,
    engines: pkg.engines,
    bin: pkg.bin,
    inventoryCount: inventory.length,
    packedAt: new Date().toISOString(),
    packer: {
      node: process.version,
      npm: run("npm", ["--version"]).trim(),
      platform: process.platform,
    },
  };
  writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(outDir, "inventory.txt"), `${inventory.join("\n")}\n`);
  // The mocked-provider preloads + import probe ride along in the artifact so acceptance
  // cells never reach into a checkout for them (checkout presence stays assertable).
  const helpers = path.join(outDir, "helpers");
  mkdirSync(helpers, { recursive: true });
  for (const name of [
    "mock-linear-provider.mjs",
    "mock-slack-provider.mjs",
    "import-probe.mjs",
    "import-probe-hooks.mjs",
  ]) {
    copyFileSync(path.join(ROOT, "test", "helpers", name), path.join(helpers, name));
  }
  copyFileSync(
    path.join(ROOT, "test", "package-acceptance", "wrong-linear-provider.mjs"),
    path.join(helpers, "wrong-linear-provider.mjs")
  );
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outDir = arg("--out");
  if (!outDir) {
    console.error("usage: node test/package-acceptance/pack.mjs --out <dir>");
    process.exit(2);
  }
  const manifest = packCandidate(path.resolve(outDir));
  console.log(
    `packed ${manifest.packageName}@${manifest.packageVersion} ` +
      `sha256=${manifest.sha256} candidate=${manifest.candidateSha} ` +
      `(${manifest.inventoryCount} files)`
  );
}
