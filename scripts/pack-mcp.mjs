#!/usr/bin/env node
// Pack once from a frozen candidate; all acceptance/publish steps consume these same bytes.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildMcpPackage,
  MCP_SOURCE_ROOT,
  MCP_PACK_INPUTS,
  MCP_MODULES,
  sha256,
} from "./build-mcp-package.mjs";

const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
export function assertFrozenMcpSource(root = MCP_SOURCE_ROOT) {
  run("git", ["ls-files", "--error-unmatch", "--", ...MCP_PACK_INPUTS], root);
  const status = run(
    "git",
    ["status", "--porcelain", "--untracked-files=all", "--", ...MCP_PACK_INPUTS],
    root
  );
  if (status.trim()) throw new Error("Refusing to pack uncommitted MCP source inputs");
  return run("git", ["rev-parse", "HEAD"], root).trim();
}
export function assertMcpPackageInventory(metadata) {
  const manifest = JSON.parse(readFileSync(path.join(metadata.directory, "package.json"), "utf8"));
  if (
    manifest.name !== "@aiosbrain/mcp" ||
    manifest.private ||
    manifest.publishConfig?.access !== "public"
  )
    throw new Error("Wrong or private MCP package");
  for (const key of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
    "scripts",
  ]) {
    if (Object.keys(manifest[key] || {}).length)
      throw new Error(`MCP package must not contain ${key}`);
  }
  const expected = [
    "package.json",
    "README.md",
    "LICENSE",
    "bin/aios-brain-mcp.mjs",
    ...MCP_MODULES.map((file) => `lib/${file}`),
  ];
  const actual = metadata.files.map((file) => file.path);
  if (actual.length !== expected.length || expected.some((file) => !actual.includes(file)))
    throw new Error("Packed MCP file inventory drift");
  return manifest;
}
export function packMcp(out, root = MCP_SOURCE_ROOT) {
  const candidateSha = assertFrozenMcpSource(root);
  const directory = path.resolve(out);
  mkdirSync(directory, { recursive: false });
  const build = path.join(directory, "build");
  try {
    const sourceDigests = buildMcpPackage(build, root);
    const npmArgs = ["--json", "--ignore-scripts", "--workspaces=false"];
    const dry = JSON.parse(run("npm", ["pack", "--dry-run", ...npmArgs], build))[0];
    assertMcpPackageInventory({ ...dry, directory: build });
    const packed = JSON.parse(
      run("npm", ["pack", ...npmArgs, "--pack-destination", directory], build)
    )[0];
    const manifest = assertMcpPackageInventory({ ...packed, directory: build });
    if (assertFrozenMcpSource(root) !== candidateSha)
      throw new Error("MCP candidate changed during packing");
    for (const [file, digest] of Object.entries(sourceDigests)) {
      if (sha256(readFileSync(path.join(root, file))) !== digest)
        throw new Error(`MCP source changed during packing: ${file}`);
    }
    const tarball = path.join(directory, packed.filename);
    const evidence = {
      candidateSha,
      packageName: manifest.name,
      version: manifest.version,
      tarball: packed.filename,
      sha256: sha256(readFileSync(tarball)),
      integrity: packed.integrity,
      node: process.version,
      npm: run("npm", ["--version"], root).trim(),
      sourceDigests,
      inventory: packed.files,
      packedAt: new Date().toISOString(),
    };
    writeFileSync(path.join(directory, "candidate.json"), JSON.stringify(evidence, null, 2) + "\n");
    return evidence;
  } finally {
    rmSync(build, { recursive: true, force: true });
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const i = process.argv.indexOf("--out");
  if (i < 0 || !process.argv[i + 1])
    throw new Error("Usage: node scripts/pack-mcp.mjs --out <new-directory>");
  console.log(JSON.stringify(packMcp(process.argv[i + 1]), null, 2));
}
